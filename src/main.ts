import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ThrottlerExceptionFilter } from './filters/throttler-exception.filter';

// Fail fast at boot if a required secret is missing. Prior behavior was to let the
// app start and throw on the first request that needed it — making deploy regressions
// silent until a user hit them. Listed in .env.example.
function assertRequiredEnv() {
  const required = [
    'DATABASE_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'USDA_API_KEY',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    const msg = `Missing required env vars: ${missing.join(', ')}`;
    // Use Logger so the failure shows up consistently in Fly logs.
    new Logger('Bootstrap').error(msg);
    throw new Error(msg);
  }
}

async function bootstrap() {
  assertRequiredEnv();
  const app = await NestFactory.create(AppModule);

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

  // Global exception filter for user-friendly throttle error messages
  app.useGlobalFilters(new ThrottlerExceptionFilter());

  // API prefix
  app.setGlobalPrefix('api');

  const port = parseInt(process.env.PORT || '3000', 10);
  // Must bind to 0.0.0.0 for Fly.io — binding to localhost won't be reachable
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`The Growth Project API running on port ${port}`);
}

bootstrap();
