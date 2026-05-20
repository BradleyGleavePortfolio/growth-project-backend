/**
 * test/auth/become-coach.tier.spec.ts
 *
 * Tests for the already-coach idempotent becomeCoach path returning tier
 * per spec §4. A coach who calls becomeCoach again must receive { role, tier }
 * in the response rather than just { role }.
 */

import { AuthService } from '../../src/auth/auth.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';

jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return {
    ...actual,
    createClient: jest.fn(() => ({
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({ error: null }),
        signUp: jest.fn(),
        signInWithIdToken: jest.fn(),
        getUser: jest.fn(),
        resetPasswordForEmail: jest.fn(),
      },
    })),
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeAnalytics = (): AnalyticsService =>
  ({ capture: jest.fn(), identify: jest.fn(), onModuleDestroy: jest.fn() } as any);

const makeAudit = () =>
  ({ write: jest.fn(async () => {}), list: jest.fn(async () => []) }) as any;

const makeAppleVerifier = () =>
  ({
    isConfigured: jest.fn(() => false),
    getAudiences: jest.fn(() => []),
    verify: jest.fn(),
  }) as any;

const makeInviteCodes = () => ({
  validate: jest.fn(),
  createForCoach: jest.fn(),
  listForCoach: jest.fn(),
  revokeForCoach: jest.fn(),
});

/**
 * Build a Prisma mock for the already-coach idempotent path.
 * @param coachUser - User row (role='coach')
 * @param subRow    - CoachSubscription row or null (for pre-migration coaches)
 */
function makePrismaAlreadyCoach(coachUser: any, subRow: any | null) {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(coachUser),
      update: jest.fn(),
    },
    coachSubscription: {
      findUnique: jest.fn().mockResolvedValue(subRow),
      upsert: jest.fn(),
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('becomeCoach — already-coach idempotent path returns tier (spec §4)', () => {
  beforeEach(() => {
    process.env.ALLOW_SELF_SERVICE_BECOME_COACH = 'true';
  });

  afterEach(() => {
    delete process.env.ALLOW_SELF_SERVICE_BECOME_COACH;
  });

  // Case: existing coach with active Pro sub calls becomeCoach again
  // → returns { role: 'coach', tier: 'pro' }
  it('existing coach with active Pro sub → returns { role: "coach", tier: "pro" }', async () => {
    const coachUser = { id: 'coach-1', email: 'coach@test.com', role: 'coach' };
    const proSub = { coach_id: 'coach-1', tier: 'pro', status: 'active' };

    const prisma = makePrismaAlreadyCoach(coachUser, proSub);

    const svc = new AuthService(
      prisma as any,
      makeInviteCodes() as any,
      makeAnalytics(),
      makeAudit(),
      makeAppleVerifier(),
    );

    const result = await svc.becomeCoach('coach-1', 'any-password');

    expect(result).toEqual({ role: 'coach', tier: 'pro' });

    // The findUnique for the user was called (to verify role)
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'coach-1' } });

    // The CoachSubscription was read for the tier
    expect(prisma.coachSubscription.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { coach_id: 'coach-1' } }),
    );

    // No role promotion attempted — already a coach
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.coachSubscription.upsert).not.toHaveBeenCalled();
  });

  // Edge case: existing coach with no CoachSubscription row (pre-migration)
  // → returns { role: 'coach', tier: 'free' }
  it('existing coach with no subscription row (pre-migration) → returns { role: "coach", tier: "free" }', async () => {
    const coachUser = { id: 'coach-legacy', email: 'legacy@test.com', role: 'coach' };

    const prisma = makePrismaAlreadyCoach(coachUser, null); // no sub row

    const svc = new AuthService(
      prisma as any,
      makeInviteCodes() as any,
      makeAnalytics(),
      makeAudit(),
      makeAppleVerifier(),
    );

    const result = await svc.becomeCoach('coach-legacy', 'any-password');

    expect(result).toEqual({ role: 'coach', tier: 'free' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
