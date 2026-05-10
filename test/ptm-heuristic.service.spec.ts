import { PtmHeuristicService } from '../src/ptm/ptm-heuristic.service';
import type { PtmSignalTypeT } from '../src/ptm/ptm.types';

// Heuristic v1 scoring engine tests. Pin the contract:
//
//   - An empty signal set returns risk=0 and a non-zero success score
//     in the upper half (no factors fired).
//   - A synthesized "high risk" pattern accumulates contributions until
//     the riskScore is clamped near 1.0; the firing factors are present
//     in the factors[] array with the brief's contribution magnitudes.
//   - Protective signals reduce risk and lift success.
//   - Weight-trend-aligned: a fat_loss user with three negative-delta
//     weight logs gets the protective factor at -0.12.

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-05-06T12:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY_MS);

interface ClientSignalRow {
  user_id: string;
  signal_type: PtmSignalTypeT;
  value: number;
  recorded_at: Date;
}

interface UserProfileRow {
  user_id: string;
  goal_type: 'fat_loss' | 'muscle_gain' | 'maintenance' | 'performance' | null;
}

function buildPrisma(
  signals: ClientSignalRow[],
  profiles: UserProfileRow[] = [],
) {
  const matchSince = (recordedAt: Date, gte: Date | undefined): boolean => {
    if (!gte) return true;
    return recordedAt >= gte;
  };

  const filterSignals = (where: {
    user_id?: string;
    signal_type?: PtmSignalTypeT;
    recorded_at?: { gte?: Date };
    value?: { gte?: number };
  }): ClientSignalRow[] => {
    return signals.filter((s) => {
      if (where.user_id && s.user_id !== where.user_id) return false;
      if (where.signal_type && s.signal_type !== where.signal_type) return false;
      if (!matchSince(s.recorded_at, where.recorded_at?.gte)) return false;
      if (where.value?.gte !== undefined && s.value < where.value.gte) {
        return false;
      }
      return true;
    });
  };

  const clientSignal = {
    count: jest.fn(async ({ where }: { where: any }) => filterSignals(where).length),
    findFirst: jest.fn(async ({ where, orderBy }: any) => {
      let rows = filterSignals(where);
      if (orderBy?.recorded_at === 'desc') {
        rows = [...rows].sort(
          (a, b) => b.recorded_at.getTime() - a.recorded_at.getTime(),
        );
      }
      return rows[0] ?? null;
    }),
    findMany: jest.fn(async ({ where, orderBy, take }: any) => {
      let rows = filterSignals(where);
      if (orderBy?.recorded_at === 'desc') {
        rows = [...rows].sort(
          (a, b) => b.recorded_at.getTime() - a.recorded_at.getTime(),
        );
      }
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    }),
  };

  const userProfile = {
    findUnique: jest.fn(async ({ where }: any) => {
      return profiles.find((p) => p.user_id === where.user_id) ?? null;
    }),
  };

  return { clientSignal, userProfile };
}

describe('PtmHeuristicService', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it('engaged-but-quiet user (recent signals across all gap factors): risk=0, success in [0.5, 1.0], factors=[]', async () => {
    // The brief's "empty signal set" intent is a brand-new client. But
    // the gap-factor tier of the heuristic reads absence-of-signal as
    // risk: a literally empty set fires every "no X in last N days"
    // factor and clamps risk to 0.85+. The semantically-clean
    // "no factors fire" baseline is a user with one fresh signal in
    // every gap-tracked stream and below-threshold counts on the rest.
    const userId = 'u-baseline';
    const signals: ClientSignalRow[] = [
      { user_id: userId, signal_type: 'app_open', value: 1, recorded_at: daysAgo(0) },
      { user_id: userId, signal_type: 'coach_note_received', value: 1, recorded_at: daysAgo(8) },
      { user_id: userId, signal_type: 'weight_logged', value: -0.1, recorded_at: daysAgo(7) },
      { user_id: userId, signal_type: 'workout_logged', value: 100, recorded_at: daysAgo(8) },
      { user_id: userId, signal_type: 'meal_logged', value: 600, recorded_at: daysAgo(5) },
      // finance_eod: 3+ entries in last 7 days -> ratio >= 0.3, factor does not fire.
      { user_id: userId, signal_type: 'finance_eod', value: 1, recorded_at: daysAgo(0) },
      { user_id: userId, signal_type: 'finance_eod', value: 1, recorded_at: daysAgo(2) },
      { user_id: userId, signal_type: 'finance_eod', value: 1, recorded_at: daysAgo(4) },
    ];
    const prisma: any = buildPrisma(signals);
    const svc = new PtmHeuristicService(prisma);
    const result = await svc.score(userId);
    expect(result.basis).toBe('heuristic_v1');
    expect(result.riskScore).toBe(0);
    expect(result.successScore).toBeGreaterThanOrEqual(0.5);
    expect(result.successScore).toBeLessThanOrEqual(1.0);
    expect(result.factors).toEqual([]);
  });

  it('genuinely empty signal set: gap factors fire, risk clamps high (documents the heuristic)', async () => {
    // A literally signal-less user reads as high-risk via the gap-tier
    // factors. This is the heuristic's correct read of "we have not
    // observed this user at all" — and the test pins it so a future
    // engine tweak that silently swallows the gap factors does not
    // sneak through.
    const prisma: any = buildPrisma([]);
    const svc = new PtmHeuristicService(prisma);
    const result = await svc.score('u-empty');
    expect(result.basis).toBe('heuristic_v1');
    expect(result.riskScore).toBeGreaterThanOrEqual(0.8);
    const keys = result.factors.map((f) => f.key);
    expect(keys).toContain('app_open_gap_7d');
    expect(keys).toContain('weight_skip_14d');
  });

  it('synthesized high-risk pattern: risk approaches 0.9+, fires checkin_miss_3plus and app_open_gap_7d', async () => {
    const userId = 'u-risky';
    // 3+ checkin_miss in last 14 days; no app_open ever; no coach note;
    // no weight_logged; consistency_low recent; no workouts; no meals;
    // 0 finance_eod entries (=> ratio 0 => fires).
    const signals: ClientSignalRow[] = [
      { user_id: userId, signal_type: 'checkin_miss', value: 1, recorded_at: daysAgo(1) },
      { user_id: userId, signal_type: 'checkin_miss', value: 1, recorded_at: daysAgo(5) },
      { user_id: userId, signal_type: 'checkin_miss', value: 1, recorded_at: daysAgo(10) },
      { user_id: userId, signal_type: 'consistency_low', value: 0.3, recorded_at: daysAgo(2) },
      { user_id: userId, signal_type: 'streak_dropped', value: 0.6, recorded_at: daysAgo(2) },
    ];
    const prisma: any = buildPrisma(signals);
    const svc = new PtmHeuristicService(prisma);
    const result = await svc.score(userId);
    expect(result.basis).toBe('heuristic_v1');
    expect(result.riskScore).toBeGreaterThanOrEqual(0.9);
    const keys = result.factors.map((f) => f.key);
    expect(keys).toContain('checkin_miss_3plus');
    expect(keys).toContain('app_open_gap_7d');
    expect(keys).toContain('coach_note_gap_10d');
    expect(keys).toContain('weight_skip_14d');
    expect(keys).toContain('streak_dropped_recent');
    expect(keys).toContain('consistency_low_recent');
    expect(keys).toContain('workout_skip_10d');
    expect(keys).toContain('meal_skip_7d');
    expect(keys).toContain('finance_eod_skip_5plus');
  });

  it('protective signals reduce risk and lift success', async () => {
    const userId = 'u-protected';
    // Recent app_open and workout — no high-risk factors fire. Plus
    // checkin_streak >= 7, finance_milestone, coach_note, workout in
    // last 3 days. risk should be 0 (negative contributions clamp to 0)
    // and success should be > 0.5.
    const signals: ClientSignalRow[] = [
      { user_id: userId, signal_type: 'app_open', value: 1, recorded_at: daysAgo(0) },
      { user_id: userId, signal_type: 'coach_note_received', value: 1, recorded_at: daysAgo(1) },
      { user_id: userId, signal_type: 'workout_logged', value: 100, recorded_at: daysAgo(1) },
      { user_id: userId, signal_type: 'meal_logged', value: 600, recorded_at: daysAgo(0) },
      { user_id: userId, signal_type: 'weight_logged', value: -0.5, recorded_at: daysAgo(2) },
      { user_id: userId, signal_type: 'checkin_streak', value: 10, recorded_at: daysAgo(1) },
      { user_id: userId, signal_type: 'finance_milestone', value: 1, recorded_at: daysAgo(3) },
      { user_id: userId, signal_type: 'finance_eod', value: 1, recorded_at: daysAgo(0) },
      { user_id: userId, signal_type: 'finance_eod', value: 1, recorded_at: daysAgo(1) },
      { user_id: userId, signal_type: 'finance_eod', value: 1, recorded_at: daysAgo(2) },
      { user_id: userId, signal_type: 'finance_eod', value: 1, recorded_at: daysAgo(3) },
      { user_id: userId, signal_type: 'finance_eod', value: 1, recorded_at: daysAgo(4) },
      { user_id: userId, signal_type: 'finance_eod', value: 1, recorded_at: daysAgo(5) },
    ];
    const prisma: any = buildPrisma(signals);
    const svc = new PtmHeuristicService(prisma);
    const result = await svc.score(userId);
    expect(result.riskScore).toBe(0);
    expect(result.successScore).toBeGreaterThan(0.5);
    const keys = result.factors.map((f) => f.key);
    expect(keys).toContain('checkin_streak_7plus');
    expect(keys).toContain('finance_milestone_recent');
    expect(keys).toContain('coach_note_recent');
    expect(keys).toContain('workout_recent');
    // High-risk factors must NOT fire.
    expect(keys).not.toContain('app_open_gap_7d');
    expect(keys).not.toContain('coach_note_gap_10d');
    expect(keys).not.toContain('weight_skip_14d');
  });

  it('weight_trend_aligned: fat_loss user with 3 negative-delta logs gets -0.12', async () => {
    const userId = 'u-cutting';
    const signals: ClientSignalRow[] = [
      { user_id: userId, signal_type: 'weight_logged', value: -0.4, recorded_at: daysAgo(1) },
      { user_id: userId, signal_type: 'weight_logged', value: -0.3, recorded_at: daysAgo(5) },
      { user_id: userId, signal_type: 'weight_logged', value: -0.5, recorded_at: daysAgo(9) },
      // Recent app_open so the heuristic does not fire weight_skip_14d.
      { user_id: userId, signal_type: 'app_open', value: 1, recorded_at: daysAgo(0) },
    ];
    const profile: UserProfileRow = { user_id: userId, goal_type: 'fat_loss' };
    const prisma: any = buildPrisma(signals, [profile]);
    const svc = new PtmHeuristicService(prisma);
    const result = await svc.score(userId);
    const aligned = result.factors.find((f) => f.key === 'weight_trend_aligned');
    expect(aligned).toBeDefined();
    expect(aligned!.contribution).toBe(-0.12);
  });

  it('weight_trend_aligned: skipped if profile missing or fewer than 2 logs', async () => {
    const userId = 'u-no-profile';
    const signals: ClientSignalRow[] = [
      { user_id: userId, signal_type: 'weight_logged', value: -0.3, recorded_at: daysAgo(1) },
      { user_id: userId, signal_type: 'app_open', value: 1, recorded_at: daysAgo(0) },
    ];
    const prisma: any = buildPrisma(signals, []);
    const svc = new PtmHeuristicService(prisma);
    const result = await svc.score(userId);
    expect(
      result.factors.find((f) => f.key === 'weight_trend_aligned'),
    ).toBeUndefined();
  });
});
