/**
 * R-DARK-1 bootstrap-level 6-probe suite (round-2 fix #3).
 *
 * The sibling feature-flag-not-found.spec.ts unit-tests the middleware
 * function in isolation — it would still pass if the app.use() wiring were
 * deleted from main.ts. This suite closes that gap:
 *
 *  1. Boots a REAL Nest app (NestFactory.create) with the production global
 *     guard chain — JwtAuthGuard, UserThrottlerGuard, RolesGuard — registered
 *     as APP_GUARD in the same order as app.module.ts, HttpExceptionFilter as
 *     the global filter, and the gate registered exactly as main.ts does
 *     (raw express middleware, before enableCors).
 *  2. Runs the R-DARK-1 6-probe matrix over real HTTP for BOTH gated flags
 *     (FEATURE_SCOUT_INGEST, FEATURE_EXTENSION_PAIRING — 12 probes total).
 *  3. Asserts the dark 404 body is KEY-FOR-KEY identical to a genuinely
 *     unmounted route's 404 (the round-2 shape-leak fix).
 *  4. Proves the app.use(featureFlagNotFoundMiddleware) wiring is
 *     load-bearing: an identical app booted WITHOUT the gate leaks 401.
 *  5. Statically asserts main.ts registers the gate before enableCors.
 *
 * Requests use node:http against a real listening socket (repo pattern —
 * see coach-empty-states.e2e.spec.ts; supertest is not a dependency here).
 */
import 'reflect-metadata';
import * as http from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Controller, INestApplication, Module, Post } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { JwksVerifierService } from '../../src/auth/jwks.service';
import { RolesGuard } from '../../src/auth/roles.guard';
import { UserThrottlerGuard } from '../../src/throttler/user-throttler.guard';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { featureFlagNotFoundMiddleware } from '../../src/common/feature-flag/feature-flag-not-found.middleware';
import { RequestIdMiddleware } from '../../src/observability/request-id.middleware';
import { computeCorsAllowedOrigins } from '../../src/common/cors-origins';
import { Roles } from '../../src/common/decorators/roles.decorator';
import { PrismaService } from '../../src/prisma.service';
import { PtmService } from '../../src/ptm/ptm.service';

const ALLOWED_ORIGIN = 'https://console.example.test';

// ─── Real-guard dependency stubs (the GUARDS are real; their I/O is not) ────
const USERS: Record<string, { id: string; role: string }> = {
  'supa-coach': { id: 'user-coach', role: 'coach' },
  'supa-student': { id: 'user-student', role: 'student' },
};
const TOKEN_TO_SUB: Record<string, string> = {
  'coach-token': 'supa-coach',
  'student-token': 'supa-student',
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

// ─── Stub controllers for the two gated surfaces ─────────────────────────────
@Controller('scout')
class ScoutIngestStubController {
  @Roles('coach')
  @Post('ingest')
  ingest() {
    return { ok: true };
  }
}

@Controller('extension/pair')
class ExtensionPairStubController {
  @Roles('coach')
  @Post('init')
  init() {
    return { ok: true };
  }
}

@Module({
  // Generous single default throttler: the REAL UserThrottlerGuard class runs
  // on every request; the production limit TABLE (throttler.config.ts) is
  // config, not guard logic, and would 429 this suite's burst of probes.
  imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 1_000 }] })],
  controllers: [ScoutIngestStubController, ExtensionPairStubController],
  providers: [
    { provide: PrismaService, useValue: prismaStub },
    { provide: JwksVerifierService, useValue: jwksStub },
    { provide: PtmService, useValue: ptmStub },
    // Same registration order as app.module.ts.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class GateTestModule {}

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

/** Boots the test app wired exactly like main.ts (gate BEFORE enableCors).
 * `withGate=false` boots the identical app minus the gate — used to prove
 * the app.use() registration is load-bearing. */
async function bootApp(withGate: boolean): Promise<{ app: INestApplication; baseUrl: string }> {
  const app = await NestFactory.create(GateTestModule, { logger: false });
  app.setGlobalPrefix('api');
  if (withGate) {
    app.use(featureFlagNotFoundMiddleware);
  }
  // RequestIdMiddleware normally runs via ObservabilityModule's consumer; a
  // bound app.use() gives the same per-request behavior here so a genuinely
  // unmounted route's 404 carries request_id, exactly as in production.
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

const FEATURES = [
  { flag: 'FEATURE_SCOUT_INGEST', method: 'POST', path: '/api/scout/ingest' },
  { flag: 'FEATURE_EXTENSION_PAIRING', method: 'POST', path: '/api/extension/pair/init' },
] as const;

const AUTH = {
  none: {},
  student: { authorization: 'Bearer student-token' },
  coach: { authorization: 'Bearer coach-token' },
} as const;

describe('R-DARK-1 bootstrap 6-probe suite (real guard chain over HTTP)', () => {
  const originalEnv = { ...process.env };
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CORS_ORIGINS = ALLOWED_ORIGIN;
    delete process.env.STOREFRONT_BASE_URL;
    ({ app, baseUrl } = await bootApp(true));
  });

  afterAll(async () => {
    if (app) await app.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => {
    delete process.env.FEATURE_SCOUT_INGEST;
    delete process.env.FEATURE_EXTENSION_PAIRING;
  });

  describe.each(FEATURES)('$flag → $method $path', ({ flag, method, path }) => {
    it('probe 1 — flag OFF, no auth → 404 (not 401)', async () => {
      process.env[flag] = 'false';
      const res = await request(baseUrl, method, path, AUTH.none);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe(`Cannot ${method} ${path}`);
      expect(res.body.error).toBe('Not Found');
    });

    it('probe 2 — flag OFF, non-coach auth → 404 (not 403)', async () => {
      process.env[flag] = 'false';
      const res = await request(baseUrl, method, path, AUTH.student);
      expect(res.status).toBe(404);
    });

    it('probe 3 — flag OFF, coach auth → 404 (not 2xx)', async () => {
      process.env[flag] = 'false';
      const res = await request(baseUrl, method, path, AUTH.coach);
      expect(res.status).toBe(404);
    });

    it('probe 4 — flag ON, no auth → 401 (pre-ruling behavior preserved)', async () => {
      process.env[flag] = 'true';
      const res = await request(baseUrl, method, path, AUTH.none);
      expect(res.status).toBe(401);
    });

    it('probe 5 — flag ON, non-coach auth → 403', async () => {
      process.env[flag] = 'true';
      const res = await request(baseUrl, method, path, AUTH.student);
      expect(res.status).toBe(403);
    });

    it('probe 6 — flag ON, coach auth → 2xx', async () => {
      process.env[flag] = 'true';
      const res = await request(baseUrl, method, path, AUTH.coach);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
    });

    it('dark 404 body is KEY-FOR-KEY identical to a truly unmounted route 404', async () => {
      process.env[flag] = 'false';
      const dark = await request(baseUrl, method, path, AUTH.none);
      const unmounted = await request(baseUrl, 'GET', '/api/does-not-exist', AUTH.none);
      expect(dark.status).toBe(404);
      expect(unmounted.status).toBe(404);
      // The round-2 shape-leak fix: same key set, same error/statusCode, and
      // both carry an X-Request-ID header — no distinguishing signal left.
      expect(Object.keys(dark.body).sort()).toEqual(Object.keys(unmounted.body).sort());
      expect(dark.body.error).toBe(unmounted.body.error);
      expect(dark.body.statusCode).toBe(unmounted.body.statusCode);
      expect(dark.headers['x-request-id']).toBeDefined();
      expect(unmounted.headers['x-request-id']).toBeDefined();
    });

    it('OPTIONS preflight on the dark route → 404 with allow-list CORS echo', async () => {
      process.env[flag] = 'false';
      const res = await request(baseUrl, 'OPTIONS', path, {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': method,
      });
      // The gate runs BEFORE the cors package, so preflight cannot bypass
      // the 404 gate (round-2 fix #2 — R-DARK-1 covers OPTIONS too).
      expect(res.status).toBe(404);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('OPTIONS preflight with the flag ON is still answered by cors (204)', async () => {
      process.env[flag] = 'true';
      const res = await request(baseUrl, 'OPTIONS', path, {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': method,
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    });
  });

  it('dark 404 echoes an upstream X-Request-ID into header and body', async () => {
    process.env.FEATURE_SCOUT_INGEST = 'false';
    const res = await request(baseUrl, 'POST', '/api/scout/ingest', {
      'x-request-id': 'edge-trace-42',
    });
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe('edge-trace-42');
    expect(res.body.request_id).toBe('edge-trace-42');
  });
});

describe('R-DARK-1 gate wiring is load-bearing', () => {
  const originalEnv = { ...process.env };
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CORS_ORIGINS = ALLOWED_ORIGIN;
    delete process.env.STOREFRONT_BASE_URL;
    // Identical app, gate deliberately NOT registered.
    ({ app, baseUrl } = await bootApp(false));
  });

  afterAll(async () => {
    if (app) await app.close();
    process.env = { ...originalEnv };
  });

  it('WITHOUT app.use(featureFlagNotFoundMiddleware), a flag-off route leaks 401', async () => {
    process.env.FEATURE_SCOUT_INGEST = 'false';
    const res = await request(baseUrl, 'POST', '/api/scout/ingest', AUTH.none);
    // This is the exact P1 leak R-DARK-1 forbids — proving the middleware
    // registration (not just its unit behavior) is what enforces the ruling.
    expect(res.status).toBe(401);
  });
});

describe('main.ts wiring (static source assertions)', () => {
  const mainTs = readFileSync(join(__dirname, '..', '..', 'src', 'main.ts'), 'utf8');

  it('registers featureFlagNotFoundMiddleware via app.use', () => {
    expect(mainTs).toContain('app.use(featureFlagNotFoundMiddleware)');
  });

  it('registers the gate BEFORE enableCors so OPTIONS cannot bypass it', () => {
    const gateIdx = mainTs.indexOf('app.use(featureFlagNotFoundMiddleware)');
    const corsIdx = mainTs.indexOf('app.enableCors(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(corsIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(corsIdx);
  });

  it('keeps the gate after helmet and before the global validation pipe', () => {
    const gateIdx = mainTs.indexOf('app.use(featureFlagNotFoundMiddleware)');
    expect(mainTs.indexOf('helmet(')).toBeLessThan(gateIdx);
    expect(mainTs.indexOf('app.useGlobalPipes(')).toBeGreaterThan(gateIdx);
  });
});
