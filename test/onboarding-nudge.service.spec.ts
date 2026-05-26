/**
 * R51 service + scheduler integration tests.
 *
 * Uses an in-memory Prisma stub (same shape as test/landing-pages.*) so
 * we exercise the real OnboardingNudgeService and OnboardingNudgeScheduler
 * code paths without booting Nest or hitting a database.  Stubs for
 * EmailService, NotificationsService and ConfigService capture what
 * would have gone out the door.
 *
 * Covers:
 *   - milestone detection: signed_up → created_package → shared_link →
 *     first_lead → first_client
 *   - ensureState lazy creation
 *   - sendNudge idempotency (re-running for an already-sent day is a no-op)
 *   - sendNudge skips opted-out / first_client / non-coach
 *   - optOut idempotency
 *   - scheduler.runOnce eligibility filter and per-day dispatch
 *   - markFirstClient terminal transition
 */

import { OnboardingNudgeService } from '../src/onboarding/onboarding-nudge.service';
import { OnboardingNudgeScheduler } from '../src/onboarding/onboarding-nudge.scheduler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FakeUser {
  id: string;
  email: string;
  name: string;
  role: 'coach' | 'owner' | 'student';
  created_at: Date;
  deletion_scheduled_at: null;
  deleted_at: null;
  coach_profile?: { timezone: string | null } | null;
}

function makePrisma(seed?: {
  users?: FakeUser[];
  packages?: Array<{ id: string; coach_id: string; share_token: string | null; share_link_generated_at?: Date | null; created_at: Date }>;
  leads?: Array<{ id: string; coach_id: string }>;
  purchases?: Array<{ coach_user_id: string; entitlement_active: boolean }>;
}) {
  const users = seed?.users ?? [];
  const states: any[] = [];
  const packages = seed?.packages ?? [];
  const leads = seed?.leads ?? [];
  const purchases = seed?.purchases ?? [];

  const matchesWhere = (row: any, where: any): boolean => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && 'in' in (v as any)) {
        if (!(v as any).in.includes(row[k])) return false;
        continue;
      }
      if (v && typeof v === 'object' && 'gte' in (v as any)) {
        if (!(row[k] instanceof Date) || row[k] < (v as any).gte) return false;
        continue;
      }
      if (v && typeof v === 'object' && 'not' in (v as any)) {
        if (row[k] === (v as any).not) return false;
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  };

  return {
    _users: users,
    _states: states,
    _packages: packages,
    _leads: leads,
    _purchases: purchases,

    user: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const u = users.find((x) => x.id === where.id);
        return u ?? null;
      }),
      findMany: jest.fn(async ({ where, select }: any) =>
        users.filter((u) => matchesWhere(u, where)).map((u) => ({
          id: u.id,
          created_at: u.created_at,
          coach_profile: u.coach_profile ?? null,
        })),
      ),
    },

    coachOnboardingState: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          states.find((s) =>
            where.id ? s.id === where.id : s.coach_id === where.coach_id,
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `state-${states.length + 1}`,
          day_1_sent: false,
          day_2_sent: false,
          day_3_sent: false,
          day_5_sent: false,
          day_7_sent: false,
          day_1_sent_at: null,
          day_2_sent_at: null,
          day_3_sent_at: null,
          day_5_sent_at: null,
          day_7_sent_at: null,
          first_client_at: null,
          churned_at: null,
          opted_out_at: null,
          last_milestone: 'signed_up',
          created_at: new Date(),
          updated_at: new Date(),
          ...data,
        };
        states.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = states.findIndex((s) => s.id === where.id);
        if (idx === -1) throw new Error('state not found');
        Object.assign(states[idx], data, { updated_at: new Date() });
        return states[idx];
      }),
    },

    coachPackage: {
      findFirst: jest.fn(async ({ where }: any) => {
        let candidates = packages.filter((p) => p.coach_id === where.coach_id);
        if (where.share_token?.not === null) {
          candidates = candidates.filter((p) => p.share_token);
        }
        return candidates[0] ?? null;
      }),
    },

    coachLandingLead: {
      count: jest.fn(async ({ where }: any) =>
        leads.filter((l) => l.coach_id === where.coach_id).length,
      ),
    },

    clientPurchase: {
      count: jest.fn(async ({ where }: any) =>
        purchases.filter(
          (p) =>
            p.coach_user_id === where.coach_user_id &&
            (where.entitlement_active === undefined ||
              p.entitlement_active === where.entitlement_active),
        ).length,
      ),
    },
  };
}

function makeEmailStub() {
  return {
    send: jest.fn().mockResolvedValue({
      status: 'sent',
      providerMessageId: 'msg_test',
      idempotencyKey: 'k',
    }),
  };
}

function makeNotificationsStub() {
  return {
    createNotification: jest.fn().mockResolvedValue({ id: 'notif_1' }),
  };
}

function makeConfigStub(overrides: Record<string, string> = {}) {
  return {
    get: jest.fn((key: string) => overrides[key]),
  };
}

function makeCoach(overrides: Partial<FakeUser> = {}): FakeUser {
  return {
    id: 'coach-1',
    email: 'coach@example.com',
    name: 'Alex Rivera',
    role: 'coach',
    created_at: new Date('2026-05-20T17:00:00Z'), // 9am Pacific equivalent
    deletion_scheduled_at: null,
    deleted_at: null,
    coach_profile: { timezone: 'America/Los_Angeles' },
    ...overrides,
  };
}

// ─── Service: ensureState ────────────────────────────────────────────────────

describe('OnboardingNudgeService.ensureState', () => {
  it('lazily creates a state row using User.created_at as signup_at', async () => {
    const coach = makeCoach();
    const prisma = makePrisma({ users: [coach] });
    const svc = new OnboardingNudgeService(
      prisma as any,
      makeEmailStub() as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    const state = await svc.ensureState(coach.id);
    expect(state.coach_id).toBe(coach.id);
    expect(state.signup_at).toEqual(coach.created_at);
    expect(prisma._states).toHaveLength(1);
  });

  it('returns existing row on second call (no duplicate create)', async () => {
    const coach = makeCoach();
    const prisma = makePrisma({ users: [coach] });
    const svc = new OnboardingNudgeService(
      prisma as any,
      makeEmailStub() as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    const a = await svc.ensureState(coach.id);
    const b = await svc.ensureState(coach.id);
    expect(b.id).toBe(a.id);
    expect(prisma._states).toHaveLength(1);
  });

  it('rejects non-coach users', async () => {
    const student = makeCoach({ id: 'student-1', role: 'student' });
    const prisma = makePrisma({ users: [student] });
    const svc = new OnboardingNudgeService(
      prisma as any,
      makeEmailStub() as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    await expect(svc.ensureState(student.id)).rejects.toThrow();
  });
});

// ─── Service: detectMilestone ────────────────────────────────────────────────

describe('OnboardingNudgeService.detectMilestone', () => {
  function build(seed: Parameters<typeof makePrisma>[0]) {
    const prisma = makePrisma(seed);
    return new OnboardingNudgeService(
      prisma as any,
      makeEmailStub() as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
  }

  it('signed_up when no packages, leads, or clients', async () => {
    const svc = build({ users: [makeCoach()] });
    expect(await svc.detectMilestone('coach-1')).toBe('signed_up');
  });

  it('created_package when a package exists with no share_token', async () => {
    const svc = build({
      users: [makeCoach()],
      packages: [{ id: 'p1', coach_id: 'coach-1', share_token: null, created_at: new Date() }],
    });
    expect(await svc.detectMilestone('coach-1')).toBe('created_package');
  });

  it('shared_link when the package has a share_token', async () => {
    const svc = build({
      users: [makeCoach()],
      packages: [{ id: 'p1', coach_id: 'coach-1', share_token: 'tok_x', created_at: new Date() }],
    });
    expect(await svc.detectMilestone('coach-1')).toBe('shared_link');
  });

  it('first_lead when a CoachLandingLead exists', async () => {
    const svc = build({
      users: [makeCoach()],
      packages: [{ id: 'p1', coach_id: 'coach-1', share_token: 'tok_x', created_at: new Date() }],
      leads: [{ id: 'l1', coach_id: 'coach-1' }],
    });
    expect(await svc.detectMilestone('coach-1')).toBe('first_lead');
  });

  it('first_client when a paid ClientPurchase exists', async () => {
    const svc = build({
      users: [makeCoach()],
      purchases: [{ coach_user_id: 'coach-1', entitlement_active: true }],
    });
    expect(await svc.detectMilestone('coach-1')).toBe('first_client');
  });
});

// ─── Service: sendNudge ──────────────────────────────────────────────────────

describe('OnboardingNudgeService.sendNudge', () => {
  it('fires in-app + email and marks day_1_sent on first call', async () => {
    const coach = makeCoach();
    const prisma = makePrisma({ users: [coach] });
    const email = makeEmailStub();
    const notif = makeNotificationsStub();
    const svc = new OnboardingNudgeService(
      prisma as any,
      email as any,
      notif as any,
      makeConfigStub() as any,
    );
    await svc.ensureState(coach.id);

    const fired = await svc.sendNudge(coach.id, 1);
    expect(fired).toBe(true);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(notif.createNotification).toHaveBeenCalledTimes(1);
    expect(prisma._states[0].day_1_sent).toBe(true);
    expect(prisma._states[0].day_1_sent_at).toBeInstanceOf(Date);
  });

  it('is idempotent: second sendNudge for the same day does nothing', async () => {
    const coach = makeCoach();
    const prisma = makePrisma({ users: [coach] });
    const email = makeEmailStub();
    const svc = new OnboardingNudgeService(
      prisma as any,
      email as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    await svc.ensureState(coach.id);

    expect(await svc.sendNudge(coach.id, 1)).toBe(true);
    expect(await svc.sendNudge(coach.id, 1)).toBe(false);
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('skips when opted_out_at is set', async () => {
    const coach = makeCoach();
    const prisma = makePrisma({ users: [coach] });
    const email = makeEmailStub();
    const svc = new OnboardingNudgeService(
      prisma as any,
      email as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    await svc.optOut(coach.id);
    expect(await svc.sendNudge(coach.id, 1)).toBe(false);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('skips when first_client_at is set (terminal)', async () => {
    const coach = makeCoach();
    const prisma = makePrisma({ users: [coach] });
    const email = makeEmailStub();
    const svc = new OnboardingNudgeService(
      prisma as any,
      email as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    await svc.ensureState(coach.id);
    await svc.markFirstClient(coach.id);
    expect(await svc.sendNudge(coach.id, 2)).toBe(false);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('detects mid-flight first_client and persists the transition', async () => {
    // Coach has a state row but no client at sendNudge entry; they
    // just paid between scheduler tick and sendNudge fire.
    const coach = makeCoach();
    const prisma = makePrisma({
      users: [coach],
      purchases: [{ coach_user_id: coach.id, entitlement_active: true }],
    });
    const email = makeEmailStub();
    const svc = new OnboardingNudgeService(
      prisma as any,
      email as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    await svc.ensureState(coach.id);

    expect(await svc.sendNudge(coach.id, 1)).toBe(false);
    expect(email.send).not.toHaveBeenCalled();
    expect(prisma._states[0].first_client_at).toBeInstanceOf(Date);
    expect(prisma._states[0].last_milestone).toBe('first_client');
  });

  it('still marks day sent even if email throws (no infinite retry)', async () => {
    const coach = makeCoach();
    const prisma = makePrisma({ users: [coach] });
    const email = {
      send: jest.fn().mockRejectedValue(new Error('resend 500')),
    };
    const svc = new OnboardingNudgeService(
      prisma as any,
      email as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    await svc.ensureState(coach.id);
    const fired = await svc.sendNudge(coach.id, 1);
    expect(fired).toBe(true);
    expect(prisma._states[0].day_1_sent).toBe(true);
  });
});

// ─── Service: optOut + markFirstClient ──────────────────────────────────────

describe('OnboardingNudgeService.optOut + markFirstClient', () => {
  it('optOut is idempotent', async () => {
    const coach = makeCoach();
    const prisma = makePrisma({ users: [coach] });
    const svc = new OnboardingNudgeService(
      prisma as any,
      makeEmailStub() as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    const first = await svc.optOut(coach.id);
    const ts = first.opted_out_at;
    // Sleep one tick to ensure a fresh Date would differ if re-set.
    await new Promise((r) => setTimeout(r, 5));
    const second = await svc.optOut(coach.id);
    expect(second.opted_out_at).toEqual(ts);
  });

  it('markFirstClient is a no-op when no state row exists', async () => {
    const coach = makeCoach();
    const prisma = makePrisma({ users: [coach] });
    const svc = new OnboardingNudgeService(
      prisma as any,
      makeEmailStub() as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    await expect(svc.markFirstClient(coach.id)).resolves.toBeUndefined();
    expect(prisma._states).toHaveLength(0);
  });
});

// ─── Scheduler: runOnce ─────────────────────────────────────────────────────

describe('OnboardingNudgeScheduler.runOnce', () => {
  it('skips coaches outside the 8-day eligibility window', async () => {
    // Signup 30 days ago — past the window.
    const oldCoach = makeCoach({
      id: 'coach-old',
      created_at: new Date(Date.now() - 30 * 86_400_000),
    });
    const prisma = makePrisma({ users: [oldCoach] });
    const svc = new OnboardingNudgeService(
      prisma as any,
      makeEmailStub() as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    const sched = new OnboardingNudgeScheduler(
      prisma as any,
      svc,
      makeConfigStub() as any,
    );
    const fired = await sched.runOnce(new Date());
    expect(fired).toBe(0);
  });

  it('does not fire when current local time is not the dispatch hour', async () => {
    // Coach signed up yesterday (1-day delta). Call at midnight UTC,
    // which is 16:00 PT — not 09:00 PT.
    const signup = new Date('2026-05-25T16:00:00Z'); // 09:00 PT day -1
    const now = new Date('2026-05-26T08:00:00Z');   // 01:00 PT next day
    const coach = makeCoach({ created_at: signup });
    const prisma = makePrisma({ users: [coach] });
    const svc = new OnboardingNudgeService(
      prisma as any,
      makeEmailStub() as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    const sched = new OnboardingNudgeScheduler(
      prisma as any,
      svc,
      makeConfigStub() as any,
    );
    expect(await sched.runOnce(now)).toBe(0);
  });

  it('fires day-1 nudge at 09:00 in coach local tz, exactly once', async () => {
    // Coach signed up yesterday at 17:00 UTC = 09:00 PT.
    const signup = new Date('2026-05-25T16:00:00Z'); // 09:00 PT
    const now = new Date('2026-05-26T16:00:00Z');    // next day 09:00 PT — day 1
    const coach = makeCoach({ created_at: signup });
    const prisma = makePrisma({ users: [coach] });
    const email = makeEmailStub();
    const svc = new OnboardingNudgeService(
      prisma as any,
      email as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    const sched = new OnboardingNudgeScheduler(
      prisma as any,
      svc,
      makeConfigStub() as any,
    );

    const fired = await sched.runOnce(now);
    expect(fired).toBe(1);
    expect(email.send).toHaveBeenCalledTimes(1);

    // Re-running same minute should not double-send.
    const refired = await sched.runOnce(now);
    expect(refired).toBe(0);
  });

  it('honors a coach opt-out', async () => {
    const signup = new Date('2026-05-25T16:00:00Z');
    const now = new Date('2026-05-26T16:00:00Z');
    const coach = makeCoach({ created_at: signup });
    const prisma = makePrisma({ users: [coach] });
    const email = makeEmailStub();
    const svc = new OnboardingNudgeService(
      prisma as any,
      email as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    await svc.optOut(coach.id);
    const sched = new OnboardingNudgeScheduler(
      prisma as any,
      svc,
      makeConfigStub() as any,
    );
    expect(await sched.runOnce(now)).toBe(0);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('respects ONBOARDING_NUDGE_HOUR_LOCAL override', async () => {
    const signup = new Date('2026-05-25T20:00:00Z'); // 13:00 PT
    const now = new Date('2026-05-26T20:00:00Z');    // 13:00 PT next day
    const coach = makeCoach({ created_at: signup });
    const prisma = makePrisma({ users: [coach] });
    const email = makeEmailStub();
    const svc = new OnboardingNudgeService(
      prisma as any,
      email as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    const sched = new OnboardingNudgeScheduler(
      prisma as any,
      svc,
      makeConfigStub({ ONBOARDING_NUDGE_HOUR_LOCAL: '13' }) as any,
    );
    expect(await sched.runOnce(now)).toBe(1);
  });

  it('does not fire on day 4 (4 is not in {1,2,3,5,7})', async () => {
    const signup = new Date('2026-05-22T16:00:00Z'); // 09:00 PT
    const now = new Date('2026-05-26T16:00:00Z');    // 09:00 PT, 4 days later
    const coach = makeCoach({ created_at: signup });
    const prisma = makePrisma({ users: [coach] });
    const email = makeEmailStub();
    const svc = new OnboardingNudgeService(
      prisma as any,
      email as any,
      makeNotificationsStub() as any,
      makeConfigStub() as any,
    );
    const sched = new OnboardingNudgeScheduler(
      prisma as any,
      svc,
      makeConfigStub() as any,
    );
    expect(await sched.runOnce(now)).toBe(0);
    expect(email.send).not.toHaveBeenCalled();
  });
});
