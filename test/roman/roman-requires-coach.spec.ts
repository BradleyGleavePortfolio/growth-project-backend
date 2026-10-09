/**
 * Owner 2026-10-09 00:0x: "Lets lock roman usage away for coachless clients
 * with epxlanation ... lets leave basic self logging alone though".
 *
 * A client with no coach gets 403 ROMAN_REQUIRES_COACH (action JOIN_COACH) on
 * POST /roman/sessions, POST /roman/sessions/:id/messages and POST /ai/chat,
 * before anything is stored, counted or sent to the AI. Coached clients,
 * coaches and the owner are unchanged, and a crisis message still gets its
 * fixed answer.
 *
 * Part 1 boots a real Nest HTTP app with the production ValidationPipe and
 * HttpExceptionFilter (stub services, no DB) to pin the wire body. Part 2 calls
 * the controllers directly to pin the order of the checks.
 */
import 'reflect-metadata';
import * as http from 'http';
import { ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { AiController } from '../../src/ai/ai.controller';
import { AiService } from '../../src/ai/ai.service';
import * as crisisRouter from '../../src/ai/ai-crisis-router';
import { ClientEntitlementGuard } from '../../src/common/guards/client-entitlement.guard';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { PrismaService } from '../../src/prisma.service';
import { RomanController } from '../../src/roman/roman.controller';
import { RomanFeatureGuard } from '../../src/roman/roman-feature.guard';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import { RomanService } from '../../src/roman/roman.service';
import {
  ROMAN_REQUIRES_COACH,
  ROMAN_REQUIRES_COACH_MESSAGE,
} from '../../src/roman/roman-requires-coach';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
const COACHLESS = { id: 'client-a', role: 'student', coach_id: null };
const COACHED = { id: 'client-b', role: 'student', coach_id: 'coach-1' };
const COACH = { id: 'coach-1', role: 'coach', coach_id: null };

function session() {
  const now = new Date('2026-10-09T07:00:00.000Z');
  return { id: 'sess_1', surface: 'client', message_count: 0, started_at: now, last_activity_at: now };
}

function makeRoman() {
  return {
    openOrResumeSession: jest.fn(async (..._a: unknown[]) => session()),
    getOwnedSession: jest.fn(async (..._a: unknown[]) => session()),
    assertWithinRateLimit: jest.fn(async (..._a: unknown[]) => undefined),
    assertMayUseAi: jest.fn(async (..._a: unknown[]) => undefined),
    assertDailyCapacity: jest.fn(async (..._a: unknown[]) => undefined),
    assertCoachPoolOpen: jest.fn(async (..._a: unknown[]) => null),
    isSafetyShortCircuit: jest.fn((..._a: unknown[]): boolean => false),
    isEatingDisorderRisk: jest.fn((..._a: unknown[]): boolean => false),
    appendMessage: jest.fn(async (..._a: unknown[]) => ({ id: 'msg_1' })),
    streamAssistantTurn: jest.fn(
      (..._a: unknown[]): AsyncGenerator<unknown> =>
        (async function* () {
          yield { type: 'done', text: 'Hello', messageId: 'msg_2', interrupted: false };
        })(),
    ),
    streamEatingDisorderFallback: jest.fn(
      (..._a: unknown[]): AsyncGenerator<unknown> =>
        (async function* () {
          yield { type: 'done', text: 'Fixed.', messageId: 'msg_ed', interrupted: false };
        })(),
    ),
  };
}

function makeAi() {
  return {
    chat: jest.fn(async (..._a: unknown[]) => ({
      reply: 'hi',
      guardrails_applied: [],
      context_generated_at: '2026-10-09T07:00:00Z',
      model_used: 'anthropic',
      degraded: false,
    })),
  };
}

function makeRes(): Response {
  return Object.assign(Object.create(null) as Response, {
    writeHead: jest.fn(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(),
  });
}

let savedFlag: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = 'true';
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

describe('Part 1 — the 403 a client with no coach receives over HTTP', () => {
  const roman = makeRoman();
  const ai = makeAi();
  let app: INestApplication;
  let baseUrl = '';
  let user: Record<string, unknown> = COACHLESS;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RomanController, AiController],
      providers: [
        RomanFeatureGuard,
        { provide: RomanService, useValue: roman },
        { provide: AiService, useValue: ai },
        { provide: PrismaService, useValue: { coachSubscription: { findUnique: async () => null } } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = user;
          return true;
        },
      })
      .overrideGuard(ClientEntitlementGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    user = COACHLESS;
  });

  function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        `${baseUrl}${path}`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = data.length ? (JSON.parse(data) as Record<string, unknown>) : {};
            } catch {
              parsed = { raw: data };
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  function expectRequiresCoach(res: { status: number; body: Record<string, unknown> }) {
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      statusCode: 403,
      error: ROMAN_REQUIRES_COACH,
      code: ROMAN_REQUIRES_COACH,
      message: ROMAN_REQUIRES_COACH_MESSAGE,
      action: 'JOIN_COACH',
    });
  }

  it('POST /roman/sessions: 403 ROMAN_REQUIRES_COACH and no session is opened', async () => {
    expectRequiresCoach(await post('/roman/sessions', { surface: 'client' }));
    expect(roman.openOrResumeSession).not.toHaveBeenCalled();
  });

  it('POST /roman/sessions/:id/messages: 403 before the rate limit, the stored turn, AI or pool checks', async () => {
    expectRequiresCoach(await post('/roman/sessions/sess_1/messages', { content: 'What should I eat today?' }));
    expect(roman.assertWithinRateLimit).not.toHaveBeenCalled();
    expect(roman.assertMayUseAi).not.toHaveBeenCalled();
    expect(roman.assertDailyCapacity).not.toHaveBeenCalled();
    expect(roman.assertCoachPoolOpen).not.toHaveBeenCalled();
    expect(roman.appendMessage).not.toHaveBeenCalled();
    expect(roman.streamAssistantTurn).not.toHaveBeenCalled();
  });

  it('POST /ai/chat: 403 ROMAN_REQUIRES_COACH and the AI guide is never called', async () => {
    expectRequiresCoach(await post('/ai/chat', { message: 'What should I eat today?' }));
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('a coached client opens a session and asks the AI guide as before', async () => {
    user = COACHED;
    const open = await post('/roman/sessions', { surface: 'client' });
    expect(open.status).toBe(200);
    expect(roman.openOrResumeSession).toHaveBeenCalledTimes(1);
    const guide = await post('/ai/chat', { message: 'What should I eat today?' });
    expect(guide.status).toBe(201);
    expect(ai.chat).toHaveBeenCalledWith('client-b', 'What should I eat today?', []);
  });

  it('a coach with no coach of their own is not a client: Roman opens', async () => {
    user = COACH;
    expect((await post('/roman/sessions', { surface: 'client' })).status).toBe(200);
  });
});

describe('Part 2 — order of the checks on a Roman turn and the AI guide', () => {
  function roman() {
    const service = makeRoman();
    const ctrl = new RomanController(
      fakeOf(service),
      fakeOf({ coachSubscription: { findUnique: async () => null } }),
    );
    return { service, ctrl };
  }
  function req(user: Record<string, unknown>): Request & AuthedRequest {
    return fakeOf({ user, on: jest.fn(), off: jest.fn() });
  }

  it('a coached client keeps every check: rate limit, consent, daily cap, coach pool, then the stream', async () => {
    const { service, ctrl } = roman();
    await ctrl.sendMessage(req(COACHED), makeRes(), 'sess_1', { content: 'hi' });
    expect(service.assertWithinRateLimit).toHaveBeenCalledTimes(1);
    expect(service.assertMayUseAi).toHaveBeenCalledTimes(1);
    expect(service.assertDailyCapacity).toHaveBeenCalledTimes(1);
    expect(service.assertCoachPoolOpen).toHaveBeenCalledTimes(1);
    expect(service.streamAssistantTurn).toHaveBeenCalledTimes(1);
  });

  it('a client with no coach sending a crisis message still gets the safety answer (no AI checks)', async () => {
    const { service, ctrl } = roman();
    service.isSafetyShortCircuit.mockReturnValueOnce(true);
    await ctrl.sendMessage(req(COACHLESS), makeRes(), 'sess_1', { content: 'x' });
    expect(service.appendMessage).toHaveBeenCalledTimes(1);
    expect(service.streamAssistantTurn).toHaveBeenCalledTimes(1);
    expect(service.assertMayUseAi).not.toHaveBeenCalled();
    expect(service.assertCoachPoolOpen).not.toHaveBeenCalled();
  });

  it('a client with no coach sending an eating-disorder-risk message gets the fixed fallback, never the model', async () => {
    const { service, ctrl } = roman();
    service.isEatingDisorderRisk.mockReturnValueOnce(true);
    await ctrl.sendMessage(req(COACHLESS), makeRes(), 'sess_1', { content: 'x' });
    expect(service.streamEatingDisorderFallback).toHaveBeenCalledTimes(1);
    expect(service.streamAssistantTurn).not.toHaveBeenCalled();
    expect(service.assertMayUseAi).not.toHaveBeenCalled();
    expect(service.assertCoachPoolOpen).not.toHaveBeenCalled();
  });

  it('AI guide: a client with no coach sending a crisis message reaches the fixed crisis reply in ai.service', async () => {
    const ai = makeAi();
    const spy = jest.spyOn(crisisRouter, 'classifyAiGuideCrisis').mockReturnValue('emergency');
    try {
      await new AiController(fakeOf(ai)).chat(req(COACHLESS), { message: 'x' });
    } finally {
      spy.mockRestore();
    }
    expect(ai.chat).toHaveBeenCalledTimes(1);
  });

  it('AI guide: a client with no coach and an ordinary message is refused before ai.service', async () => {
    const ai = makeAi();
    await expect(new AiController(fakeOf(ai)).chat(req(COACHLESS), { message: 'hi' })).rejects.toMatchObject({
      status: 403,
    });
    expect(ai.chat).not.toHaveBeenCalled();
  });
});
