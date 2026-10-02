/**
 * R2a — /me/ai-consent over real HTTP (Express adapter, the production
 * ValidationPipe options, the production HttpExceptionFilter and
 * CacheControlInterceptor), with the ledger on an in-memory stand-in.
 *
 * Proves the API contract the mobile builder follows: status codes, response
 * bodies, the error envelope (`code` survives the global filter), body
 * whitelisting, subject = authenticated caller, idempotency, no-store caching,
 * the default-OFF 503, and the guard set (no Roman / entitlement guard).
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { PrismaService } from '../../src/prisma.service';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { CacheControlInterceptor } from '../../src/common/cache-control.interceptor';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import {
  AiConsentController,
  AiConsentLedgerGuard,
} from '../../src/ai-consent/ai-consent.controller';
import { RomanFeatureGuard } from '../../src/roman/roman-feature.guard';
import { ClientEntitlementGuard } from '../../src/common/guards/client-entitlement.guard';
import { FakeLedgerPrisma } from './_support/fake-ledger-prisma';

const COPY_SHA = 'fbf821401d4313c6a301a6cc08d3870bb117c293fbb970e321bf87f49abe34f4';
const H_USER = 'x-test-user';
const H_ROLE = 'x-test-role';

/** Stand-in for JwtAuthGuard: the caller is whoever the test header names. */
class HeaderAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const id = req.headers[H_USER];
    if (typeof id !== 'string' || !id) throw new UnauthorizedException();
    req.user = { id, role: req.headers[H_ROLE] ?? 'student' };
    return true;
  }
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

describe('/me/ai-consent HTTP contract (R2a)', () => {
  const OLD_FLAG = process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
  let app: INestApplication;
  let fake: FakeLedgerPrisma;
  let baseUrl: string;

  function call(
    method: string,
    path: string,
    user: string | null,
    body?: unknown,
    role = 'student',
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = {};
      if (user) {
        headers[H_USER] = user;
        headers[H_ROLE] = role;
      }
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload).toString();
      }
      const req = http.request(`${baseUrl}${path}`, { method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data.length ? JSON.parse(data) : null,
          });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  beforeEach(async () => {
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    fake = new FakeLedgerPrisma();
    const fakePrismaModule: DynamicModule = {
      module: class FakePrismaModule {},
      global: true,
      providers: [{ provide: PrismaService, useValue: fake }],
      exports: [PrismaService],
    };
    const moduleRef = await Test.createTestingModule({
      imports: [fakePrismaModule, AiConsentModule],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(HeaderAuthGuard)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new CacheControlInterceptor());
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
    if (OLD_FLAG === undefined) delete process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
    else process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = OLD_FLAG;
  });

  it('guards: JwtAuthGuard + RolesGuard + AiConsentLedgerGuard; no Roman or entitlement guard', () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, AiConsentController) ?? [];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard, AiConsentLedgerGuard]);
    expect(guards).not.toContain(RomanFeatureGuard);
    expect(guards).not.toContain(ClientEntitlementGuard);
    for (const m of ['get', 'grant', 'withdraw'] as const) {
      const own: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, AiConsentController.prototype[m]) ?? [];
      expect(own).toEqual([]);
    }
  });

  it('401 without an authenticated caller', async () => {
    const r = await call('GET', '/me/ai-consent', null);
    expect(r.status).toBe(401);
  });

  it('GET -> 200 status + copy, no-store', async () => {
    const r = await call('GET', '/me/ai-consent', 'u_a');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({
      purpose: 'client_ai_processing',
      processor: 'anthropic',
      granted: false,
      state: 'not_granted',
      version: null,
      granted_at: null,
      withdrawn_at: null,
      current_version: 'client-ai-v4',
      needs_reconsent: false,
      copy: {
        version: 'client-ai-v4',
        processor: 'anthropic',
        sha256: COPY_SHA,
        paragraph: { text: expect.stringContaining('Roman, the assistant in this app') },
        box_label: { text: expect.stringContaining('Optional: I allow Roman') },
      },
    });
  });

  it('POST grant -> 200 granted; repeat is idempotent (one row)', async () => {
    const body = { version: 'client-ai-v4', copy_sha256: COPY_SHA, platform: 'ios', app_version: '1.0.0', locale: 'en-US' };
    const a = await call('POST', '/me/ai-consent/roman', 'u_a', body);
    expect(a.status).toBe(200);
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.body).toMatchObject({ granted: true, state: 'granted', version: 'client-ai-v4' });
    const b = await call('POST', '/me/ai-consent/roman', 'u_a', body);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ granted: true, granted_at: a.body?.granted_at });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].user_id).toBe('u_a');
  });

  it('POST with a stale version -> 409 envelope carrying code CONSENT_VERSION_MISMATCH', async () => {
    const r = await call('POST', '/me/ai-consent/roman', 'u_a', { version: 'client-ai-v2' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ statusCode: 409, code: 'CONSENT_VERSION_MISMATCH' });
    expect(fake.rows).toHaveLength(0);
  });

  it('POST naming the superseded client-ai-v3 (180-day text) -> 409 with the v4 version and sha256 over HTTP', async () => {
    const r = await call('POST', '/me/ai-consent/roman', 'u_a', {
      version: 'client-ai-v3',
      copy_sha256: 'd8738c900ed2bfbb12b7ca6423132a532fc47e2cd0fe52854cc38e34c427840f',
    });
    expect(r.status).toBe(409);
    // The global error envelope carries the stable machine code; the client
    // then re-reads GET for the current (v4) copy, version and sha256.
    expect(r.body).toMatchObject({ statusCode: 409, code: 'CONSENT_VERSION_MISMATCH' });
    expect(fake.rows).toHaveLength(0);
    const g = await call('GET', '/me/ai-consent', 'u_a');
    expect(g.body).toMatchObject({ current_version: 'client-ai-v4', copy: { sha256: COPY_SHA } });
  });

  it('POST with a different copy_sha256 -> 409 CONSENT_VERSION_MISMATCH', async () => {
    const r = await call('POST', '/me/ai-consent/roman', 'u_a', {
      version: 'client-ai-v4',
      copy_sha256: 'c'.repeat(64),
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'CONSENT_VERSION_MISMATCH' });
  });

  it.each([
    ['a foreign user_id (subject is never a body field)', { version: 'client-ai-v4', user_id: 'u_b' }],
    ['a missing version', {}],
    ['a malformed copy_sha256', { version: 'client-ai-v4', copy_sha256: 'xyz' }],
    ['an unknown platform', { version: 'client-ai-v4', platform: 'tv' }],
    ['an over-long locale', { version: 'client-ai-v4', locale: 'en-US-xxxxxxxxxxxxxxxx' }],
  ])('POST with %s -> 400, nothing written', async (_l, body) => {
    const r = await call('POST', '/me/ai-consent/roman', 'u_a', body);
    expect(r.status).toBe(400);
    expect(fake.rows).toHaveLength(0);
  });

  it('DELETE withdraws (200) and is idempotent; history is append-only', async () => {
    await call('POST', '/me/ai-consent/roman', 'u_a', { version: 'client-ai-v4' });
    const a = await call('DELETE', '/me/ai-consent/roman', 'u_a');
    expect(a.status).toBe(200);
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.body).toMatchObject({ granted: false, state: 'withdrawn', version: 'client-ai-v4' });
    const b = await call('DELETE', '/me/ai-consent/roman', 'u_a');
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ state: 'withdrawn', withdrawn_at: a.body?.withdrawn_at });
    expect(fake.rows.map((r) => r.action)).toEqual(['grant', 'withdraw']);
    const g = await call('GET', '/me/ai-consent', 'u_a');
    expect(g.body).toMatchObject({ granted: false, state: 'withdrawn' });
  });

  it('DELETE with no history -> 200 not_granted, nothing written', async () => {
    const r = await call('DELETE', '/me/ai-consent/roman', 'u_a');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'not_granted' });
    expect(fake.rows).toHaveLength(0);
  });

  it("one user's grant never shows as another user's", async () => {
    await call('POST', '/me/ai-consent/roman', 'u_a', { version: 'client-ai-v4' });
    const b = await call('GET', '/me/ai-consent', 'u_b');
    expect(b.body).toMatchObject({ granted: false, state: 'not_granted' });
  });

  it.each(['student', 'coach', 'owner'])('role %s may read and write its own record', async (role) => {
    expect((await call('GET', '/me/ai-consent', 'u_r', undefined, role)).status).toBe(200);
    expect(
      (await call('POST', '/me/ai-consent/roman', 'u_r', { version: 'client-ai-v4' }, role)).status,
    ).toBe(200);
  });

  // Sol B-622-3: optional means omitted. A null digest (or any null optional
  // field) is a malformed request -> 400, never an internal error.
  it.each(['copy_sha256', 'platform', 'app_version', 'locale'])(
    'POST with %s: null -> 400, nothing written',
    async (field) => {
      const r = await call('POST', '/me/ai-consent/roman', 'u_a', {
        version: 'client-ai-v4',
        [field]: null,
      });
      expect(r.status).toBe(400);
      expect(fake.rows).toHaveLength(0);
    },
  );

  it('POST with an uppercase matching digest still succeeds (only null changed)', async () => {
    const r = await call('POST', '/me/ai-consent/roman', 'u_a', {
      version: 'client-ai-v4',
      copy_sha256: COPY_SHA.toUpperCase(),
    });
    expect(r.status).toBe(200);
    expect(fake.rows).toHaveLength(1);
  });

  // Sol B-622-2: a ledger read failure is the contract's 503, over the wire.
  it.each([
    ['GET', '/me/ai-consent', undefined],
    ['POST', '/me/ai-consent/roman', { version: 'client-ai-v4' }],
    ['DELETE', '/me/ai-consent/roman', undefined],
  ])('%s %s: a ledger read failure -> 503 AI_CONSENT_UNAVAILABLE', async (method, path, body) => {
    fake.failNext = { method: 'findFirst', times: 1, error: new Error('READ_CANARY') };
    const r = await call(method, path, 'u_a', body);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ statusCode: 503, code: 'AI_CONSENT_UNAVAILABLE' });
    expect(JSON.stringify(r.body)).not.toContain('READ_CANARY');
    expect(fake.rows).toHaveLength(0);
  });

  describe('flag off (default)', () => {
    it.each([
      ['GET', '/me/ai-consent', undefined],
      ['POST', '/me/ai-consent/roman', { version: 'client-ai-v4' }],
      ['POST', '/me/ai-consent/roman', { bogus: true }],
      ['DELETE', '/me/ai-consent/roman', undefined],
    ])('%s %s -> 503 AI_CONSENT_UNAVAILABLE (before body validation)', async (method, path, body) => {
      delete process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
      const r = await call(method, path, 'u_a', body);
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ statusCode: 503, code: 'AI_CONSENT_UNAVAILABLE' });
      expect(fake.calls.create + fake.calls.findFirst).toBe(0);
    });
  });
});
