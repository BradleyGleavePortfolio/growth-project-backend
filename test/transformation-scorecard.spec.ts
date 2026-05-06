import {
  TransformationScorecardService,
  TRANSFORMATION_SCORECARD_COLUMNS,
} from '../src/admin/reports/transformation-scorecard.service';
import { rowsToCsv } from '../src/admin/reports/csv';

// Phase 5 — TransformationScorecardService composition spec.
//
// What this test guards:
//   - The CSV column set is frozen via a snapshot of the header line. Any
//     drift forces a privacy / contract review (the same pattern the
//     clients report uses for its key whitelist).
//   - The composer reads from authoritative tables only — no fabricated
//     numbers. Every column either traces back to a Prisma read in the
//     mock, or is derived from one (weight delta, meal consistency).
//   - Defensive composition: when the optional Phase-3 / Phase-4 tables
//     are missing (or their reads throw), the corresponding columns
//     render `null`, never zero.
//   - Bucketization wires through PTM's shared cutoffs (>0.6 = red).
//   - Empty windows / missing rows render `null`, not synthetic zeros.
//   - Finance federation columns (wealth_velocity_score, net_worth_delta,
//     milestones_hit) render `null` when finance is not configured. Full
//     coverage of the federation path is in
//     transformation-scorecard-finance-columns.spec.ts.

const NOW = new Date('2026-05-06T12:00:00.000Z');

// Stub FinanceAdminClient — unconfigured by default so finance columns
// are null in tests that are not testing the finance path.
function makeFinanceClientStub(configured = false) {
  return {
    isConfigured: jest.fn(() => configured),
    hasAuth: jest.fn(() => false),
    lookupClient: jest.fn(async () => ({ kind: 'degraded', reason: 'not_configured', detail: '' })),
  } as any;
}

function makePrisma(overrides: {
  diagnostic?: 'present' | 'missing' | 'throws';
  buildWeek?: 'present' | 'missing' | 'throws';
  hasWeights?: boolean;
  hasCheckIn?: boolean;
  hasPrediction?: boolean;
  hasOutcome?: boolean;
  workoutCount?: number;
  mealsLogged?: number;
} = {}) {
  const userRows = [
    {
      id: 'u-1',
      email: 'a@x.test',
      name: 'Alice',
      role: 'student',
      created_at: new Date('2025-12-06T00:00:00Z'), // ~5 months before NOW
      coach: { email: 'coach@x.test' },
    },
  ];

  const checkIn = overrides.hasCheckIn === false
    ? null
    : { mood: 4, energy: 3, sleep_hours: 7.5, weight_kg: 80 };

  const earliestWeight = overrides.hasWeights === false
    ? null
    : { weight_lbs: 200 };
  const latestWeight = overrides.hasWeights === false
    ? null
    : { weight_lbs: 188.4 };

  const sessions = (overrides.workoutCount ?? 1) > 0
    ? [
        {
          exercises: [
            // 5 reps × 100 lbs × 3 sets = 1500
            { sets_completed: 3, reps_per_set: [5, 5, 5], weight_per_set: [100, 100, 100] },
            // 8 reps × 50 lbs × 2 sets = 800
            { sets_completed: 2, reps_per_set: [8, 8], weight_per_set: [50, 50] },
          ],
        },
      ]
    : [];

  const mealCount = overrides.mealsLogged ?? 12;
  const mealRows = Array.from({ length: mealCount }).map((_, i) => ({
    recorded_at: new Date(NOW.getTime() - i * 86_400_000),
  }));

  const prediction = overrides.hasPrediction === false
    ? null
    : { risk_score: 0.72, success_score: 0.41 };

  const outcome = overrides.hasOutcome
    ? { outcome_type: 'churned' }
    : null;

  const diagnosticTable: any = overrides.diagnostic === 'throws'
    ? {
        findFirst: jest.fn(async () => {
          throw new Error('relation "diagnostic_submissions" does not exist');
        }),
      }
    : overrides.diagnostic === 'present'
      ? {
          findFirst: jest.fn(async () => ({ overall_score: 72, bucket: 'amber' })),
        }
      : undefined;

  const buildWeekTable: any = overrides.buildWeek === 'throws'
    ? {
        findFirst: jest.fn(async () => {
          throw new Error('relation "build_week_enrollments" does not exist');
        }),
      }
    : overrides.buildWeek === 'present'
      ? {
          findFirst: jest.fn(async () => ({
            status: null,
            current_day: 5,
            completed_at: null,
          })),
        }
      : undefined;

  const prisma: any = {
    user: {
      findUnique: jest.fn(async () => userRows[0]),
      findMany: jest.fn(async () => userRows),
    },
    checkIn: {
      findFirst: jest.fn(async () => checkIn),
    },
    weightLog: {
      findFirst: jest.fn(async ({ orderBy }: any) => {
        const dir = orderBy?.date;
        if (dir === 'asc') return earliestWeight;
        return latestWeight;
      }),
    },
    workoutSession: {
      findMany: jest.fn(async () => sessions),
    },
    clientSignal: {
      findMany: jest.fn(async () => mealRows),
    },
    coachMessage: {
      count: jest.fn(async ({ where }: any) => {
        if (where.sender_id === 'u-1') return 3;
        return 7;
      }),
    },
    ptmPrediction: {
      findFirst: jest.fn(async () => prediction),
    },
    clientOutcome: {
      findUnique: jest.fn(async () => outcome),
    },
  };
  if (diagnosticTable) prisma.diagnosticSubmission = diagnosticTable;
  if (buildWeekTable) prisma.buildWeekEnrollment = buildWeekTable;

  return { prisma };
}

describe('TransformationScorecardService.build', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it('returns the canonical envelope and a single row when user_id is supplied', async () => {
    const { prisma } = makePrisma({
      diagnostic: 'present',
      buildWeek: 'present',
      hasOutcome: true,
    });
    const svc = new TransformationScorecardService(prisma, makeFinanceClientStub());
    const out = await svc.build({ userId: 'u-1', sinceDays: 30 });

    expect(out.report).toBe('transformation-scorecard');
    expect(typeof out.generated_at).toBe('string');
    expect(out.window).toEqual({
      since_days: 30,
      since: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
    });
    expect(out.data).toHaveLength(1);
  });

  it('composes every documented column with values traceable to the mocked tables', async () => {
    const { prisma } = makePrisma({
      diagnostic: 'present',
      buildWeek: 'present',
      hasOutcome: true,
    });
    const svc = new TransformationScorecardService(prisma, makeFinanceClientStub());
    const out = await svc.build({ userId: 'u-1' });
    const row = out.data[0];

    // Identity passthroughs
    expect(row.user_id).toBe('u-1');
    expect(row.email).toBe('a@x.test');
    expect(row.name).toBe('Alice');
    expect(row.role).toBe('student');
    expect(row.coach_email).toBe('coach@x.test');

    // Latest CheckIn
    expect(row.latest_mood).toBe(4);
    expect(row.latest_energy).toBe(3);
    expect(row.latest_sleep_hrs).toBe(7.5);

    // Weight delta = 188.4 − 200 = −11.6
    expect(row.starting_weight_lbs).toBe(200);
    expect(row.current_weight_lbs).toBe(188.4);
    expect(row.weight_delta_lbs).toBe(-11.6);

    // Workout volume = (5*100*3) + (8*50*2) = 1500 + 800 = 2300
    expect(row.workout_volume_30d).toBe(2300);

    // 12 meal_logged signals on 12 distinct days → 12/30 = 40%
    expect(row.meals_logged_30d).toBe(12);
    expect(row.meal_consistency_pct_30d).toBe(40);

    // Messages: sender=u-1 → 3; not u-1 → 7
    expect(row.messages_sent_30d).toBe(3);
    expect(row.messages_received_30d).toBe(7);

    // PTM 0.72 → red bucket
    expect(row.ptm_risk_score).toBe(0.72);
    expect(row.ptm_success_score).toBe(0.41);
    expect(row.ptm_bucket).toBe('red');

    // Outcome
    expect(row.latest_outcome).toBe('churned');

    // Phase-3 / Phase-4 sources present
    expect(row.diagnostic_overall_score).toBe(72);
    expect(row.diagnostic_bucket).toBe('amber');
    expect(row.build_week_status).toBe('day_5');

    // Finance columns null when not configured (FinanceAdminClient stub)
    expect(row.wealth_velocity_score).toBeNull();
    expect(row.net_worth_delta).toBeNull();
    expect(row.milestones_hit).toBeNull();

    // days_active is the integer days between created_at and NOW.
    // 2025-12-06 → 2026-05-06 = 25 + 31 + 28 + 31 + 30 + 6 = 151 days
    // + 12h spillover floors back to 151.
    expect(row.days_active).toBe(151);

    // generated_at is an ISO string equal to the envelope's
    expect(row.generated_at).toBe(out.generated_at);
  });

  it('renders nulls (not zeros) when source rows are missing', async () => {
    const { prisma } = makePrisma({
      hasCheckIn: false,
      hasWeights: false,
      hasPrediction: false,
      hasOutcome: false,
      workoutCount: 0,
      mealsLogged: 0,
      diagnostic: 'missing',
      buildWeek: 'missing',
    });
    const svc = new TransformationScorecardService(prisma, makeFinanceClientStub());
    const out = await svc.build({ userId: 'u-1' });
    const row = out.data[0];

    expect(row.latest_mood).toBeNull();
    expect(row.latest_energy).toBeNull();
    expect(row.latest_sleep_hrs).toBeNull();
    expect(row.starting_weight_lbs).toBeNull();
    expect(row.current_weight_lbs).toBeNull();
    expect(row.weight_delta_lbs).toBeNull();
    // Behavioral counters are real reads — empty ranges legitimately are 0.
    expect(row.workout_volume_30d).toBe(0);
    expect(row.meals_logged_30d).toBe(0);
    expect(row.meal_consistency_pct_30d).toBe(0);
    expect(row.ptm_risk_score).toBeNull();
    expect(row.ptm_success_score).toBeNull();
    expect(row.ptm_bucket).toBeNull();
    expect(row.latest_outcome).toBeNull();
    expect(row.diagnostic_overall_score).toBeNull();
    expect(row.diagnostic_bucket).toBeNull();
    expect(row.build_week_status).toBeNull();
    // Finance columns also null when not configured
    expect(row.wealth_velocity_score).toBeNull();
    expect(row.net_worth_delta).toBeNull();
    expect(row.milestones_hit).toBeNull();
  });

  it('defensively renders null when the optional Phase-3 / Phase-4 reads throw', async () => {
    const { prisma } = makePrisma({
      diagnostic: 'throws',
      buildWeek: 'throws',
    });
    const svc = new TransformationScorecardService(prisma, makeFinanceClientStub());
    const out = await svc.build({ userId: 'u-1' });
    const row = out.data[0];

    // The optional table reads were called; the catch branch fired.
    expect(row.diagnostic_overall_score).toBeNull();
    expect(row.diagnostic_bucket).toBeNull();
    expect(row.build_week_status).toBeNull();
    // The required columns still composed normally — one bad source must
    // not poison the rest of the row.
    expect(row.user_id).toBe('u-1');
    expect(row.workout_volume_30d).toBe(2300);
  });

  it('routes coach_id to a per-coach roster query', async () => {
    const { prisma } = makePrisma();
    const svc = new TransformationScorecardService(prisma, makeFinanceClientStub());
    await svc.build({ coachId: 'coach-7' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { coach_id: 'coach-7' },
        take: 1000,
      }),
    );
  });

  it('clamps since_days into [7, 365] (default 90)', async () => {
    const { prisma } = makePrisma();
    const svc = new TransformationScorecardService(prisma, makeFinanceClientStub());

    const tooHigh = await svc.build({ userId: 'u-1', sinceDays: 9999 });
    expect(tooHigh.window?.since_days).toBe(365);

    const tooLow = await svc.build({ userId: 'u-1', sinceDays: 1 });
    expect(tooLow.window?.since_days).toBe(7);

    const def = await svc.build({ userId: 'u-1' });
    expect(def.window?.since_days).toBe(90);
  });

  it('CSV header line is frozen (column count + order)', () => {
    // Column count is 28: 25 original + 3 finance columns
    // (wealth_velocity_score, net_worth_delta, milestones_hit)
    // inserted before generated_at.
    expect(TRANSFORMATION_SCORECARD_COLUMNS).toHaveLength(28);
    const header = rowsToCsv(TRANSFORMATION_SCORECARD_COLUMNS, []).split('\r\n')[0];
    // Frozen snapshot: any column rename / reorder / insertion fails this
    // assertion, forcing a docs + downstream-pipeline review before the
    // CSV contract drifts.
    const expected = [
      'user_id',
      'email',
      'name',
      'role',
      'coach_email',
      'days_active',
      'latest_mood',
      'latest_energy',
      'latest_sleep_hrs',
      'starting_weight_lbs',
      'current_weight_lbs',
      'weight_delta_lbs',
      'workout_volume_30d',
      'meals_logged_30d',
      'meal_consistency_pct_30d',
      'messages_sent_30d',
      'messages_received_30d',
      'ptm_risk_score',
      'ptm_success_score',
      'ptm_bucket',
      'latest_outcome',
      'diagnostic_overall_score',
      'diagnostic_bucket',
      'build_week_status',
      'wealth_velocity_score',
      'net_worth_delta',
      'milestones_hit',
      'generated_at',
    ].join(',');
    expect(header).toBe(expected);
  });
});
