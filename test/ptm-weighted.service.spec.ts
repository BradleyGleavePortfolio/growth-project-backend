import { PtmWeightedService } from '../src/ptm/ptm-weighted.service';
import { PTM_WINDOWS } from '../src/ptm/ptm.types';

// Phase 1D — weighted v2 engine tests.
//
// We exercise the engine against a synthetic ClientOutcome / ClientSignal
// dataset and assert four contracts:
//   1. isActive() honours the activation threshold AND the empty-cohort
//      guard.
//   2. Trained weights are directionally sensible — a signal that
//      appears heavily in the FAILURE cohort produces a positive weight,
//      a signal that appears heavily in SUCCESS produces a negative
//      weight.
//   3. score() is callable regardless of activation (admin diagnostics)
//      and returns the documented PtmScoreResult shape.
//   4. The 1-hour in-memory cache short-circuits repeat training calls;
//      refresh() clears it.

type OutcomeRow = {
  outcome_type: string;
  signal_snapshot: Record<string, number> | null;
};

function makePrisma(outcomes: OutcomeRow[], signals: Array<{ signal_type: string; count: number }> = []) {
  return {
    clientOutcome: {
      count: jest.fn(async () => outcomes.length),
      findMany: jest.fn(async () => outcomes),
    },
    clientSignal: {
      groupBy: jest.fn(async () =>
        signals.map((s) => ({
          signal_type: s.signal_type,
          _count: { _all: s.count },
        })),
      ),
    },
  } as any;
}

// 25-outcome synthetic seed. checkin_miss is heavy in the FAILURE
// cohort, message_received is heavy in SUCCESS — directional sense is
// the assertion.
function seed25(): OutcomeRow[] {
  const success: OutcomeRow[] = [];
  const failure: OutcomeRow[] = [];
  for (let i = 0; i < 15; i += 1) {
    success.push({
      outcome_type: 'completed_90day',
      signal_snapshot: {
        checkin_miss: 0,
        message_received: 12,
        workout_logged: 14,
      },
    });
  }
  for (let i = 0; i < 10; i += 1) {
    failure.push({
      outcome_type: 'churned',
      signal_snapshot: {
        checkin_miss: 8,
        message_received: 1,
        workout_logged: 2,
      },
    });
  }
  return [...success, ...failure];
}

describe('PtmWeightedService.isActive', () => {
  const prevEnv = process.env.PTM_WEIGHTED_ACTIVATION_OUTCOMES;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PTM_WEIGHTED_ACTIVATION_OUTCOMES;
    else process.env.PTM_WEIGHTED_ACTIVATION_OUTCOMES = prevEnv;
  });

  it('returns false below the default threshold (20)', async () => {
    const prisma = makePrisma([
      { outcome_type: 'completed_90day', signal_snapshot: { checkin_miss: 0 } },
      { outcome_type: 'churned', signal_snapshot: { checkin_miss: 5 } },
    ]);
    const svc = new PtmWeightedService(prisma);
    await expect(svc.isActive()).resolves.toBe(false);
  });

  it('returns true at the default threshold with both cohorts populated', async () => {
    const prisma = makePrisma(seed25());
    const svc = new PtmWeightedService(prisma);
    await expect(svc.isActive()).resolves.toBe(true);
  });

  it('honours PTM_WEIGHTED_ACTIVATION_OUTCOMES when set', async () => {
    process.env.PTM_WEIGHTED_ACTIVATION_OUTCOMES = '5';
    const prisma = makePrisma([
      { outcome_type: 'completed_90day', signal_snapshot: { checkin_miss: 0 } },
      { outcome_type: 'completed_90day', signal_snapshot: { checkin_miss: 0 } },
      { outcome_type: 'completed_90day', signal_snapshot: { checkin_miss: 0 } },
      { outcome_type: 'churned', signal_snapshot: { checkin_miss: 5 } },
      { outcome_type: 'churned', signal_snapshot: { checkin_miss: 5 } },
    ]);
    const svc = new PtmWeightedService(prisma);
    await expect(svc.isActive()).resolves.toBe(true);
  });

  it('falls back to the default when PTM_WEIGHTED_ACTIVATION_OUTCOMES is invalid', async () => {
    process.env.PTM_WEIGHTED_ACTIVATION_OUTCOMES = 'not-a-number';
    const prisma = makePrisma(seed25());
    const svc = new PtmWeightedService(prisma);
    await expect(svc.isActive()).resolves.toBe(true);
    expect(PTM_WINDOWS.WEIGHTED_ACTIVATION_OUTCOMES).toBe(20);
  });

  it('returns false when SUCCESS cohort is empty even if total >= threshold', async () => {
    // 20 failure rows, 0 success rows: empty-cohort guard fires.
    const failures: OutcomeRow[] = [];
    for (let i = 0; i < 20; i += 1) {
      failures.push({
        outcome_type: 'churned',
        signal_snapshot: { checkin_miss: 5 },
      });
    }
    const prisma = makePrisma(failures);
    const svc = new PtmWeightedService(prisma);
    await expect(svc.isActive()).resolves.toBe(false);
  });

  it('returns false when FAILURE cohort is empty even if total >= threshold', async () => {
    const successes: OutcomeRow[] = [];
    for (let i = 0; i < 20; i += 1) {
      successes.push({
        outcome_type: 'completed_90day',
        signal_snapshot: { message_received: 10 },
      });
    }
    const prisma = makePrisma(successes);
    const svc = new PtmWeightedService(prisma);
    await expect(svc.isActive()).resolves.toBe(false);
  });

  it('skips rows whose signal_snapshot is null and surfaces the count', async () => {
    const rows: OutcomeRow[] = seed25();
    rows.push({ outcome_type: 'churned', signal_snapshot: null });
    rows.push({ outcome_type: 'completed_90day', signal_snapshot: null });
    const prisma = makePrisma(rows);
    const svc = new PtmWeightedService(prisma);
    const summary = await svc.getCurrentWeights();
    expect(summary.skipped_no_snapshot).toBe(2);
    expect(summary.training_count).toBe(25);
  });
});

describe('PtmWeightedService.getCurrentWeights — directional sense', () => {
  it('produces positive weight for failure-correlated signals and negative for success-correlated', async () => {
    const prisma = makePrisma(seed25());
    const svc = new PtmWeightedService(prisma);
    const summary = await svc.getCurrentWeights();
    const byType = new Map(summary.weights.map((w) => [w.signal_type, w]));

    const checkinMiss = byType.get('checkin_miss');
    const messageReceived = byType.get('message_received');

    expect(checkinMiss).toBeDefined();
    expect(messageReceived).toBeDefined();
    // checkin_miss appears almost exclusively in the FAILURE cohort, so
    // its weight must be positive (risk-correlated).
    expect(checkinMiss!.weight).toBeGreaterThan(0.5);
    // message_received is heavy in SUCCESS, light in FAILURE → negative weight.
    expect(messageReceived!.weight).toBeLessThan(-0.5);
  });

  it('reports the per-cohort averages and training_max so an operator can audit the weight', async () => {
    const prisma = makePrisma(seed25());
    const svc = new PtmWeightedService(prisma);
    const summary = await svc.getCurrentWeights();
    const checkinMiss = summary.weights.find((w) => w.signal_type === 'checkin_miss')!;
    expect(checkinMiss.success_avg).toBe(0);
    expect(checkinMiss.failure_avg).toBeCloseTo(8, 5);
    expect(checkinMiss.training_max).toBe(8);
    expect(checkinMiss.training_count).toBe(25);
  });
});

describe('PtmWeightedService.score', () => {
  it('returns the documented PtmScoreResult shape with basis weighted_v2', async () => {
    const prisma = makePrisma(seed25(), [
      { signal_type: 'checkin_miss', count: 4 },
      { signal_type: 'message_received', count: 1 },
    ]);
    const svc = new PtmWeightedService(prisma);
    const out = await svc.score('user-1');
    expect(out.basis).toBe('weighted_v2');
    expect(out.riskScore).toBeGreaterThanOrEqual(0);
    expect(out.riskScore).toBeLessThanOrEqual(1);
    expect(out.successScore).toBeGreaterThanOrEqual(0);
    expect(out.successScore).toBeLessThanOrEqual(1);
    // Risk + success are LINKED in v2 (1 - risk = success).
    expect(out.riskScore + out.successScore).toBeCloseTo(1, 5);
    expect(out.factors.length).toBeLessThanOrEqual(5);
    expect(out.factors[0].label).toMatch(/Weighted: /);
  });

  it('a user with mostly checkin_miss observations scores higher risk than one with message_received', async () => {
    const seed = seed25();
    const riskySignals = [
      { signal_type: 'checkin_miss', count: 8 },
      { signal_type: 'message_received', count: 0 },
    ];
    const protectiveSignals = [
      { signal_type: 'checkin_miss', count: 0 },
      { signal_type: 'message_received', count: 12 },
    ];
    const risky = await new PtmWeightedService(makePrisma(seed, riskySignals)).score('u-risky');
    const protective = await new PtmWeightedService(makePrisma(seed, protectiveSignals)).score('u-protective');
    expect(risky.riskScore).toBeGreaterThan(protective.riskScore);
  });

  it('is callable when the engine is below threshold — returns a zero-factor weighted_v2 row for admin diagnostics', async () => {
    // 2 outcomes, well below threshold. score() must not throw — the
    // orchestrator chooses NOT to call it, but admin tooling may.
    const prisma = makePrisma(
      [
        { outcome_type: 'completed_90day', signal_snapshot: { checkin_miss: 0 } },
        { outcome_type: 'churned', signal_snapshot: { checkin_miss: 5 } },
      ],
      [{ signal_type: 'checkin_miss', count: 3 }],
    );
    const svc = new PtmWeightedService(prisma);
    const out = await svc.score('user-1');
    expect(out.basis).toBe('weighted_v2');
    // With 2 outcomes the engine still has both cohorts, so it does
    // train weights — verify the inactive-cohort branch separately
    // below.
    expect(out.factors).toBeInstanceOf(Array);
  });

  it('returns the zero-factor placeholder when both cohorts are empty', async () => {
    const prisma = makePrisma([], []);
    const svc = new PtmWeightedService(prisma);
    const out = await svc.score('user-1');
    expect(out.factors).toEqual([]);
    expect(out.riskScore).toBe(0.5);
    expect(out.successScore).toBe(0.5);
    expect(out.basis).toBe('weighted_v2');
  });
});

describe('PtmWeightedService caching', () => {
  it('runs trainPass exactly once across two consecutive score() calls', async () => {
    const prisma = makePrisma(seed25(), [{ signal_type: 'checkin_miss', count: 4 }]);
    const svc: any = new PtmWeightedService(prisma);
    const trainSpy = jest.spyOn(svc, 'trainPass');
    await svc.score('user-1');
    await svc.score('user-2');
    expect(trainSpy).toHaveBeenCalledTimes(1);
  });

  it('refresh() forces the next score() to retrain', async () => {
    const prisma = makePrisma(seed25(), [{ signal_type: 'checkin_miss', count: 4 }]);
    const svc: any = new PtmWeightedService(prisma);
    const trainSpy = jest.spyOn(svc, 'trainPass');
    await svc.score('user-1');
    svc.refresh();
    await svc.score('user-2');
    expect(trainSpy).toHaveBeenCalledTimes(2);
  });

  it('isActive() and score() share a single training pass within the cache window', async () => {
    const prisma = makePrisma(seed25(), [{ signal_type: 'checkin_miss', count: 4 }]);
    const svc: any = new PtmWeightedService(prisma);
    const trainSpy = jest.spyOn(svc, 'trainPass');
    await svc.isActive();
    await svc.score('user-1');
    await svc.getCurrentWeights();
    expect(trainSpy).toHaveBeenCalledTimes(1);
  });
});
