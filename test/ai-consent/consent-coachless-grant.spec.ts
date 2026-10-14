/**
 * Owner W-CONSENT and CONSENT-954 Option 1: a coachless grant is stored like a coached one; Roman
 * stays 403 ROMAN_REQUIRES_COACH until a coach is linked, then the grant applies with no second
 * ask; GET and DELETE stay open. Real HTTP, the real ledger service and Roman's real consent gate.
 * Ledger RLS (another person's rows): test/rls/ai-processing-consent-ledger-rls.spec.ts.
 */
import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { type DynamicModule, type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { PrismaService } from '../../src/prisma.service';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { AiConsentModule } from '../../src/ai-consent/ai-consent.module';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import {
  CLIENT_AI_CONSENT_V6_COPY_SHA256 as V6_SHA,
  CLIENT_AI_CONSENT_V7_COPY_SHA256 as V7_SHA,
} from '../../src/ai-consent/ai-consent.constants';
import { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import {
  AI_CONSENT_REQUIRED_CLIENT_MESSAGE,
  AI_CONSENT_REQUIRED_CODE,
} from '../../src/ai-egress/ai-consent-required.exception';
import { RomanController } from '../../src/roman/roman.controller';
import { RomanFeatureGuard } from '../../src/roman/roman-feature.guard';
import { RomanService, type RomanCaller } from '../../src/roman/roman.service';
import { ROMAN_REQUIRES_COACH } from '../../src/roman/roman-requires-coach';
import { FakeLedgerPrisma, type LedgerRow } from './_support/fake-ledger-prisma';

const ENV = ['FEATURE_AI_CONSENT_LEDGER_ENABLED', 'FEATURE_ROMAN_CHAT_ENABLED', 'FEATURE_ROMAN_MEMORY'];
const V6 = { version: 'client-ai-v6', copy_sha256: V6_SHA };
const EVIDENCE = { platform: 'ios', app_version: '1.4.0', locale: 'en-GB' };
type Res = { status: number; body: Record<string, unknown>; raw: string };

describe('W-CONSENT: a client with no coach is asked once; Roman waits for a coach', () => {
  const saved = ENV.map((k) => process.env[k]);
  let users: Record<string, { id: string; role: string; coach_id: string | null }>;
  let fake: FakeLedgerPrisma;
  let app: INestApplication;
  let consent: AiConsentService;
  let baseUrl = '';
  let logLines: string[];
  let roman: ReturnType<typeof makeRoman>;

  // Roman's consent gate is the real one: RomanService.assertMayUseAi over the real egress gate.
  const gate = { egress: null as unknown as AiEgressService, dataSubjectFor: RomanService.prototype.dataSubjectFor };
  function makeRoman() {
    const now = new Date('2026-10-14T07:00:00.000Z');
    const session = { id: 'sess_1', surface: 'client', message_count: 0, started_at: now, last_activity_at: now };
    return {
      openOrResumeSession: jest.fn(async () => session),
      getOwnedSession: jest.fn(async () => session),
      assertWithinRateLimit: jest.fn(async () => undefined),
      assertMayUseAi: jest.fn((c: RomanCaller) => RomanService.prototype.assertMayUseAi.call(gate as unknown as RomanService, c)),
      assertDailyCapacity: jest.fn(async () => undefined),
      assertCoachPoolOpen: jest.fn(async () => null),
      isSafetyShortCircuit: jest.fn(async () => false),
      isEatingDisorderRisk: jest.fn(() => false),
      appendMessage: jest.fn(async () => ({ id: 'msg_1' })),
      streamAssistantTurn: jest.fn(async function* () {
        yield { type: 'done', text: 'Hello', messageId: 'msg_2', interrupted: false };
      }),
    };
  }

  async function call(method: string, path: string, user: string, body?: unknown): Promise<Res> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'x-test-user': user, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await res.text();
    // A Roman turn answers with an event stream; `raw` carries it.
    const json = res.headers.get('content-type')?.includes('json') ?? false;
    return { status: res.status, body: json ? (JSON.parse(raw) as Record<string, unknown>) : {}, raw };
  }
  const grant = (user: string, body: unknown = { ...V6, ...EVIDENCE }) => call('POST', '/me/ai-consent/roman', user, body);
  const withdraw = (user: string) => call('DELETE', '/me/ai-consent/roman', user);
  const status = (user: string, query = '') => call('GET', `/me/ai-consent${query}`, user);
  const askRoman = (user: string) => call('POST', '/roman/sessions/sess_1/messages', user, { content: 'Plan my lunch' });
  /** What a ledger row records, without its own id, owner and time. */
  const recorded = (row?: LedgerRow) => {
    const { id: _id, user_id: _u, created_at: _t, ...rest } = row ?? ({} as LedgerRow);
    return rest;
  };
  const rowsOf = (user: string) => fake.rows.filter((r) => r.user_id === user);

  beforeEach(async () => {
    ENV.forEach((k, i) => (i < 2 ? (process.env[k] = 'true') : delete process.env[k]));
    users = { u_a: { id: 'u_a', role: 'student', coach_id: null }, u_b: { id: 'u_b', role: 'student', coach_id: 'coach_1' } };
    logLines = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void logLines.push(String(m)));
    roman = makeRoman();
    fake = new FakeLedgerPrisma();
    const prisma = Object.assign(fake, { coachSubscription: { findUnique: async () => null } });
    const providers = [{ provide: PrismaService, useValue: prisma }];
    const fakePrismaModule: DynamicModule = { module: class P {}, global: true, providers, exports: [PrismaService] };
    const moduleRef = await Test.createTestingModule({
      imports: [fakePrismaModule, AiConsentModule],
      controllers: [RomanController],
      providers: [RomanFeatureGuard, { provide: RomanService, useValue: roman }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => Record<string, any> } }) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { ...users[req.headers['x-test-user']] };
          return true;
        },
      })
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
    jest.restoreAllMocks();
    ENV.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  });

  it('a coachless grant is stored and audited exactly like a coached one; GET reads it', async () => {
    const a = await grant('u_a');
    const b = await grant('u_b');
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ granted: true, state: 'granted', version: 'client-ai-v6', scope: 'base' });
    expect(b.body).toEqual({ ...a.body, granted_at: expect.any(String) });
    const row = { processor: 'anthropic', purpose: 'client_ai_processing', seq: 1, action: 'grant' };
    expect(recorded(rowsOf('u_a')[0])).toEqual({ ...row, ...V6, ...EVIDENCE });
    expect(recorded(rowsOf('u_b')[0])).toEqual(recorded(rowsOf('u_a')[0]));
    expect(logLines).toContain('ai_consent.grant user=u_a version=client-ai-v6 seq=1');
    expect(logLines).toContain('ai_consent.grant user=u_b version=client-ai-v6 seq=1');
    for (const q of ['', '?variant=safety_exception', '?variant=coach_free']) {
      expect((await status('u_a', q)).body).toMatchObject({ granted: true, current_version: 'client-ai-v6', needs_reconsent: false });
    }
  });

  it('with a stored grant, Roman still answers 403 ROMAN_REQUIRES_COACH and nothing reaches the AI', async () => {
    await grant('u_a');
    for (const r of [await call('POST', '/roman/sessions', 'u_a', { surface: 'client' }), await askRoman('u_a')]) {
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: ROMAN_REQUIRES_COACH, action: 'JOIN_COACH' });
    }
    for (const fn of [roman.openOrResumeSession, roman.assertMayUseAi, roman.appendMessage, roman.streamAssistantTurn]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('once a coach is linked, Roman works on the stored grant with no second ask', async () => {
    await grant('u_a');
    users.u_a.coach_id = 'coach_1';
    expect((await call('POST', '/roman/sessions', 'u_a', { surface: 'client' })).status).toBe(200);
    const turn = await askRoman('u_a');
    expect(turn.status).toBe(200);
    expect(turn.raw).toContain('"type":"done"');
    expect(roman.assertMayUseAi).toHaveBeenCalledTimes(1);
    expect(fake.rows).toHaveLength(1);
    const after = await status('u_a', '?variant=safety_exception');
    expect(after.body).toMatchObject({ granted: true, version: 'client-ai-v6', needs_reconsent: false });
    // The coached text also covers the coach's AI tools (audience 'coach').
    expect(await consent.hasClientAiConsent('u_a', 'base', 'coach')).toBe(true);
  });

  it('a withdrawal works the same with or without a coach; Roman then gives the existing consent error', async () => {
    await grant('u_a');
    await grant('u_b');
    const wa = await withdraw('u_a');
    const wb = await withdraw('u_b');
    expect(wa.status).toBe(200);
    expect(wa.body).toMatchObject({ granted: false, state: 'withdrawn', version: 'client-ai-v6' });
    expect(wb.body).toEqual({ ...wa.body, withdrawn_at: expect.any(String) });
    expect(recorded(rowsOf('u_a')[1])).toEqual(recorded(rowsOf('u_b')[1]));
    expect(rowsOf('u_a')[1]).toMatchObject({ seq: 2, action: 'withdraw', ...V6 });
    users.u_a.coach_id = 'coach_1';
    for (const user of ['u_a', 'u_b']) {
      const r = await askRoman(user);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: AI_CONSENT_REQUIRED_CODE, message: AI_CONSENT_REQUIRED_CLIENT_MESSAGE });
    }
    expect(roman.appendMessage).not.toHaveBeenCalled();
  });

  it('versions: the coachless ask offers the coached copies; v7 and v4 are kept and cover Roman once coached', async () => {
    process.env.FEATURE_ROMAN_MEMORY = 'true';
    const ask = (await status('u_a', '?variant=safety_exception')).body;
    expect(ask).toMatchObject({ state: 'not_granted', copy: { version: 'client-ai-v6', sha256: V6_SHA } });
    expect(ask).toMatchObject({ memory_copy: { version: 'client-ai-v7', sha256: V7_SHA } });
    const v7 = await grant('u_a', { version: 'client-ai-v7', copy_sha256: V7_SHA });
    expect(v7.body).toMatchObject({ granted: true, version: 'client-ai-v7', scope: 'memory' });
    // An installed build that pins client-ai-v4 (plain GET) is kept the same way.
    users.u_c = { id: 'u_c', role: 'student', coach_id: null };
    expect((await grant('u_c', { version: 'client-ai-v4' })).body).toMatchObject({ version: 'client-ai-v4' });
    // A copy the client did not see is the same 409 as for a coached client, and writes nothing.
    const stale = await grant('u_a', { version: 'client-ai-v6', copy_sha256: V7_SHA });
    expect(stale).toMatchObject({ status: 409, body: { code: 'CONSENT_VERSION_MISMATCH' } });
    expect(fake.rows).toHaveLength(2);
    users.u_a.coach_id = users.u_c.coach_id = 'coach_1';
    expect((await status('u_a')).body).toMatchObject({ granted: true, scope: 'memory', needs_reconsent: false });
    expect((await status('u_c')).body).toMatchObject({ granted: true, scope: 'base', needs_reconsent: false });
    expect(await consent.hasClientAiConsent('u_a', 'memory', 'client')).toBe(true);
    expect((await askRoman('u_c')).status).toBe(200);
  });

  it("another user's consent is untouched: the subject is always the caller", async () => {
    await grant('u_b');
    const before = rowsOf('u_b').map((r) => ({ ...r }));
    // A body cannot name another person (whitelist): 400, nothing written.
    expect((await grant('u_a', { ...V6, user_id: 'u_b' })).status).toBe(400);
    await grant('u_a');
    await withdraw('u_a');
    await grant('u_a');
    expect(rowsOf('u_b')).toEqual(before);
    expect((await status('u_b')).body).toMatchObject({ granted: true, state: 'granted' });
    await withdraw('u_b');
    expect((await status('u_a')).body).toMatchObject({ granted: true, version: 'client-ai-v6' });
    expect(rowsOf('u_a').map((r) => r.action)).toEqual(['grant', 'withdraw', 'grant']);
  });
});
