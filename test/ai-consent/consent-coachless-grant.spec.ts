/**
 * Owner W-CONSENT (2026-10-14): "We should still ask for the permission then so
 * we dont have to as a repeat, but explain clients without a coach dont get
 * roman". CONSENT-954 Option 1: GET and DELETE stay open for a client with no
 * coach.
 *
 *   - POST /me/ai-consent/roman from a client with no coach stores the grant
 *     exactly like a coached grant: same versions, same ledger row (the audit
 *     event), same evidence fields, same log line;
 *   - Roman still answers 403 ROMAN_REQUIRES_COACH until a coach is linked;
 *     then the grant on file applies with no second ask;
 *   - a withdrawal works the same for both, and Roman then answers the existing
 *     403 ai_consent_required;
 *   - nothing here reads or writes another user's consent.
 *
 * Real HTTP (production ValidationPipe and HttpExceptionFilter), the real
 * AiConsentService on the in-memory ledger, and Roman's real consent gate
 * (RomanService.assertMayUseAi over the real AiEgressService). The ledger's
 * row-level security is proven live in test/rls/ai-processing-consent-ledger-rls.spec.ts.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  type INestApplication,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { PrismaService } from '../../src/prisma.service';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import {
  CLIENT_AI_CONSENT_V6_COPY_SHA256,
  CLIENT_AI_CONSENT_V7_COPY_SHA256,
} from '../../src/ai-consent/ai-consent.constants';
import { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import {
  AI_CONSENT_REQUIRED_CLIENT_MESSAGE,
  AI_CONSENT_REQUIRED_CODE,
} from '../../src/ai-egress/ai-consent-required.exception';
import { RomanController } from '../../src/roman/roman.controller';
import { RomanFeatureGuard } from '../../src/roman/roman-feature.guard';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { RomanService, type RomanCaller } from '../../src/roman/roman.service';
import { ROMAN_REQUIRES_COACH } from '../../src/roman/roman-requires-coach';
import { FakeLedgerPrisma, type LedgerRow } from './_support/fake-ledger-prisma';

const ENV = ['FEATURE_AI_CONSENT_LEDGER_ENABLED', FEATURE_ROMAN_CHAT_ENABLED_ENV, 'FEATURE_ROMAN_MEMORY'];
const V6 = { version: 'client-ai-v6', copy_sha256: CLIENT_AI_CONSENT_V6_COPY_SHA256 };
const EVIDENCE = { platform: 'ios', app_version: '1.4.0', locale: 'en-GB' };

interface HttpResult {
  status: number;
  body: Record<string, unknown> | null;
  raw: string;
}

describe('W-CONSENT: a client with no coach is asked once; Roman waits for a coach', () => {
  const saved = ENV.map((k) => process.env[k]);
  /** The signed-in people (JwtAuthGuard attaches the fresh User row). */
  let users: Record<string, { id: string; role: string; coach_id: string | null }>;
  let fake: FakeLedgerPrisma;
  let app: INestApplication;
  let consent: AiConsentService;
  let baseUrl = '';
  let logLines: string[];
  let logSpy: jest.SpyInstance;

  // Roman's own consent gate, unchanged: the real method over the real egress gate.
  const gate = { egress: null as unknown as AiEgressService, dataSubjectFor: RomanService.prototype.dataSubjectFor };
  let roman: ReturnType<typeof makeRoman>;
  function makeRoman() {
    return {
      openOrResumeSession: jest.fn(async (..._a: unknown[]) => session()),
      getOwnedSession: jest.fn(async (..._a: unknown[]) => session()),
      assertWithinRateLimit: jest.fn(async (..._a: unknown[]) => undefined),
      assertMayUseAi: jest.fn((caller: RomanCaller) =>
        RomanService.prototype.assertMayUseAi.call(gate as unknown as RomanService, caller),
      ),
      assertDailyCapacity: jest.fn(async (..._a: unknown[]) => undefined),
      assertCoachPoolOpen: jest.fn(async (..._a: unknown[]) => null),
      isSafetyShortCircuit: jest.fn(async (..._a: unknown[]) => false),
      isEatingDisorderRisk: jest.fn((..._a: unknown[]) => false),
      appendMessage: jest.fn(async (..._a: unknown[]) => ({ id: 'msg_1' })),
      streamAssistantTurn: jest.fn((..._a: unknown[]) =>
        (async function* () {
          yield { type: 'done', text: 'Hello', messageId: 'msg_2', interrupted: false };
        })(),
      ),
    };
  }

  function session() {
    const now = new Date('2026-10-14T07:00:00.000Z');
    return { id: 'sess_1', surface: 'client', message_count: 0, started_at: now, last_activity_at: now };
  }

  class TestAuthGuard implements CanActivate {
    canActivate(ctx: ExecutionContext): boolean {
      const req = ctx.switchToHttp().getRequest();
      req.user = { ...users[req.headers['x-test-user'] as string] };
      return true;
    }
  }

  function call(method: string, path: string, user: string, body?: unknown): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = { 'x-test-user': user };
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload).toString();
      }
      const req = http.request(`${baseUrl}${path}`, { method, headers }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = raw.length ? (JSON.parse(raw) as Record<string, unknown>) : null;
          } catch {
            parsed = null; // the SSE stream of a Roman turn
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const grant = (user: string, body: unknown = { ...V6, ...EVIDENCE }) =>
    call('POST', '/me/ai-consent/roman', user, body);
  const askRoman = (user: string) =>
    call('POST', '/roman/sessions/sess_1/messages', user, { content: 'What should I eat today?' });
  /** A ledger row without its own id, owner and time: what a grant records. */
  const recorded = (row: LedgerRow | undefined) => {
    if (!row) throw new Error('no ledger row');
    const { id: _id, user_id: _u, created_at: _t, ...rest } = row;
    return rest;
  };
  const rowOf = (user: string) => fake.rows.find((r) => r.user_id === user);

  beforeEach(async () => {
    process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED = 'true';
    process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = 'true';
    delete process.env.FEATURE_ROMAN_MEMORY;
    roman = makeRoman();
    users = {
      u_a: { id: 'u_a', role: 'student', coach_id: null },
      u_b: { id: 'u_b', role: 'student', coach_id: 'coach_1' },
    };
    logLines = [];
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(String(args[0]));
    });
    fake = new FakeLedgerPrisma();
    const prisma = Object.assign(fake, { coachSubscription: { findUnique: async () => null } });
    const fakePrismaModule: DynamicModule = {
      module: class FakePrismaModule {},
      global: true,
      providers: [{ provide: PrismaService, useValue: prisma }],
      exports: [PrismaService],
    };
    const moduleRef = await Test.createTestingModule({
      imports: [fakePrismaModule, AiConsentModule],
      controllers: [RomanController],
      providers: [RomanFeatureGuard, { provide: RomanService, useValue: roman }],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestAuthGuard)
      .compile();
    consent = moduleRef.get(AiConsentService);
    gate.egress = new AiEgressService(consent);
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app.close();
    logSpy.mockRestore();
    ENV.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  });

  it('a coachless grant is stored and audited exactly like a coached one', async () => {
    const a = await grant('u_a');
    const b = await grant('u_b');
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ granted: true, state: 'granted', version: 'client-ai-v6', scope: 'base' });
    expect(b.body).toEqual({ ...(a.body ?? {}), granted_at: expect.any(String) });
    expect(recorded(rowOf('u_a'))).toEqual({
      processor: 'anthropic',
      purpose: 'client_ai_processing',
      seq: 1,
      action: 'grant',
      ...V6,
      ...EVIDENCE,
    });
    expect(recorded(rowOf('u_b'))).toEqual(recorded(rowOf('u_a')));
    expect(logLines).toEqual(
      expect.arrayContaining([
        'ai_consent.grant user=u_a version=client-ai-v6 seq=1',
        'ai_consent.grant user=u_b version=client-ai-v6 seq=1',
      ]),
    );
    // GET stays open and reads the grant as live, whatever the app asks for.
    for (const path of ['/me/ai-consent', '/me/ai-consent?variant=safety_exception', '/me/ai-consent?variant=coach_free']) {
      const g = await call('GET', path, 'u_a');
      expect(g.status).toBe(200);
      expect(g.body).toMatchObject({ granted: true, current_version: 'client-ai-v6', needs_reconsent: false });
    }
  });

  it('with a stored grant, Roman still answers 403 ROMAN_REQUIRES_COACH and nothing reaches the AI', async () => {
    await grant('u_a');
    for (const r of [await call('POST', '/roman/sessions', 'u_a', { surface: 'client' }), await askRoman('u_a')]) {
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: ROMAN_REQUIRES_COACH, action: 'JOIN_COACH' });
    }
    expect(roman.openOrResumeSession).not.toHaveBeenCalled();
    expect(roman.assertMayUseAi).not.toHaveBeenCalled();
    expect(roman.appendMessage).not.toHaveBeenCalled();
    expect(roman.streamAssistantTurn).not.toHaveBeenCalled();
  });

  it('once a coach is linked, Roman works on the stored grant with no second ask', async () => {
    await grant('u_a');
    users.u_a.coach_id = 'coach_1';
    expect((await call('POST', '/roman/sessions', 'u_a', { surface: 'client' })).status).toBe(200);
    const turn = await askRoman('u_a');
    expect(turn.status).toBe(200);
    expect(turn.raw).toContain('"type":"done"');
    expect(roman.assertMayUseAi).toHaveBeenCalledTimes(1);
    expect(roman.streamAssistantTurn).toHaveBeenCalledTimes(1);
    expect(fake.rows).toHaveLength(1);
    const status = await call('GET', '/me/ai-consent?variant=safety_exception', 'u_a');
    expect(status.body).toMatchObject({ granted: true, state: 'granted', version: 'client-ai-v6', needs_reconsent: false });
    // The coached text covers the coach's AI drafts too (audience 'coach').
    expect(await consent.hasClientAiConsent('u_a', 'base', 'coach')).toBe(true);
  });

  it('a withdrawal works the same with or without a coach; Roman then gives the existing consent error', async () => {
    await grant('u_a');
    await grant('u_b');
    const wa = await call('DELETE', '/me/ai-consent/roman', 'u_a');
    const wb = await call('DELETE', '/me/ai-consent/roman', 'u_b');
    expect(wa.status).toBe(200);
    expect(wa.body).toMatchObject({ granted: false, state: 'withdrawn', version: 'client-ai-v6' });
    expect(wb.body).toEqual({ ...(wa.body ?? {}), withdrawn_at: expect.any(String) });
    const withdrawals = fake.rows.filter((r) => r.action === 'withdraw');
    expect(withdrawals.map(recorded)).toEqual([
      expect.objectContaining({ seq: 2, ...V6 }),
      expect.objectContaining({ seq: 2, ...V6 }),
    ]);
    users.u_a.coach_id = 'coach_1';
    for (const user of ['u_a', 'u_b']) {
      const r = await askRoman(user);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: AI_CONSENT_REQUIRED_CODE, message: AI_CONSENT_REQUIRED_CLIENT_MESSAGE });
    }
    expect(roman.appendMessage).not.toHaveBeenCalled();
  });

  it('versions: the coachless ask offers the coached copies; v7 and v4 are kept as given and cover Roman once coached', async () => {
    process.env.FEATURE_ROMAN_MEMORY = 'true';
    const ask = await call('GET', '/me/ai-consent?variant=safety_exception', 'u_a');
    expect(ask.body).toMatchObject({
      state: 'not_granted',
      current_version: 'client-ai-v6',
      copy: { sha256: CLIENT_AI_CONSENT_V6_COPY_SHA256 },
      memory_copy: { version: 'client-ai-v7', sha256: CLIENT_AI_CONSENT_V7_COPY_SHA256 },
    });
    const v7 = await grant('u_a', { version: 'client-ai-v7', copy_sha256: CLIENT_AI_CONSENT_V7_COPY_SHA256 });
    expect(v7.body).toMatchObject({ granted: true, version: 'client-ai-v7', scope: 'memory' });
    // An installed build that pins client-ai-v4 (plain GET) is kept the same way.
    users.u_c = { id: 'u_c', role: 'student', coach_id: null };
    expect((await grant('u_c', { version: 'client-ai-v4' })).body).toMatchObject({ granted: true, version: 'client-ai-v4' });
    // A copy the client did not see is the same 409 as for a coached client, and writes nothing.
    const stale = await grant('u_a', { version: 'client-ai-v6', copy_sha256: CLIENT_AI_CONSENT_V7_COPY_SHA256 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'CONSENT_VERSION_MISMATCH' });
    expect(fake.rows).toHaveLength(2);
    users.u_a.coach_id = 'coach_1';
    users.u_c.coach_id = 'coach_1';
    expect((await call('GET', '/me/ai-consent', 'u_a')).body).toMatchObject({ granted: true, scope: 'memory', needs_reconsent: false });
    expect((await call('GET', '/me/ai-consent', 'u_c')).body).toMatchObject({ granted: true, scope: 'base', needs_reconsent: false });
    expect(await consent.hasClientAiConsent('u_a', 'memory', 'client')).toBe(true);
    expect((await askRoman('u_c')).status).toBe(200);
  });

  it("another user's consent is untouched: the subject is always the caller", async () => {
    await grant('u_b');
    const before = fake.rows.filter((r) => r.user_id === 'u_b').map((r) => ({ ...r }));
    // A body cannot name another person (whitelist), and nothing is written.
    expect((await grant('u_a', { ...V6, user_id: 'u_b' })).status).toBe(400);
    await grant('u_a');
    await call('DELETE', '/me/ai-consent/roman', 'u_a');
    await grant('u_a');
    expect(fake.rows.filter((r) => r.user_id === 'u_b')).toEqual(before);
    expect((await call('GET', '/me/ai-consent', 'u_b')).body).toMatchObject({ granted: true, state: 'granted' });
    expect(await consent.hasClientAiConsent('u_b')).toBe(true);
    // And B withdrawing leaves A's grant on file.
    await call('DELETE', '/me/ai-consent/roman', 'u_b');
    expect((await call('GET', '/me/ai-consent', 'u_a')).body).toMatchObject({ granted: true, version: 'client-ai-v6' });
    expect(fake.rows.filter((r) => r.user_id === 'u_a').map((r) => r.action)).toEqual(['grant', 'withdraw', 'grant']);
  });
});
