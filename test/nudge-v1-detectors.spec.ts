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
}

function makePrisma(db: FakeDb) {
  return {
    checkIn: {
      groupBy: jest.fn(async () => {
        const byUser = new Map<string, Date>();
        for (const c of db.checkIns) {
          const cur = byUser.get(c.user_id);
          if (!cur || c.date > cur) byUser.set(c.user_id, c.date);
        }
        return Array.from(byUser.entries()).map(([user_id, date]) => ({
          user_id,
          _max: { date },
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
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
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
