import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { AuthController } from '../src/auth/auth.controller';
import { AdminService } from '../src/admin/admin.service';
import {
  COACH_AI_MAX_ACTUAL_CENTS_DEFAULT,
  FREE_COACH_AI_MONTHLY_CAP_USD_DEFAULT,
  resolveFreeTierMaxActualCents,
} from '../src/ai-credits/ai-credits.constants';
import { CoachAIBudgetService } from '../src/ai-credits/coach-ai-budget.service';
import { PackagesService } from '../src/packages/packages.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import {
  AUTH_OAUTH_COACH_SIGNUP_PER_HOUR_DEFAULT,
  LoginThrottleResetService,
  resolveOAuthCoachSignupPerHour,
} from '../src/throttler/login-throttle-reset.service';

// Clinic C13 fix round — cross-module regressions requested by the two
// independent audits (Opus + Grok) of PR #597. The auth-service paths live in
// test/auth-signup-role-choice.spec.ts; this file covers the surrounding
// modules: the free-tier AI cap, the OAuth coach-signup throttle, the
// controller wiring, the admin invite-code sampler and the phantom sub-coach
// promotion through PackagesService.

describe('free-tier coach AI cap (Opus B2 / Grok B5)', () => {
  const ORIG_FREE = process.env.FREE_COACH_AI_MONTHLY_CAP_USD;
  const ORIG_MAX = process.env.COACH_AI_MAX_ACTUAL_CENTS;
  afterEach(() => {
    if (ORIG_FREE === undefined) delete process.env.FREE_COACH_AI_MONTHLY_CAP_USD;
    else process.env.FREE_COACH_AI_MONTHLY_CAP_USD = ORIG_FREE;
    if (ORIG_MAX === undefined) delete process.env.COACH_AI_MAX_ACTUAL_CENTS;
    else process.env.COACH_AI_MAX_ACTUAL_CENTS = ORIG_MAX;
  });

  it('defaults to $5 (500 cents) and never exceeds the global ceiling', () => {
    delete process.env.FREE_COACH_AI_MONTHLY_CAP_USD;
    delete process.env.COACH_AI_MAX_ACTUAL_CENTS;
    expect(FREE_COACH_AI_MONTHLY_CAP_USD_DEFAULT).toBe(5);
    expect(resolveFreeTierMaxActualCents()).toBe(500);
    expect(resolveFreeTierMaxActualCents()).toBeLessThan(COACH_AI_MAX_ACTUAL_CENTS_DEFAULT);

    process.env.FREE_COACH_AI_MONTHLY_CAP_USD = '12.5';
    expect(resolveFreeTierMaxActualCents()).toBe(1250);

    // Raising it above the global cap is clamped: this knob only reduces spend.
    process.env.FREE_COACH_AI_MONTHLY_CAP_USD = '999';
    expect(resolveFreeTierMaxActualCents()).toBe(COACH_AI_MAX_ACTUAL_CENTS_DEFAULT);

    // Garbage / negative -> default.
    process.env.FREE_COACH_AI_MONTHLY_CAP_USD = 'lots';
    expect(resolveFreeTierMaxActualCents()).toBe(500);
    process.env.FREE_COACH_AI_MONTHLY_CAP_USD = '-3';
    expect(resolveFreeTierMaxActualCents()).toBe(500);
    // Zero is a legal "no free AI" setting.
    process.env.FREE_COACH_AI_MONTHLY_CAP_USD = '0';
    expect(resolveFreeTierMaxActualCents()).toBe(0);
  });

  function buildBudgetPrisma(opts: { tier: 'free' | 'pro' | null; existingRow?: any }) {
    const rows: any[] = opts.existingRow ? [{ ...opts.existingRow }] : [];
    const prisma: any = {
      coachSubscription: {
        findUnique: jest.fn(async () => (opts.tier ? { tier: opts.tier } : null)),
      },
      teamSubCoachAssignment: { findFirst: jest.fn(async () => null) },
      coachAIBudget: {
        findUnique: jest.fn(
          async ({ where }: any) =>
            rows.find((r) => r.coach_user_id === where.coach_user_id) ?? null,
        ),
        upsert: jest.fn(async ({ create }: any) => {
          const row = {
            id: 'b-1',
            pack_paid_cents: 0,
            pack_displayed_cents: 0,
            actual_used_cents: 0,
            total_pack_actual_cents: 0,
            ...create,
          };
          rows.push(row);
          return row;
        }),
        findMany: jest.fn(async () =>
          rows.map((r) => ({ id: r.id, coach_user_id: r.coach_user_id })),
        ),
        updateMany: jest.fn(async ({ data }: any) => {
          Object.assign(rows[0], data);
          return { count: 1 };
        }),
      },
    };
    return { prisma, rows };
  }

  it("a NEW free-tier coach's first budget row is created with the $5 base, not $40", async () => {
    delete process.env.FREE_COACH_AI_MONTHLY_CAP_USD;
    const { prisma, rows } = buildBudgetPrisma({ tier: 'free' });
    const svc = new CoachAIBudgetService(prisma);
    const snap = await svc.getOrCreateCurrentPeriod('free-coach');
    expect(rows[0].base_actual_cents).toBe(500);
    expect(snap.base_actual_cents).toBe(500);
    expect(snap.total_actual_available_cents).toBe(500);
    // canCharge refuses the 501st cent.
    prisma.coachSubscription.findUnique.mockResolvedValue({ tier: 'free' });
    expect((await svc.canCharge('free-coach', 500)).allowed).toBe(true);
    expect((await svc.canCharge('free-coach', 501)).allowed).toBe(false);
  });

  it('a pro coach and a legacy coach without a subscription row keep the global $40 base', async () => {
    delete process.env.FREE_COACH_AI_MONTHLY_CAP_USD;
    for (const tier of ['pro', null] as const) {
      const { prisma, rows } = buildBudgetPrisma({ tier });
      const svc = new CoachAIBudgetService(prisma);
      const snap = await svc.getOrCreateCurrentPeriod('coach');
      expect(rows[0].base_actual_cents).toBe(COACH_AI_MAX_ACTUAL_CENTS_DEFAULT);
      expect(snap.total_actual_available_cents).toBe(COACH_AI_MAX_ACTUAL_CENTS_DEFAULT);
    }
  });

  it('an EXISTING free coach provisioned with the $40 row is capped immediately in the snapshot (packs untouched)', async () => {
    delete process.env.FREE_COACH_AI_MONTHLY_CAP_USD;
    const { prisma } = buildBudgetPrisma({
      tier: 'free',
      existingRow: {
        id: 'b-old',
        coach_user_id: 'free-coach',
        period_start: new Date('2026-09-01T00:00:00Z'),
        period_end: new Date('2026-10-01T00:00:00Z'),
        base_actual_cents: 4000,
        value_multiplier: new Prisma.Decimal(3.125),
        base_displayed_cents: 12500,
        pack_paid_cents: 1000,
        pack_displayed_cents: 3125,
        actual_used_cents: 450,
        total_pack_actual_cents: 1000,
      },
    });
    const svc = new CoachAIBudgetService(prisma);
    const snap = await svc.getOrCreateCurrentPeriod('free-coach');
    expect(snap.base_actual_cents).toBe(500);
    expect(snap.base_displayed_cents).toBe(Math.round(500 * 3.125));
    expect(snap.total_pack_actual_cents).toBe(1000); // paid credit survives
    expect(snap.total_actual_available_cents).toBe(1500);
    // 450 used + 1051 would exceed 1500; 1050 fits exactly.
    expect((await svc.canCharge('free-coach', 1050)).allowed).toBe(true);
    expect((await svc.canCharge('free-coach', 1051)).allowed).toBe(false);
  });

  it('rollover re-bases a free coach at the free cap and a pro coach at the global cap', async () => {
    delete process.env.FREE_COACH_AI_MONTHLY_CAP_USD;
    for (const [tier, expected] of [
      ['free', 500],
      ['pro', COACH_AI_MAX_ACTUAL_CENTS_DEFAULT],
    ] as const) {
      const { prisma, rows } = buildBudgetPrisma({
        tier,
        existingRow: {
          id: 'b-roll',
          coach_user_id: 'c',
          period_start: new Date('2026-08-01T00:00:00Z'),
          period_end: new Date('2026-09-01T00:00:00Z'),
          base_actual_cents: 4000,
          value_multiplier: new Prisma.Decimal(3.125),
          base_displayed_cents: 12500,
          pack_paid_cents: 0,
          pack_displayed_cents: 0,
          actual_used_cents: 3999,
          total_pack_actual_cents: 0,
        },
      });
      const svc = new CoachAIBudgetService(prisma);
      const res = await svc.rolloverDueBudgets(new Date('2026-09-30T12:00:00Z'));
      expect(res.rolled).toBe(1);
      expect(rows[0].base_actual_cents).toBe(expected);
      expect(rows[0].actual_used_cents).toBe(0);
    }
  });
});

describe('OAuth coach-signup throttle (Grok B5)', () => {
  const ORIG = process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR;
    else process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR = ORIG;
  });

  it('resolves the per-hour limit from env with a small default and sane clamps', () => {
    delete process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR;
    expect(AUTH_OAUTH_COACH_SIGNUP_PER_HOUR_DEFAULT).toBe(5);
    expect(resolveOAuthCoachSignupPerHour()).toBe(5);
    process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR = '20';
    expect(resolveOAuthCoachSignupPerHour()).toBe(20);
    process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR = '0';
    expect(resolveOAuthCoachSignupPerHour()).toBe(5);
    process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR = 'nope';
    expect(resolveOAuthCoachSignupPerHour()).toBe(5);
  });

  function buildStorage() {
    const hits = new Map<string, number>();
    const storage: any = {
      increment: jest.fn(async (key: string) => {
        const n = (hits.get(key) ?? 0) + 1;
        hits.set(key, n);
        return { totalHits: n, timeToExpire: 3600, isBlocked: false, timeToBlockExpire: 0 };
      }),
    };
    return { hits, storage };
  }

  it('allows `limit` coach creates per IP per hour and refuses the next one with a ThrottlerException', async () => {
    delete process.env.AUTH_OAUTH_COACH_SIGNUP_PER_HOUR;
    const { storage, hits } = buildStorage();
    const svc = new LoginThrottleResetService(storage);
    for (let i = 0; i < 5; i++) {
      await expect(svc.consumeOAuthCoachSignupSlot('10.0.0.1')).resolves.toBeUndefined();
    }
    await expect(svc.consumeOAuthCoachSignupSlot('10.0.0.1')).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    // Keyed per IP: a different IP is unaffected.
    await expect(svc.consumeOAuthCoachSignupSlot('10.0.0.2')).resolves.toBeUndefined();
    expect([...hits.keys()]).toEqual([
      'oauth-coach-signup:ip:10.0.0.1',
      'oauth-coach-signup:ip:10.0.0.2',
    ]);
  });

  it('is a no-op without storage or without an IP, and fails open on a storage error', async () => {
    await expect(
      new LoginThrottleResetService(undefined).consumeOAuthCoachSignupSlot('1.1.1.1'),
    ).resolves.toBeUndefined();
    const { storage } = buildStorage();
    const svc = new LoginThrottleResetService(storage);
    await expect(svc.consumeOAuthCoachSignupSlot(null)).resolves.toBeUndefined();
    expect(storage.increment).not.toHaveBeenCalled();
    storage.increment.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.consumeOAuthCoachSignupSlot('1.1.1.1')).resolves.toBeUndefined();
  });
});

describe('AuthController google/apple wiring (Opus C5 / Grok B1, B5)', () => {
  function build(result: any) {
    const auth: any = {
      googleAuth: jest.fn(async () => result),
      appleAuth: jest.fn(async () => result),
    };
    const loginThrottleReset: any = { resetLoginCounters: jest.fn() };
    const inviteCodes: any = {};
    const controller = new AuthController(auth, inviteCodes, loginThrottleReset);
    const req: any = {
      ip: '203.0.113.9',
      headers: { 'user-agent': 'growth-mobile/1.0' },
      socket: { remoteAddress: '203.0.113.9' },
    };
    return { controller, auth, loginThrottleReset, req };
  }

  it('passes IP/user-agent into AuthService.googleAuth and skips the login-throttle reset for a NEW user', async () => {
    const { controller, auth, loginThrottleReset, req } = build({ is_new_user: true, user: {} });
    const body: any = { token: 't', intended_role: 'coach' };
    await controller.googleAuth(body, req);
    expect(auth.googleAuth).toHaveBeenCalledWith(
      't',
      undefined,
      'coach',
      expect.objectContaining({ ip: '203.0.113.9', userAgent: 'growth-mobile/1.0' }),
    );
    expect(loginThrottleReset.resetLoginCounters).not.toHaveBeenCalled();
  });

  it('still resets the login counters for a RETURNING user (google and apple)', async () => {
    const { controller, loginThrottleReset, req } = build({ is_new_user: false, user: {} });
    const body: any = { token: 't' };
    await controller.googleAuth(body, req);
    await controller.appleAuth(body, req);
    expect(loginThrottleReset.resetLoginCounters).toHaveBeenCalledTimes(2);
  });

  it('apple: no reset for a NEW user either', async () => {
    const { controller, auth, loginThrottleReset, req } = build({ is_new_user: true, user: {} });
    const body: any = { token: 't', intended_role: 'coach' };
    await controller.appleAuth(body, req);
    expect(auth.appleAuth).toHaveBeenCalledWith(
      't',
      undefined,
      undefined,
      expect.objectContaining({ ip: '203.0.113.9' }),
      undefined,
      'coach',
    );
    expect(loginThrottleReset.resetLoginCounters).not.toHaveBeenCalled();
  });
});

describe('AdminService invite-code sampler (Grok C6)', () => {
  it('ensureCoachProfile mints GP- codes from the uniform randomInt alphabet', async () => {
    const codes: string[] = [];
    const prisma: any = {
      coachProfile: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => {
          codes.push(data.invite_code);
          return { id: 'cp', ...data };
        }),
      },
    };
    const analytics: any = { capture: jest.fn() };
    const audit: any = { write: jest.fn() };
    const svc = new AdminService(prisma, analytics, audit);
    for (let i = 0; i < 50; i++) await svc.ensureCoachProfile(`u-${i}`);
    expect(codes).toHaveLength(50);
    for (const c of codes) expect(c).toMatch(/^GP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    // No 0/O/1/I/L — the ambiguous glyphs are excluded from the alphabet.
    expect(codes.map((c) => c.slice(3)).join('')).not.toMatch(/[01OIL]/);
  });
});

describe('PackagesService.resolveEffectiveCoachId — phantom sub-coach (Opus A1)', () => {
  const HEAD = 'head-coach';
  const PHANTOM = 'free-coach-who-bought-a-package';
  function build(membership: boolean) {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === PHANTOM
            ? { role: 'coach', coach_id: HEAD }
            : { role: 'coach', coach_id: null },
        ),
        findMany: jest.fn(async () => []),
      },
      teamSubCoachAssignment: {
        findFirst: jest.fn(async () => (membership ? { id: 'seat' } : null)),
      },
      subCoachAssignment: {
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
      },
    };
    const scope = new SubCoachScopeService(prisma);
    return { svc: new PackagesService(prisma, scope), prisma };
  }

  it('WITHOUT a membership relation the caller manages their OWN packages, never the head coach\u2019s', async () => {
    const { svc } = build(false);
    expect(await svc.resolveEffectiveCoachId(PHANTOM)).toBe(PHANTOM);
  });

  it('WITH an active team seat the caller is scoped to the head coach', async () => {
    const { svc } = build(true);
    expect(await svc.resolveEffectiveCoachId(PHANTOM)).toBe(HEAD);
  });
});
