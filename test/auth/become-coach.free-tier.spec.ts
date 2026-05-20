/**
 * test/auth/become-coach.free-tier.spec.ts
 *
 * Tests for the new free-tier becomeCoach path (spec §10 — 4 required cases).
 *
 * These tests focus specifically on:
 *   1. No prior CoachSubscription → row created with tier='free', returns 200
 *   2. Existing tier='pro' row → row left untouched, returns 200 { tier: 'pro' }
 *   3. Wrong password → 401 (auth check runs before upsert)
 *   4. Audit log entry written on successful become-coach
 *
 * Setup:
 *   - Supabase is mocked via jest.mock('@supabase/supabase-js').
 *   - Prisma coachSubscription.upsert is mocked to return configured results.
 *   - ALLOW_SELF_SERVICE_BECOME_COACH=true for all tests in this file.
 */

import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../../src/auth/auth.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { AuditAction } from '../../src/audit/audit.service';

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

/** Build a Prisma mock for becomeCoach tests.
 *  @param user        - User row returned by findUnique.
 *  @param upsertReturn - Value returned by coachSubscription.upsert.
 */
function makePrisma(user: any, upsertReturn: any) {
  const state = { user: { ...user } };
  return {
    state,
    user: {
      findUnique: jest.fn(async () => state.user),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(state.user, data);
        return state.user;
      }),
    },
    coachSubscription: {
      upsert: jest.fn(async () => upsertReturn),
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('becomeCoach — free tier path (spec §10)', () => {
  const baseStudent = { id: 'u-free-1', email: 'student@test.com', role: 'student' };

  beforeEach(() => {
    process.env.ALLOW_SELF_SERVICE_BECOME_COACH = 'true';
    (globalThis as any).__supaSignIn = undefined;
  });

  afterEach(() => {
    delete process.env.ALLOW_SELF_SERVICE_BECOME_COACH;
  });

  // Case 1: student with no prior CoachSubscription becomes coach
  //   → row created with tier='free', status='active'
  //   → returns 200 { role: 'coach', tier: 'free' }
  it('student with no prior CoachSubscription → row created tier="free" status="active", returns { role:"coach", tier:"free" }', async () => {
    const upsertResult = { coach_id: baseStudent.id, tier: 'free', status: 'active' };
    const prisma = makePrisma(baseStudent, upsertResult);
    (globalThis as any).__supaSignIn = jest.fn().mockResolvedValue({ error: null });

    const svc = new AuthService(
      prisma as any,
      makeInviteCodes() as any,
      makeAnalytics(),
      makeAudit(),
      makeAppleVerifier(),
    );

    const result = await svc.becomeCoach(baseStudent.id, 'correct-password');

    // Return shape includes tier
    expect(result).toEqual({ role: 'coach', tier: 'free' });

    // Upsert was called with correct create payload
    expect(prisma.coachSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { coach_id: baseStudent.id },
        create: expect.objectContaining({
          coach_id: baseStudent.id,
          tier: 'free',
          status: 'active',
        }),
        update: {}, // empty — never overwrite existing row
      }),
    );

    // Role was promoted
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'coach' }) }),
    );
  });

  // Case 2: student with existing tier='pro' row hits becomeCoach (edge case)
  //   → row left untouched (update: {})
  //   → returns 200 { role: 'coach', tier: 'pro' }
  it('student with existing tier="pro" row → row left untouched, returns { role:"coach", tier:"pro" }', async () => {
    // The upsert returns the existing pro row (update: {} was applied, row unchanged)
    const existingProRow = { coach_id: baseStudent.id, tier: 'pro', status: 'active' };
    const prisma = makePrisma(baseStudent, existingProRow);
    (globalThis as any).__supaSignIn = jest.fn().mockResolvedValue({ error: null });

    const svc = new AuthService(
      prisma as any,
      makeInviteCodes() as any,
      makeAnalytics(),
      makeAudit(),
      makeAppleVerifier(),
    );

    const result = await svc.becomeCoach(baseStudent.id, 'correct-password');

    // Tier preserved from existing row
    expect(result).toEqual({ role: 'coach', tier: 'pro' });

    // Upsert update clause was empty (no overwrite of tier)
    expect(prisma.coachSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {}, // critically: NOT { tier: 'free' }
      }),
    );
  });

  // Case 3: wrong password → 401 (auth check runs before upsert)
  it('wrong password → throws UnauthorizedException; upsert NOT called', async () => {
    const prisma = makePrisma(baseStudent, { tier: 'free', status: 'active' });
    (globalThis as any).__supaSignIn = jest
      .fn()
      .mockResolvedValue({ error: { message: 'Invalid credentials' } });

    const svc = new AuthService(
      prisma as any,
      makeInviteCodes() as any,
      makeAnalytics(),
      makeAudit(),
      makeAppleVerifier(),
    );

    await expect(
      svc.becomeCoach(baseStudent.id, 'wrong-password'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Password verification runs BEFORE the upsert — upsert never called
    expect(prisma.coachSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // Case 4: audit log entry is written on successful become-coach
  it('audit log entry written on successful become-coach', async () => {
    const upsertResult = { coach_id: baseStudent.id, tier: 'free', status: 'active' };
    const prisma = makePrisma(baseStudent, upsertResult);
    const audit = makeAudit();
    (globalThis as any).__supaSignIn = jest.fn().mockResolvedValue({ error: null });

    const svc = new AuthService(
      prisma as any,
      makeInviteCodes() as any,
      makeAnalytics(),
      audit,
      makeAppleVerifier(),
    );

    await svc.becomeCoach(baseStudent.id, 'correct-password');

    // Audit row was written
    expect(audit.write).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.USER_ROLE_CHANGED,
        actorId: baseStudent.id,
        targetUserId: baseStudent.id,
        metadata: expect.objectContaining({
          from: 'student',
          to: 'coach',
          via: 'self_service_become_coach',
        }),
      }),
    );
  });
});
