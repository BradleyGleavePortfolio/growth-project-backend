import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { Events } from '../../../src/analytics/events';
import { PrismaService } from '../../../src/prisma.service';
import { ScoutLifecycleService } from '../../../src/scout/lifecycle/lifecycle.service';
import type { RunPassResult } from '../../../src/scout/reconstruct/orchestration/run-context';
import { ScoutReconstructService } from '../../../src/scout/scout-reconstruct.service';

/**
 * The S8-G body of ScoutLifecycleService.onTransferSettled against the S7-L doubles pattern
 * (test/scout/lifecycle/lifecycle.service.spec.ts) plus a `reconstructRun` double. Proves order
 * (the pass BEFORE the FOR NO KEY UPDATE tail), the gate closure handed to the pass is this run's
 * assertRunOpen, a CAS miss on a raised epoch writes nothing (G14), classifyClosed after a closed
 * gate (G03/G05), verdicts from durable facts not from the pass result (G01/G06), and that the hook
 * never writes a terminal field except through S7-L's single writeTerminal statement.
 */

const COACH = 'coach-1';
const INTENT = '3f2b9c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

interface Doubles {
  order: string[];
  queryRaw: jest.Mock;
  executeRaw: jest.Mock;
  completionFindUnique: jest.Mock;
  stagedGroupBy: jest.Mock;
  ledgerGroupBy: jest.Mock;
  runFindUnique: jest.Mock;
  capture: jest.Mock;
  reconstructRun: jest.Mock;
}

const passResult = (over: Partial<RunPassResult> = {}): RunPassResult => ({
  families: [],
  unmapped_families: [],
  stopped: null,
  ...over,
});

interface LockedRow {
  execution_epoch: number;
  terminal_status: string | null;
  fenced_at: Date | null;
  fence_reason: string | null;
  deadline_at: Date | null;
}

function make(lockedRow: LockedRow | null) {
  const d: Doubles = {
    order: [],
    queryRaw: jest.fn(),
    executeRaw: jest.fn(),
    completionFindUnique: jest.fn().mockResolvedValue({ terminal_status: 'success' }),
    stagedGroupBy: jest.fn().mockResolvedValue([{ entity_type: 'clients', _count: { _all: 2 } }]),
    ledgerGroupBy: jest
      .fn()
      .mockResolvedValue([
        { entity_type: 'clients', status: 'reconstructed', _count: { _all: 2 } },
      ]),
    runFindUnique: jest.fn().mockResolvedValue(null),
    capture: jest.fn(),
    reconstructRun: jest.fn(async () => {
      d.order.push('pass');
      return passResult();
    }),
  };
  d.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('FOR NO KEY UPDATE')) {
      d.order.push('lock');
      return lockedRow ? [lockedRow] : [];
    }
    if (text.includes('last_observed_at')) {
      d.order.push('gate');
      return [{ execution_epoch: 1 }];
    }
    return [];
  });
  d.executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    d.order.push(
      text.includes('terminal_status = ')
        ? 'terminal'
        : text.includes('fenced_at = ')
          ? 'fence'
          : 'exec',
    );
    return 1;
  });
  const tx = {
    $queryRaw: d.queryRaw,
    $executeRaw: d.executeRaw,
    scoutImportCompletion: { findUnique: d.completionFindUnique },
    scoutIngestEntity: { groupBy: d.stagedGroupBy },
    scoutReconstructionLedger: { groupBy: d.ledgerGroupBy },
  };
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    scoutImport: { findUnique: d.runFindUnique },
    scoutImportCompletion: { findUnique: d.completionFindUnique },
    scoutReconstructionLedger: { groupBy: d.ledgerGroupBy },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  });
  const analytics = Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
    capture: d.capture,
  });
  const reconstruct = Object.assign(
    Object.create(ScoutReconstructService.prototype) as ScoutReconstructService,
    { reconstructRun: d.reconstructRun },
  );
  const service = new ScoutLifecycleService(prisma, analytics, reconstruct);
  return { d, service };
}

const open: LockedRow = {
  execution_epoch: 1,
  terminal_status: null,
  fenced_at: null,
  fence_reason: null,
  deadline_at: new Date(Date.now() + 60_000),
};
const terminalCall = (d: Doubles) =>
  d.executeRaw.mock.calls.find((c: any[]) => c[0].join('?').includes('terminal_status = '));

describe('onTransferSettled — S8-G body', () => {
  it('G01: runs the pass once with this run and epoch, then locks, arbitrates and settles', async () => {
    const { d, service } = make(open);
    await service.onTransferSettled(COACH, INTENT, 1);
    expect(d.reconstructRun).toHaveBeenCalledTimes(1);
    const [coach, intent, ctx] = d.reconstructRun.mock.calls[0];
    expect(coach).toBe(COACH);
    expect(intent).toBe(INTENT);
    expect(ctx).toMatchObject({ mode: 'server', epoch: 1 });
    expect(typeof ctx.gate).toBe('function');
    expect(d.order).toEqual(['pass', 'lock', 'terminal']);
    // Until S9 supplies a reconciliation verdict the arbiter's step 4 is the truthful terminal.
    expect(terminalCall(d)?.slice(1)).toEqual(
      expect.arrayContaining([
        'partial',
        'partial',
        'reconciliation_not_performed',
        COACH,
        INTENT,
        1,
      ]),
    );
    expect(d.capture).toHaveBeenCalledWith(
      COACH,
      Events.SCOUT_RUN_SETTLED,
      expect.objectContaining({
        intent_id: INTENT,
        terminal_status: 'partial',
        reason_code: 'reconciliation_not_performed',
      }),
    );
    // `complete` never appears in any write argument (S7-L invariant kept).
    for (const call of d.executeRaw.mock.calls) expect(call.slice(1)).not.toContain('complete');
  });

  it('the gate closure handed to the pass is assertRunOpen bound to this run', async () => {
    const { d, service } = make(open);
    await service.onTransferSettled(COACH, INTENT, 1);
    const ctx = d.reconstructRun.mock.calls[0][2];
    const tx = { $queryRaw: d.queryRaw };
    await expect(ctx.gate(tx)).resolves.toBe(1);
    expect(d.order).toContain('gate');
    // Bound to (coach, intent): the UPDATE carries both as parameters.
    const gateCall = d.queryRaw.mock.calls.find((c: any[]) =>
      c[0].join('?').includes('last_observed_at'),
    );
    expect(gateCall?.slice(1)).toEqual(expect.arrayContaining([COACH, INTENT]));
  });

  it('the pass result is informational: the verdict comes from the durable facts under the lock', async () => {
    const { d, service } = make(open);
    d.reconstructRun.mockImplementationOnce(async () => {
      d.order.push('pass');
      return passResult({
        families: [
          {
            token: 'clients',
            source_platform: 'truecoach',
            family: 'clients',
            staged: 2,
            reconstructed: 2,
            skipped: 0,
            failed: 0,
            stopped: null,
          },
        ],
      });
    });
    await service.onTransferSettled(COACH, INTENT, 1);
    expect(d.stagedGroupBy).toHaveBeenCalledTimes(1);
    expect(d.ledgerGroupBy).toHaveBeenCalledTimes(1);
    expect(terminalCall(d)?.slice(1)).toEqual(
      expect.arrayContaining(['partial', 'reconciliation_not_performed']),
    );
  });

  it('G14: a raised epoch at the lock is a CAS miss — no facts read, no terminal write, no event', async () => {
    const { d, service } = make({
      ...open,
      execution_epoch: 2,
      fenced_at: new Date(),
      fence_reason: 'cancelled',
      terminal_status: 'cancelled',
    });
    await service.onTransferSettled(COACH, INTENT, 1);
    expect(d.order).toEqual(['pass', 'lock']);
    expect(d.stagedGroupBy).not.toHaveBeenCalled();
    expect(d.executeRaw).not.toHaveBeenCalled();
    expect(d.capture).not.toHaveBeenCalled();
  });

  it('a run already terminal at the lock (same epoch) is also a miss', async () => {
    const { d, service } = make({ ...open, terminal_status: 'partial' });
    await service.onTransferSettled(COACH, INTENT, 1);
    expect(d.order).toEqual(['pass', 'lock']);
    expect(d.executeRaw).not.toHaveBeenCalled();
  });

  it('G03/G05: a pass stopped by a closed gate → classifyClosed once, then the tail', async () => {
    const { d, service } = make(open);
    d.reconstructRun.mockImplementationOnce(async () => {
      d.order.push('pass');
      return passResult({ stopped: 'gate_closed' });
    });
    // classifyClosed re-reads unlocked: an open row PAST its deadline → fence timed_out in its own
    // transaction (lock, fence UPDATE, terminal write), then the hook's tail runs its own lock.
    d.runFindUnique.mockResolvedValueOnce({
      mode: 'server',
      import_intent_id: INTENT,
      phase: 'reconciling',
      accepted_start_at: new Date(0),
      deadline_at: new Date(Date.now() - 1000),
      last_observed_at: null,
      execution_epoch: 1,
      fenced_at: null,
      fence_reason: null,
      reason_code: null,
      terminal_status: null,
      completed_at: null,
      started_at: new Date(0),
    });
    const spy = jest.spyOn(service, 'classifyClosed');
    await service.onTransferSettled(COACH, INTENT, 1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(COACH, INTENT);
    expect(d.order.slice(0, 4)).toEqual(['pass', 'lock', 'fence', 'terminal']);
    // The fence's terminal is timed_out under epoch 2; on real PG the tail's CAS on epoch 1 then
    // misses (the double keeps returning epoch 1 at the lock, which is why only the prefix is pinned).
    expect(terminalCall(d)?.slice(1)).toEqual(
      expect.arrayContaining(['timed_out', 'timed_out', 2]),
    );
    expect(d.capture).toHaveBeenCalledWith(
      COACH,
      Events.SCOUT_RUN_FENCED,
      expect.objectContaining({ fence_reason: 'timed_out' }),
    );
  });

  it('a closed gate on a run that is not past its deadline (fenced elsewhere) writes nothing itself', async () => {
    const { d, service } = make({
      ...open,
      execution_epoch: 2,
      fenced_at: new Date(),
      fence_reason: 'cancelled',
      terminal_status: 'cancelled',
    });
    d.reconstructRun.mockImplementationOnce(async () => {
      d.order.push('pass');
      return passResult({ stopped: 'gate_closed' });
    });
    d.runFindUnique.mockResolvedValueOnce({
      mode: 'server',
      import_intent_id: INTENT,
      phase: 'reconciling',
      accepted_start_at: new Date(0),
      deadline_at: new Date(Date.now() + 60_000),
      last_observed_at: null,
      execution_epoch: 2,
      fenced_at: new Date(),
      fence_reason: 'cancelled',
      reason_code: 'cancelled_by_coach',
      terminal_status: 'cancelled',
      completed_at: new Date(),
      started_at: new Date(0),
    });
    await service.onTransferSettled(COACH, INTENT, 1);
    expect(d.order).toEqual(['pass', 'lock']);
    expect(d.executeRaw).not.toHaveBeenCalled();
    expect(d.capture).not.toHaveBeenCalled();
  });

  it('G06: claim failed with zero staged → failed/transfer_failed; with staged rows → partial', async () => {
    const a = make(open);
    a.d.completionFindUnique.mockResolvedValue({ terminal_status: 'failed' });
    a.d.stagedGroupBy.mockResolvedValue([]);
    a.d.ledgerGroupBy.mockResolvedValue([]);
    await a.service.onTransferSettled(COACH, INTENT, 1);
    expect(terminalCall(a.d)?.slice(1)).toEqual(
      expect.arrayContaining(['failed', 'transfer_failed']),
    );

    const b = make(open);
    b.d.completionFindUnique.mockResolvedValue({ terminal_status: 'failed' });
    await b.service.onTransferSettled(COACH, INTENT, 1);
    expect(terminalCall(b.d)?.slice(1)).toEqual(
      expect.arrayContaining(['partial', 'reconciliation_not_performed']),
    );
  });

  it('an unexpected pass failure propagates; nothing is locked or written (run left open)', async () => {
    const { d, service } = make(open);
    d.reconstructRun.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.onTransferSettled(COACH, INTENT, 1)).rejects.toThrow('connection lost');
    expect(d.executeRaw).not.toHaveBeenCalled();
    expect(d.order).toEqual([]);
    expect(d.capture).not.toHaveBeenCalled();
  });

  it('without an injected engine the hook constructs the real one (never skips the pass)', () => {
    const prisma = Object.create(PrismaService.prototype) as PrismaService;
    const analytics = Object.create(AnalyticsService.prototype) as AnalyticsService;
    const service = new ScoutLifecycleService(prisma, analytics);
    expect(service).toHaveProperty('reconstruct', expect.any(ScoutReconstructService));
  });
});
