import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json') as { version: string };

// Spec is gated: enabled in any non-production NODE_ENV, OR opt-in in
// production via ENABLE_API_DOCS=true. Production stays opt-in because the
// schema enumerates internal admin/coach surfaces that we'd rather not
// publish by default.
export function isApiDocsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ENABLE_API_DOCS === 'true') return true;
  return env.NODE_ENV !== 'production';
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Growth Project API')
    .setDescription(
      'HTTP API for The Growth Project — coach/client SaaS platform covering ' +
        'auth, billing, messaging, check-ins, meal plans, workouts, habits, ' +
        'and admin/federation surfaces. Consumed by the React Native mobile ' +
        'app, the coach console BFF, and partner integrations.',
    )
    .setVersion(pkg.version)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Supabase-issued JWT. Send as `Authorization: Bearer <token>`. ' +
          'Tokens are verified against the Supabase JWKS in JwtAuthGuard.',
      },
      'bearer',
    )
    .addServer('https://api.trygrowthproject.com', 'Production')
    .addServer(`http://localhost:${process.env.PORT || '3000'}`, 'Local development')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  // @nestjs/swagger emits OpenAPI 3.0; bump the version field so SDK
  // generators that key on `openapi: '3.1.0'` accept the spec. The shape
  // emitted is a strict subset of 3.1, so no other fields need patching.
  document.openapi = '3.1.0';
  return document;
}

export function setupSwagger(app: INestApplication): void {
  if (!isApiDocsEnabled()) {
    return;
  }
  const document = buildOpenApiDocument(app);
  // /docs serves Swagger UI; /docs-json serves the raw spec. Both are
  // mounted OUTSIDE the global /api prefix because SwaggerModule.setup
  // registers absolute paths.
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { persistAuthorization: true },
  });
  Logger.log('Swagger UI available at /docs (JSON: /docs-json)', 'Bootstrap');
}
