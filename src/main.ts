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

// Fail fast at boot if a required secret is missing. Prior behavior was to let the
// app start and throw on the first request that needed it — making deploy regressions
// silent until a user hit them. Listed in .env.example.
function assertRequiredEnv() {
  // Hard-required: app cannot function without these — crash fast on boot.
  const hardRequired = [
    'DATABASE_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ];
  // Soft-required: feature-specific keys. Missing them only breaks that
  // feature (food.service guards them at call-time), so warn instead of
  // crashing the whole backend.
  const softRequired = ['USDA_API_KEY'];

  const logger = new Logger('Bootstrap');
  const missingHard = hardRequired.filter((k) => !process.env[k]);
  if (missingHard.length) {
    const msg = `Missing required env vars: ${missingHard.join(', ')}`;
    logger.error(msg);
    throw new Error(msg);
  }
  const missingSoft = softRequired.filter((k) => !process.env[k]);
  if (missingSoft.length) {
    logger.warn(
      `Optional env vars missing (related features will return errors at call time): ${missingSoft.join(', ')}`,
    );
  }
}

async function bootstrap() {
  assertRequiredEnv();
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
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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

  // API prefix — exclude /health so Fly.io liveness probes hit /health, not /api/health
  app.setGlobalPrefix('api', { exclude: ['health'] });

  const port = parseInt(process.env.PORT || '3000', 10);
  // Must bind to 0.0.0.0 for Fly.io — binding to localhost won't be reachable
  await app.listen(port, '0.0.0.0');
  Logger.log(`The Growth Project API running on port ${port}`, 'Bootstrap');
}

bootstrap();
