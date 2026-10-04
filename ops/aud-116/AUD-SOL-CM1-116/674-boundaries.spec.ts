import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { AdminPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { ServiceTokenGuard } from '../src/auth/service-token.guard';
import { RefundTransferReversalScheduler } from '../src/checkout/refund-transfer-reversal.scheduler';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { HOUR, harness, refundRow, seedPurchase } from './support/refund-reversal-harness';

describe('Sol independent M1 boundary probes at 9a512028', () => {
  it('owner JWT reaches the newly added review endpoint, without a second mutually exclusive bearer', async () => {
    const old = process.env.ADMIN_SERVICE_TOKEN;
    process.env.ADMIN_SERVICE_TOKEN = 'audit-service-token';
    const jwt = Reflect.construct(JwtAuthGuard, [
      { user: { findUnique: jest.fn(async () => ({ id: 'owner-1', role: 'owner' })) } },
      { verify: jest.fn(async (token: string) => {
        if (token !== 'audit-owner-jwt') throw new Error('not a JWT');
        return { sub: 'owner-subject' };
      }) },
      new Reflector(),
      { emit: jest.fn() },
    ]);
    const module = await Test.createTestingModule({ controllers: [AdminPaymentOpsController] })
      .overrideGuard(JwtAuthGuard).useValue(jwt)
      .overrideGuard(ServiceTokenGuard).useValue(new ServiceTokenGuard())
      .overrideGuard(RolesGuard).useValue(new RolesGuard(new Reflector()))
      .useMocker(() => ({}))
      .compile();
    const ctrl = module.get(AdminPaymentOpsController);
    Reflect.set(ctrl, 'refundDispute', { listTransferReversalsInReview: async () => [] });
    const app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    try {
      const url = `${await app.getUrl()}/v1/admin/payments/refund-reversals/review`;
      const serviceResponse = await fetch(url, { headers: {
        Authorization: 'Bearer audit-service-token',
      } });
      expect(serviceResponse.status).toBe(401);
      const ownerResponse = await fetch(url, { headers: {
        Authorization: 'Bearer audit-owner-jwt',
      } });
      expect(ownerResponse.status).toBe(200);
    } finally {
      await app.close();
      if (old === undefined) delete process.env.ADMIN_SERVICE_TOKEN;
      else process.env.ADMIN_SERVICE_TOKEN = old;
    }
  });

  it('scheduler failure logger does not emit arbitrary exception text', async () => {
    const scheduler = Reflect.construct(RefundTransferReversalScheduler, [{
      retryPendingTransferReversals: async () => {
        throw new Error('AUDIT_PRIVATE_CANARY_contact_at_example_invalid');
      },
    }]);
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await scheduler.handleCron();
      expect(log).toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain('AUDIT_PRIVATE_CANARY');
    } finally {
      log.mockRestore();
    }
  });

  it('webhook-before-record cannot consume the next distinct refund share', async () => {
    const h = harness();
    const at = new Date(Date.now() - HOUR);
    seedPurchase(h.db, 'p-race', at);
    for (const id of ['r-one', 'r-two']) {
      h.db.state.chargeRefund.push(refundRow(id, 'p-race', at, {
        transfer_reversal_first_attempt_at: null,
      }));
    }
    const provider = h.reverseTransfer.getMockImplementation()!;
    h.reverseTransfer.mockImplementation(async (args) => {
      const receipt = await provider(args);
      await h.svc.handle({
        id: `evt_${receipt.id}`,
        type: 'transfer.reversed',
        data: { object: {
          id: args.transfer_id,
          amount_reversed: h.stripeTotal(args.transfer_id),
          reversed: false,
        } },
      });
      return receipt;
    });
    await h.svc.retryPendingTransferReversals();
    expect(h.refund('r-one').transfer_reversed).toBe(true);
    expect(h.refund('r-two').transfer_reversed).toBe(true);
    expect(h.stripeTotal('tr_p-race')).toBe(244);
    expect(h.headCoach('p-race')).toBe(244);
  });

  it('two distinct refund transactions add both local transfer and ledger reversals', async () => {
    let transfer = {
      id: 'transfer-1', stripe_transfer_id: 'tr_1', purchase_id: 'purchase-1',
      amount_cents: 1000, reversed_amount_cents: 0, ledger_entry_id: 'ledger-1',
      status: 'succeeded', reversed_at: null,
    };
    let entry = {
      id: 'ledger-1', amount_cents: 1000, reversed_cents: 0,
      status: 'posted', reversed_at: null, stripe_transfer_id: 'tr_1',
    };
    let localReads = 0;
    let ledgerReads = 0;
    let release!: () => void;
    let releaseLedger!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    const bothLedgerRead = new Promise<void>((resolve) => { releaseLedger = resolve; });
    const tx = {
      connectTransfer: {
        findUniqueOrThrow: async () => {
          const snapshot = { ...transfer };
          if (++localReads === 2) release();
          await bothRead;
          return snapshot;
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          transfer = { ...transfer, ...data };
          return { ...transfer };
        },
      },
      splitLedgerEntry: {
        findUniqueOrThrow: async () => {
          const snapshot = { ...entry };
          if (++ledgerReads === 2) releaseLedger();
          await bothLedgerRead;
          return snapshot;
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          entry = { ...entry, ...data };
          return { ...entry };
        },
      },
    };
    const db = {
      ...tx,
      connectTransfer: {
        ...tx.connectTransfer,
        findUniqueOrThrow: async () => ({ ...transfer }),
      },
      // Independent refund-row locks do not serialize two transactions
      // touching one transfer. SELECT returns a snapshot, UPDATE is literal.
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const stripe = { reverseTransfer: jest.fn(async () => ({ id: 'receipt' })) };
    const ledger = Reflect.construct(SplitLedgerService, [db]);
    const svc = Reflect.construct(TransferOrchestratorService, [db, stripe, ledger]);
    await Promise.all([
      svc.reverse({ transfer_row_id: 'transfer-1', amount_cents: 100,
        idempotency_key: 'refund-one', claim: async () => true }),
      svc.reverse({ transfer_row_id: 'transfer-1', amount_cents: 50,
        idempotency_key: 'refund-two', claim: async () => true }),
    ]);
    expect(stripe.reverseTransfer).toHaveBeenCalledTimes(2);
    expect({ transfer: transfer.reversed_amount_cents, ledger: entry.reversed_cents })
      .toEqual({ transfer: 150, ledger: 150 });
  });
});
