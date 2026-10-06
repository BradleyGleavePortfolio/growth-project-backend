// test/roman/roman-sse-error-contract.spec.ts
//
// B-626-2 — cross-repo contract pin for Roman's in-stream `event: error`
// frame (POST /roman/sessions/:id/messages).
//
// The mobile app parses the frame with a STRICT schema
// (growth-project-mobile `src/api/romanApi.ts`):
//
//   export const RomanStreamErrorSchema = z
//     .object({ code: z.string(), message: z.string() })
//     .strict();
//
// and throws RomanWireError (contract drift) on any extra key, which turns a
// consent refusal or the calm ROMAN_UNAVAILABLE state into a generic error.
// `MOBILE_ROMAN_STREAM_ERROR_SCHEMA` below is that schema verbatim. Every
// error the stream can throw is driven through the REAL controller and the
// written frame must pass it, carry exactly ROMAN_SSE_ERROR_KEYS, and keep
// the original machine code. The reference travels in the X-Request-ID
// header, never in the frame. If the mobile schema changes, change it here in
// the same release and update ROMAN_SSE_ERROR_KEYS.

import 'reflect-metadata';
import {
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { RomanController } from '../../src/roman/roman.controller';
import type { RomanService } from '../../src/roman/roman.service';
import {
  ROMAN_SSE_ERROR_KEYS,
  ROMAN_SSE_FALLBACK_ERROR,
  toRomanSseErrorFrame,
} from '../../src/roman/roman-sse-error';
import {
  AI_CONSENT_REQUIRED_CLIENT_MESSAGE,
  AI_CONSENT_REQUIRED_CODE,
  AI_CONSENT_REQUIRED_COACH_MESSAGE,
  AI_EGRESS_POLICY_CODE,
  AI_EGRESS_POLICY_MESSAGE,
  AiConsentRequiredException,
  AiEgressPolicyException,
} from '../../src/ai-egress/ai-consent-required.exception';
import { ROMAN_ERROR_UNAVAILABLE } from '../../src/roman/roman.constants';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

/** Verbatim copy of mobile `RomanStreamErrorSchema` (src/api/romanApi.ts). */
const MOBILE_ROMAN_STREAM_ERROR_SCHEMA = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();

function controllerThatThrows(thrown: unknown) {
  const service = {
    assertWithinRateLimit: jest.fn(async () => undefined),
    getOwnedSession: jest.fn(async () => ({ id: 'sess_1' })),
    assertMayUseAi: jest.fn(async () => undefined),
    assertDailyCapacity: jest.fn(async () => undefined),
    assertCoachPoolOpen: jest.fn(async () => null),
    isSafetyShortCircuit: jest.fn(() => false),
    appendMessage: jest.fn(async () => ({ id: 'm1' })),
    // eslint-disable-next-line require-yield
    streamAssistantTurn: jest.fn(async function* () {
      throw thrown;
    }),
  };
  return new RomanController(
    fakeOf<RomanService>(service),
    fakeOf({ coachSubscription: { findUnique: jest.fn(async () => null) } }),
  );
}

function fakeReq(requestId?: string) {
  return {
    user: { id: 'user-A', role: 'student' },
    ...(requestId ? { requestId } : {}),
    on: jest.fn(),
    off: jest.fn(),
  };
}

function fakeRes() {
  const writes: string[] = [];
  const res = {
    writeHead: jest.fn((_status: number, _headers: Record<string, string>): void => undefined),
    flushHeaders: jest.fn(),
    write: jest.fn((c: string): boolean => {
      writes.push(c);
      return true;
    }),
    end: jest.fn(),
  };
  return { res, writes };
}

/** The SSE error frames exactly as the mobile buffered parser splits them. */
function errorFrames(writes: string[]): unknown[] {
  return writes
    .join('')
    .split(/\n\n/)
    .map((f) => f.trim())
    .filter((f) =>
      f.split('\n').some((l) => l.startsWith('event:') && l.slice(6).trim() === 'error'),
    )
    .map((f) =>
      JSON.parse(
        f
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice('data:'.length).trim())
          .join('\n'),
      ),
    );
}

async function frameFor(thrown: unknown, requestId = 'req_b6262') {
  const ctrl = controllerThatThrows(thrown);
  const { res, writes } = fakeRes();
  await ctrl.sendMessage(fakeOf(fakeReq(requestId)), fakeOf(res), 'sess_1', { content: 'hi' });
  const frames = errorFrames(writes);
  expect(frames).toHaveLength(1);
  return { frame: frames[0], res };
}

describe('Roman SSE error frame: pinned to the mobile strict parser (B-626-2)', () => {
  it('the backend key allowlist is exactly the mobile schema keys', () => {
    expect([...ROMAN_SSE_ERROR_KEYS].sort()).toEqual(
      Object.keys(MOBILE_ROMAN_STREAM_ERROR_SCHEMA.shape).sort(),
    );
  });

  it('negative control: the mobile schema rejects a frame with an extra requestId key', () => {
    const drifted = {
      code: AI_EGRESS_POLICY_CODE,
      message: AI_EGRESS_POLICY_MESSAGE,
      requestId: 'r1',
    };
    expect(MOBILE_ROMAN_STREAM_ERROR_SCHEMA.safeParse(drifted).success).toBe(false);
  });

  const cases: Array<[string, () => unknown, { code: string; message: string }]> = [
    [
      'client consent refusal',
      () => new AiConsentRequiredException('client'),
      { code: AI_CONSENT_REQUIRED_CODE, message: AI_CONSENT_REQUIRED_CLIENT_MESSAGE },
    ],
    [
      'coach-audience consent refusal',
      () => new AiConsentRequiredException('coach'),
      { code: AI_CONSENT_REQUIRED_CODE, message: AI_CONSENT_REQUIRED_COACH_MESSAGE },
    ],
    [
      'egress policy refusal (503)',
      () => new AiEgressPolicyException(),
      { code: AI_EGRESS_POLICY_CODE, message: AI_EGRESS_POLICY_MESSAGE },
    ],
    [
      'ROMAN_UNAVAILABLE (flag or client missing)',
      () =>
        new ServiceUnavailableException({
          code: ROMAN_ERROR_UNAVAILABLE,
          message: 'Roman is not available right now.',
        }),
      { code: ROMAN_ERROR_UNAVAILABLE, message: 'Roman is not available right now.' },
    ],
    [
      'a structured body with extra keys (retryAfterSeconds, requestId, statusCode)',
      () =>
        new HttpException(
          {
            code: 'ROMAN_RATE_LIMIT',
            message: 'You have reached the Roman conversation limit for now.',
            retryAfterSeconds: 30,
            requestId: 'leak',
            statusCode: 429,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      {
        code: 'ROMAN_RATE_LIMIT',
        message: 'You have reached the Roman conversation limit for now.',
      },
    ],
    [
      'a NestJS default body without a code',
      () => new NotFoundException('Roman session not found'),
      ROMAN_SSE_FALLBACK_ERROR,
    ],
    [
      'a raw Error (never leaks its text)',
      () => new Error('ECONNRESET sk-ant-secret'),
      ROMAN_SSE_FALLBACK_ERROR,
    ],
    ['a non-object throw', () => 'boom', ROMAN_SSE_FALLBACK_ERROR],
  ];

  it.each(cases)(
    '%s: passes the mobile strict schema with exactly {code, message}',
    async (_name, make, expected) => {
      const { frame, res } = await frameFor(make());
      const parsed = MOBILE_ROMAN_STREAM_ERROR_SCHEMA.safeParse(frame);
      expect(parsed.success).toBe(true);
      expect(Object.keys(frame as object).sort()).toEqual([...ROMAN_SSE_ERROR_KEYS].sort());
      expect(frame).toEqual(expected);
      // The reference is on the response header, not in the frame.
      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ 'X-Request-ID': 'req_b6262' }),
      );
      expect(JSON.stringify(frame)).not.toContain('req_b6262');
    },
  );

  it('no request id on the request: no X-Request-ID override, frame unchanged', async () => {
    const ctrl = controllerThatThrows(new AiEgressPolicyException());
    const { res, writes } = fakeRes();
    await ctrl.sendMessage(fakeOf(fakeReq()), fakeOf(res), 'sess_1', { content: 'hi' });
    const headers = res.writeHead.mock.calls[0][1];
    expect(headers).not.toHaveProperty('X-Request-ID');
    expect(errorFrames(writes)).toEqual([
      { code: AI_EGRESS_POLICY_CODE, message: AI_EGRESS_POLICY_MESSAGE },
    ]);
  });

  it('toRomanSseErrorFrame never returns the shared fallback object itself', () => {
    const a = toRomanSseErrorFrame(new Error('x'));
    a.code = 'mutated';
    expect(toRomanSseErrorFrame(new Error('y')).code).toBe(ROMAN_ERROR_UNAVAILABLE);
  });
});
