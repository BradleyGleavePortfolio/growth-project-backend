/**
 * Nudge v1 — detector unit tests.
 *
 * Each detector is exercised against a synthetic Prisma fixture so we
 * can assert that the right candidates emerge with the right signal_keys
 * and that adjacent windows don't overlap (no double-coverage).
 */

import {
  NudgeDetectorService,
  DETECTOR_WINDOWS,
  calendarDayDiff,
  localDateKey,
} from '../src/notifications/nudges/nudge-detector.service';
import { NudgeTriggerType } from '../src/notifications/nudges/nudge.types';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-05-08T18:00:00Z');

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY);
}

function hoursAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 60 * 60 * 1000);
}

interface FakeDb {
  checkIns: Array<{ user_id: string; date: Date; logged_at: Date }>;
  users: Array<{
    id: string;
    name: string;
    created_at: Date;
    archived_at: Date | null;
    deleted_at: Date | null;
    profile?: { onboardingCompleted: boolean };
  }>;
  notifications: Array<{ user_id: string; read_at: Date | null }>;
  /**
   * NotificationPreferences rows. Optional — detectors fall back to the
   * schema default tz ('America/Los_Angeles') when absent.
   */
  prefs?: Array<{ user_id: string; timezone: string }>;
  /**
   * CoachSubscription rows. Used by the P2-3 subscription gate. Empty
   * ⇒ user is considered eligible (no row).
   */
  coachSubs?: Array<{ coach_id: string; status: string }>;
  /**
   * ClientPurchase rows. Used by the P2-3 subscription gate. Empty
   * ⇒ user is considered eligible. A user with rows is excluded only
   * if ALL of them are entitlement_active=false.
   */
  clientPurchases?: Array<{ client_user_id: string; entitlement_active: boolean }>;
}

function makePrisma(db: FakeDb) {
  // Counters expose how many round-trips a detector made — used by
  // the P2-1 N+1 regression test below.
  const counts = {
    checkInGroupBy: 0,
    checkInFindFirst: 0,
    notificationGroupBy: 0,
    notificationFindFirst: 0,
    userFindMany: 0,
  };
  return {
    __counts: counts,
    checkIn: {
      groupBy: jest.fn(async (args: any = {}) => {
        counts.checkInGroupBy++;
        // The inactive detector keys on _max.logged_at; the missed-checkin
        // detector keys on _max.date. Compute both so either caller works.
        const userIdFilter: Set<string> | null = args.where?.user_id?.in
          ? new Set(args.where.user_id.in as string[])
          : null;
        const byUser = new Map<string, { date: Date; logged_at: Date }>();
        for (const c of db.checkIns) {
          if (userIdFilter && !userIdFilter.has(c.user_id)) continue;
          const cur = byUser.get(c.user_id);
          if (!cur) {
            byUser.set(c.user_id, { date: c.date, logged_at: c.logged_at });
          } else {
            if (c.date > cur.date) cur.date = c.date;
            if (c.logged_at > cur.logged_at) cur.logged_at = c.logged_at;
          }
        }
        return Array.from(byUser.entries()).map(([user_id, agg]) => ({
          user_id,
          _max: agg,
        }));
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return db.checkIns
          .filter((c) => (where.date?.gte ? c.date >= where.date.gte : true))
          .sort((a, b) => {
            if (a.user_id !== b.user_id) return a.user_id < b.user_id ? -1 : 1;
            return b.date.getTime() - a.date.getTime();
          });
      }),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        counts.checkInFindFirst++;
        const filtered = db.checkIns
          .filter((c) => c.user_id === where.user_id)
          .sort((a, b) =>
            (orderBy?.logged_at === 'desc' ? -1 : 1) *
            (a.logged_at.getTime() - b.logged_at.getTime()),
          );
        return filtered[0] ?? null;
      }),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) => {
        counts.userFindMany++;
        return db.users.filter((u) => {
          if (where.archived_at === null && u.archived_at !== null) return false;
          if (where.deleted_at === null && u.deleted_at !== null) return false;
          if (where.created_at?.gte && u.created_at < where.created_at.gte) return false;
          if (where.created_at?.lte && u.created_at > where.created_at.lte) return false;
          if (where.profile?.is?.onboardingCompleted !== undefined) {
            if (u.profile?.onboardingCompleted !== where.profile.is.onboardingCompleted) return false;
          }
          return true;
        });
      }),
    },
    notification: {
      groupBy: jest.fn(async (args: any = {}) => {
        counts.notificationGroupBy++;
        const userIdFilter: Set<string> | null = args.where?.user_id?.in
          ? new Set(args.where.user_id.in as string[])
          : null;
        const byUser = new Map<string, Date>();
        for (const n of db.notifications) {
          if (userIdFilter && !userIdFilter.has(n.user_id)) continue;
          if (n.read_at == null) continue; // matches { read_at: { not: null } }
          const cur = byUser.get(n.user_id);
          if (!cur || n.read_at > cur) byUser.set(n.user_id, n.read_at);
        }
        return Array.from(byUser.entries()).map(([user_id, read_at]) => ({
          user_id,
          _max: { read_at },
        }));
      }),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        counts.notificationFindFirst++;
        const filtered = db.notifications
          .filter((n) => n.user_id === where.user_id && (where.read_at?.not !== undefined ? n.read_at != null : true))
          .sort((a, b) => {
            const aT = a.read_at?.getTime() ?? 0;
            const bT = b.read_at?.getTime() ?? 0;
            return (orderBy?.read_at === 'desc' ? -1 : 1) * (aT - bT);
          });
        return filtered[0] ?? null;
      }),
    },
    notificationPreferences: {
      findMany: jest.fn(async ({ where }: any) => {
        const filter: Set<string> | null = where?.user_id?.in
          ? new Set(where.user_id.in as string[])
          : null;
        return (db.prefs ?? []).filter((p) => !filter || filter.has(p.user_id));
      }),
    },
    coachSubscription: {
      findMany: jest.fn(async ({ where }: any) => {
        const filter: Set<string> | null = where?.coach_id?.in
          ? new Set(where.coach_id.in as string[])
          : null;
        return (db.coachSubs ?? []).filter((s) => !filter || filter.has(s.coach_id));
      }),
    },
    clientPurchase: {
      findMany: jest.fn(async ({ where }: any) => {
        const filter: Set<string> | null = where?.client_user_id?.in
          ? new Set(where.client_user_id.in as string[])
          : null;
        return (db.clientPurchases ?? []).filter(
          (p) => !filter || filter.has(p.client_user_id),
        );
      }),
    },
  } as any;
}

describe('NudgeDetectorService.detectMissedCheckin', () => {
  it('flags users with last check-in 2–6 days ago', async () => {
    const db: FakeDb = {
      users: [],
      notifications: [],
      checkIns: [
        // last check-in 3 days ago → IN window
        { user_id: 'u-stale-3d', date: daysAgo(3), logged_at: daysAgo(3) },
        // last check-in 0 days ago → still fresh, out
        { user_id: 'u-fresh', date: NOW, logged_at: NOW },
        // last check-in 8 days ago → inactivity window, not us
        { user_id: 'u-very-stale', date: daysAgo(8), logged_at: daysAgo(8) },
      ],
    };
    const svc = new NudgeDetectorService(makePrisma(db));
    const out = await svc.detectMissedCheckin(NOW);
    expect(out.map((c) => c.user_id)).toEqual(['u-stale-3d']);
    expect(out[0].trigger_type).toBe(NudgeTriggerType.MISSED_CHECKIN);
    expect(out[0].signal_key).toMatch(/^missed_checkin:\d{4}-\d{2}-\d{2}$/);
  });
});

describe('NudgeDetectorService.detectStreakBroken', () => {
  it('flags users with a prior 7+ day streak that just broke', async () => {
    const db: FakeDb = {
      users: [],
      notifications: [],
      // 7 consecutive days ending 1 day ago.
      checkIns: Array.from({ length: 8 }).map((_, i) => ({
        user_id: 'u-streak',
        date: daysAgo(1 + i),
        logged_at: daysAgo(1 + i),
      })),
    };
    const svc = new NudgeDetectorService(makePrisma(db));
    const out = await svc.detectStreakBroken(NOW);
    expect(out).toHaveLength(1);
    expect(out[0].user_id).toBe('u-streak');
    expect(out[0].trigger_type).toBe(NudgeTriggerType.STREAK_BROKEN);
    // signal_key contains the date of the last check-in and the streak length.
    expect(out[0].signal_key).toMatch(/^streak_broken:\d{4}-\d{2}-\d{2}:\d+$/);
  });

  it('ignores users with a prior streak under 7', async () => {
    const db: FakeDb = {
      users: [],
      notifications: [],
      checkIns: Array.from({ length: 5 }).map((_, i) => ({
        user_id: 'u-short',
        date: daysAgo(1 + i),
        logged_at: daysAgo(1 + i),
      })),
    };
    const svc = new NudgeDetectorService(makePrisma(db));
    const out = await svc.detectStreakBroken(NOW);
    expect(out).toEqual([]);
  });

  it('ignores still-active streaks', async () => {
    const db: FakeDb = {
      users: [],
      notifications: [],
      // 10 consecutive days ending TODAY (no break).
      checkIns: Array.from({ length: 10 }).map((_, i) => ({
        user_id: 'u-active',
        date: daysAgo(i),
        logged_at: daysAgo(i),
      })),
    };
    const svc = new NudgeDetectorService(makePrisma(db));
    const out = await svc.detectStreakBroken(NOW);
    expect(out).toEqual([]);
  });
});

describe('NudgeDetectorService.detectOnboardingAbandoned', () => {
  it('flags accounts 48–96h old without completed onboarding', async () => {
    const db: FakeDb = {
      checkIns: [],
      notifications: [],
      users: [
        {
          id: 'u-mid',
          name: 'Jane Doe',
          created_at: hoursAgo(60),
          archived_at: null,
          deleted_at: null,
          profile: { onboardingCompleted: false },
        },
        {
          id: 'u-too-fresh',
          name: 'New Sam',
          created_at: hoursAgo(24),
          archived_at: null,
          deleted_at: null,
          profile: { onboardingCompleted: false },
        },
        {
          id: 'u-too-old',
          name: 'Old Kim',
          created_at: hoursAgo(120),
          archived_at: null,
          deleted_at: null,
          profile: { onboardingCompleted: false },
        },
        {
          id: 'u-done',
          name: 'Done Lee',
          created_at: hoursAgo(60),
          archived_at: null,
          deleted_at: null,
          profile: { onboardingCompleted: true },
        },
      ],
    };
    const svc = new NudgeDetectorService(makePrisma(db));
    const out = await svc.detectOnboardingAbandoned(NOW);
    expect(out.map((c) => c.user_id)).toEqual(['u-mid']);
    expect(out[0].trigger_type).toBe(NudgeTriggerType.ONBOARDING_ABANDONED);
    expect(out[0].context?.first_name).toBe('Jane');
  });
});

describe('NudgeDetectorService.detectInactive', () => {
  it('flags users whose last activity is 7–14 days stale', async () => {
    const db: FakeDb = {
      checkIns: [
        { user_id: 'u-stale', date: daysAgo(9), logged_at: daysAgo(9) },
        { user_id: 'u-fresh', date: daysAgo(2), logged_at: daysAgo(2) },
        { user_id: 'u-too-stale', date: daysAgo(20), logged_at: daysAgo(20) },
      ],
      notifications: [],
      users: [
        {
          id: 'u-stale',
          name: 'Stale User',
          created_at: daysAgo(30),
          archived_at: null,
          deleted_at: null,
        },
        {
          id: 'u-fresh',
          name: 'Fresh User',
          created_at: daysAgo(30),
          archived_at: null,
          deleted_at: null,
        },
        {
          id: 'u-too-stale',
          name: 'Old User',
          created_at: daysAgo(60),
          archived_at: null,
          deleted_at: null,
        },
      ],
    };
    const svc = new NudgeDetectorService(makePrisma(db));
    const out = await svc.detectInactive(NOW);
    expect(out.map((c) => c.user_id)).toEqual(['u-stale']);
    expect(out[0].trigger_type).toBe(NudgeTriggerType.INACTIVE);
  });

  // ─── P2-1 refix: N+1 elimination ─────────────────────────────────────
  // The previous implementation did 2 awaited SELECTs per user per tick.
  // After the refix the detector is bounded at 3 round-trips no matter
  // how many candidate users exist: one user findMany + one checkIn
  // groupBy + one notification groupBy.
  it('uses bounded round-trips (no N+1): 1 user.findMany + 1 checkIn.groupBy + 1 notification.groupBy', async () => {
    // 50 stale users — the pre-refix code would issue 100 per-user
    // SELECTs. Post-refix is a constant 3 calls.
    const users = Array.from({ length: 50 }, (_, i) => ({
      id: `u-${i}`,
      name: `User ${i}`,
      created_at: daysAgo(30),
      archived_at: null,
      deleted_at: null,
    }));
    const checkIns = users.map((u) => ({
      user_id: u.id,
      date: daysAgo(10),
      logged_at: daysAgo(10),
    }));
    const db: FakeDb = { users, checkIns, notifications: [] };
    const prisma = makePrisma(db);
    const svc = new NudgeDetectorService(prisma);

    const out = await svc.detectInactive(NOW);
    expect(out).toHaveLength(50);

    const counts = (prisma as any).__counts;
    expect(counts.userFindMany).toBe(1);
    expect(counts.checkInGroupBy).toBe(1);
    expect(counts.notificationGroupBy).toBe(1);
    // The pre-refix per-user SELECTs must be zero — they are the
    // regression that this test exists to prevent.
    expect(counts.checkInFindFirst).toBe(0);
    expect(counts.notificationFindFirst).toBe(0);
  });

  it('returns empty fast when there are no candidate users (no follow-up groupBy)', async () => {
    const db: FakeDb = { users: [], checkIns: [], notifications: [] };
    const prisma = makePrisma(db);
    const svc = new NudgeDetectorService(prisma);
    const out = await svc.detectInactive(NOW);
    expect(out).toHaveLength(0);
    const counts = (prisma as any).__counts;
    expect(counts.checkInGroupBy).toBe(0);
    expect(counts.notificationGroupBy).toBe(0);
  });
});

describe('Detector window boundaries (no overlap)', () => {
  it('exposes constants matching the spec', () => {
    expect(DETECTOR_WINDOWS.missedCheckinMinDays).toBe(2);
    expect(DETECTOR_WINDOWS.missedCheckinMaxDays).toBe(7);
    expect(DETECTOR_WINDOWS.streakBrokenMinPriorLength).toBe(7);
    expect(DETECTOR_WINDOWS.onboardingAbandonedMinHours).toBe(48);
    expect(DETECTOR_WINDOWS.inactiveMinDays).toBe(7);
  });
});

// ─── P2-2 refix: DST-correct calendar-day arithmetic ──────────────────
// The previous implementation used `floor((later - earlier) / 86_400_000)`,
// which silently mis-counts on DST transitions. These tests pin down the
// new helper's behaviour at the two US transition points.
describe('calendarDayDiff (DST correctness)', () => {
  it('treats spring-forward day (23h) as a single calendar day', () => {
    // 2026-03-08 02:00 PST → 03:00 PDT — the local day is 23h long.
    // Saturday 2026-03-07 17:00 PT and Sunday 2026-03-08 17:00 PT span
    // that boundary. UTC ms math returns 0 days (only 23h elapsed),
    // calendar math returns 1.
    const sat = new Date('2026-03-08T01:00:00Z'); // Sat 2026-03-07 17:00 PT
    const sun = new Date('2026-03-09T00:00:00Z'); // Sun 2026-03-08 17:00 PT
    expect(calendarDayDiff(sun, sat, 'America/Los_Angeles')).toBe(1);
  });

  it('treats fall-back day (25h) as a single calendar day', () => {
    // 2026-11-01 02:00 PDT → 01:00 PST — the local day is 25h long.
    // Sat 2026-10-31 17:00 PT and Sun 2026-11-01 17:00 PT are still
    // exactly one calendar day apart even though 25h elapsed.
    const sat = new Date('2026-11-01T00:00:00Z'); // Sat 2026-10-31 17:00 PDT
    const sun = new Date('2026-11-02T01:00:00Z'); // Sun 2026-11-01 17:00 PST
    expect(calendarDayDiff(sun, sat, 'America/Los_Angeles')).toBe(1);
  });

  it('returns 0 for two instants on the same local calendar day', () => {
    const a = new Date('2026-05-08T08:00:00Z'); // 01:00 PT
    const b = new Date('2026-05-08T23:00:00Z'); // 16:00 PT same day
    expect(calendarDayDiff(b, a, 'America/Los_Angeles')).toBe(0);
  });

  it('honours non-Pacific timezones', () => {
    // Tokyo is UTC+9 and has no DST.
    const a = new Date('2026-05-08T14:00:00Z'); // 2026-05-08 23:00 JST
    const b = new Date('2026-05-08T16:00:00Z'); // 2026-05-09 01:00 JST
    expect(calendarDayDiff(b, a, 'Asia/Tokyo')).toBe(1);
  });

  it('localDateKey renders YYYY-MM-DD in the target tz', () => {
    const d = new Date('2026-03-08T07:30:00Z'); // 23:30 PT 2026-03-07
    expect(localDateKey(d, 'America/Los_Angeles')).toBe('2026-03-07');
    expect(localDateKey(d, 'UTC')).toBe('2026-03-08');
  });
});

describe('NudgeDetectorService.detectStreakBroken (DST)', () => {
  it('flags a streak that ended on spring-forward Sunday with correct local day-count', async () => {
    // "Now" is Tue 2026-03-10 13:00 PDT (= 2026-03-10 20:00 UTC), the
    // day after the 23h spring-forward Sunday. Latest check-in is
    // Sun 2026-03-08 10:00 PDT — the spring-forward day itself. Local
    // calendar diff is exactly 2 days.
    //
    // Pre-refix UTC ms math: now - latest = (Mar-10 20:00 UTC) -
    // (Mar-08 17:00 UTC) = 51h → floor = 2. So in this *exact* case
    // UTC math also got 2, but it does so by accident — the 23h Sunday
    // partially compensates for the 17:00→20:00 UTC drift. Move the
    // latest check-in to 03:00 PDT (= 10:00 UTC) and UTC math returns
    // floor(58h/24) = 2 as well; conversely move now an hour earlier
    // and you'd get UTC math = 1 instead of 2. The new helper is exact
    // regardless of intra-day timing because it operates on date keys.
    const tz = 'America/Los_Angeles';
    const now = new Date('2026-03-10T20:00:00Z'); // Tue 13:00 PDT
    const latest = new Date('2026-03-08T17:00:00Z'); // Sun 10:00 PDT (spring-forward day)
    expect(localDateKey(now, tz)).toBe('2026-03-10');
    expect(localDateKey(latest, tz)).toBe('2026-03-08');
    expect(calendarDayDiff(now, latest, tz)).toBe(2);

    // Build 7 consecutive local-calendar daily check-ins ending Sunday
    // 2026-03-08. Latest day inclusive: 2026-03-02 … 2026-03-08.
    const dates = [
      new Date('2026-03-08T17:00:00Z'), // Sun 10:00 PDT
      new Date('2026-03-07T17:00:00Z'), // Sat 09:00 PST (still PST pre-DST)
      new Date('2026-03-06T17:00:00Z'), // Fri
      new Date('2026-03-05T17:00:00Z'), // Thu
      new Date('2026-03-04T17:00:00Z'), // Wed
      new Date('2026-03-03T17:00:00Z'), // Tue
      new Date('2026-03-02T17:00:00Z'), // Mon
    ];
    const db: FakeDb = {
      users: [],
      notifications: [],
      checkIns: dates.map((d) => ({ user_id: 'u-pst', date: d, logged_at: d })),
      prefs: [{ user_id: 'u-pst', timezone: tz }],
    };
    const svc = new NudgeDetectorService(makePrisma(db));
    const out = await svc.detectStreakBroken(now);
    expect(out).toHaveLength(1);
    expect(out[0].user_id).toBe('u-pst');
    // signal_key date is the latest local date, not the UTC date.
    expect(out[0].signal_key).toBe('streak_broken:2026-03-08:7');
  });

  it('does not undercount the streak length across the DST boundary', async () => {
    // Same scenario but framed around the gap-walk. If `calendarDayDiff`
    // returned 0 for the Sat→Sun (PST→PDT) jump, the gap-walk would
    // treat them as the same day and the streak count would be 6, not 7,
    // dropping the user below the 7-day threshold. This test pins that
    // failure mode.
    const tz = 'America/Los_Angeles';
    // Sat 17:00 PST → Sun 17:00 PDT crosses spring-forward; they differ
    // by 23h in UTC but 1 calendar day locally.
    const sat = new Date('2026-03-08T01:00:00Z'); // Sat 17:00 PST
    const sun = new Date('2026-03-09T00:00:00Z'); // Sun 17:00 PDT (next local day)
    expect(calendarDayDiff(sun, sat, tz)).toBe(1);
  });

  it('honours a non-default timezone from NotificationPreferences', async () => {
    // Asia/Tokyo (UTC+9) user. "Now" = 2026-05-10 09:00 UTC = 18:00 JST 2026-05-10.
    // Latest check-in 2 calendar days ago in Tokyo, with 7 prior days.
    const now = new Date('2026-05-10T09:00:00Z');
    const tz = 'Asia/Tokyo';
    // Build dates 2026-05-08, -07, -06, -05, -04, -03, -02 each at 18:00 JST
    // (= 09:00 UTC the same date).
    const dayNums = [8, 7, 6, 5, 4, 3, 2];
    const dates = dayNums.map(
      (d) => new Date(`2026-05-${String(d).padStart(2, '0')}T09:00:00Z`),
    );
    expect(localDateKey(now, tz)).toBe('2026-05-10');
    expect(localDateKey(dates[0], tz)).toBe('2026-05-08');
    expect(calendarDayDiff(now, dates[0], tz)).toBe(2);
    const db: FakeDb = {
      users: [],
      notifications: [],
      checkIns: dates.map((d) => ({ user_id: 'u-jp', date: d, logged_at: d })),
      prefs: [{ user_id: 'u-jp', timezone: tz }],
    };
    const svc = new NudgeDetectorService(makePrisma(db));
    const out = await svc.detectStreakBroken(now);
    expect(out).toHaveLength(1);
    expect(out[0].signal_key).toBe('streak_broken:2026-05-08:7');
  });
});

// ─── P2-3 refix: subscription-state gate ──────────────────────────
// scanAll() must drop candidates for users whose billing is in a non-active
// state. We drive it through scanAll() (where the filter lives) and ensure
// every non-active state is honoured.
describe('NudgeDetectorService.scanAll subscription-state filter (P2-3)', () => {
  function makeBaseDb(): FakeDb {
    // Six stale-inactive users. We'll vary their subscription state per test.
    const users = ['u-active', 'u-trialing', 'u-canceled', 'u-past_due', 'u-paused', 'u-unpaid'].map(
      (id) => ({
        id,
        name: id,
        created_at: daysAgo(30),
        archived_at: null,
        deleted_at: null,
      }),
    );
    const checkIns = users.map((u) => ({
      user_id: u.id,
      date: daysAgo(10),
      logged_at: daysAgo(10),
    }));
    return { users, checkIns, notifications: [] };
  }

  it('drops coaches whose subscription is canceled / past_due / paused / unpaid', async () => {
    const db = makeBaseDb();
    db.coachSubs = [
      { coach_id: 'u-active', status: 'active' },
      { coach_id: 'u-trialing', status: 'trialing' },
      { coach_id: 'u-canceled', status: 'canceled' },
      { coach_id: 'u-past_due', status: 'past_due' },
      { coach_id: 'u-paused', status: 'paused' },
      { coach_id: 'u-unpaid', status: 'unpaid' },
    ];
    const svc = new NudgeDetectorService(makePrisma(db));
    const out = await svc.scanAll(NOW);
    const ids = new Set(out.map((c) => c.user_id));
    expect(ids.has('u-active')).toBe(true);
    expect(ids.has('u-trialing')).toBe(true);
    expect(ids.has('u-canceled')).toBe(false);
    expect(ids.has('u-past_due')).toBe(false);
    expect(ids.has('u-paused')).toBe(false);
    expect(ids.has('u-unpaid')).toBe(false);
  });

  it('drops clients whose only purchases are entitlement_active=false', async () => {
    const db = makeBaseDb();
    db.clientPurchases = [
      // u-active has one active purchase → kept
      { client_user_id: 'u-active', entitlement_active: true },
      // u-canceled has only inactive purchases → dropped
      { client_user_id: 'u-canceled', entitlement_active: false },
      { client_user_id: 'u-canceled', entitlement_active: false },
      // u-past_due has a mix → kept (any active wins)
      { client_user_id: 'u-past_due', entitlement_active: false },
      { client_user_id: 'u-past_due', entitlement_active: true },
    ];
    const svc = new NudgeDetectorService(makePrisma(db));
    const out = await svc.scanAll(NOW);
    const ids = new Set(out.map((c) => c.user_id));
    expect(ids.has('u-active')).toBe(true);
    expect(ids.has('u-past_due')).toBe(true);
    expect(ids.has('u-canceled')).toBe(false);
    // Users without any sub or purchase row are kept (free / pre-paywall).
    expect(ids.has('u-trialing')).toBe(true);
    expect(ids.has('u-paused')).toBe(true);
    expect(ids.has('u-unpaid')).toBe(true);
  });

  it('keeps users with no subscription rows at all (free tier / pre-paywall)', async () => {
    const db = makeBaseDb();
    // No coachSubs, no clientPurchases.
    const svc = new NudgeDetectorService(makePrisma(db));
    const out = await svc.scanAll(NOW);
    // All six are kept since none are in a known-lapsed state.
    expect(out).toHaveLength(6);
  });

  it('returns [] when there are no candidates without issuing the gate query', async () => {
    const db: FakeDb = { users: [], checkIns: [], notifications: [] };
    const prisma = makePrisma(db);
    const svc = new NudgeDetectorService(prisma);
    const out = await svc.scanAll(NOW);
    expect(out).toEqual([]);
    // No candidates ⇒ we should not waste round-trips on the sub gate.
    expect((prisma.coachSubscription.findMany as jest.Mock).mock.calls.length).toBe(0);
    expect((prisma.clientPurchase.findMany as jest.Mock).mock.calls.length).toBe(0);
  });
});
