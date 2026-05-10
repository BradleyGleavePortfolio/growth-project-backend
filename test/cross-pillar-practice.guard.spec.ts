// Stage 3 — cross-pillar practice guard.
//
// The mobile app routes coaches with `null` / single-pillar practice
// types AWAY from the cross-pillar navigator, but the guard is the
// belt-and-suspenders enforcement at the API boundary. Tests pin all
// four allow/deny outcomes.

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CrossPillarPracticeGuard } from '../src/coach/cross-pillar/cross-pillar-practice.guard';

function ctxFor(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('CrossPillarPracticeGuard', () => {
  const guard = new CrossPillarPracticeGuard();

  it('allows a coach with practice_type = both', () => {
    expect(guard.canActivate(ctxFor({ role: 'coach', coach_practice_type: 'both' }))).toBe(true);
  });

  it('allows an owner with practice_type = both', () => {
    expect(guard.canActivate(ctxFor({ role: 'owner', coach_practice_type: 'both' }))).toBe(true);
  });

  it('rejects a coach with practice_type = fitness_only', () => {
    expect(() =>
      guard.canActivate(
        ctxFor({ role: 'coach', coach_practice_type: 'fitness_only' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects a coach with practice_type = finance_only', () => {
    expect(() =>
      guard.canActivate(
        ctxFor({ role: 'coach', coach_practice_type: 'finance_only' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects a coach with practice_type = null with PRACTICE_NOT_SELECTED', () => {
    try {
      guard.canActivate(ctxFor({ role: 'coach', coach_practice_type: null }));
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const body = (err as ForbiddenException).getResponse() as { code?: string };
      expect(body.code).toBe('PRACTICE_NOT_SELECTED');
    }
  });

  it('rejects when req.user is missing', () => {
    expect(() => guard.canActivate(ctxFor(undefined))).toThrow(ForbiddenException);
  });

  it('does NOT auto-allow owners regardless of practice type', () => {
    // Owner who runs fitness-only should not see cross-pillar data.
    expect(() =>
      guard.canActivate(
        ctxFor({ role: 'owner', coach_practice_type: 'fitness_only' }),
      ),
    ).toThrow(ForbiddenException);
  });
});
