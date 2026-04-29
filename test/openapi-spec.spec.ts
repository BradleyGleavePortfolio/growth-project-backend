import { Test } from '@nestjs/testing';
import {
  buildOpenApiDocument,
  isApiDocsEnabled,
} from '../src/common/openapi';
import { AppModule } from '../src/app.module';

// Smoke test for the OpenAPI surface exposed at /docs-json. We don't boot
// the full HTTP listener — instead we resolve the same document that
// SwaggerModule would serve (`buildOpenApiDocument(app)`) and assert the
// invariants partner integrations rely on:
//
//   1. `openapi: '3.1.0'` (we explicitly bump from the 3.0 default)
//   2. The auth controller's surface is present and tagged
//   3. BearerAuth security scheme is published
//
// Anything that breaks these is a contract change visible to SDK
// generators downstream and should be a deliberate, reviewed edit.

describe('OpenAPI document', () => {
  jest.setTimeout(20000);

  let document: any;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    document = buildOpenApiDocument(app);
    await app.close();
  });

  it('declares OpenAPI 3.1', () => {
    expect(document.openapi).toBe('3.1.0');
  });

  it('publishes the expected metadata', () => {
    expect(document.info?.title).toBe('Growth Project API');
    expect(document.info?.version).toBeDefined();
    expect(document.servers?.map((s: any) => s.url)).toEqual(
      expect.arrayContaining(['https://api.trygrowthproject.com']),
    );
  });

  it('publishes the bearer security scheme', () => {
    const schemes = document.components?.securitySchemes ?? {};
    expect(schemes.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes the documented auth paths', () => {
    const paths = Object.keys(document.paths || {});
    // /api prefix is applied via setGlobalPrefix() at runtime, NOT in the
    // OpenAPI document itself, so paths are recorded as bare /auth/...
    for (const expected of [
      '/auth/login',
      '/auth/register',
      '/auth/forgot-password',
      '/auth/me',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it('tags auth and users operations', () => {
    const login = document.paths['/auth/login']?.post;
    expect(login?.tags).toEqual(expect.arrayContaining(['auth']));
    const me = document.paths['/users/me/preferences']?.get;
    expect(me?.tags).toEqual(expect.arrayContaining(['users']));
  });

  it('has @ApiOperation summary on the documented auth endpoints', () => {
    expect(document.paths['/auth/login'].post.summary).toBeTruthy();
    expect(document.paths['/auth/register'].post.summary).toBeTruthy();
    expect(document.paths['/auth/forgot-password'].post.summary).toBeTruthy();
  });
});

describe('isApiDocsEnabled', () => {
  it('is enabled in non-production by default', () => {
    expect(isApiDocsEnabled({ NODE_ENV: 'development' } as any)).toBe(true);
    expect(isApiDocsEnabled({ NODE_ENV: 'test' } as any)).toBe(true);
    expect(isApiDocsEnabled({} as any)).toBe(true);
  });

  it('is gated off in production unless ENABLE_API_DOCS=true', () => {
    expect(isApiDocsEnabled({ NODE_ENV: 'production' } as any)).toBe(false);
    expect(
      isApiDocsEnabled({
        NODE_ENV: 'production',
        ENABLE_API_DOCS: 'true',
      } as any),
    ).toBe(true);
    // Any other value (including 'false') keeps it disabled.
    expect(
      isApiDocsEnabled({
        NODE_ENV: 'production',
        ENABLE_API_DOCS: 'false',
      } as any),
    ).toBe(false);
    expect(
      isApiDocsEnabled({
        NODE_ENV: 'production',
        ENABLE_API_DOCS: '1',
      } as any),
    ).toBe(false);
  });
});
