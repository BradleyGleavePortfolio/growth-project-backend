/**
 * Owner 2026-10-09 00:0x: "Lets lock roman usage away for coachless clients
 * with epxlanation ... lets leave basic self logging alone though".
 *
 * A client with no coach gets 403 ROMAN_REQUIRES_COACH (action JOIN_COACH) on
 * POST /roman/sessions, POST /roman/sessions/:id/messages and POST /ai/chat,
 * before anything is stored, counted or sent to the AI. Coached clients,
 * coaches and the owner are unchanged, and a crisis message still gets its
 * fixed answer. 139-15: the same 403 on GET /ai/context, GET
 * /ai/structured-context and GET /roman/context/me, before anything is read.
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
import { AI_GUIDE_RETIRED_REPLY, AiController } from '../../src/ai/ai.controller';
import { AiService } from '../../src/ai/ai.service';
import * as crisisRouter from '../../src/ai/ai-crisis-router';
import { ClientEntitlementGuard } from '../../src/common/guards/client-entitlement.guard';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { PrismaService } from '../../src/prisma.service';
import { RomanController } from '../../src/roman/roman.controller';
import { RomanContextController } from '../../src/roman/context/roman-context.controller';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
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
const OWNER = { id: 'owner-1', role: 'owner', coach_id: null };
const COACHED_C = { id: 'client-c', role: 'student', coach_id: 'coach-1' };

function session() {
  const now = new Date('2026-10-09T07:00:00.000Z');
  return {
    id: 'sess_1',
    surface: 'client',
    message_count: 0,
    started_at: now,
    last_activity_at: now,
  };
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
    streamAssistantTurn: jest.fn((..._a: unknown[]): AsyncGenerator<unknown> =>
      (async function* () {
        yield { type: 'done', text: 'Hello', messageId: 'msg_2', interrupted: false };
      })(),
    ),
    streamEatingDisorderFallback: jest.fn((..._a: unknown[]): AsyncGenerator<unknown> =>
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
    getUserContext: jest.fn(async (..._a: unknown[]) => ({ user: { id: 'client-b' } })),
    getStructuredContext: jest.fn(async (..._a: unknown[]) => ({ coach: { name: 'Dana' } })),
  };
}

function makeRomanContext() {
  return {
    buildFresh: jest.fn(async (..._a: unknown[]) => ({
      context: { version: 1 },
      generated_at: new Date('2026-10-12T07:00:00.000Z'),
      estimated_tokens: 10,
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
  const romanContext = makeRomanContext();
  let app: INestApplication;
  let baseUrl = '';
  let user: Record<string, unknown> = COACHLESS;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RomanController, AiController, RomanContextController],
      providers: [
        RomanFeatureGuard,
        { provide: RomanService, useValue: roman },
        { provide: AiService, useValue: ai },
        { provide: RomanClientContextService, useValue: romanContext },
        {
          provide: PrismaService,
          useValue: { coachSubscription: { findUnique: async () => null } },
        },
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
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
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

  function post(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return send('POST', path, JSON.stringify(body));
  }

  function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return send('GET', path, '');
  }

  function send(
    method: 'POST' | 'GET',
    path: string,
    payload: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${path}`,
        {
          method,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
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
    expectRequiresCoach(
      await post('/roman/sessions/sess_1/messages', { content: 'What should I eat today?' }),
    );
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

  it('GET /ai/context: 403 ROMAN_REQUIRES_COACH and the AI context is never built (139-15)', async () => {
    expectRequiresCoach(await get('/ai/context'));
    expect(ai.getUserContext).not.toHaveBeenCalled();
  });

  it('GET /ai/structured-context: 403 ROMAN_REQUIRES_COACH and the context is never read (139-15)', async () => {
    expectRequiresCoach(await get('/ai/structured-context'));
    expect(ai.getStructuredContext).not.toHaveBeenCalled();
  });

  it('GET /roman/context/me: 403 ROMAN_REQUIRES_COACH and Roman context is never built (139-15)', async () => {
    expectRequiresCoach(await get('/roman/context/me'));
    expect(romanContext.buildFresh).not.toHaveBeenCalled();
  });

  it('a coached client still reads all three context routes, unchanged', async () => {
    user = COACHED;
    const context = await get('/ai/context');
    expect(context.status).toBe(200);
    expect(ai.getUserContext).toHaveBeenCalledWith('client-b');
    const structured = await get('/ai/structured-context');
    expect(structured.status).toBe(200);
    expect(structured.body).toEqual({ coach: { name: 'Dana' } });
    expect(ai.getStructuredContext).toHaveBeenCalledWith('client-b');
    const grounded = await get('/roman/context/me');
    expect(grounded.status).toBe(200);
    expect(grounded.body).toMatchObject({ version: 1, estimated_tokens: 10 });
    expect(romanContext.buildFresh).toHaveBeenCalledWith({ id: 'client-b', role: 'student' });
  });

  it('a coached client opens a session; the retired AI guide answers with the fixed reply (R2)', async () => {
    user = COACHED;
    const open = await post('/roman/sessions', { surface: 'client' });
    expect(open.status).toBe(200);
    expect(roman.openOrResumeSession).toHaveBeenCalledTimes(1);
    const guide = await post('/ai/chat', { message: 'What should I eat today?' });
    expect(guide.status).toBe(201);
    expect(guide.body.reply).toBe(AI_GUIDE_RETIRED_REPLY);
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('a coach with no coach of their own is not a client: Roman opens', async () => {
    user = COACH;
    expect((await post('/roman/sessions', { surface: 'client' })).status).toBe(200);
  });

  // ROMANCTX-ROLE: RolesGuard lets a coach through @Roles('student') and the
  // owner through every route, so GET /roman/context/me refuses them itself
  // with the guard's own 403 (same rule as GET /me/roman/usage, #1020).
  describe('ROMANCTX-ROLE: GET /roman/context/me answers clients only', () => {
    function expectInsufficientRole(res: { status: number; body: Record<string, unknown> }) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ statusCode: 403, message: 'Insufficient role' });
      expect(res.body).not.toHaveProperty('context');
      expect(romanContext.buildFresh).not.toHaveBeenCalled();
    }

    it('a coach gets 403 Insufficient role and no context is built', async () => {
      user = COACH;
      expectInsufficientRole(await get('/roman/context/me'));
    });

    it('a coach who is also linked to a coach gets 403 Insufficient role too', async () => {
      user = { ...COACH, coach_id: 'coach-2' };
      expectInsufficientRole(await get('/roman/context/me'));
    });

    it('the owner gets 403 Insufficient role and no context is built', async () => {
      user = OWNER;
      expectInsufficientRole(await get('/roman/context/me'));
    });

    it('a client with no coach still gets 403 ROMAN_REQUIRES_COACH, nothing read', async () => {
      user = COACHLESS;
      expectRequiresCoach(await get('/roman/context/me'));
      expect(romanContext.buildFresh).not.toHaveBeenCalled();
    });

    it('each coached client gets 200 with only their own context (keyed on the signed-in user)', async () => {
      // The stub echoes whose context it built, so a body can only be the caller's.
      const ownContext = async (...a: unknown[]) => ({
        context: { version: 1, owner_id: (a[0] as { id: string }).id },
        generated_at: new Date('2026-10-12T07:00:00.000Z'),
        estimated_tokens: 10,
      });
      const usual = romanContext.buildFresh.getMockImplementation();
      romanContext.buildFresh.mockImplementation(ownContext);
      try {
        user = COACHED;
        const b = await get('/roman/context/me?client_id=client-c');
        expect(b.status).toBe(200);
        expect(b.body).toEqual({
          version: 1,
          as_of: '2026-10-12T07:00:00.000Z',
          estimated_tokens: 10,
          context: { version: 1, owner_id: 'client-b' },
        });
        user = COACHED_C;
        const c = await get('/roman/context/me');
        expect(c.status).toBe(200);
        expect(c.body.context).toEqual({ version: 1, owner_id: 'client-c' });
        expect(romanContext.buildFresh.mock.calls).toEqual([
          [{ id: 'client-b', role: 'student' }],
          [{ id: 'client-c', role: 'student' }],
        ]);
      } finally {
        if (usual) romanContext.buildFresh.mockImplementation(usual);
      }
    });
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

  it('AI guide: a client with no coach sending a crisis message gets the fixed crisis reply, no model (R2)', async () => {
    const ai = makeAi();
    const spy = jest.spyOn(crisisRouter, 'classifyAiGuideCrisis').mockReturnValue('emergency');
    let res;
    try {
      res = await new AiController(fakeOf(ai)).chat(req(COACHLESS), { message: 'x' });
    } finally {
      spy.mockRestore();
    }
    expect(res?.reply).toBe(crisisRouter.AI_GUIDE_CRISIS_REPLIES.emergency);
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('AI guide: a client with no coach and an ordinary message is refused before ai.service', async () => {
    const ai = makeAi();
    await expect(
      new AiController(fakeOf(ai)).chat(req(COACHLESS), { message: 'hi' }),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(ai.chat).not.toHaveBeenCalled();
  });
});
