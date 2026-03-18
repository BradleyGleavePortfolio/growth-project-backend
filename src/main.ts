import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ThrottlerExceptionFilter } from './filters/throttler-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS is open for React Native mobile clients — no browser CORS risk
  app.enableCors({
    origin: '*',
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
  console.log(`The Growth Project API running on port ${port}`);
}

bootstrap();
