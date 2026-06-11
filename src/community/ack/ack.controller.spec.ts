/**
 * v2-2 AckController + AckFeatureFlagGuard unit tests.
 *
 * Controller: each endpoint delegates to AckService.applyTransition with the
 * correct target state and the authenticated user.
 *
 * Flag guard: passes through when FEATURE_COMMUNITY_ACKS is on; short-circuits
 * with a 404 when off (dark-launch posture / kill-switch invariant). No HTTP
 * server is spun up — the guard is exercised directly with a faked
 * ExecutionContext.
 */
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth-request';
import type { User } from '@prisma/client';
import { AckController } from './ack.controller';
import { AckFeatureFlagGuard } from './ack-flag.guard';
import { FEATURE_COMMUNITY_ACKS_ENV } from './ack.feature';

const MSG_ID = 'eeeeeeee-0000-0000-0000-000000000001';
const coach = {
  id: 'cccccccc-0000-0000-0000-00000000000a',
  role: 'coach',
} as unknown as User;

function reqFor(user: User): AuthedRequest {
  return { user } as AuthedRequest;
}

function ctxFor(req: AuthedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
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
