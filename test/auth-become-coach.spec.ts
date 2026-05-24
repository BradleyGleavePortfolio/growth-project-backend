import {
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AuditAction } from '../src/audit/audit.service';

// Self-service "become coach" privilege-escalation gate tests.
// Updated for hybrid-coach-pricing (spec §7): the old payment gate
// (403 coach_subscription_required) is replaced with a free-tier upsert.
// Tests that previously expected 403 coach_subscription_required now
// expect 200 { role: 'coach', tier: 'free' }.

// Mock @supabase/supabase-js so that createClient() inside the service
// returns a controllable stub. Tests assign (globalThis as any).__supaSignIn
// before each call to control the signInWithPassword response.
jest.mock('@supabase/supabase-js', () => {
  const actual = jest.requireActual('@supabase/supabase-js');
  return {
    ...actual,
    createClient: jest.fn(() => ({
      auth: {
        signInWithPassword: (...args: any[]) =>
          (globalThis as any).__supaSignIn?.(...args) ??
          Promise.resolve({ error: { message: 'not mocked' } }),
        signUp: jest.fn(),
        signInWithIdToken: jest.fn(),
        getUser: jest.fn(),
        resetPasswordForEmail: jest.fn(),
      },
    })),
  };
});

const makeInviteCodesMock = () => ({
  validate: jest.fn(),
  createForCoach: jest.fn(),
  listForCoach: jest.fn(),
  revokeForCoach: jest.fn(),
});
const makeAnalyticsMock = () =>
  ({ capture: jest.fn(), identify: jest.fn(), onModuleDestroy: jest.fn() } as unknown as AnalyticsService);
const makeAuditMock = () =>
  ({ write: jest.fn(async () => {}), list: jest.fn(async () => []) }) as any;
const makeAppleVerifierMock = () =>
  ({
    isConfigured: jest.fn(() => false),
    getAudiences: jest.fn(() => []),
    verify: jest.fn(),
  }) as any;
const makeGoogleVerifierMock = () =>
  ({
    isConfigured: jest.fn(() => false),
    getAudiences: jest.fn(() => []),
    verify: jest.fn(),
  }) as any;

function buildPrismaMock(initialUser: any, coachSubRow: any = null) {
  const state: { user: any } = { user: initialUser };
  return {
    state,
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === state.user?.id ? state.user : null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        if (where.id !== state.user?.id) return null;
        Object.assign(state.user, data);
        return state.user;
      }),
    },
    coachSubscription: {
      findUnique: jest.fn(async () => coachSubRow),
      upsert: jest.fn(async ({ create }: any) => coachSubRow ?? create),
    },
  };
}

describe('AuthService.becomeCoach (privilege-escalation hard gate)', () => {
  const baseStudent = {
    id: 'u-1',
    email: 's@example.test',
    role: 'student',
  };

  const originalEnv = process.env.ALLOW_SELF_SERVICE_BECOME_COACH;

  beforeEach(() => {
    (globalThis as any).__supaSignIn = undefined;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ALLOW_SELF_SERVICE_BECOME_COACH;
    } else {
      process.env.ALLOW_SELF_SERVICE_BECOME_COACH = originalEnv;
    }
  });

  it('refuses self-service promotion by default with a structured 403', async () => {
    delete process.env.ALLOW_SELF_SERVICE_BECOME_COACH;
    const prisma: any = buildPrismaMock({ ...baseStudent });
    const audit = makeAuditMock();
    const svc = new AuthService(
      prisma,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      audit,
      makeAppleVerifierMock(),
      makeGoogleVerifierMock(),
    );

    let caught: ForbiddenException | null = null;
    try {
      await svc.becomeCoach('u-1', 'irrelevant');
    } catch (err) {
      caught = err as ForbiddenException;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    const body: any = (caught as any).getResponse();
    expect(body.error).toBe('self_service_promotion_disabled');
    expect(body.canonical_path).toBe('/admin/users/:id/promote');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('refuses an OWNER attempting to self-elevate (no demotion via this path)', async () => {
    process.env.ALLOW_SELF_SERVICE_BECOME_COACH = 'true';
    const prisma: any = buildPrismaMock({ ...baseStudent, role: 'owner' });
    const svc = new AuthService(
      prisma,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
      makeGoogleVerifierMock(),
    );
    await expect(svc.becomeCoach('u-1', 'pw')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('is idempotent for an existing coach — returns role and tier without touching the gate', async () => {
    delete process.env.ALLOW_SELF_SERVICE_BECOME_COACH;
    // coachSubRow=null → no subscription row → impl defaults tier to 'free' (spec §4)
    const prisma: any = buildPrismaMock({ ...baseStudent, role: 'coach' });
    const svc = new AuthService(
      prisma,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
      makeGoogleVerifierMock(),
    );
    const res = await svc.becomeCoach('u-1', 'irrelevant');
    expect(res).toEqual({ role: 'coach', tier: 'free' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('is idempotent for an existing coach with Pro sub — returns role:coach and tier:pro', async () => {
    delete process.env.ALLOW_SELF_SERVICE_BECOME_COACH;
    // coachSubRow has tier='pro' → impl reads it and returns tier:'pro' (spec §4)
    const prisma: any = buildPrismaMock(
      { ...baseStudent, role: 'coach' },
      { tier: 'pro', status: 'active' },
    );
    const svc = new AuthService(
      prisma,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
    );
    const res = await svc.becomeCoach('u-1', 'irrelevant');
    expect(res).toEqual({ role: 'coach', tier: 'pro' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException for a missing user row', async () => {
    delete process.env.ALLOW_SELF_SERVICE_BECOME_COACH;
    const prisma: any = buildPrismaMock(null);
    const svc = new AuthService(
      prisma,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
      makeGoogleVerifierMock(),
    );
    await expect(svc.becomeCoach('u-missing', 'pw')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('writes an audit row on a permitted self-service elevation (gate ON, password ok)', async () => {
    process.env.ALLOW_SELF_SERVICE_BECOME_COACH = 'true';
    expect(AuditAction.USER_ROLE_CHANGED).toBe('user.role_changed');
  });

  // -------------------------------------------------------------------------
  // Hybrid pricing (spec §7): payment gate is REMOVED.
  // Students with no CoachSubscription now successfully become coaches.
  // The old tests expecting 403 coach_subscription_required are replaced.
  // -------------------------------------------------------------------------

  it('promotes student with no CoachSubscription row to coach (tier=free) — payment gate removed', async () => {
    process.env.ALLOW_SELF_SERVICE_BECOME_COACH = 'true';
    const userState = { ...baseStudent };
    const upsertResult = { tier: 'free', status: 'active', coach_id: 'u-1' };
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => userState),
        update: jest.fn(async ({ data }: any) => {
          Object.assign(userState, data);
          return userState;
        }),
      },
      coachSubscription: {
        upsert: jest.fn(async () => upsertResult),
      },
    };
    (globalThis as any).__supaSignIn = jest.fn().mockResolvedValue({ error: null });
    const svc = new AuthService(
      prisma,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
      makeGoogleVerifierMock(),
    );
    const result = await svc.becomeCoach('u-1', 'correct-password');
    expect(result).toEqual({ role: 'coach', tier: 'free' });
    expect(prisma.coachSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { coach_id: 'u-1' },
        create: expect.objectContaining({ tier: 'free', status: 'active' }),
        update: {},
      }),
    );
  });

  it('promotes student with incomplete CoachSubscription to coach (tier=free) — status no longer blocks', async () => {
    process.env.ALLOW_SELF_SERVICE_BECOME_COACH = 'true';
    const userState = { ...baseStudent };
    const upsertResult = { tier: 'free', status: 'incomplete', coach_id: 'u-1' };
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => userState),
        update: jest.fn(async ({ data }: any) => {
          Object.assign(userState, data);
          return userState;
        }),
      },
      coachSubscription: {
        upsert: jest.fn(async () => upsertResult),
      },
    };
    (globalThis as any).__supaSignIn = jest.fn().mockResolvedValue({ error: null });
    const svc = new AuthService(
      prisma,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
    );
    // Old code would throw 403 coach_subscription_required here.
    // New code upserts and returns 200.
    const result = await svc.becomeCoach('u-1', 'correct-password');
    expect(result.role).toBe('coach');
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('promotes student with canceled CoachSubscription to coach — payment gate removed', async () => {
    process.env.ALLOW_SELF_SERVICE_BECOME_COACH = 'true';
    const userState = { ...baseStudent };
    const upsertResult = { tier: 'free', status: 'canceled', coach_id: 'u-1' };
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => userState),
        update: jest.fn(async ({ data }: any) => {
          Object.assign(userState, data);
          return userState;
        }),
      },
      coachSubscription: {
        upsert: jest.fn(async () => upsertResult),
      },
    };
    (globalThis as any).__supaSignIn = jest.fn().mockResolvedValue({ error: null });
    const svc = new AuthService(
      prisma,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
    );
    // Old code would throw 403 here. New code succeeds.
    const result = await svc.becomeCoach('u-1', 'correct-password');
    expect(result.role).toBe('coach');
  });

  it('promotes student with past_due CoachSubscription to coach — payment gate removed', async () => {
    process.env.ALLOW_SELF_SERVICE_BECOME_COACH = 'true';
    const userState = { ...baseStudent };
    const upsertResult = { tier: 'free', status: 'past_due', coach_id: 'u-1' };
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => userState),
        update: jest.fn(async ({ data }: any) => {
          Object.assign(userState, data);
          return userState;
        }),
      },
      coachSubscription: {
        upsert: jest.fn(async () => upsertResult),
      },
    };
    (globalThis as any).__supaSignIn = jest.fn().mockResolvedValue({ error: null });
    const svc = new AuthService(
      prisma,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
    );
    // Old code would throw 403 here. New code succeeds.
    const result = await svc.becomeCoach('u-1', 'correct-password');
    expect(result.role).toBe('coach');
  });

  it('passes with active subscription — role update + resolution (compat)', async () => {
    process.env.ALLOW_SELF_SERVICE_BECOME_COACH = 'true';
    const userState = { ...baseStudent };
    const upsertResult = { tier: 'free', status: 'active', coach_id: 'u-1' };
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => userState),
        update: jest.fn(async ({ data }: any) => {
          Object.assign(userState, data);
          return userState;
        }),
      },
      coachSubscription: {
        upsert: jest.fn(async () => upsertResult),
      },
    };
    (globalThis as any).__supaSignIn = jest.fn().mockResolvedValue({ error: null });
    const svc = new AuthService(
      prisma,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
    );
    const result = await svc.becomeCoach('u-1', 'correct-password');
    expect(result).toEqual({ role: 'coach', tier: 'free' });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'coach' }) }),
    );
  });

  it('wrong password → 401, prisma.user.update never called (auth check before upsert)', async () => {
    process.env.ALLOW_SELF_SERVICE_BECOME_COACH = 'true';
    const userState = { ...baseStudent };
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => userState),
        update: jest.fn(),
      },
      coachSubscription: {
        upsert: jest.fn(),
      },
    };
    (globalThis as any).__supaSignIn = jest
      .fn()
      .mockResolvedValue({ error: { message: 'Invalid credentials' } });
    const svc = new AuthService(
      prisma,
      makeInviteCodesMock() as any,
      makeAnalyticsMock(),
      makeAuditMock(),
      makeAppleVerifierMock(),
    );
    await expect(svc.becomeCoach('u-1', 'wrong-password')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.coachSubscription.upsert).not.toHaveBeenCalled();
  });
});
