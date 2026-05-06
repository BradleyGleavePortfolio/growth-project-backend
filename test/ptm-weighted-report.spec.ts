import { ReportsService } from '../src/admin/reports/reports.service';
import { rowsToCsv } from '../src/admin/reports/csv';

// /admin/reports/ptm-signal-weights — verifies:
//   - The report envelope is wrapped in the canonical
//     { report, generated_at, window, data } shape.
//   - When the engine is INACTIVE the response carries
//     basis='heuristic_v1', empty data array, and a `reason` /
//     `activation_threshold` field so the operator can tell why no
//     weights are available.
//   - When the engine IS active the response carries basis='weighted_v2'
//     and a row per learned weight with the documented column shape.
//   - The CSV form (built in the controller) emits the documented header
//     columns and one row per weight. We assert the underlying rows
//     directly and rely on the controller's rowsToCsv helper for the
//     CSV serialisation (covered in reports-csv.spec).

function buildSvc(opts: {
  active: boolean;
  weights?: Array<{
    signal_type: string;
    weight: number;
    training_count: number;
    training_max: number;
    success_avg: number;
    failure_avg: number;
  }>;
  trainingCount?: number;
  successCount?: number;
  failureCount?: number;
  skippedNoSnapshot?: number;
}) {
  const ptmWeighted: any = {
    isActive: jest.fn(async () => opts.active),
    getCurrentWeights: jest.fn(async () => ({
      generated_at: '2026-05-06T00:00:00.000Z',
      training_count: opts.trainingCount ?? (opts.weights?.length ?? 0),
      skipped_no_snapshot: opts.skippedNoSnapshot ?? 0,
      skipped_unclassified: 0,
      success_count: opts.successCount ?? 0,
      failure_count: opts.failureCount ?? 0,
      weights: opts.weights ?? [],
    })),
  };
  const prisma: any = {};
  const metrics: any = {};
  const financeFederation: any = {};
  const audit: any = {};
  return new ReportsService(prisma, metrics, financeFederation, audit, ptmWeighted);
}

describe('ReportsService.ptmSignalWeights — inactive engine', () => {
  it('returns basis=heuristic_v1 with empty data and a below_activation_threshold reason', async () => {
    const svc = buildSvc({ active: false, trainingCount: 5 });
    const out = await svc.ptmSignalWeights();
    expect(out.report).toBe('ptm-signal-weights');
    expect(out.basis).toBe('heuristic_v1');
    expect(out.data).toEqual([]);
    expect(out.reason).toBe('below_activation_threshold');
    expect(out.activation_threshold).toBe(20);
    expect(out.training_count).toBe(5);
  });

  it('returns reason=empty_cohort when training_count >= threshold but cohort guard fired', async () => {
    const svc = buildSvc({
      active: false,
      trainingCount: 25,
      successCount: 25,
      failureCount: 0,
    });
    const out = await svc.ptmSignalWeights();
    expect(out.basis).toBe('heuristic_v1');
    expect(out.reason).toBe('empty_cohort');
    expect(out.training_count).toBe(25);
  });

  it('honours PTM_WEIGHTED_ACTIVATION_OUTCOMES when surfacing activation_threshold', async () => {
    const prev = process.env.PTM_WEIGHTED_ACTIVATION_OUTCOMES;
    process.env.PTM_WEIGHTED_ACTIVATION_OUTCOMES = '50';
    try {
      const svc = buildSvc({ active: false, trainingCount: 10 });
      const out = await svc.ptmSignalWeights();
      expect(out.activation_threshold).toBe(50);
    } finally {
      if (prev === undefined) delete process.env.PTM_WEIGHTED_ACTIVATION_OUTCOMES;
      else process.env.PTM_WEIGHTED_ACTIVATION_OUTCOMES = prev;
    }
  });
});

describe('ReportsService.ptmSignalWeights — active engine', () => {
  it('returns basis=weighted_v2 with one row per trained weight', async () => {
    const svc = buildSvc({
      active: true,
      trainingCount: 25,
      successCount: 15,
      failureCount: 10,
      weights: [
        {
          signal_type: 'checkin_miss',
          weight: 0.95,
          training_count: 25,
          training_max: 8,
          success_avg: 0,
          failure_avg: 8,
        },
        {
          signal_type: 'message_received',
          weight: -0.85,
          training_count: 25,
          training_max: 12,
          success_avg: 12,
          failure_avg: 1,
        },
      ],
    });
    const out = await svc.ptmSignalWeights();
    expect(out.report).toBe('ptm-signal-weights');
    expect(out.basis).toBe('weighted_v2');
    expect(out.training_count).toBe(25);
    expect(out.success_count).toBe(15);
    expect(out.failure_count).toBe(10);
    expect(out.data).toHaveLength(2);
    const checkin = out.data.find((r) => r.signal_type === 'checkin_miss')!;
    expect(checkin).toEqual({
      signal_type: 'checkin_miss',
      weight: 0.95,
      training_count: 25,
      training_max: 8,
      success_avg: 0,
      failure_avg: 8,
      basis: 'weighted_v2',
    });
    expect(out.reason).toBeUndefined();
  });

  it('the row shape is the privacy-reviewed column whitelist (no extras)', async () => {
    const svc = buildSvc({
      active: true,
      trainingCount: 20,
      successCount: 10,
      failureCount: 10,
      weights: [
        {
          signal_type: 'checkin_miss',
          weight: 0.5,
          training_count: 20,
          training_max: 5,
          success_avg: 0,
          failure_avg: 5,
        },
      ],
    });
    const out = await svc.ptmSignalWeights();
    expect(Object.keys(out.data[0]).sort()).toEqual(
      [
        'basis',
        'failure_avg',
        'signal_type',
        'success_avg',
        'training_count',
        'training_max',
        'weight',
      ].sort(),
    );
  });
});

describe('ReportsService.ptmSignalWeights — CSV serialisation', () => {
  // The controller is what calls rowsToCsv, but we exercise the same
  // helper here to lock the column ordering that the controller sets.
  it('serialises rows with the documented header line in the documented order', async () => {
    const svc = buildSvc({
      active: true,
      trainingCount: 25,
      successCount: 15,
      failureCount: 10,
      weights: [
        {
          signal_type: 'checkin_miss',
          weight: 0.95,
          training_count: 25,
          training_max: 8,
          success_avg: 0,
          failure_avg: 8,
        },
      ],
    });
    const out = await svc.ptmSignalWeights();
    const csv = rowsToCsv(
      [
        'signal_type',
        'weight',
        'training_count',
        'training_max',
        'success_avg',
        'failure_avg',
        'basis',
      ],
      out.data,
    );
    expect(csv).toMatch(
      /^signal_type,weight,training_count,training_max,success_avg,failure_avg,basis\r\n/,
    );
    expect(csv).toContain('checkin_miss,0.95,25,8,0,8,weighted_v2');
  });
});
