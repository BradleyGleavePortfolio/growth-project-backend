import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AdminService } from '../src/admin/admin.service';
import { InviteCodesService } from '../src/invite-codes/invite-codes.service';
import { AuthService } from '../src/auth/auth.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { MessagingService } from '../src/messaging/messaging.service';
import { SubscriptionGuard } from '../src/billing/subscription.guard';

// End-to-end smoke spec for the merged SaaS flow. Each describe block lines
// up with one step in the manual runbook (docs/e2e-qa-runbook.md):
//
//   1. Owner promotes a user to coach + CoachProfile/invite_code is minted
//   2. Mobile fetches /auth/signup-policy and previews the invite code
//   3. Client signs up with code (gate enforced when COACH_CODE_GATE_ENABLED=true)
//   4. Google-auth client attaches the invite code in a follow-up call
//   5. Client logs data → AI context surfaces it for /ai/chat
//   6. Coach <-> client thread sends + unread counts work
//   7. SubscriptionGuard gates writes per BILLING_ENFORCEMENT
//
// Prisma is mocked per-step (we don't bring up a DB). Supabase + Stripe are
// not invoked: the AuthService entry points we exercise here (signup-policy,
// signupWithCode gating, attach via invite-codes) avoid hitting Supabase, and
// the SubscriptionGuard is a pure read of the mirror row.

function fakeClientAttach() {
  // Build a minimal Prisma surface for InviteCodesService.attachUserToCoachByCode
  // and AuthService.signupWithCode. Used by both auth alias and Google paths.
  const users: Record<string, any> = {};
  const profiles: Record<string, any> = {};
  return {
    coachProfile: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.invite_code) {
          return Object.values(profiles).find((p: any) => p.invite_code === where.invite_code) ?? null;
        }
        if (where.user_id) return profiles[where.user_id] ?? null;
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `cp-${Object.keys(profiles).length + 1}`, ...data };
        profiles[data.user_id] = row;
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = profiles[where.user_id];
        Object.assign(row, data);
        return row;
      }),
    },
    inviteCode: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => users[where.id] ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const row = users[where.id];
        Object.assign(row, data);
        return row;
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn({
      inviteCode: { findUnique: jest.fn(), updateMany: jest.fn() },
      user: {
        update: jest.fn(async ({ where, data }: any) => {
          const row = users[where.id];
          Object.assign(row, data);
          return row;
        }),
      },
    })),
    _users: users,
    _profiles: profiles,
  };
}

describe('E2E SaaS smoke — owner -> coach -> client -> AI -> messaging -> billing', () => {
  // ---- 1. Owner promotes a user to coach ----------------------------------
  describe('1. owner promotes user to coach + mints CoachProfile', () => {
    function buildAdmin() {
      const owner = {
        id: 'owner-1',
        email: 'o@o.test',
        name: 'Owner',
        role: 'owner',
        coach_id: null,
      };
      const target = {
        id: 'u-target',
        email: 'jay@coach.test',
        name: 'Jay',
        role: 'student',
        coach_id: null,
      };
      const profiles: any[] = [];
      const prisma: any = {
        user: {
          findUnique: jest.fn(async ({ where }: any) => {
            if (where.id === target.id) return target;
            if (where.id === owner.id) return owner;
            return null;
          }),
          update: jest.fn(async ({ where, data }: any) => {
            const row = where.id === target.id ? target : where.id === owner.id ? owner : null;
            if (!row) return null;
            Object.assign(row, data);
            return row;
          }),
          findMany: jest.fn(),
        },
        coachProfile: {
          findUnique: jest.fn(async ({ where }: any) =>
            profiles.find((p) => p.user_id === where.user_id) ?? null,
          ),
          create: jest.fn(async ({ data }: any) => {
            const row = { id: `cp-${profiles.length + 1}`, ...data };
            profiles.push(row);
            return row;
          }),
        },
      };
      const analyticsMock: any = { capture: jest.fn(), identify: jest.fn() };
      const auditMock: any = { write: jest.fn(async () => {}), list: jest.fn(async () => []) };
      return {
        admin: new AdminService(prisma, analyticsMock, auditMock),
        prisma,
        target,
        profiles,
        auditMock,
      };
    }

    it('promotes student → coach and creates a unique GP- invite_code', async () => {
      const { admin, target, profiles } = buildAdmin();
      const result = await admin.promoteUser('owner-1', target.id, 'coach', {
        business_name: 'Jay Fitness',
        timezone: 'America/Denver',
      });
      expect(result.role).toBe('coach');
      expect(profiles).toHaveLength(1);
      expect(profiles[0].invite_code).toMatch(/^GP-[A-Z2-9]{6}$/);
      expect(profiles[0].business_name).toBe('Jay Fitness');
      expect(profiles[0].created_by_owner_id).toBe('owner-1');
    });

    it('refuses to demote the acting owner (keeps at least one owner online)', async () => {
      const { admin } = buildAdmin();
      await expect(
        admin.promoteUser('owner-1', 'owner-1', 'coach'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s when target user is missing', async () => {
      const { admin } = buildAdmin();
      await expect(
        admin.promoteUser('owner-1', 'ghost', 'coach'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---- 2. Mobile fetches signup-policy + previews invite code ------------
  describe('2. mobile signup-policy + invite_code preview', () => {
    const ORIG = process.env.COACH_CODE_GATE_ENABLED;
    afterEach(() => {
      if (ORIG === undefined) delete process.env.COACH_CODE_GATE_ENABLED;
      else process.env.COACH_CODE_GATE_ENABLED = ORIG;
    });

    function buildAuth() {
      const prisma: any = { user: { findUnique: jest.fn() } };
      const inviteCodes = new InviteCodesService(prisma, { capture: jest.fn(), identify: jest.fn() } as any);
      const analytics: any = { capture: jest.fn() };
      const auth = new AuthService(prisma, inviteCodes, analytics, { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any, { isConfigured: () => false, getAudiences: () => [], verify: jest.fn() } as any);
      return { auth, inviteCodes, prisma };
    }

    it('signup-policy reflects COACH_CODE_GATE_ENABLED=true and exposes the canonical mobile contract', async () => {
      process.env.COACH_CODE_GATE_ENABLED = 'true';
      const { auth } = buildAuth();
      const policy = auth.getSignupPolicy();
      // Canonical name aligned with `invite_code_field`. The legacy
      // `coach_code_required` alias mirrors the same value for older clients.
      expect(policy.invite_code_required).toBe(true);
      expect(policy.coach_code_required).toBe(true);
      expect(policy.invite_code_field).toBe('invite_code');
      expect(policy.providers).toContain('email');
      // Mobile uses these to gate input client-side and avoid the 32-char
      // overflow 400 the invite QA surfaced on PR #61.
      expect(policy.invite_code).toEqual({
        min_length: 3,
        max_length: 32,
        prefix: 'GP-',
      });
    });

    it('signup-policy false when gate disabled', async () => {
      delete process.env.COACH_CODE_GATE_ENABLED;
      const { auth } = buildAuth();
      const policy = auth.getSignupPolicy();
      expect(policy.invite_code_required).toBe(false);
      expect(policy.coach_code_required).toBe(false);
    });

    it('previewCode resolves a CoachProfile.invite_code into a safe coach card', async () => {
      const prisma: any = {
        coachProfile: {
          findUnique: jest.fn(async ({ where }: any) =>
            where.invite_code === 'GP-ABCDEF'
              ? {
                  user: { id: 'coach-1', name: 'Sasha Lin', role: 'coach' },
                  business_name: 'Sasha Strength',
                  branding_accent_color: '#0F0',
                  branding_logo_url: null,
                  subscription_status: 'active',
                }
              : null,
          ),
        },
        inviteCode: { findUnique: jest.fn(async () => null) },
      };
      const inviteCodes = new InviteCodesService(prisma, { capture: jest.fn(), identify: jest.fn() } as any);
      const result = await inviteCodes.previewCode('GP-ABCDEF');
      expect(result).toEqual({
        valid: true,
        coach_id: 'coach-1',
        coach_name: 'Sasha Lin',
        business_name: 'Sasha Strength',
        branding: { accent_color: '#0F0', logo_url: null },
      });
    });

    it('previewCode hides paused/canceled coaches', async () => {
      const prisma: any = {
        coachProfile: {
          findUnique: jest.fn(async () => ({
            user: { id: 'coach-1', name: 'X', role: 'coach' },
            business_name: 'X',
            branding_accent_color: null,
            branding_logo_url: null,
            subscription_status: 'paused',
          })),
        },
        inviteCode: { findUnique: jest.fn(async () => null) },
      };
      const inviteCodes = new InviteCodesService(prisma, { capture: jest.fn(), identify: jest.fn() } as any);
      const result = await inviteCodes.previewCode('GP-PAUSED');
      expect(result).toEqual({ valid: false });
    });

    it('previewCode returns {valid:false} for an unknown code without leaking', async () => {
      const prisma: any = {
        coachProfile: { findUnique: jest.fn(async () => null) },
        inviteCode: { findUnique: jest.fn(async () => null) },
      };
      const inviteCodes = new InviteCodesService(prisma, { capture: jest.fn(), identify: jest.fn() } as any);
      const result = await inviteCodes.previewCode('GP-GHOST0');
      expect(result).toEqual({ valid: false });
    });
  });

  // ---- 3. signup-with-code gate enforcement ------------------------------
  describe('3. signupWithCode gate enforcement', () => {
    const ORIG = process.env.COACH_CODE_GATE_ENABLED;
    afterEach(() => {
      if (ORIG === undefined) delete process.env.COACH_CODE_GATE_ENABLED;
      else process.env.COACH_CODE_GATE_ENABLED = ORIG;
    });

    it('rejects signup without a code when COACH_CODE_GATE_ENABLED=true', async () => {
      process.env.COACH_CODE_GATE_ENABLED = 'true';
      const prisma: any = { user: { findUnique: jest.fn() } };
      const inviteCodes = new InviteCodesService(prisma, { capture: jest.fn(), identify: jest.fn() } as any);
      const auth = new AuthService(prisma, inviteCodes, { capture: jest.fn() } as any, { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any, { isConfigured: () => false, getAudiences: () => [], verify: jest.fn() } as any);
      await expect(
        auth.signupWithCode({
          email: 'c@c.test',
          password: 'Aa1!aaaa',
          name: 'C',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects signup with an invalid code regardless of gate', async () => {
      delete process.env.COACH_CODE_GATE_ENABLED;
      const prisma: any = {
        user: { findUnique: jest.fn() },
        coachProfile: { findUnique: jest.fn(async () => null) },
        inviteCode: { findUnique: jest.fn(async () => null) },
      };
      const inviteCodes = new InviteCodesService(prisma, { capture: jest.fn(), identify: jest.fn() } as any);
      const auth = new AuthService(prisma, inviteCodes, { capture: jest.fn() } as any, { write: jest.fn(async () => {}), list: jest.fn(async () => []) } as any, { isConfigured: () => false, getAudiences: () => [], verify: jest.fn() } as any);
      await expect(
        auth.signupWithCode({
          email: 'c@c.test',
          password: 'Aa1!aaaa',
          name: 'C',
          invite_code: 'GP-FAKE00',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ---- 4. attach-invite-code linkage (Google or post-OAuth) --------------
  describe('4. attach-invite-code links student → coach atomically', () => {
    it('links a freshly-signed-up Google user to the coach by invite_code', async () => {
      const fake = fakeClientAttach();
      fake._users['student-1'] = {
        id: 'student-1',
        role: 'student',
        coach_id: null,
        email: 'g@c.test',
      };
      fake._profiles['coach-1'] = {
        user_id: 'coach-1',
        invite_code: 'GP-LINK01',
        subscription_status: 'active',
        user: { id: 'coach-1', role: 'coach' },
      };
      const inviteCodes = new InviteCodesService(fake as any, { capture: jest.fn(), identify: jest.fn() } as any);
      const result = await inviteCodes.attachUserToCoachByCode(
        'student-1',
        'GP-LINK01',
      );
      expect(result.role).toBe('student');
      expect(result.coach_id).toBe('coach-1');
    });

    it('refuses to link OWNERs (defense in depth)', async () => {
      const fake = fakeClientAttach();
      fake._users['owner-1'] = { id: 'owner-1', role: 'owner', coach_id: null };
      fake._profiles['coach-1'] = {
        user_id: 'coach-1',
        invite_code: 'GP-OWN001',
        subscription_status: 'active',
        user: { id: 'coach-1', role: 'coach' },
      };
      const inviteCodes = new InviteCodesService(fake as any, { capture: jest.fn(), identify: jest.fn() } as any);
      await expect(
        inviteCodes.attachUserToCoachByCode('owner-1', 'GP-OWN001'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses to link when the coach is paused', async () => {
      const fake = fakeClientAttach();
      fake._users['student-1'] = {
        id: 'student-1',
        role: 'student',
        coach_id: null,
      };
      fake._profiles['coach-1'] = {
        user_id: 'coach-1',
        invite_code: 'GP-PAUS01',
        subscription_status: 'paused',
        user: { id: 'coach-1', role: 'coach' },
      };
      const inviteCodes = new InviteCodesService(fake as any, { capture: jest.fn(), identify: jest.fn() } as any);
      await expect(
        inviteCodes.attachUserToCoachByCode('student-1', 'GP-PAUS01'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ---- 5. AI sees the client's logged data + coach context ---------------
  describe('5. ClientAIContext surfaces logged app data + coach context', () => {
    it('aggregates 7d adherence from logged food entries and includes APP_PRESCRIBED markers', async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const prisma: any = {
        user: {
          findUnique: jest.fn(async ({ where }: any) => {
            if (where.id === 'u1') {
              return {
                id: 'u1',
                name: 'Alex Smith',
                coach_id: 'coach-1',
                profile: {
                  height_cm: 180,
                  current_weight_lbs: 190,
                  target_weight_lbs: 175,
                  date_of_birth: new Date('1990-01-01'),
                  sex: 'male',
                  activity_level: 'active',
                  goal_type: 'fat_loss',
                  workout_experience: 'intermediate',
                  has_gym_membership: true,
                  preferred_snacks: [],
                  dietary_pattern: null,
                  dietary_restrictions: [],
                  workout_days_per_week: null,
                  equipment_access: [],
                  macro_target_calories: 2200,
                  macro_target_protein_g: 180,
                  macro_target_carbs_g: 220,
                  macro_target_fat_g: 60,
                  water_goal_oz: 100,
                  meals_per_day: 4,
                  bio: 'no dairy',
                },
              };
            }
            if (where.id === 'coach-1') return { name: 'Sasha Lin' };
            return null;
          }),
        },
        loggedFoodEntry: {
          findMany: jest
            .fn()
            .mockImplementationOnce(async () => [
              {
                date: yesterday,
                food_item: { calories: 500, protein_g: 40, carbs_g: 50, fat_g: 10 },
                quantity_multiplier: 1,
              },
            ])
            .mockImplementationOnce(async () => [
              {
                date: today,
                food_item: { calories: 600, protein_g: 50, carbs_g: 60, fat_g: 15 },
                quantity_multiplier: 1,
              },
            ]),
        },
        workoutSession: { findMany: jest.fn(async () => []) },
        weightLog: { findMany: jest.fn(async () => []) },
        habit: { findMany: jest.fn(async () => []) },
        checkIn: { findMany: jest.fn(async () => []) },
        coachMessage: {
          findFirst: jest.fn(async () => ({
            body: 'Push hard on protein this week.',
            created_at: new Date(),
          })),
        },
        coachGuideline: {
          findUnique: jest.fn(async () => ({ content: 'No alcohol on training days.' })),
        },
        mealPlan: { findFirst: jest.fn(async () => null) },
      };

      const svc = new ClientAIContextService(prisma);
      const ctx = await svc.buildFresh('u1');

      expect(ctx.identity.first_name).toBe('Alex');
      expect(ctx.prescribed.calories).toBe(2200);
      expect(ctx.today.calories).toBe(600);
      expect(ctx.today.remaining_calories).toBe(1600);
      expect(ctx.recent_adherence_7d).toHaveLength(1);
      expect(ctx.coach.has_coach).toBe(true);
      expect(ctx.coach.coach_name).toBe('Sasha');
      expect(ctx.coach.last_coach_message_excerpt).toContain('protein');
      expect(ctx.coach.active_guidelines_excerpt).toContain('alcohol');

      const rendered = svc.renderForPrompt(ctx);
      expect(rendered).toContain('APP_PRESCRIBED (DO NOT CONTRADICT)');
      expect(rendered).toContain('GUARDRAILS');
      expect(rendered).not.toContain('@'); // email never leaks
    });

    it('degrades to a safe empty context when user is unknown', async () => {
      const prisma: any = { user: { findUnique: jest.fn(async () => null) } };
      const svc = new ClientAIContextService(prisma);
      const ctx = await svc.buildFresh('ghost');
      expect(ctx.coach.has_coach).toBe(false);
      expect(ctx.guardrails.forbid_unsafe_substances).toBe(true);
    });
  });

  // ---- 6. Coach <-> client thread send + unread counts -------------------
  describe('6. coach ↔ client messaging contract', () => {
    function buildMessaging() {
      const users: Record<string, any> = {
        'coach-1': { id: 'coach-1', role: 'coach', coach_id: null },
        'student-1': { id: 'student-1', role: 'student', coach_id: 'coach-1' },
      };
      const messages: any[] = [];
      let seq = 0;
      const prisma: any = {
        user: {
          findFirst: jest.fn(async ({ where }: any) => {
            const u = users[where.id];
            if (!u) return null;
            if (where.coach_id && u.coach_id !== where.coach_id) return null;
            if (where.role && u.role !== where.role) return null;
            return u;
          }),
          findUnique: jest.fn(async ({ where }: any) => users[where.id] ?? null),
        },
        coachMessage: {
          create: jest.fn(async ({ data }: any) => {
            const row = {
              id: `m-${++seq}`,
              ...data,
              created_at: new Date(),
              read_at: null,
            };
            messages.push(row);
            return row;
          }),
          findMany: jest.fn(async () => [...messages].reverse()),
          updateMany: jest.fn(async () => ({ count: 0 })),
          groupBy: jest.fn(async () => []),
          count: jest.fn(async () => 0),
        },
      };
      const supabase: any = { broadcastNewMessage: jest.fn() };
      return {
        svc: new MessagingService(prisma, supabase, { capture: jest.fn(), identify: jest.fn() } as any, { emit: jest.fn() } as any),
        prisma,
        supabase,
        messages,
      };
    }

    it('coach can send to their assigned student and broadcasts a refresh ping', async () => {
      const { svc, supabase, messages } = buildMessaging();
      const created = await svc.sendAsCoach('coach-1', 'student-1', 'Hey, nice work!');
      expect(created.body).toBe('Hey, nice work!');
      expect(messages).toHaveLength(1);
      expect(supabase.broadcastNewMessage).toHaveBeenCalledWith('student-1');
    });

    it('coach 404s when targeting a foreign client (no leak)', async () => {
      const { svc } = buildMessaging();
      await expect(
        svc.sendAsCoach('coach-1', 'someone-elses-student', 'hi'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('client without an assigned coach gets NO_COACH_ASSIGNED on send', async () => {
      const users: Record<string, any> = {
        'orphan-1': { id: 'orphan-1', role: 'student', coach_id: null },
      };
      const prisma: any = {
        user: {
          findUnique: jest.fn(async ({ where }: any) => users[where.id] ?? null),
        },
        coachMessage: { create: jest.fn() },
      };
      const svc = new MessagingService(prisma, { broadcastNewMessage: jest.fn() } as any, { capture: jest.fn(), identify: jest.fn() } as any, { emit: jest.fn() } as any);
      await expect(svc.sendAsClient('orphan-1', 'hi')).rejects.toMatchObject({
        response: expect.objectContaining({ error: 'NO_COACH_ASSIGNED' }),
      });
    });
  });

  // ---- 7. SubscriptionGuard gates SaaS write paths -----------------------
  describe('7. SubscriptionGuard end-to-end policy matrix', () => {
    const ORIG = process.env.BILLING_ENFORCEMENT;
    afterEach(() => {
      if (ORIG === undefined) delete process.env.BILLING_ENFORCEMENT;
      else process.env.BILLING_ENFORCEMENT = ORIG;
    });

    function ctxFor(user: any): ExecutionContext {
      return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as any;
    }

    it('observe mode: even canceled coach is allowed (rollout posture)', async () => {
      delete process.env.BILLING_ENFORCEMENT;
      const prisma: any = {
        coachSubscription: {
          findUnique: jest.fn(async () => ({
            status: 'canceled',
            last_payment_failed_at: null,
          })),
        },
      };
      const guard = new SubscriptionGuard(prisma);
      await expect(
        guard.canActivate(ctxFor({ id: 'c', role: 'coach' })),
      ).resolves.toBe(true);
    });

    it('enforce mode: active and trialing pass, canceled and stale past_due fail', async () => {
      process.env.BILLING_ENFORCEMENT = 'enforce';

      const make = (sub: any) =>
        new SubscriptionGuard({
          coachSubscription: { findUnique: jest.fn(async () => sub) },
        } as any);

      await expect(
        make({ status: 'active', last_payment_failed_at: null }).canActivate(
          ctxFor({ id: 'c', role: 'coach' }),
        ),
      ).resolves.toBe(true);

      await expect(
        make({ status: 'trialing', last_payment_failed_at: null }).canActivate(
          ctxFor({ id: 'c', role: 'coach' }),
        ),
      ).resolves.toBe(true);

      await expect(
        make({
          status: 'past_due',
          last_payment_failed_at: new Date(Date.now() - 8 * 86400_000),
        }).canActivate(ctxFor({ id: 'c', role: 'coach' })),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        make({ status: 'canceled', last_payment_failed_at: null }).canActivate(
          ctxFor({ id: 'c', role: 'coach' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('owner bypasses billing entirely (Tier-0 platform admin)', async () => {
      process.env.BILLING_ENFORCEMENT = 'enforce';
      const prisma: any = {
        coachSubscription: { findUnique: jest.fn() },
      };
      const guard = new SubscriptionGuard(prisma);
      await expect(
        guard.canActivate(ctxFor({ id: 'o', role: 'owner' })),
      ).resolves.toBe(true);
    });
  });
});
