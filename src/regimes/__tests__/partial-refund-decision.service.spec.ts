/**
 * PartialRefundDecisionService unit tests (F2).
 *
 * Pins the partial-refund coach-decision contract with Prisma + fanout mocked:
 *  - onPartialRefund creates a 'pending' row when the flag is ON;
 *  - onPartialRefund is a NO-OP when FEATURE_NAMED_REGIMES is OFF (flag-off
 *    doctrine: no decision rows written while the feature is hidden);
 *  - onPartialRefund is idempotent on the unique stripe_refund_id;
 *  - decide('keep_drops') marks decided and does NOT cancel drops;
 *  - decide('unassign_drops') marks decided AND cancels pending drops via
 *    cancelPendingForPurchase;
 *  - decide on a foreign / missing / already-decided row 404s identically.
 */

import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PartialRefundDecisionService } from '../partial-refund-decision.service';
import type { PrismaService } from '../../prisma.service';
import type { PurchaseFanoutService } from '../../packages/purchase-fanout.service';
import { asPrismaDouble } from './prisma-test-double';
import { FEATURE_NAMED_REGIMES_ENV } from '../named-regimes.feature';

/**
 * Build a P2002 unique-constraint error exactly as Prisma raises it, so the
 * service's `instanceof PrismaClientKnownRequestError && code === 'P2002'`
 * branch is exercised against the real error class (not a structural fake).
 */
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['stripe_refund_id'] },
  });
}

/**
 * Prisma double whose `$transaction(cb)` runs the callback against a tx client
 * exposing the supplied partialRefundDecision delegate mocks. Mirrors how
 * onPartialRefund opens its own $transaction when no ambient tx is passed.
 */
function txPrismaDouble(delegate: {
  findUnique: jest.Mock;
  create: jest.Mock;
}): PrismaService {
  const txClient = { partialRefundDecision: delegate };
  return asPrismaDouble({
    $transaction: jest.fn(async (cb: (tx: typeof txClient) => unknown) =>
      cb(txClient),
    ),
  });
}

function fanoutDouble(canceled = 0): {
  fanout: PurchaseFanoutService;
  cancel: jest.Mock;
} {
  const cancel = jest.fn(async () => canceled);
  const fanout: Pick<PurchaseFanoutService, 'cancelPendingForPurchase'> = {
    cancelPendingForPurchase: cancel,
  };
  return { fanout: fanout as PurchaseFanoutService, cancel };
}

describe('PartialRefundDecisionService', () => {
  const ORIGINAL = process.env[FEATURE_NAMED_REGIMES_ENV];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[FEATURE_NAMED_REGIMES_ENV];
    else process.env[FEATURE_NAMED_REGIMES_ENV] = ORIGINAL;
    jest.clearAllMocks();
  });

  describe('onPartialRefund', () => {
    it('creates a pending decision when the flag is ON', async () => {
      process.env[FEATURE_NAMED_REGIMES_ENV] = 'true';
      const create = jest.fn(async () => ({ id: 'dec-1' }));
      const prisma = txPrismaDouble({
        findUnique: jest.fn(async () => null),
        create,
      });
      const { fanout } = fanoutDouble();
      const service = new PartialRefundDecisionService(prisma, fanout);

      const created = await service.onPartialRefund({
        client_purchase_id: 'cp-1',
        stripe_refund_id: 're_123',
      });

      expect(created).toBe(true);
      expect(create).toHaveBeenCalledWith({
        data: {
          client_purchase_id: 'cp-1',
          stripe_refund_id: 're_123',
          decision: 'pending',
        },
      });
    });

    it('is a NO-OP when the feature flag is OFF (flag-off doctrine)', async () => {
      delete process.env[FEATURE_NAMED_REGIMES_ENV];
      const create = jest.fn();
      const $transaction = jest.fn();
      const prisma = asPrismaDouble({ $transaction });
      const { fanout } = fanoutDouble();
      const service = new PartialRefundDecisionService(prisma, fanout);

      const created = await service.onPartialRefund({
        client_purchase_id: 'cp-1',
        stripe_refund_id: 're_123',
      });

      expect(created).toBe(false);
      expect(create).not.toHaveBeenCalled();
      // flag-off short-circuits BEFORE any transaction is opened.
      expect($transaction).not.toHaveBeenCalled();
    });

    it('is idempotent on the unique stripe_refund_id (pre-check fast path)', async () => {
      process.env[FEATURE_NAMED_REGIMES_ENV] = 'true';
      const create = jest.fn();
      const prisma = txPrismaDouble({
        findUnique: jest.fn(async () => ({ id: 'dec-existing' })),
        create,
      });
      const { fanout } = fanoutDouble();
      const service = new PartialRefundDecisionService(prisma, fanout);

      const created = await service.onPartialRefund({
        client_purchase_id: 'cp-1',
        stripe_refund_id: 're_123',
      });

      expect(created).toBe(false);
      expect(create).not.toHaveBeenCalled();
    });

    it('runs the check-and-create inside a single $transaction', async () => {
      process.env[FEATURE_NAMED_REGIMES_ENV] = 'true';
      const prisma = txPrismaDouble({
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: 'dec-1' })),
      });
      const { fanout } = fanoutDouble();
      const service = new PartialRefundDecisionService(prisma, fanout);

      await service.onPartialRefund({
        client_purchase_id: 'cp-1',
        stripe_refund_id: 're_123',
      });

      // The atomic boundary is the whole point of the F2 fix: a bare
      // findUnique+create outside a tx is the TOCTOU the audit flagged.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('two concurrent calls create exactly one row; the racing call swallows P2002 (R81 F2)', async () => {
      process.env[FEATURE_NAMED_REGIMES_ENV] = 'true';

      // Simulate the TOCTOU window: BOTH deliveries observe findUnique=null
      // (the first create has not committed yet). The first create wins; the
      // second hits the unique constraint and Prisma raises P2002.
      const rows = new Set<string>();
      const findUnique = jest.fn(async () => null);
      let createCalls = 0;
      const create = jest.fn(
        async (arg: { data: { stripe_refund_id: string } }) => {
          createCalls += 1;
          const key = arg.data.stripe_refund_id;
          if (rows.has(key)) throw p2002();
          rows.add(key);
          return { id: `dec-${createCalls}` };
        },
      );
      const prisma = txPrismaDouble({ findUnique, create });
      const { fanout } = fanoutDouble();
      const service = new PartialRefundDecisionService(prisma, fanout);

      const args = { client_purchase_id: 'cp-1', stripe_refund_id: 're_race' };
      const [a, b] = await Promise.all([
        service.onPartialRefund(args),
        service.onPartialRefund(args),
      ]);

      // Exactly one row was created; exactly one call reports it created the row.
      expect(rows.size).toBe(1);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      // Neither call threw - the loser collapsed the P2002 into a no-op (false).
      expect([a, b].sort()).toEqual([false, true]);
      expect(create).toHaveBeenCalledTimes(2);
    });
  });

  describe('decide', () => {
    function decideHarness(opts: {
      decision: string;
      coach_user_id: string;
    }) {
      const updateMany = jest.fn(async () => ({ count: 1 }));
      const txClient = {
        partialRefundDecision: { updateMany },
      };
      const prisma = asPrismaDouble({
        partialRefundDecision: {
          findUnique: jest.fn(async () => ({
            id: 'dec-1',
            decision: opts.decision,
            client_purchase_id: 'cp-1',
            client_purchase: { coach_user_id: opts.coach_user_id },
          })),
        },
        $transaction: jest.fn(async (cb: (tx: typeof txClient) => unknown) =>
          cb(txClient),
        ),
      });
      return { prisma, updateMany };
    }

    it('keep_drops marks decided and does NOT cancel drops', async () => {
      const { prisma, updateMany } = decideHarness({
        decision: 'pending',
        coach_user_id: 'coach-1',
      });
      const { fanout, cancel } = fanoutDouble();
      const service = new PartialRefundDecisionService(prisma, fanout);

      const result = await service.decide('coach-1', 're_123', 'keep_drops');

      expect(result.decision).toBe('keep_drops');
      expect(result.drops_canceled).toBe(0);
      expect(updateMany).toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    });

    it('unassign_drops marks decided AND cancels pending drops', async () => {
      const { prisma, updateMany } = decideHarness({
        decision: 'pending',
        coach_user_id: 'coach-1',
      });
      const { fanout, cancel } = fanoutDouble(4);
      const service = new PartialRefundDecisionService(prisma, fanout);

      const result = await service.decide('coach-1', 're_123', 'unassign_drops');

      expect(result.decision).toBe('unassign_drops');
      expect(result.drops_canceled).toBe(4);
      expect(updateMany).toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledWith(
        'cp-1',
        'partial_refund_decision',
        expect.anything(),
      );
    });

    it('404s on a decision owned by another coach', async () => {
      const { prisma } = decideHarness({
        decision: 'pending',
        coach_user_id: 'coach-OTHER',
      });
      const { fanout } = fanoutDouble();
      const service = new PartialRefundDecisionService(prisma, fanout);

      await expect(
        service.decide('coach-1', 're_123', 'keep_drops'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s on an already-decided decision', async () => {
      const { prisma } = decideHarness({
        decision: 'keep_drops',
        coach_user_id: 'coach-1',
      });
      const { fanout } = fanoutDouble();
      const service = new PartialRefundDecisionService(prisma, fanout);

      await expect(
        service.decide('coach-1', 're_123', 'unassign_drops'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
