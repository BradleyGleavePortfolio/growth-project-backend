/**
 * FIX-4 — HTTP integration test through the PRODUCTION ValidationPipe.
 *
 * The sibling controller/DTO spec calls class-validator's validate() directly
 * with { whitelist: false } — that proves the decorators fire but skips the
 * production pipe behavior (whitelist + forbidNonWhitelisted + transform) that
 * actually decides the 4xx at the boundary. This suite boots a real Nest app
 * with the exact global pipe from main.ts and the real guard chain
 * (JwtAuthGuard + RolesGuard, driven by test-stubbed jwks/prisma identities),
 * then drives real HTTP so the following are proven end-to-end:
 *
 *   - a verbatim makeEntity()-shaped envelope from a coach → 202,
 *   - an unknown TOP-LEVEL field → 400 (forbidNonWhitelisted),
 *   - an unknown ENTITY field → 400 (nested forbidNonWhitelisted),
 *   - malformed JSON body → 400 (body parser),
 *   - capturedAt: "bad" → 400 (strict IsISO8601, proving FIX-2),
 *   - a noncanonical sourcePlatform → 400 with a field-level message (G2-R D2), and
 *     the decorator's accept/reject set is exactly isCanonicalPlatform's over a table
 *     that includes malformed input and trailing line terminators.
 *
 * Requests use node:http against a real listening socket (repo pattern — see
 * feature-flag-not-found.bootstrap.spec.ts; supertest is not a dependency).
 */
import 'reflect-metadata';
import * as http from 'http';
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ScoutEntityDto } from '../../src/scout/scout-ingest.dto';
import { isCanonicalPlatform } from '../../src/scout/scout-platform';

import { ScoutIngestController } from '../../src/scout/scout-ingest.controller';
import { ScoutIngestService } from '../../src/scout/scout-ingest.service';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { RolesGuard } from '../../src/auth/roles.guard';
import { JwksVerifierService } from '../../src/auth/jwks.service';
import { PrismaService } from '../../src/prisma.service';
import { PtmService } from '../../src/ptm/ptm.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';

// ─── Real-guard dependency stubs (the GUARDS are real; their I/O is not) ────
const COACH = { id: 'user-coach', role: 'coach', deleted_at: null, deletion_scheduled_at: null };
const jwksStub = {
  verify: async (token: string) => {
    if (token !== 'coach-token') throw new Error('unrecognised test token');
    return { sub: 'supa-coach' };
  },
};
const capturedRows: Array<Record<string, unknown>> = [];
const prismaStub = {
  user: {
    findUnique: async ({ where }: { where: { supabase_id: string } }) =>
      where.supabase_id === 'supa-coach' ? { ...COACH } : null,
  },
  scoutIngestEntity: {
    createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      capturedRows.push(...data);
      return { count: data.length };
    },
  },
};
const ptmStub = { emit: jest.fn() };
const analyticsStub = { capture: jest.fn() };

@Module({
  controllers: [ScoutIngestController],
  providers: [
    ScoutIngestService,
    { provide: PrismaService, useValue: prismaStub },
    { provide: AnalyticsService, useValue: analyticsStub },
    { provide: JwksVerifierService, useValue: jwksStub },
    { provide: PtmService, useValue: ptmStub },
    // Route uses @UseGuards(JwtAuthGuard, RolesGuard) — provide the REAL guards
    // so Nest resolves them from DI against the stubbed I/O above.
    JwtAuthGuard,
    RolesGuard,
  ],
})
class ScoutValidationModule {}

interface HttpResult {
  status: number;
  body: unknown;
}

function request(
  baseUrl: string,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; rawBody?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method, headers: { 'content-type': 'application/json', ...opts.headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = data.length ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (opts.rawBody !== undefined) req.write(opts.rawBody);
    req.end();
  });
}

const COACH_AUTH = { authorization: 'Bearer coach-token' };

function makeEntity(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 's1',
    sourcePlatform: 'auto:coachrx.example.com',
    capturedAt: '2026-07-08T12:00:00.000Z',
    payload: { plan: 'gold' },
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return { intent_id: 'intent-1', entity_type: 'lead', entities: [makeEntity()], ...overrides };
}

function post(baseUrl: string, body: unknown): Promise<HttpResult> {
  return request(baseUrl, 'POST', '/api/scout/ingest', {
    headers: COACH_AUTH,
    rawBody: JSON.stringify(body),
  });
}

describe('POST /api/scout/ingest through the production ValidationPipe', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(ScoutValidationModule, { logger: false });
    app.setGlobalPrefix('api');
    // The exact global pipe from main.ts.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0);
    const addr = app.getHttpServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    capturedRows.length = 0;
  });

  it('accepts a verbatim makeEntity()-shaped envelope from a coach → 202', async () => {
    const res = await post(baseUrl, envelope());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ received: 1, deduped: 0 });
    expect(capturedRows).toHaveLength(1);
  });

  it('rejects an unknown top-level field → 400', async () => {
    const res = await post(baseUrl, envelope({ rogue_field: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('rejects an unknown entity field → 400', async () => {
    const res = await post(baseUrl, envelope({ entities: [makeEntity({ rogue: 'nope' })] }));
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON → 400', async () => {
    const res = await request(baseUrl, 'POST', '/api/scout/ingest', {
      headers: COACH_AUTH,
      rawBody: '{{{',
    });
    expect(res.status).toBe(400);
  });

  it('rejects capturedAt: "bad" → 400 (strict ISO8601, proves FIX-2)', async () => {
    const res = await post(baseUrl, envelope({ entities: [makeEntity({ capturedAt: 'bad' })] }));
    expect(res.status).toBe(400);
  });

  it('rejects a noncanonical sourcePlatform → 400 with a field-level message; nothing staged (G2-R D2)', async () => {
    for (const sourcePlatform of ['TrueCoach', 'auto:x.com\n', ' truecoach', '-truecoach']) {
      const res = await post(baseUrl, envelope({ entities: [makeEntity({ sourcePlatform })] }));
      expect(res.status).toBe(400);
      // Field-level: the ValidationPipe's message array names the nested property and the
      // decorator's own reason, so a client learns which field failed and why.
      expect(JSON.stringify(res.body)).toMatch(
        /entities\.0\.sourcePlatform must be a canonical platform token/,
      );
      expect(capturedRows).toHaveLength(0);
    }
  });

  it('accepts canonical sourcePlatform tokens at the boundary unchanged (fixtures stay valid)', async () => {
    for (const sourcePlatform of [
      'truecoach',
      'auto:coachrx.example.com',
      'a',
      `z${'-'.repeat(255)}`,
    ]) {
      const res = await post(baseUrl, envelope({ entities: [makeEntity({ sourcePlatform })] }));
      expect(res.status).toBe(202);
    }
    expect(capturedRows).toHaveLength(4);
  });
});

/**
 * G2-R D2 parity: the boundary decorator delegates to isCanonicalPlatform, so its accept/reject
 * set over this table must equal the function's. The table is chosen to break a merely similar
 * regex: empty, exact length bounds, every leading-character class, case, whitespace, NUL,
 * trailing \n and \r\n (a `$` anchor with multiline or a trailing-newline allowance would admit
 * them), non-ASCII, and non-string inputs. The database CHECK shipped by
 * 20270120000000_scout_identity_ready mirrors the same predicate.
 */
describe('ScoutEntityDto.sourcePlatform parity with isCanonicalPlatform', () => {
  const table: unknown[] = [
    '',
    'a',
    '0',
    'truecoach',
    'auto:coachrx.example.com',
    'a.b_c:d-e',
    'z'.repeat(256),
    'z'.repeat(257),
    `a${'.'.repeat(255)}`,
    `a${'.'.repeat(256)}`,
    '-truecoach',
    '.truecoach',
    ':truecoach',
    '_truecoach',
    'TrueCoach',
    'true coach',
    ' truecoach',
    'truecoach ',
    'truecoach\n',
    'truecoach\r\n',
    '\ntruecoach',
    'true\ncoach',
    'truecoach\u0000',
    'truecoach/',
    'true@coach',
    'trüecoach',
    'ｔruecoach',
    'truecoach\u200b',
    1,
    null,
    undefined,
    ['truecoach'],
    { toString: () => 'truecoach' },
  ];
  const dtoAccepts = async (sourcePlatform: unknown) => {
    const dto = plainToInstance(ScoutEntityDto, {
      sourceId: 's1',
      sourcePlatform,
      capturedAt: '2026-07-08T12:00:00.000Z',
      payload: { plan: 'gold' },
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    return errors.filter((e) => e.property === 'sourcePlatform').length === 0;
  };

  it('accepts exactly the values isCanonicalPlatform accepts', async () => {
    const outcomes = await Promise.all(
      table.map(async (value) => ({
        value: typeof value === 'string' ? JSON.stringify(value) : String(value),
        dto: await dtoAccepts(value),
        authority: isCanonicalPlatform(value),
      })),
    );
    expect(outcomes.filter((o) => o.dto !== o.authority)).toEqual([]);
    // The table must genuinely exercise both classes, and the authority itself must hold the
    // properties the database CHECK relies on (a stale table would otherwise prove nothing).
    expect(outcomes.filter((o) => o.authority)).toHaveLength(7);
    expect(outcomes.filter((o) => !o.authority)).toHaveLength(table.length - 7);
    expect(isCanonicalPlatform('truecoach\n')).toBe(false);
    expect(isCanonicalPlatform('truecoach\r\n')).toBe(false);
    expect(isCanonicalPlatform('z'.repeat(256))).toBe(true);
    expect(isCanonicalPlatform('z'.repeat(257))).toBe(false);
  });
});
