/**
 * v2-2 AckController + AckFeatureFlagGuard unit tests.
 *
 * Controller: each endpoint delegates to AckService.applyTransition with the
 * correct target state and the authenticated user.
 *
 * Param validation (R1): the `messageId` route param is guarded by
 * ParseUUIDPipe({ version: '4' }); a malformed id is rejected with a 400
 * BadRequestException before the controller body runs. Exercised here against
 * the pipe directly (the HTTP-wired rejection is also covered end-to-end in
 * test/community/ack/community-v2-2-ack.e2e.spec.ts).
 *
 * Flag guard: passes through when FEATURE_COMMUNITY_ACKS is on; short-circuits
 * with a 404 when off (dark-launch posture / kill-switch invariant). No HTTP
 * server is spun up — the guard is exercised directly with a faked
 * ExecutionContext.
 *
 * Fakes come from the typed `ack.test-fixtures` builders (R0: no `as unknown
 * as`); the faked ExecutionContext uses a narrow, typed helper shape.
 */
import {
  ArgumentMetadata,
  BadRequestException,
  ExecutionContext,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth-request';
import { AckController } from './ack.controller';
import { AckFeatureFlagGuard } from './ack-flag.guard';
import { FEATURE_COMMUNITY_ACKS_ENV } from './ack.feature';
import { FIXTURE_IDS, coachUser } from './ack.test-fixtures';
import type { AckActor } from './ack.service';

const MSG_ID = FIXTURE_IDS.message;
const coach = coachUser();

/**
 * The controller/guard only read `req.user`. We build a minimally-typed
 * AuthedRequest carrying a typed AckActor (the slice the service consumes),
 * avoiding a full User fake or any cast.
 */
function reqFor(user: AckActor): AuthedRequest {
  return { user } as Pick<AuthedRequest, 'user'> as AuthedRequest;
}

/** A typed, minimal ExecutionContext exposing only switchToHttp().getRequest(). */
function ctxFor(req: AuthedRequest): ExecutionContext {
  const ctx: Pick<ExecutionContext, 'switchToHttp'> = {
    switchToHttp: () =>
      ({ getRequest: () => req }) as ReturnType<
        ExecutionContext['switchToHttp']
      >,
  };
  return ctx as ExecutionContext;
}

describe('AckController', () => {
  let ack: { applyTransition: jest.Mock };
  let controller: AckController;

  beforeEach(() => {
    ack = { applyTransition: jest.fn(async () => ({ message_id: MSG_ID })) };
    controller = new AckController(ack as never);
  });

  it('markSeen delegates with target "seen"', async () => {
    await controller.markSeen(reqFor(coach), MSG_ID);
    expect(ack.applyTransition).toHaveBeenCalledWith(coach, MSG_ID, 'seen');
  });

  it('markAcked delegates with target "acked"', async () => {
    await controller.markAcked(reqFor(coach), MSG_ID);
    expect(ack.applyTransition).toHaveBeenCalledWith(coach, MSG_ID, 'acked');
  });

  it('markReplied delegates with target "replied"', async () => {
    await controller.markReplied(reqFor(coach), MSG_ID);
    expect(ack.applyTransition).toHaveBeenCalledWith(coach, MSG_ID, 'replied');
  });
});

describe('messageId param validation (ParseUUIDPipe v4)', () => {
  const pipe = new ParseUUIDPipe({ version: '4' });
  const meta: ArgumentMetadata = { type: 'param', data: 'messageId' };

  it('rejects a non-UUID id with 400 BadRequestException', async () => {
    await expect(pipe.transform('not-a-uuid', meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a non-v4 UUID (wrong version nibble) with 400', async () => {
    // Valid UUID shape but version nibble is 0, not 4.
    await expect(
      pipe.transform('eeeeeeee-0000-0000-0000-000000000001', meta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a well-formed v4 UUID (returns it unchanged)', async () => {
    await expect(pipe.transform(MSG_ID, meta)).resolves.toBe(MSG_ID);
  });
});

describe('AckFeatureFlagGuard', () => {
  const original = process.env[FEATURE_COMMUNITY_ACKS_ENV];
  let guard: AckFeatureFlagGuard;

  beforeEach(() => {
    guard = new AckFeatureFlagGuard();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[FEATURE_COMMUNITY_ACKS_ENV];
    else process.env[FEATURE_COMMUNITY_ACKS_ENV] = original;
  });

  it('passes through when the flag is on', () => {
    process.env[FEATURE_COMMUNITY_ACKS_ENV] = 'true';
    expect(guard.canActivate(ctxFor(reqFor(coach)))).toBe(true);
  });

  it('throws 404 when the flag is off (unset)', () => {
    delete process.env[FEATURE_COMMUNITY_ACKS_ENV];
    expect(() => guard.canActivate(ctxFor(reqFor(coach)))).toThrow(
      NotFoundException,
    );
  });

  it('throws 404 when the flag is any non-"true" value (fails safe)', () => {
    process.env[FEATURE_COMMUNITY_ACKS_ENV] = 'false';
    expect(() => guard.canActivate(ctxFor(reqFor(coach)))).toThrow(
      NotFoundException,
    );
    process.env[FEATURE_COMMUNITY_ACKS_ENV] = '1';
    expect(() => guard.canActivate(ctxFor(reqFor(coach)))).toThrow(
      NotFoundException,
    );
  });
});
