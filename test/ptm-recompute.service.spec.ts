import { PtmRecomputeService } from '../src/ptm/ptm-recompute.service';
import type { PtmHeuristicService } from '../src/ptm/ptm-heuristic.service';
import type { PtmWeightedService } from '../src/ptm/ptm-weighted.service';
import type { PtmScoreResult } from '../src/ptm/ptm.types';

// Recompute orchestrator tests. Pin:
//
//   - recomputeOne calls the heuristic when weighted is inactive and
//     APPENDs a PtmPrediction with basis=heuristic_v1.
//   - recomputeOne calls the weighted engine when active and tags
//     basis=weighted_v2.
//   - recomputeBatch processes the eligible set respecting limit and
//     returns a {considered, recomputed, errors} report.
//   - One user's failure is caught and counted; the batch keeps going.

const NOW = new Date('2026-05-06T04:00:00.000Z');

function buildPrisma(opts: {
  eligibleUserIds: string[];
}) {
  const created: any[] = [];
  const ptmPrediction = {
    // 6B alert-hook reads the prior prediction on every recomputeOne. We
    // return null (first-time scoring) so the bucket-transition guard
    // short-circuits before any alert side effect runs.
    findFirst: jest.fn(async () => null),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: `pred-${created.length + 1}`, ...data, computed_at: NOW };
      created.push(row);
      return row;
    }),
  };
  const clientSignal = {
    findMany: jest.fn(async ({ take }: any) => {
      const rows = opts.eligibleUserIds.map((user_id) => ({ user_id }));
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    }),
  };
  // 6B alert-hook reads the user when it would create an alert. We don't
  // exercise that branch in these specs (no coachAlerts injected) but
  // expose findUnique so the mock matches the live shape.
  const user = {
    findUnique: jest.fn(async () => null),
  };
  return { ptmPrediction, clientSignal, user, created };
}

function buildHeuristic(result: PtmScoreResult) {
  const score = jest.fn(async (_userId: string) => result);
  return { score } as unknown as PtmHeuristicService & { score: jest.Mock };
}

function buildWeighted(opts: {
  active: boolean;
  result?: PtmScoreResult;
}) {
  const isActive = jest.fn(async () => opts.active);
  const score = jest.fn(async (_userId: string) => {
    if (!opts.result) throw new Error('weighted score not configured');
    return opts.result;
  });
  return { isActive, score } as unknown as PtmWeightedService & {
    isActive: jest.Mock;
    score: jest.Mock;
  };
}

describe('PtmRecomputeService', () => {
  describe('recomputeOne', () => {
    it('writes a PtmPrediction with basis=heuristic_v1 when weighted is inactive', async () => {
      const prisma: any = buildPrisma({ eligibleUserIds: [] });
      const heuristic = buildHeuristic({
        riskScore: 0.4,
        successScore: 0.6,
        basis: 'heuristic_v1',
        factors: [
          { key: 'checkin_miss_3plus', label: 'x', contribution: 0.2, observed: 3 },
        ],
      });
      const weighted = buildWeighted({ active: false });
      const svc = new PtmRecomputeService(prisma, heuristic, weighted);

      const row = await svc.recomputeOne('u-1');

      expect(weighted.isActive).toHaveBeenCalledTimes(1);
      expect(weighted.score).not.toHaveBeenCalled();
      expect(heuristic.score).toHaveBeenCalledWith('u-1');
      expect(prisma.ptmPrediction.create).toHaveBeenCalledTimes(1);
      const createArg = prisma.ptmPrediction.create.mock.calls[0][0];
      expect(createArg.data.user_id).toBe('u-1');
      expect(createArg.data.prediction_basis).toBe('heuristic_v1');
      expect(createArg.data.risk_score).toBe(0.4);
      expect(createArg.data.success_score).toBe(0.6);
      expect(row.prediction_basis).toBe('heuristic_v1');
    });

    it('writes a PtmPrediction with basis=weighted_v2 when weighted is active', async () => {
      const prisma: any = buildPrisma({ eligibleUserIds: [] });
      const heuristic = buildHeuristic({
        riskScore: 0,
        successScore: 1,
        basis: 'heuristic_v1',
        factors: [],
      });
      const weighted = buildWeighted({
        active: true,
        result: {
          riskScore: 0.7,
          successScore: 0.3,
          basis: 'weighted_v2',
          factors: [],
        },
      });
      const svc = new PtmRecomputeService(prisma, heuristic, weighted);

      const row = await svc.recomputeOne('u-2');

      expect(heuristic.score).not.toHaveBeenCalled();
      expect(weighted.score).toHaveBeenCalledWith('u-2');
      const createArg = prisma.ptmPrediction.create.mock.calls[0][0];
      expect(createArg.data.prediction_basis).toBe('weighted_v2');
      expect(createArg.data.risk_score).toBe(0.7);
      expect(row.prediction_basis).toBe('weighted_v2');
    });
  });

  describe('recomputeBatch', () => {
    it('processes the eligible set respecting limit and returns the report shape', async () => {
      const prisma: any = buildPrisma({
        eligibleUserIds: ['u-a', 'u-b', 'u-c'],
      });
      const heuristic = buildHeuristic({
        riskScore: 0.1,
        successScore: 0.9,
        basis: 'heuristic_v1',
        factors: [],
      });
      const weighted = buildWeighted({ active: false });
      const svc = new PtmRecomputeService(prisma, heuristic, weighted);

      const report = await svc.recomputeBatch({ now: NOW, limit: 10 });

      expect(report.considered).toBe(3);
      expect(report.recomputed).toBe(3);
      expect(report.errors).toBe(0);
      expect(prisma.ptmPrediction.create).toHaveBeenCalledTimes(3);
      // limit is forwarded to the eligible-set query.
      expect(prisma.clientSignal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });

    it('clamps limit to [1, 50000]', async () => {
      const prisma: any = buildPrisma({ eligibleUserIds: [] });
      const heuristic = buildHeuristic({
        riskScore: 0,
        successScore: 1,
        basis: 'heuristic_v1',
        factors: [],
      });
      const weighted = buildWeighted({ active: false });
      const svc = new PtmRecomputeService(prisma, heuristic, weighted);

      await svc.recomputeBatch({ now: NOW, limit: -5 });
      expect(prisma.clientSignal.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 1 }),
      );

      await svc.recomputeBatch({ now: NOW, limit: 999999 });
      expect(prisma.clientSignal.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 50000 }),
      );
    });

    it("a single user's failure is caught and does not abort the batch", async () => {
      const prisma: any = buildPrisma({
        eligibleUserIds: ['u-a', 'u-bad', 'u-c'],
      });
      const heuristicScore = jest.fn(async (userId: string) => {
        if (userId === 'u-bad') throw new Error('synthetic per-user failure');
        return {
          riskScore: 0.2,
          successScore: 0.8,
          basis: 'heuristic_v1' as const,
          factors: [],
        };
      });
      const heuristic = { score: heuristicScore } as unknown as PtmHeuristicService;
      const weighted = buildWeighted({ active: false });
      const svc = new PtmRecomputeService(prisma, heuristic, weighted);

      const report = await svc.recomputeBatch({ now: NOW, limit: 10 });

      expect(report.considered).toBe(3);
      expect(report.recomputed).toBe(2);
      expect(report.errors).toBe(1);
      // u-a and u-c each got a row; u-bad did not.
      const createdUserIds = prisma.ptmPrediction.create.mock.calls.map(
        (c: any[]) => c[0].data.user_id,
      );
      expect(createdUserIds).toEqual(expect.arrayContaining(['u-a', 'u-c']));
      expect(createdUserIds).not.toContain('u-bad');
    });
  });
});
