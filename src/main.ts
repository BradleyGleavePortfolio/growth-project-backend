import 'reflect-metadata';
// IMPORTANT: instrument.ts must be imported before any other application
// module so Sentry's auto-instrumentation can patch the runtime. Do not
// reorder these lines.
import './instrument';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { ThrottlerExceptionFilter } from './filters/throttler-exception.filter';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { assertEnv } from './common/env-validation';

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
    throw new Error(
      'CORS_ORIGINS=* is not permitted — list explicit origins (e.g. https://console.example.com).',
    );
  }
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
  app.useGlobalFilters(
    new HttpExceptionFilter(),
    new ThrottlerExceptionFilter(),
  );

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
      'join/:code',
      'invite/:code',
      'download/ios',
      'download/android',
      'signup',
      'signup/:code',
    ],
  });

  const port = parseInt(process.env.PORT || '3000', 10);
  // Must bind to 0.0.0.0 for Fly.io — binding to localhost won't be reachable
  await app.listen(port, '0.0.0.0');
  Logger.log(`The Growth Project API running on port ${port}`, 'Bootstrap');
}

bootstrap();
