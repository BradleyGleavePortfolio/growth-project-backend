import { CoachEffectivenessController } from '../src/coach/coach-effectiveness.controller';
import { CoachGuard } from '../src/auth/coach.guard';
import { ForbiddenException } from '@nestjs/common';

// EFF-2 — GET /coach/my-effectiveness.
//
// Asserts:
//   (a) the route returns the CALLING coach's own latest score, scoped to
//       req.user.id (no path/query lets a caller name another coach);
//   (b) when no score exists yet it computes a fresh one via the scoring
//       service (still scoped to the caller);
//   (c) it is role-guarded by CoachGuard (student → 403; coach/owner → ok);
//   (d) no cross-coach leak — a coach only ever resolves their own id.

function buildEffectiveness() {
  const store: Record<string, any> = {
    'coach-1': { id: 'ces-1', coach_id: 'coach-1', score: 82, bucket: 'high-performer' },
    'coach-2': { id: 'ces-2', coach_id: 'coach-2', score: 40, bucket: 'developing' },
  };
  return {
    store,
    getLatest: jest.fn(async (coachId: string) => store[coachId] ?? null),
    score: jest.fn(async (coachId: string) => ({
      id: `fresh-${coachId}`,
      coach_id: coachId,
      score: 10,
      bucket: 'developing',
    })),
  };
}

function makeReq(user: any) {
  return { user } as any;
}

describe('CoachEffectivenessController — EFF-2 /coach/my-effectiveness', () => {
  it('returns the calling coach\'s own latest score (scoped to req.user.id)', async () => {
    const eff = buildEffectiveness();
    const ctrl = new CoachEffectivenessController(eff as any);

    const res = await ctrl.myEffectiveness(makeReq({ id: 'coach-1', role: 'coach' }));

    expect(eff.getLatest).toHaveBeenCalledWith('coach-1');
    expect(res.coach_id).toBe('coach-1');
    expect(res.score).toBe(82);
  });

  it('does NOT leak another coach\'s score — caller id is the only input', async () => {
    const eff = buildEffectiveness();
    const ctrl = new CoachEffectivenessController(eff as any);

    const res = await ctrl.myEffectiveness(makeReq({ id: 'coach-2', role: 'coach' }));

    // Even though coach-1 has a higher score in the store, coach-2 only ever
    // gets their own row back. getLatest was never called with a peer id.
    expect(res.coach_id).toBe('coach-2');
    expect(res.score).toBe(40);
    expect(eff.getLatest).toHaveBeenCalledTimes(1);
    expect(eff.getLatest).toHaveBeenCalledWith('coach-2');
    expect(eff.getLatest).not.toHaveBeenCalledWith('coach-1');
  });

  it('computes a fresh score via the service when none is persisted yet', async () => {
    const eff = buildEffectiveness();
    const ctrl = new CoachEffectivenessController(eff as any);

    const res = await ctrl.myEffectiveness(makeReq({ id: 'coach-new', role: 'coach' }));

    expect(eff.getLatest).toHaveBeenCalledWith('coach-new');
    expect(eff.score).toHaveBeenCalledWith('coach-new');
    expect(res.coach_id).toBe('coach-new');
  });

  // ── Role guard ─────────────────────────────────────────────────────────
  const guard = new CoachGuard();
  const ctx = (user: any) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;

  it('is role-guarded: a student is rejected (403)', () => {
    expect(() => guard.canActivate(ctx({ id: 's1', role: 'student' }))).toThrow(
      ForbiddenException,
    );
  });

  it('allows coaches and owners through the guard', () => {
    expect(guard.canActivate(ctx({ id: 'c1', role: 'coach' }))).toBe(true);
    expect(guard.canActivate(ctx({ id: 'o1', role: 'owner' }))).toBe(true);
  });
});
