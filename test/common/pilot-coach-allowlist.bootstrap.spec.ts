/**
 * S12-B1 pilot-coach allowlist — bootstrap-level proof over real HTTP.
 *
 * Boots a REAL Nest app (NestFactory.create) with the production global guard
 * chain in app.module.ts order — JwtAuthGuard, PilotCoachAllowlistGuard,
 * UserThrottlerGuard, RolesGuard — the R-DARK-1 middleware registered exactly
 * as main.ts does (raw express middleware, before enableCors),
 * RequestIdMiddleware, CORS and HttpExceptionFilter. Stub controllers mount
 * every gated importer route (15) + the public `redeem` + one ungated route.
 *
 * Proves, per route: flag-off ⇒ 404 for everyone; flags on + list
 * absent/empty/malformed ⇒ 404 for every authenticated caller (fail closed);
 * flags on + list ⇒ on-list 2xx, off-list uniform 404 (never 403), anon 401;
 * case-variant URLs behave identically. Proves the off-list 404 is
 * indistinguishable (body bar timestamp, header key set, content-length,
 * CORS echo) from BOTH the flag-off 404 and a genuinely unmounted 404.
 * Round-2 (review B1): flag-off case-variant URLs are dark PRE-AUTH for
 * anonymous callers, malformed bearers and CORS preflights.
 *
 * Statically pins the stub inventory against the real controllers and the
 * guard order in app.module.ts.
 *
 * Requests use node:http against a real listening socket (repo pattern —
 * see feature-flag-not-found.bootstrap.spec.ts).
 */
import 'reflect-metadata';
import * as http from 'http';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { Controller, Get, INestApplication, Module, Post } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { JwksVerifierService } from '../../src/auth/jwks.service';
import { RolesGuard } from '../../src/auth/roles.guard';
import { UserThrottlerGuard } from '../../src/throttler/user-throttler.guard';
import { PilotCoachAllowlistGuard } from '../../src/common/feature-flag/pilot-coach-allowlist.guard';
import { PILOT_COACH_ALLOWLIST_ENV } from '../../src/common/feature-flag/pilot-coach-allowlist';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { featureFlagNotFoundMiddleware } from '../../src/common/feature-flag/feature-flag-not-found.middleware';
import { RequestIdMiddleware } from '../../src/observability/request-id.middleware';
import { computeCorsAllowedOrigins } from '../../src/common/cors-origins';
import { Roles } from '../../src/common/decorators/roles.decorator';
import { Public } from '../../src/common/decorators/public.decorator';
import { PrismaService } from '../../src/prisma.service';
import { PtmService } from '../../src/ptm/ptm.service';

const ALLOWED_ORIGIN = 'https://console.example.test';
const REPO_ROOT = join(__dirname, '..', '..');

const PILOT = '5f3c9a1e-8b2d-4c7a-9e6f-1a2b3c4d5e6f';
const OTHER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const STUDENT = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OWNER = 'deadbeef-cafe-4bad-8f00-0123456789ab';

const FLAGS = ['FEATURE_SCOUT_INGEST', 'FEATURE_SCOUT_RECONSTRUCT', 'FEATURE_EXTENSION_PAIRING'];

// ─── Real-guard dependency stubs (the GUARDS are real; their I/O is not) ────
const USERS: Record<string, { id: string; role: string }> = {
  'supa-pilot': { id: PILOT, role: 'coach' },
  'supa-other': { id: OTHER, role: 'coach' },
  'supa-student': { id: STUDENT, role: 'student' },
  'supa-owner': { id: OWNER, role: 'owner' },
};
const TOKEN_TO_SUB: Record<string, string> = {
  'pilot-token': 'supa-pilot',
  'other-token': 'supa-other',
  'student-token': 'supa-student',
  'owner-token': 'supa-owner',
};
const jwksStub = {
  verify: async (token: string) => {
    const sub = TOKEN_TO_SUB[token];
    if (!sub) throw new Error('unrecognised test token');
    return { sub };
  },
};
const prismaStub = {
  user: {
    findUnique: async ({ where }: { where: { supabase_id: string } }) => {
      const u = USERS[where.supabase_id];
      return u ? { ...u, deleted_at: null, deletion_scheduled_at: null } : null;
    },
  },
};
const ptmStub = { emit: jest.fn() };

// ─── Stub controllers: every real importer route, same @Roles/@Public ────────
@Controller('scout')
class ScoutStubController {
  @Roles('coach', 'owner')
  @Post('progress')
  progress() {
    return { ok: true };
  }

  @Roles('coach')
  @Post('ingest')
  ingest() {
    return { ok: true };
  }

  @Roles('coach', 'owner')
  @Post('ingest/complete')
  ingestComplete() {
    return { ok: true };
  }

  @Roles('coach', 'owner')
  @Get('import/status')
  importStatus() {
    return { ok: true };
  }

  @Roles('coach', 'owner')
  @Post('runs/start')
  runsStart() {
    return { ok: true };
  }

  @Roles('coach', 'owner')
  @Post('runs/cancel')
  runsCancel() {
    return { ok: true };
  }

  @Roles('coach', 'owner')
  @Post('runs/declaration')
  runsDeclaration() {
    return { ok: true };
  }

  @Roles('coach', 'owner')
  @Post('runs/observation')
  runsObservation() {
    return { ok: true };
  }

  @Roles('coach')
  @Post('reconstruct')
  reconstruct() {
    return { ok: true };
  }

  @Roles('coach')
  @Get('reconstruct/roster')
  reconstructRoster() {
    return { ok: true };
  }

  @Roles('coach')
  @Get('reconstruct/entities')
  reconstructEntities() {
    return { ok: true };
  }
}

@Controller('extension/pair')
class ExtensionPairStubController {
  @Roles('coach', 'owner')
  @Post('init')
  init() {
    return { ok: true };
  }

  @Roles('coach', 'owner')
  @Post('status')
  status() {
    return { ok: true };
  }

  @Roles('coach', 'owner')
  @Post('session')
  session() {
    return { ok: true };
  }

  @Roles('coach', 'owner')
  @Post('current')
  current() {
    return { ok: true };
  }

  @Public()
  @Post('redeem')
  redeem() {
    return { ok: true };
  }
}

@Controller('me')
class UngatedStubController {
  @Get('feature-flags')
  flags() {
    return { ok: true };
  }
}

@Module({
  // Generous single default throttler: the REAL UserThrottlerGuard class runs
  // on every request; the production limit TABLE is config, not guard logic.
  imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100_000 }] })],
  controllers: [ScoutStubController, ExtensionPairStubController, UngatedStubController],
  providers: [
    { provide: PrismaService, useValue: prismaStub },
    { provide: JwksVerifierService, useValue: jwksStub },
    { provide: PtmService, useValue: ptmStub },
    // Same registration order as app.module.ts (pinned statically below).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PilotCoachAllowlistGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class PilotGateTestModule {}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function request(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed: any = null;
          try {
            parsed = data.length ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Boots the test app wired exactly like main.ts (gate BEFORE enableCors). */
async function bootApp(): Promise<{ app: INestApplication; baseUrl: string }> {
  const app = await NestFactory.create(PilotGateTestModule, { logger: false });
  app.setGlobalPrefix('api');
  app.use(featureFlagNotFoundMiddleware);
  const rid = new RequestIdMiddleware();
  app.use(rid.use.bind(rid));
  const corsOrigins = computeCorsAllowedOrigins();
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Recent-Auth-Token'],
    credentials: true,
  });
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(0);
  const addr = app.getHttpServer().address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

interface GatedRoute {
  method: 'GET' | 'POST';
  path: string;
}

/** Every mounted, non-public importer route (verified against the real
 * controllers by the static inventory test at the bottom). */
const GATED_ROUTES: readonly GatedRoute[] = [
  { method: 'POST', path: '/api/scout/progress' },
  { method: 'POST', path: '/api/scout/ingest' },
  { method: 'POST', path: '/api/scout/ingest/complete' },
  { method: 'GET', path: '/api/scout/import/status' },
  { method: 'POST', path: '/api/scout/runs/start' },
  { method: 'POST', path: '/api/scout/runs/cancel' },
  { method: 'POST', path: '/api/scout/runs/declaration' },
  { method: 'POST', path: '/api/scout/runs/observation' },
  { method: 'POST', path: '/api/scout/reconstruct' },
  { method: 'GET', path: '/api/scout/reconstruct/roster' },
  { method: 'GET', path: '/api/scout/reconstruct/entities' },
  { method: 'POST', path: '/api/extension/pair/init' },
  { method: 'POST', path: '/api/extension/pair/status' },
  { method: 'POST', path: '/api/extension/pair/session' },
  { method: 'POST', path: '/api/extension/pair/current' },
];
const PUBLIC_REDEEM: GatedRoute = { method: 'POST', path: '/api/extension/pair/redeem' };

const AUTH = {
  none: {},
  pilot: { authorization: 'Bearer pilot-token' },
  other: { authorization: 'Bearer other-token' },
  student: { authorization: 'Bearer student-token' },
  owner: { authorization: 'Bearer owner-token' },
} as const;

function lightAllFlags(): void {
  for (const flag of FLAGS) process.env[flag] = 'true';
}
function darkAllFlags(): void {
  for (const flag of FLAGS) delete process.env[flag];
}
function setList(value: string | undefined): void {
  if (value === undefined) delete process.env[PILOT_COACH_ALLOWLIST_ENV];
  else process.env[PILOT_COACH_ALLOWLIST_ENV] = value;
}

/** Upper-cases the first path segment after `/api` and the last one — a
 * spelling express still routes to the same handler. */
function caseVariant(path: string): string {
  const parts = path.split('/');
  // parts[0] === '' , parts[1] === 'api'
  if (parts.length > 2) parts[2] = parts[2].toUpperCase();
  parts[parts.length - 1] = parts[parts.length - 1].toUpperCase();
  return parts.join('/');
}

const expect404Uniform = (res: HttpResult, method: string, path: string) => {
  expect(res.status).toBe(404);
  expect(res.body.statusCode).toBe(404);
  expect(res.body.error).toBe('Not Found');
  expect(res.body.message).toBe(`Cannot ${method} ${path}`);
  expect(Object.keys(res.body).sort()).toEqual([
    'error',
    'message',
    'path',
    'request_id',
    'statusCode',
    'timestamp',
  ]);
  // The guard runs before the throttler: no rate-limit fingerprint on a 404.
  expect(Object.keys(res.headers).some((h) => h.startsWith('x-ratelimit'))).toBe(false);
};

const headerKeys = (res: HttpResult) =>
  Object.keys(res.headers)
    .filter((k) => k !== 'date')
    .sort();
const bodyBarTimestamp = (res: HttpResult) => {
  const { timestamp, ...rest } = res.body;
  expect(typeof timestamp).toBe('string');
  return rest;
};

describe('S12-B1 pilot-coach allowlist over HTTP (real guard chain)', () => {
  const originalEnv = { ...process.env };
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CORS_ORIGINS = ALLOWED_ORIGIN;
    delete process.env.STOREFRONT_BASE_URL;
    ({ app, baseUrl } = await bootApp());
  });

  afterAll(async () => {
    if (app) await app.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => {
    darkAllFlags();
    setList(undefined);
  });

  describe.each(GATED_ROUTES)('$method $path', ({ method, path }) => {
    it('flags OFF ⇒ 404 for pilot, other, owner and anonymous even with the list set', async () => {
      setList(PILOT);
      for (const who of ['pilot', 'other', 'owner', 'none'] as const) {
        const res = await request(baseUrl, method, path, AUTH[who]);
        expect404Uniform(res, method, path);
      }
    });

    it('flags ON + list UNSET ⇒ 404 for every authenticated caller (fail closed)', async () => {
      lightAllFlags();
      for (const who of ['pilot', 'other', 'student', 'owner'] as const) {
        const res = await request(baseUrl, method, path, AUTH[who]);
        expect404Uniform(res, method, path);
      }
    });

    it.each(['', '  ', ',,'])('flags ON + list %p (empty form) ⇒ 404 for the pilot', async (v) => {
      lightAllFlags();
      setList(v);
      expect404Uniform(await request(baseUrl, method, path, AUTH.pilot), method, path);
    });

    it.each([`${PILOT},*`, 'true', '*', `${PILOT};${OTHER}`, 'pilot', `${PILOT}, ${OTHER}x`])(
      'flags ON + malformed list %p ⇒ 404 even for the pilot named beside the junk',
      async (v) => {
        lightAllFlags();
        setList(v);
        expect404Uniform(await request(baseUrl, method, path, AUTH.pilot), method, path);
        expect404Uniform(await request(baseUrl, method, path, AUTH.owner), method, path);
      },
    );

    it('flags ON + list = pilot ⇒ pilot 2xx; other coach / student / owner uniform 404; anon 401', async () => {
      lightAllFlags();
      setList(PILOT);
      const ok = await request(baseUrl, method, path, AUTH.pilot);
      expect([200, 201]).toContain(ok.status);
      expect(ok.body).toEqual({ ok: true });
      for (const who of ['other', 'student', 'owner'] as const) {
        expect404Uniform(await request(baseUrl, method, path, AUTH[who]), method, path);
      }
      const anon = await request(baseUrl, method, path, AUTH.none);
      expect(anon.status).toBe(401);
    });

    it('padded, upper-cased two-id list admits both coaches', async () => {
      lightAllFlags();
      setList(`  ${OTHER.toUpperCase()} , ${PILOT.toUpperCase()} `);
      expect([200, 201]).toContain((await request(baseUrl, method, path, AUTH.pilot)).status);
      expect([200, 201]).toContain((await request(baseUrl, method, path, AUTH.other)).status);
    });

    it('case-variant URL: flags ON ⇒ off-list 404 / on-list 2xx; flags OFF ⇒ 404 for the pilot', async () => {
      const variant = caseVariant(path);
      lightAllFlags();
      setList(PILOT);
      expect404Uniform(await request(baseUrl, method, variant, AUTH.other), method, variant);
      expect([200, 201]).toContain((await request(baseUrl, method, variant, AUTH.pilot)).status);
      darkAllFlags();
      expect404Uniform(await request(baseUrl, method, variant, AUTH.pilot), method, variant);
      expect404Uniform(await request(baseUrl, method, variant, AUTH.none), method, variant);
    });
  });

  it('layered reconstruct: INGEST on, RECONSTRUCT off ⇒ reconstruct routes 404 for the pilot, ingest 2xx', async () => {
    lightAllFlags();
    process.env.FEATURE_SCOUT_RECONSTRUCT = 'false';
    setList(PILOT);
    for (const r of GATED_ROUTES.filter((g) => g.path.includes('/reconstruct'))) {
      expect404Uniform(await request(baseUrl, r.method, r.path, AUTH.pilot), r.method, r.path);
    }
    expect((await request(baseUrl, 'POST', '/api/scout/ingest', AUTH.pilot)).status).toBe(201);
  });

  it('off-list 404 ≡ flag-off 404 ≡ unmounted 404 (body bar timestamp, header key set, CORS echo)', async () => {
    const fixed = { 'x-request-id': 'edge-trace-s12b1', origin: ALLOWED_ORIGIN };
    // Same-length URL outside the mounted route set but under a lit prefix.
    const unmountedPath = '/api/scout/ingesx';

    lightAllFlags();
    setList(PILOT);
    const offList = await request(baseUrl, 'POST', '/api/scout/ingest', {
      ...AUTH.other,
      ...fixed,
    });
    const unmounted = await request(baseUrl, 'POST', unmountedPath, { ...AUTH.other, ...fixed });
    darkAllFlags();
    const flagOff = await request(baseUrl, 'POST', '/api/scout/ingest', {
      ...AUTH.other,
      ...fixed,
    });

    expect404Uniform(offList, 'POST', '/api/scout/ingest');
    expect404Uniform(flagOff, 'POST', '/api/scout/ingest');
    expect404Uniform(unmounted, 'POST', unmountedPath);

    expect(bodyBarTimestamp(offList)).toEqual(bodyBarTimestamp(flagOff));
    expect(bodyBarTimestamp(offList)).toEqual({
      ...bodyBarTimestamp(unmounted),
      message: 'Cannot POST /api/scout/ingest',
      path: '/api/scout/ingest',
    });
    expect(headerKeys(offList)).toEqual(headerKeys(flagOff));
    expect(headerKeys(offList)).toEqual(headerKeys(unmounted));
    for (const h of [
      'content-type',
      'content-length',
      'x-request-id',
      'vary',
      'access-control-allow-origin',
      'access-control-allow-credentials',
    ]) {
      expect(offList.headers[h]).toEqual(flagOff.headers[h]);
      expect(offList.headers[h]).toEqual(unmounted.headers[h]);
    }
    expect(offList.headers['x-request-id']).toBe('edge-trace-s12b1');
    expect(offList.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('a student ON the list still gets 403 from RolesGuard on a coach-only route (list is not a role bypass)', async () => {
    lightAllFlags();
    setList(`${PILOT},${STUDENT}`);
    const res = await request(baseUrl, 'POST', '/api/scout/ingest', AUTH.student);
    expect(res.status).toBe(403);
  });

  it('an owner ON the list is admitted (owner is subject to the list, not exempt from it)', async () => {
    lightAllFlags();
    setList(OWNER);
    expect((await request(baseUrl, 'POST', '/api/scout/ingest', AUTH.owner)).status).toBe(201);
    expect404Uniform(
      await request(baseUrl, 'POST', '/api/scout/ingest', AUTH.pilot),
      'POST',
      '/api/scout/ingest',
    );
  });

  it('public redeem: reachable with the flag on regardless of the list; 404 with the flag off', async () => {
    lightAllFlags();
    setList(undefined);
    expect((await request(baseUrl, 'POST', PUBLIC_REDEEM.path, AUTH.none)).status).toBe(201);
    setList(PILOT);
    expect((await request(baseUrl, 'POST', PUBLIC_REDEEM.path, AUTH.none)).status).toBe(201);
    darkAllFlags();
    expect404Uniform(
      await request(baseUrl, 'POST', PUBLIC_REDEEM.path, AUTH.none),
      'POST',
      PUBLIC_REDEEM.path,
    );
    const variant = '/API/extension/pair/REDEEM';
    expect404Uniform(await request(baseUrl, 'POST', variant, AUTH.none), 'POST', variant);
  });

  it('ungated route is untouched for every caller and every list/flag state', async () => {
    for (const listValue of [undefined, '', '*', PILOT, OTHER]) {
      setList(listValue);
      for (const who of ['pilot', 'other', 'student', 'owner'] as const) {
        const res = await request(baseUrl, 'GET', '/api/me/feature-flags', AUTH[who]);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
      }
      expect((await request(baseUrl, 'GET', '/api/me/feature-flags', AUTH.none)).status).toBe(401);
      expect((await request(baseUrl, 'GET', '/API/me/feature-flags', AUTH.none)).status).toBe(401);
    }
  });

  it('list edits are honoured on the next request without a restart', async () => {
    lightAllFlags();
    setList(OTHER);
    expect404Uniform(
      await request(baseUrl, 'POST', '/api/scout/ingest', AUTH.pilot),
      'POST',
      '/api/scout/ingest',
    );
    setList(PILOT);
    expect((await request(baseUrl, 'POST', '/api/scout/ingest', AUTH.pilot)).status).toBe(201);
    setList(`${PILOT},junk`);
    expect404Uniform(
      await request(baseUrl, 'POST', '/api/scout/ingest', AUTH.pilot),
      'POST',
      '/api/scout/ingest',
    );
    setList(PILOT);
    expect((await request(baseUrl, 'POST', '/api/scout/ingest', AUTH.pilot)).status).toBe(201);
  });

  // ─── Round 2 (review B1): case-variant URLs are dark PRE-AUTH ─────────────
  const CASE_VARIANTS = [
    {
      flag: 'FEATURE_SCOUT_INGEST',
      method: 'POST',
      canonical: '/api/scout/ingest',
      variant: '/API/scout/ingest',
      // Equal-length, outside EVERY gated prefix: Nest's own router 404.
      unmounted: '/API/scoux/ingest',
    },
    {
      flag: 'FEATURE_SCOUT_RECONSTRUCT',
      method: 'POST',
      canonical: '/api/scout/reconstruct',
      variant: '/api/SCOUT/Reconstruct',
      unmounted: '/api/SCOUX/Reconstruct',
    },
    {
      flag: 'FEATURE_SCOUT_RECONSTRUCT',
      method: 'GET',
      canonical: '/api/scout/reconstruct/roster',
      variant: '/API/scout/reconstruct/ROSTER',
      unmounted: '/API/scoux/reconstruct/ROSTER',
    },
    {
      flag: 'FEATURE_EXTENSION_PAIRING',
      method: 'POST',
      canonical: '/api/extension/pair/init',
      variant: '/api/Extension/PAIR/init',
      unmounted: '/api/Extensiox/PAIR/init',
    },
  ] as const;

  const preflight = (path: string, method: string) =>
    request(baseUrl, 'OPTIONS', path, {
      origin: ALLOWED_ORIGIN,
      'access-control-request-method': method,
      'x-request-id': 'edge-trace-preflight',
    });

  describe.each(CASE_VARIANTS)(
    'round 2 — $flag off, $method $variant is dark pre-auth',
    ({ flag, method, canonical, variant, unmounted }) => {
      const darkOnly = () => {
        lightAllFlags();
        process.env[flag] = 'false';
        setList(PILOT);
      };

      it('anonymous ⇒ uniform 404 identical to an equal-length unmounted 404 outside every gated prefix', async () => {
        darkOnly();
        const fixed = { 'x-request-id': 'edge-trace-variant', origin: ALLOWED_ORIGIN };
        const dark = await request(baseUrl, method, variant, fixed);
        const ref = await request(baseUrl, method, unmounted, fixed);
        expect404Uniform(dark, method, variant);
        expect404Uniform(ref, method, unmounted);
        expect(bodyBarTimestamp(dark)).toEqual({
          ...bodyBarTimestamp(ref),
          message: `Cannot ${method} ${variant}`,
          path: variant,
        });
        expect(headerKeys(dark)).toEqual(headerKeys(ref));
        for (const h of [
          'content-type',
          'content-length',
          'x-request-id',
          'vary',
          'access-control-allow-origin',
          'access-control-allow-credentials',
        ]) {
          expect(dark.headers[h]).toEqual(ref.headers[h]);
        }
        expect(dark.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      });

      it.each(['Bearer not-a-real-token', 'Bearer ', 'Basic abc'])(
        'malformed bearer %p ⇒ 404, never 401',
        async (authorization) => {
          darkOnly();
          expect404Uniform(
            await request(baseUrl, method, variant, { authorization }),
            method,
            variant,
          );
        },
      );

      it('on-list and off-list coaches ⇒ 404 on the variant spelling', async () => {
        darkOnly();
        expect404Uniform(await request(baseUrl, method, variant, AUTH.pilot), method, variant);
        expect404Uniform(await request(baseUrl, method, variant, AUTH.other), method, variant);
      });

      it('OPTIONS preflight ⇒ 404 with CORS echo, never 204; same shape as the canonical dark preflight', async () => {
        darkOnly();
        const dark = await preflight(variant, method);
        const ref = await preflight(canonical, method);
        expect(dark.status).toBe(404);
        expect(ref.status).toBe(404);
        expect(dark.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
        expect(dark.body.message).toBe(`Cannot OPTIONS ${variant}`);
        expect(Object.keys(dark.body).sort()).toEqual(Object.keys(ref.body).sort());
        expect(dark.body.statusCode).toBe(ref.body.statusCode);
        expect(dark.body.error).toBe(ref.body.error);
        expect(dark.body.request_id).toBe(ref.body.request_id);
        expect(dark.body.message.toLowerCase()).toBe(ref.body.message.toLowerCase());
        expect(headerKeys(dark)).toEqual(headerKeys(ref));
        expect(dark.headers['content-length']).toBe(ref.headers['content-length']);
      });

      it('flag ON ⇒ anon 401, preflight 204 with origin echo, pilot 2xx, other coach 404 (allowlist unchanged)', async () => {
        lightAllFlags();
        setList(PILOT);
        expect((await request(baseUrl, method, variant, AUTH.none)).status).toBe(401);
        const pre = await preflight(variant, method);
        expect(pre.status).toBe(204);
        expect(pre.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
        expect([200, 201]).toContain((await request(baseUrl, method, variant, AUTH.pilot)).status);
        expect404Uniform(await request(baseUrl, method, variant, AUTH.other), method, variant);
      });
    },
  );

  it('round 2 — public redeem on a case-variant URL: 404 pre-auth (POST and OPTIONS) with the flag off, 201 once on', async () => {
    lightAllFlags();
    process.env.FEATURE_EXTENSION_PAIRING = 'false';
    const variant = '/API/extension/pair/REDEEM';
    expect404Uniform(await request(baseUrl, 'POST', variant, AUTH.none), 'POST', variant);
    const pre = await preflight(variant, 'POST');
    expect(pre.status).toBe(404);
    expect(pre.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    process.env.FEATURE_EXTENSION_PAIRING = 'true';
    expect((await request(baseUrl, 'POST', variant, AUTH.none)).status).toBe(201);
  });

  it('round 2 — the fold does not widen the gate: /API/scouting is an ordinary 404, the ungated route still 401s', async () => {
    darkAllFlags();
    const sibling = await request(baseUrl, 'POST', '/API/scouting', AUTH.none);
    expect(sibling.status).toBe(404);
    // Ordinary unmounted 404 (Nest router), not the middleware: a lit-prefix
    // preflight on it is answered 204 by the cors package like any other
    // unmounted path in the app.
    expect((await preflight('/API/scouting', 'POST')).status).toBe(204);
    expect((await request(baseUrl, 'GET', '/API/me/feature-flags', AUTH.none)).status).toBe(401);
  });
});

// ─── Static pins ────────────────────────────────────────────────────────────
interface RouteRow {
  method: string;
  path: string;
  isPublic: boolean;
}

function listControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...listControllerFiles(full));
    } else if (entry.endsWith('.controller.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Parses `@Controller('x')` + `@Get/Post/...('y')` decorators from source
 * and notes whether `@Public()` sits among the handler's decorators. */
function realImporterRoutes(): RouteRow[] {
  const files = [
    ...listControllerFiles(join(REPO_ROOT, 'src', 'scout')),
    ...listControllerFiles(join(REPO_ROOT, 'src', 'extension-pair')),
  ];
  const rows: RouteRow[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const ctrl = /^@Controller\(\s*'([^']*)'\s*\)/m.exec(src);
    if (!ctrl) continue;
    const base = ctrl[1].replace(/^\/+|\/+$/g, '');
    const methodRe = /^\s*@(Get|Post|Put|Patch|Delete)\(\s*'([^']*)'\s*\)/gm;
    let match: RegExpExecArray | null;
    let cursor = ctrl.index;
    while ((match = methodRe.exec(src)) !== null) {
      const decoratorBlock = src.slice(cursor, match.index);
      cursor = match.index + match[0].length;
      const sub = match[2].replace(/^\/+|\/+$/g, '');
      rows.push({
        method: match[1].toUpperCase(),
        path: `/api/${base}${sub ? `/${sub}` : ''}`,
        isPublic: /^\s*@Public\(\)/m.test(decoratorBlock),
      });
    }
  }
  return rows.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

describe('S12-B1 static pins', () => {
  it('stub inventory == real scout + extension-pair controllers (15 gated + exactly one public = redeem)', () => {
    const real = realImporterRoutes();
    expect(real.filter((r) => r.isPublic).map((r) => `${r.method} ${r.path}`)).toEqual([
      `${PUBLIC_REDEEM.method} ${PUBLIC_REDEEM.path}`,
    ]);
    const realGated = real
      .filter((r) => !r.isPublic)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const stubGated = GATED_ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(realGated).toEqual(stubGated);
    expect(realGated).toHaveLength(15);
    expect(real).toHaveLength(16);
  });

  it('app.module.ts registers Jwt → PilotCoachAllowlist → Throttler → Roles with nothing between Jwt and Pilot', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'app.module.ts'), 'utf8');
    const guardOrder = Array.from(
      src.matchAll(/\{\s*provide:\s*APP_GUARD,\s*useClass:\s*(\w+)\s*\}/g),
      (m) => m[1],
    );
    expect(guardOrder).toEqual([
      'JwtAuthGuard',
      'PilotCoachAllowlistGuard',
      'UserThrottlerGuard',
      'RolesGuard',
      'DunningLockoutGuard',
    ]);
    expect(src).toContain(
      "import { PilotCoachAllowlistGuard } from './common/feature-flag/pilot-coach-allowlist.guard';",
    );
  });

  it('the allowlist variable is registered (.env.example empty default, prod-switches.yml never auto-flipped)', () => {
    const env = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
    expect(env).toMatch(/^FEATURE_SCOUT_PILOT_COACH_IDS=$/m);
    const switches = readFileSync(join(REPO_ROOT, 'prod-switches.yml'), 'utf8');
    const row = /- name: FEATURE_SCOUT_PILOT_COACH_IDS\n([\s\S]*?)(?=\n {2}- name:|\n*$)/.exec(
      switches,
    );
    expect(row).not.toBeNull();
    expect(row?.[1]).toContain('auto_flip_on_in_prod: false');
    expect(row?.[1]).toContain('tier: feature');
  });
});
