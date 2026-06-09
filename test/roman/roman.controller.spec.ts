// test/roman/roman.controller.spec.ts
//
// Roman Phase 1 controller — integration-level coverage of the REST surface
// (brief §1.2) without booting a full HTTP server. We exercise:
//
//   1. RomanFeatureGuard: 404 on every route while FEATURE_ROMAN_CHAT_ENABLED
//      is OFF; pass-through when ON (the flag-off→404, flag-on→reachable
//      contract for all 4 endpoints).
//   2. JwtAuthGuard wiring: the @Controller is decorated with
//      @UseGuards(JwtAuthGuard, RomanFeatureGuard) — auth is required on every
//      route (asserted via reflected guard metadata).
//   3. Each of the 4 handlers delegates to the service with the authenticated
//      caller, and shapes the response view as the mobile client expects.
//
// The codebase convention (see test/team-mode-controller-tier-gate.spec.ts) is
// to instantiate the controller directly with test doubles rather than spin up
// Supertest — that keeps these specs fast and deterministic while still
// covering the guard + handler contract.

import 'reflect-metadata';
import { NotFoundException, UseGuards } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { RomanController } from '../../src/roman/roman.controller';
import { RomanFeatureGuard } from '../../src/roman/roman-feature.guard';
import { JwtAuthGuard } from '../../src/auth/auth.guard';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../src/roman/roman.feature';
import type { RomanCaller } from '../../src/roman/roman.service';

// ─── flag harness ────────────────────────────────────────────────────────────
const FLAG = FEATURE_ROMAN_CHAT_ENABLED_ENV;
let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env[FLAG];
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

function flagOn() {
  process.env[FLAG] = 'true';
}
function flagOff() {
  delete process.env[FLAG];
}

// A minimal ExecutionContext stub for the feature guard (it only inspects the
// env flag, never the request, so an empty context is sufficient).
function fakeContext(): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({}),
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

// ─── controller doubles ──────────────────────────────────────────────────────
function makeSession(over: Partial<Record<string, unknown>> = {}) {
  const now = new Date('2026-06-09T12:00:00.000Z');
  return {
    id: 'sess_1',
    user_id: 'user-A',
    surface: 'client',
    day_key: '2026-06-09',
    message_count: 0,
    started_at: now,
    last_activity_at: now,
    ...over,
  };
}

function makeService() {
  // Untyped jest.fn() doubles (cast to `never` at the controller boundary), so
  // the recorded `.mock.calls` are `any[]` — avoids the strict empty-tuple
  // inference that a typed return value would impose.
  const openOrResumeSession = jest.fn((..._a: unknown[]) =>
    Promise.resolve(makeSession()),
  );
  const getOwnedSession = jest.fn((..._a: unknown[]) =>
    Promise.resolve(makeSession()),
  );
  const softDeleteSession = jest.fn((..._a: unknown[]) =>
    Promise.resolve(undefined),
  );
  const assertWithinRateLimit = jest.fn((..._a: unknown[]) =>
    Promise.resolve(undefined),
  );
  const appendMessage = jest.fn((..._a: unknown[]) =>
    Promise.resolve({
      id: 'msg_1',
      role: 'user',
      content: 'hi',
      interrupted: false,
      created_at: new Date('2026-06-09T12:00:01.000Z'),
    }),
  );
  const listMessages = jest.fn((..._a: unknown[]) =>
    Promise.resolve({
      messages: [
        {
          id: 'msg_2',
          role: 'roman',
          content: 'Welcome.',
          interrupted: false,
          created_at: new Date('2026-06-09T12:00:02.000Z'),
        },
      ],
      nextCursor: null,
    }),
  );
  // Async generator that yields one delta then done. Typed as `unknown` chunks
  // so mockImplementationOnce can return a throwing generator without a type
  // mismatch.
  const streamAssistantTurn = jest.fn(
    (..._a: unknown[]): AsyncGenerator<unknown> =>
      (async function* () {
        yield { type: 'delta', text: 'Hel' };
        yield { type: 'delta', text: 'lo' };
        yield {
          type: 'done',
          text: 'Hello',
          messageId: 'msg_3',
          interrupted: false,
        };
      })(),
  );
  return {
    openOrResumeSession,
    getOwnedSession,
    softDeleteSession,
    assertWithinRateLimit,
    appendMessage,
    listMessages,
    streamAssistantTurn,
  };
}

function makePrisma() {
  return {
    coachSubscription: {
      findUnique: jest.fn(async () => null), // no row → free tier
    },
  };
}

function makeController() {
  const service = makeService();
  const prisma = makePrisma();
  const ctrl = new RomanController(service as never, prisma as never);
  const req = {
    user: { id: 'user-A', role: 'student' },
    on: jest.fn(),
    off: jest.fn(),
  } as never;
  return { ctrl, service, prisma, req };
}

// A fake express Response capturing SSE writes.
function makeRes() {
  const writes: string[] = [];
  let head: { status?: number; headers?: Record<string, string> } = {};
  let ended = false;
  const res = {
    writeHead: jest.fn((status: number, headers: Record<string, string>): void => {
      head = { status, headers };
    }),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string): boolean => {
      writes.push(chunk);
      return true;
    }),
    end: jest.fn((): void => {
      ended = true;
    }),
  };
  return { res, writes, getHead: () => head, isEnded: () => ended };
}

// ─── 1. feature guard: flag-off → 404, flag-on → reachable (all 4 routes) ─────
describe('RomanFeatureGuard — flag gates the whole surface', () => {
  it('throws 404 (NotFoundException) on every route while the flag is OFF', () => {
    flagOff();
    const guard = new RomanFeatureGuard();
    expect(() => guard.canActivate(fakeContext())).toThrow(NotFoundException);
  });

  it('hides the feature existence — the 404 message is a generic not-found', () => {
    flagOff();
    const guard = new RomanFeatureGuard();
    try {
      guard.canActivate(fakeContext());
      throw new Error('guard should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      // 404, never 403 — must not leak that the route exists (ENGINEERING_RULES §3).
      expect((err as NotFoundException).getStatus()).toBe(404);
    }
  });

  it('passes through (returns true) once the flag is ON', () => {
    flagOn();
    const guard = new RomanFeatureGuard();
    expect(guard.canActivate(fakeContext())).toBe(true);
  });

  it('treats any non-exactly-"true" value as OFF (default-OFF invariant)', () => {
    // Resolution is exact (case-insensitive) on the literal 'true' — NOT
    // trimmed. So a stray space or any synonym is OFF, identical in every env.
    for (const v of ['1', 'yes', 'on', 'TRUE ', ' true', 'false', '']) {
      process.env[FLAG] = v;
      const guard = new RomanFeatureGuard();
      expect(() => guard.canActivate(fakeContext())).toThrow(NotFoundException);
    }
    // Case-insensitive match on the exact literal is ON.
    for (const v of ['true', 'TRUE', 'True']) {
      process.env[FLAG] = v;
      const guard = new RomanFeatureGuard();
      expect(guard.canActivate(fakeContext())).toBe(true);
    }
  });
});

// ─── 2. auth is required on every route (guard metadata) ──────────────────────
describe('RomanController — auth + feature guards mounted', () => {
  it('mounts JwtAuthGuard AND RomanFeatureGuard on the controller', () => {
    const guards = Reflect.getMetadata('__guards__', RomanController) as unknown[];
    expect(Array.isArray(guards)).toBe(true);
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(RomanFeatureGuard);
    // Order matters: authenticate first, then gate on the flag.
    expect(guards.indexOf(JwtAuthGuard)).toBeLessThan(
      guards.indexOf(RomanFeatureGuard),
    );
  });

  // The @UseGuards decorator is what attaches that metadata — sanity that the
  // controller class itself is decorated (not a per-method override).
  it('applies the guards at class scope', () => {
    @UseGuards(JwtAuthGuard, RomanFeatureGuard)
    class Probe {}
    const probeGuards = Reflect.getMetadata('__guards__', Probe) as unknown[];
    const ctrlGuards = Reflect.getMetadata('__guards__', RomanController) as unknown[];
    expect(ctrlGuards).toEqual(probeGuards);
  });
});

// ─── 3. handlers delegate to the service with the authed caller ───────────────
describe('RomanController — POST /roman/sessions (open or resume)', () => {
  it('opens/resumes for the authenticated caller and shapes the view', async () => {
    flagOn();
    const { ctrl, service, req } = makeController();
    const out = await ctrl.openSession(req, { surface: 'client' });

    expect(service.openOrResumeSession).toHaveBeenCalledTimes(1);
    const caller = (service.openOrResumeSession.mock.calls[0][0]) as unknown as RomanCaller;
    expect(caller.id).toBe('user-A');
    expect(caller.role).toBe('student');
    expect(caller.tier).toBe('free'); // no CoachSubscription row
    expect(service.openOrResumeSession.mock.calls[0][1]).toBe('client');

    // Response is the camelCase mobile view, not the raw row.
    expect(out).toMatchObject({
      id: 'sess_1',
      surface: 'client',
      messageCount: 0,
    });
    expect(out).toHaveProperty('startedAt');
    expect(out).toHaveProperty('lastActivityAt');
    expect(out).not.toHaveProperty('user_id'); // never leak owner column
  });

  it('resolves the pro tier when a CoachSubscription row exists', async () => {
    flagOn();
    const { ctrl, service, prisma, req } = makeController();
    prisma.coachSubscription.findUnique.mockResolvedValueOnce({ tier: 'pro' } as never);
    await ctrl.openSession(req, { surface: 'coach' });
    const caller = service.openOrResumeSession.mock.calls[0][0] as unknown as RomanCaller;
    expect(caller.tier).toBe('pro');
  });
});

describe('RomanController — GET /roman/sessions/:id/messages', () => {
  it('lists messages newest-first and forwards the cursor + limit', async () => {
    flagOn();
    const { ctrl, service, req } = makeController();
    const out = await ctrl.listMessages(req, 'sess_1', { cursor: 'msg_x', limit: 25 });

    expect(service.listMessages).toHaveBeenCalledTimes(1);
    expect(service.listMessages.mock.calls[0][1]).toBe('sess_1');
    expect(service.listMessages.mock.calls[0][2]).toMatchObject({
      cursor: 'msg_x',
      limit: 25,
    });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({ id: 'msg_2', role: 'roman' });
    expect(out.nextCursor).toBeNull();
    // Views never leak the owner / session columns.
    expect(out.messages[0]).not.toHaveProperty('user_id');
    expect(out.messages[0]).not.toHaveProperty('session_id');
  });
});

describe('RomanController — DELETE /roman/sessions/:id (soft delete)', () => {
  it('soft-deletes for the authenticated caller', async () => {
    flagOn();
    const { ctrl, service, req } = makeController();
    await ctrl.deleteSession(req, 'sess_1');
    expect(service.softDeleteSession).toHaveBeenCalledTimes(1);
    const caller = service.softDeleteSession.mock.calls[0][0] as unknown as RomanCaller;
    expect(caller.id).toBe('user-A');
    expect(service.softDeleteSession.mock.calls[0][1]).toBe('sess_1');
  });
});

// ─── 4. POST /messages — SSE happy path: rate-limit → persist user → stream ───
describe('RomanController — POST /roman/sessions/:id/messages (SSE)', () => {
  it('rate-limits, persists the user turn, then streams the assistant reply', async () => {
    flagOn();
    const { ctrl, service, req } = makeController();
    const { res, writes, getHead, isEnded } = makeRes();

    await ctrl.sendMessage(req, res as never, 'sess_1', { content: 'hi roman' });

    // Order of operations (brief §4): the cap is checked BEFORE we persist the
    // user turn, so a rejected turn never counts against the quota.
    expect(service.assertWithinRateLimit).toHaveBeenCalledTimes(1);
    expect(service.getOwnedSession).toHaveBeenCalledTimes(1);
    expect(service.appendMessage).toHaveBeenCalledTimes(1);
    expect(service.appendMessage.mock.calls[0][2]).toMatchObject({
      role: 'user',
      content: 'hi roman',
    });
    expect(service.streamAssistantTurn).toHaveBeenCalledTimes(1);

    // SSE headers.
    expect(getHead().status).toBe(200);
    expect(getHead().headers?.['Content-Type']).toBe('text/event-stream');
    expect(getHead().headers?.['Cache-Control']).toContain('no-cache');

    // Stream body: two deltas then a done frame, each as `data: …\n\n`.
    const body = writes.join('');
    expect(body).toContain('data: {"type":"delta","text":"Hel"}');
    expect(body).toContain('data: {"type":"delta","text":"lo"}');
    expect(body).toContain('"type":"done"');
    expect(body).toContain('"messageId":"msg_3"');
    expect(isEnded()).toBe(true);

    // The disconnect hook is wired (req.on('close', …)).
    expect((req as unknown as { on: jest.Mock }).on).toHaveBeenCalledWith(
      'close',
      expect.any(Function),
    );
  });

  it('emits a structured SSE error frame (never a raw stack) when streaming throws', async () => {
    flagOn();
    const { ctrl, service, req } = makeController();
    const { res, writes, isEnded } = makeRes();
    service.streamAssistantTurn.mockImplementationOnce(
      (): AsyncGenerator<unknown> =>
        (async function* () {
          throw { response: { code: 'ROMAN_UNAVAILABLE', message: 'down' } };
          // eslint-disable-next-line no-unreachable
          yield { type: 'done' };
        })(),
    );

    await ctrl.sendMessage(req, res as never, 'sess_1', { content: 'hi' });

    const body = writes.join('');
    expect(body).toContain('event: error');
    expect(body).toContain('ROMAN_UNAVAILABLE');
    // No stack / message leakage beyond the structured envelope.
    expect(body).not.toMatch(/at Object|node_modules|\.ts:\d+/);
    expect(isEnded()).toBe(true);
  });

  it('does not persist the user turn when the rate-limit gate rejects', async () => {
    flagOn();
    const { ctrl, service, req } = makeController();
    const { res } = makeRes();
    service.assertWithinRateLimit.mockRejectedValueOnce(
      Object.assign(new Error('rate limited'), {
        response: { code: 'ROMAN_RATE_LIMIT' },
      }),
    );

    await expect(
      ctrl.sendMessage(req, res as never, 'sess_1', { content: 'hi' }),
    ).rejects.toBeTruthy();

    expect(service.appendMessage).not.toHaveBeenCalled();
    expect(service.streamAssistantTurn).not.toHaveBeenCalled();
  });
});
