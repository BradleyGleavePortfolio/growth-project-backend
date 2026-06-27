import 'reflect-metadata';
// IMPORTANT: instrument.ts must be imported before any other application
// module so Sentry's auto-instrumentation can patch the runtime. Do not
// reorder these lines.
import './instrument';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ThrottlerExceptionFilter } from './filters/throttler-exception.filter';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { CircuitOpenFilter } from './circuit-breakers/circuit-open.filter';
import { assertEnv, isProdLike, parseStorefrontBaseUrl } from './common/env-validation';
import { BootstrapValidationError } from './common/errors/bootstrap-validation.error';
import { setupSwagger } from './common/openapi';
import { CacheControlInterceptor } from './common/cache-control.interceptor';
import { MetricsService } from './observability/metrics.service';
import { LANDING_PUBLIC_PREFIX_EXCLUDE } from './landing-pages/public-route-prefix';

async function bootstrap() {
  // Fail fast at boot if required env vars are missing. See
  // src/common/env-validation.ts for the full rule set; in production /
  // staging the prod-tier rules also throw, while dev only enforces hard
  // rules and warns about the rest.
  assertEnv();
  const app = await NestFactory.create(AppModule, {
    // Capture raw request bodies so the Stripe webhook controller can verify
    // HMAC signatures over the exact byte sequence Stripe signed. Nest's
    // express adapter exposes this via `bodyParser: false` + manual parsing,
    // but the simpler `rawBody: true` flag is supported on Nest 11 and adds
    // `req.rawBody` to every request without disabling JSON parsing.
    rawBody: true,
  });

  // SECURITY (audit E-1): register helmet before any routes so every response
  // carries sensible defaults — HSTS, frameguard (X-Frame-Options: SAMEORIGIN),
  // X-Content-Type-Options: nosniff, Referrer-Policy, X-DNS-Prefetch-Control,
  // etc. CSP is disabled because this is a JSON API consumed by mobile and a
  // future browser console; the default helmet CSP is HTML-oriented and would
  // not block any meaningful attack vector for our JSON responses.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // OPS (audit M-4): forward SIGTERM/SIGINT to module lifecycle hooks so
  // PrismaService.onModuleDestroy() (which calls $disconnect()) actually
  // runs on Fly redeploys. Without this, in-flight requests are killed
  // mid-flight when Fly sends SIGTERM. PrismaService already implements
  // OnModuleDestroy → $disconnect (see src/prisma.service.ts).
  app.enableShutdownHooks();

  // SECURITY: CORS was previously `origin: '*'` (audit C6). The React Native mobile
  // client does not require CORS (it isn't a browser), so the only consumers of CORS
  // are future browser-based admin/web pages. Default to a deny-all allow-list so a
  // misconfigured deploy doesn't inadvertently expose the API to every origin.
  // Set CORS_ORIGINS as a comma-separated list in Fly secrets when a web client needs
  // access, e.g. `CORS_ORIGINS=https://admin.example.com,https://app.example.com`.
  const corsOriginsEnv = process.env.CORS_ORIGINS || '';
  const corsOrigins = corsOriginsEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Reject the wildcard outright: `cors` accepts `'*'` but combined with
  // `credentials: true` it produces a response browsers refuse. In
  // production we want a hard failure rather than silent breakage.
  if (corsOrigins.includes('*')) {
    throw new BootstrapValidationError(
      'CORS_ORIGINS=* is not permitted — list explicit origins (e.g. https://console.example.com).',
      'BOOTSTRAP_CORS_WILDCARD',
    );
  }
  // R43 / P2-1 — the public storefront is hosted at STOREFRONT_BASE_URL and
  // calls /api/v1/packages/public/* from the browser. Auto-include its
  // origin in the CORS allow-list so operators don't have to duplicate the
  // hostname across CORS_ORIGINS and STOREFRONT_BASE_URL. The single
  // source of truth for the URL shape is parseStorefrontBaseUrl in
  // src/common/env-validation.ts.
  //
  // Under prod-like NODE_ENV a malformed STOREFRONT_BASE_URL is fatal —
  // assertEnv already enforces presence, and parsing failures here would
  // mean a deploy that ships a public URL the storefront can't actually
  // round-trip. In dev a malformed value is logged and skipped so
  // contributors are not blocked by a stale value in their .env.
  const storefrontBaseRaw = process.env.STOREFRONT_BASE_URL;
  if (typeof storefrontBaseRaw === 'string' && storefrontBaseRaw.trim().length > 0) {
    const parsed = parseStorefrontBaseUrl(storefrontBaseRaw);
    if (parsed.ok) {
      if (!corsOrigins.includes(parsed.origin)) {
        corsOrigins.push(parsed.origin);
      }
    } else if (isProdLike(process.env.NODE_ENV)) {
      throw new BootstrapValidationError(
        `STOREFRONT_BASE_URL is invalid: ${parsed.message}`,
        'BOOTSTRAP_STOREFRONT_BASE_URL_INVALID',
      );
    } else {
      new Logger('bootstrap').warn(
        `STOREFRONT_BASE_URL is invalid (skipping CORS auto-include in dev): ${parsed.message}`,
      );
    }
  }
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Recent-Auth-Token'],
    // Coach console BFF reads the Supabase access token from a cookie/header
    // depending on how the console is hosted; allow credentials so the
    // browser will actually send them when the origin is in the allow-list.
    credentials: true,
  });

  // Global validation pipe using class-validator
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global exception filters. Order matters: the LAST filter registered runs
  // FIRST for a given exception type, and Nest picks the most-specific @Catch()
  // first regardless of registration order. ThrottlerExceptionFilter stays as a
  // specific @Catch(ThrottlerException); HttpExceptionFilter is the catch-all
  // with @Catch() that normalizes every other HttpException into
  // { statusCode, message, error, timestamp, path }.
  // HttpExceptionFilter forwards 5xx (server) errors to Sentry internally;
  // 4xx are deliberately not sent to avoid noise from validation failures.
  // ThrottlerExceptionFilter receives MetricsService from the DI container
  // so each 429 increments `throttler_rejected_total`. MetricsService is
  // resolved at module init time; if observability is not wired (tests),
  // the filter falls back to logging-only.
  const metrics = app.get(MetricsService, { strict: false });
  app.useGlobalFilters(
    new HttpExceptionFilter(),
    new ThrottlerExceptionFilter(metrics),
    new CircuitOpenFilter(),
  );

  // Global Cache-Control interceptor — adds `private, max-age=60` to safe
  // GET responses, `no-store` to /auth/*, /messaging/*, /admin/*, /health*,
  // /.well-known/*. See src/common/cache-control.interceptor.ts.
  app.useGlobalInterceptors(new CacheControlInterceptor());

  // Surface unhandled rejections / uncaught exceptions to Sentry. Without
  // these, async errors that escape Nest's filter chain (e.g. setTimeout
  // callbacks) would be silently swallowed in production.
  process.on('unhandledRejection', (reason) => {
    Sentry.captureException(reason);
    new Logger('UnhandledRejection').error(reason);
  });
  process.on('uncaughtException', (err) => {
    Sentry.captureException(err);
    new Logger('UncaughtException').error(err);
  });

  // API prefix — exclude /health so Fly.io liveness probes hit /health,
  // and exclude /join/:code and /invite/:code so the public invite landing
  // pages match the universal-link config (https://app.tgp.com/join/...)
  // without the /api prefix. The invite-landing controller's `api/invite/:code`
  // JSON alias is *not* excluded — it intentionally lives under /api alongside
  // the existing /api/invite/:code/preview JSON route.
  // /download/* and /signup are durable public status pages used as the
  // destinations for the APP_STORE_URL, PLAY_STORE_URL, and
  // PUBLIC_WEB_SIGNUP_URL secrets until the real App Store / Play Store
  // listings exist; they must be reachable as bare paths under
  // app.trygrowthproject.com, so they are excluded from the /api prefix.
  app.setGlobalPrefix('api', {
    exclude: [
      'health',
      'healthz',
      'readyz',
      'join/:code',
      'invite/:code',
      'download/ios',
      'download/android',
      'signup',
      'signup/:code',
      // Universal Links / App Links require these documents at the apex
      // domain (not under /api). See WellKnownController.
      '.well-known/apple-app-site-association',
      '.well-known/assetlinks.json',
      // Public trust surface (privacy, terms, security, status). Mounted
      // outside /api so they resolve as bare paths under
      // app.trygrowthproject.com — that is the URL shape app store
      // reviewers and early customers expect.
      'privacy',
      'terms',
      'security',
      'status',
      // Public help surface (coach-facing self-serve content). Mounted
      // outside /api for the same reason as trust pages — bare URLs
      // under the public hostname so coaches can be linked here from
      // welcome emails and the console without an /api prefix.
      'help',
      'help/setup',
      'help/first-client',
      'help/tour',
      'help/faq',
      'help/support',
      'help/contact',
      // R46 — Public coach landing pages (canonical `/p/...` slug routes) AND
      // B3 (PR-18) — verified custom-domain apex routes (`GET /`,
      // `GET /checkout`, `POST /leads`, `POST /view`). Both shapes are pinned
      // in LANDING_PUBLIC_PREFIX_EXCLUDE so the route-registration spec boots
      // against the EXACT same exclude list — a future edit that drops an
      // exclusion fails the test rather than silently regressing routing
      // (the prior P0 was a bare custom-domain route mounted under /api).
      // The custom-domain entries are method-scoped, so no `/api/...` route
      // is shadowed and `/p/...` is never hijacked.
      ...LANDING_PUBLIC_PREFIX_EXCLUDE,
    ],
  });

  // OpenAPI spec + Swagger UI. No-op when ENABLE_API_DOCS!=true in
  // production. Mounted before listen() so /docs-json and /docs are
  // registered routes when the server starts accepting connections.
  setupSwagger(app);

  const port = parseInt(process.env.PORT || '3000', 10);
  // Must bind to 0.0.0.0 for Fly.io — binding to localhost won't be reachable
  await app.listen(port, '0.0.0.0');
  Logger.log(`The Growth Project API running on port ${port}`, 'Bootstrap');
}

bootstrap();
