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
import { PartialRefundDecisionService } from '../partial-refund-decision.service';
import type { PrismaService } from '../../prisma.service';
import type { PurchaseFanoutService } from '../../packages/purchase-fanout.service';
import { asPrismaDouble } from './prisma-test-double';
import { FEATURE_NAMED_REGIMES_ENV } from '../named-regimes.feature';

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
      const prisma = asPrismaDouble({
        partialRefundDecision: {
          findUnique: jest.fn(async () => null),
          create,
        },
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
      const prisma = asPrismaDouble({
        partialRefundDecision: {
          findUnique: jest.fn(),
          create,
        },
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

    it('is idempotent on the unique stripe_refund_id', async () => {
      process.env[FEATURE_NAMED_REGIMES_ENV] = 'true';
      const create = jest.fn();
      const prisma = asPrismaDouble({
        partialRefundDecision: {
          findUnique: jest.fn(async () => ({ id: 'dec-existing' })),
          create,
        },
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
