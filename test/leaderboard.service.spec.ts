// Phase 7C — LeaderboardService unit tests.
//
// Pins:
//   1. Formula correctness — synthetic fixtures produce expected scores.
//   2. Opt-out exclusion — opted-out users never appear in the ranked list.
//   3. Coach-roster scoping — only members of the same coach roster appear.
//   4. Display name derivation — "{firstName} {lastInitial}." fallback from `name`.
//   5. Score clamping — raw values above the denominator cap at 1.0.
//   6. Kill switch — LEADERBOARD_ENABLED=off returns empty.

import { LeaderboardService } from '../src/leaderboard/leaderboard.service';

// ─── Prisma fake ──────────────────────────────────────────────────────────────

interface FakeUser {
  id:                       string;
  name:                     string;
  coach_id:                 string | null;
  show_on_leaderboard:      boolean;
  leaderboard_display_name: string | null;
  deleted_at:               Date | null;
}

interface FakeSignal {
  id:          string;
  user_id:     string;
  signal_type: string;
  value:       number | null;
  recorded_at: Date;
}

function buildPrisma(users: FakeUser[], signals: FakeSignal[]) {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const u = users.find((x) => x.id === where.id) ?? null;
        if (!u || !select) return u;
        const result: any = {};
        for (const k of Object.keys(select)) result[k] = (u as any)[k];
        return result;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return users.filter((u) => {
          if (where?.coach_id && u.coach_id !== where.coach_id) return false;
          if (where?.show_on_leaderboard !== undefined && u.show_on_leaderboard !== where.show_on_leaderboard) return false;
          if (where?.deleted_at?.equals !== undefined && u.deleted_at !== null) return false;
          if (where?.deleted_at === null && u.deleted_at !== null) return false;
          return true;
        });
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) throw new Error('not found');
        Object.assign(u, data);
        return u;
      }),
    },
    clientSignal: {
      findFirst: jest.fn(async ({ where }: any) => {
        const matches = signals.filter(
          (s) => s.user_id === where.user_id && s.signal_type === where.signal_type,
        );
        if (!matches.length) return null;
        // Sort descending by recorded_at
        matches.sort((a, b) => b.recorded_at.getTime() - a.recorded_at.getTime());
        return matches[0];
      }),
      count: jest.fn(async ({ where }: any) => {
        return signals.filter((s) => {
          if (s.user_id !== where.user_id) return false;
          if (s.signal_type !== where.signal_type) return false;
          if (where.recorded_at?.gte && s.recorded_at < where.recorded_at.gte) return false;
          return true;
        }).length;
      }),
    },
  };
  return prisma;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const COACH_ID = 'coach-1';
const NOW = new Date();
const WITHIN_30 = (daysAgo: number) =>
  new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1_000);

// A requester who is opted in and has perfect activity.
// name = "Amara Osei" → derives "Amara O." when no custom display name set.
const USER_PERFECT: FakeUser = {
  id: 'u-perfect',
  name: 'Amara Osei',
  coach_id: COACH_ID,
  show_on_leaderboard: true,
  leaderboard_display_name: null,
  deleted_at: null,
};

// A peer who is opted in with partial activity and an explicit display name.
const USER_PARTIAL: FakeUser = {
  id: 'u-partial',
  name: 'James Webb',
  coach_id: COACH_ID,
  show_on_leaderboard: true,
  leaderboard_display_name: 'JW',
  deleted_at: null,
};

// A peer who is opted OUT — should never appear.
const USER_OPTED_OUT: FakeUser = {
  id: 'u-opted-out',
  name: 'Hidden User',
  coach_id: COACH_ID,
  show_on_leaderboard: false,
  leaderboard_display_name: null,
  deleted_at: null,
};

// A user on a DIFFERENT coach — should never appear.
const USER_OTHER_COACH: FakeUser = {
  id: 'u-other',
  name: 'Other Person',
  coach_id: 'coach-9',
  show_on_leaderboard: true,
  leaderboard_display_name: null,
  deleted_at: null,
};

function buildPerfectSignals(userId: string): FakeSignal[] {
  // 30 checkin_streak signals + streak value 30, 12 workouts, 90 meals, 10 messages
  const sigs: FakeSignal[] = [];
  for (let i = 0; i < 30; i++) {
    sigs.push({ id: `ci-${userId}-${i}`, user_id: userId, signal_type: 'checkin_streak', value: 30, recorded_at: WITHIN_30(i) });
  }
  for (let i = 0; i < 12; i++) {
    sigs.push({ id: `wo-${userId}-${i}`, user_id: userId, signal_type: 'workout_logged', value: null, recorded_at: WITHIN_30(i) });
  }
  for (let i = 0; i < 90; i++) {
    sigs.push({ id: `ml-${userId}-${i}`, user_id: userId, signal_type: 'meal_logged', value: null, recorded_at: WITHIN_30(i % 30) });
  }
  for (let i = 0; i < 10; i++) {
    sigs.push({ id: `ms-${userId}-${i}`, user_id: userId, signal_type: 'message_sent', value: null, recorded_at: WITHIN_30(i) });
  }
  return sigs;
}

function buildPartialSignals(userId: string): FakeSignal[] {
  // Half of each target
  const sigs: FakeSignal[] = [];
  for (let i = 0; i < 15; i++) {
    sigs.push({ id: `ci-${userId}-${i}`, user_id: userId, signal_type: 'checkin_streak', value: 15, recorded_at: WITHIN_30(i) });
  }
  for (let i = 0; i < 6; i++) {
    sigs.push({ id: `wo-${userId}-${i}`, user_id: userId, signal_type: 'workout_logged', value: null, recorded_at: WITHIN_30(i) });
  }
  for (let i = 0; i < 45; i++) {
    sigs.push({ id: `ml-${userId}-${i}`, user_id: userId, signal_type: 'meal_logged', value: null, recorded_at: WITHIN_30(i % 30) });
  }
  for (let i = 0; i < 5; i++) {
    sigs.push({ id: `ms-${userId}-${i}`, user_id: userId, signal_type: 'message_sent', value: null, recorded_at: WITHIN_30(i) });
  }
  return sigs;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LeaderboardService', () => {
  afterEach(() => {
    delete process.env.LEADERBOARD_ENABLED;
  });

  describe('computeScore', () => {
    it('returns 100 for a user with perfect 30-day activity', async () => {
      const signals = buildPerfectSignals(USER_PERFECT.id);
      const svc = new LeaderboardService(buildPrisma([USER_PERFECT], signals) as any);
      const score = await svc.computeScore(USER_PERFECT.id);
      expect(score).toBe(100);
    });

    it('returns ~50 for a user with exactly half of each target met', async () => {
      const signals = buildPartialSignals(USER_PARTIAL.id);
      const svc = new LeaderboardService(buildPrisma([USER_PARTIAL], signals) as any);
      const score = await svc.computeScore(USER_PARTIAL.id);
      // 0.5 * 100 = 50
      expect(score).toBe(50);
    });

    it('returns 0 for a user with no activity', async () => {
      const svc = new LeaderboardService(buildPrisma([USER_PERFECT], []) as any);
      const score = await svc.computeScore(USER_PERFECT.id);
      expect(score).toBe(0);
    });

    it('caps components at 1.0 — over-activity does not exceed 100', async () => {
      // 60 check-ins (double the 30 target)
      const signals: FakeSignal[] = [];
      for (let i = 0; i < 60; i++) {
        signals.push({ id: `ci-${i}`, user_id: USER_PERFECT.id, signal_type: 'checkin_streak', value: 60, recorded_at: WITHIN_30(i % 30) });
      }
      // Fill everything else to max too
      for (let i = 0; i < 24; i++) {
        signals.push({ id: `wo-${i}`, user_id: USER_PERFECT.id, signal_type: 'workout_logged', value: null, recorded_at: WITHIN_30(i % 30) });
      }
      for (let i = 0; i < 180; i++) {
        signals.push({ id: `ml-${i}`, user_id: USER_PERFECT.id, signal_type: 'meal_logged', value: null, recorded_at: WITHIN_30(i % 30) });
      }
      for (let i = 0; i < 20; i++) {
        signals.push({ id: `ms-${i}`, user_id: USER_PERFECT.id, signal_type: 'message_sent', value: null, recorded_at: WITHIN_30(i % 30) });
      }
      const svc = new LeaderboardService(buildPrisma([USER_PERFECT], signals) as any);
      const score = await svc.computeScore(USER_PERFECT.id);
      expect(score).toBe(100);
    });
  });

  describe('getLeaderboard', () => {
    it('excludes opted-out users from the ranked entries', async () => {
      const allUsers = [USER_PERFECT, USER_PARTIAL, USER_OPTED_OUT, USER_OTHER_COACH];
      const allSignals = [
        ...buildPerfectSignals(USER_PERFECT.id),
        ...buildPartialSignals(USER_PARTIAL.id),
      ];
      const svc = new LeaderboardService(buildPrisma(allUsers, allSignals) as any);
      const { entries } = await svc.getLeaderboard(USER_PERFECT.id);
      const ids = entries.map((e) => e.userId);
      expect(ids).not.toContain(USER_OPTED_OUT.id);
    });

    it('never includes users from a different coach roster', async () => {
      const allUsers = [USER_PERFECT, USER_PARTIAL, USER_OPTED_OUT, USER_OTHER_COACH];
      const allSignals = [
        ...buildPerfectSignals(USER_PERFECT.id),
        ...buildPartialSignals(USER_PARTIAL.id),
      ];
      const svc = new LeaderboardService(buildPrisma(allUsers, allSignals) as any);
      const { entries } = await svc.getLeaderboard(USER_PERFECT.id);
      const ids = entries.map((e) => e.userId);
      expect(ids).not.toContain(USER_OTHER_COACH.id);
    });

    it('ranks higher-scoring users above lower-scoring users', async () => {
      const allUsers = [USER_PERFECT, USER_PARTIAL];
      const allSignals = [
        ...buildPerfectSignals(USER_PERFECT.id),
        ...buildPartialSignals(USER_PARTIAL.id),
      ];
      const svc = new LeaderboardService(buildPrisma(allUsers, allSignals) as any);
      const { entries } = await svc.getLeaderboard(USER_PERFECT.id);
      const perfectEntry = entries.find((e) => e.userId === USER_PERFECT.id)!;
      const partialEntry = entries.find((e) => e.userId === USER_PARTIAL.id)!;
      expect(perfectEntry.rank).toBeLessThan(partialEntry.rank);
      expect(perfectEntry.combinedScore).toBeGreaterThan(partialEntry.combinedScore);
    });

    it('returns empty entries when user has no coach', async () => {
      const noCoachUser: FakeUser = { ...USER_PERFECT, coach_id: null };
      const svc = new LeaderboardService(buildPrisma([noCoachUser], []) as any);
      const result = await svc.getLeaderboard(noCoachUser.id);
      expect(result.entries).toHaveLength(0);
      expect(result.selfRank).toBeNull();
    });

    it('returns empty entries when LEADERBOARD_ENABLED=off', async () => {
      process.env.LEADERBOARD_ENABLED = 'off';
      const svc = new LeaderboardService(buildPrisma([USER_PERFECT], []) as any);
      const result = await svc.getLeaderboard(USER_PERFECT.id);
      expect(result.entries).toHaveLength(0);
    });
  });

  describe('setOptIn', () => {
    it('clears the score cache on opt-out', async () => {
      const user = { ...USER_PERFECT };
      const svc = new LeaderboardService(buildPrisma([user], buildPerfectSignals(user.id)) as any);
      // Prime the cache
      await svc.getCachedScore(user.id);
      expect((svc as any).scoreCache.has(user.id)).toBe(true);
      // Opt out
      await svc.setOptIn(user.id, false);
      expect((svc as any).scoreCache.has(user.id)).toBe(false);
    });

    it('persists custom displayName when opting in', async () => {
      const user = { ...USER_PERFECT };
      const prisma = buildPrisma([user], []);
      const svc = new LeaderboardService(prisma as any);
      await svc.setOptIn(user.id, true, 'Amara O.');
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ leaderboard_display_name: 'Amara O.' }),
        }),
      );
    });

    it('clears displayName on opt-out regardless of passed value', async () => {
      const user = { ...USER_PERFECT };
      const prisma = buildPrisma([user], []);
      const svc = new LeaderboardService(prisma as any);
      await svc.setOptIn(user.id, false, 'ignored');
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ leaderboard_display_name: null }),
        }),
      );
    });
  });

  describe('display name derivation', () => {
    it('uses configured leaderboard_display_name when set', async () => {
      const allUsers = [USER_PERFECT, USER_PARTIAL]; // USER_PARTIAL has displayName='JW'
      const allSignals = [
        ...buildPerfectSignals(USER_PERFECT.id),
        ...buildPartialSignals(USER_PARTIAL.id),
      ];
      const svc = new LeaderboardService(buildPrisma(allUsers, allSignals) as any);
      const { entries } = await svc.getLeaderboard(USER_PERFECT.id);
      const partialEntry = entries.find((e) => e.userId === USER_PARTIAL.id)!;
      expect(partialEntry.displayName).toBe('JW');
    });

    it('derives "{firstName} {lastInitial}." from the `name` field when no custom name set', async () => {
      // USER_PERFECT has name='Amara Osei', no custom display name
      // Service parses: parts[0]='Amara', parts[1]='Osei' → 'Amara O.'
      const allUsers = [USER_PERFECT, USER_PARTIAL];
      const allSignals = [
        ...buildPerfectSignals(USER_PERFECT.id),
        ...buildPartialSignals(USER_PARTIAL.id),
      ];
      const svc = new LeaderboardService(buildPrisma(allUsers, allSignals) as any);
      const { entries } = await svc.getLeaderboard(USER_PERFECT.id);
      const perfectEntry = entries.find((e) => e.userId === USER_PERFECT.id)!;
      expect(perfectEntry.displayName).toBe('Amara O.');
    });
  });
});
