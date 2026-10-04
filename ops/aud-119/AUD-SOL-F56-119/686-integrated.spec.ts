// Audit-only: exact fees-top tree, simulated providers, no candidate edits.
import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import {
  ChargeSettlementService,
  INVOICE_BACKFILL_CURSOR,
} from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { ReversalUncertainError } from '../src/connect/fees/money-errors';
import { formatMoney } from '../src/connect/fees/payout-notice-copy';
import type { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import { asPrisma, FakeStripe, makeCharge, makeSettlementPrisma, type Row } from './utils/settlement-fakes';

function setup(currency = 'usd', billing: 'recurring' | 'one_time' = 'recurring') {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const policy = new FeePolicyService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc = new ChargeSettlementService(asPrisma(prisma), stripe, policy, ledger, transfers);
  const purchase = {
    id: 'cp_audit', coach_user_id: 'coach_audit', client_user_id: 'client_audit',
    package_id: 'pkg_audit', amount_cents: 10_000, currency,
    status: 'active', entitlement_active: true, source: null, billing_type: billing,
    stripe_subscription_id: billing === 'recurring' ? 'sub_audit' : null,
    stripe_payment_intent_id: 'pi_audit', created_at: new Date(Date.now() - 50 * 86_400_000),
  } as ClientPurchase;
  db.purchases.push(purchase as unknown as Row);
  db.accounts.push({ coach_user_id: 'coach_audit', stripe_account_id: 'acct_audit' });
  const notifications = { createNotification: jest.fn(async () => undefined) };
  const handler = new RefundDisputeHandlerService(
    asPrisma(prisma), stripe, ledger, transfers,
    {} as PayoutReadinessService, notifications as unknown as NotificationsService,
    undefined, undefined, svc,
  );
  const sell = (refunded = 0) => {
    stripe.charges.set('ch_audit', makeCharge({
      id: 'ch_audit', amount: 10_000, fee: 320, currency, amount_refunded: refunded,
    }));
    return svc.settleCharge({ purchase, charge_id: 'ch_audit' });
  };
  const adjust = (refunded: number) => svc.applyAdjustments({
    purchase, charge_id: 'ch_audit', refunded_cents: refunded,
  });
  const dispute = async (event: 'created' | 'closed', status: string) => {
    const balance_transactions = status === 'won'
      ? [{ id: 'txn_debit', amount: -10_000, fee: 1_500 },
         { id: 'txn_credit', amount: 10_000, fee: -1_500 }]
      : [{ id: 'txn_debit', amount: -10_000, fee: 1_500 }];
    stripe.retrieveDispute.mockResolvedValue({
      id: 'dp_audit', amount: 10_000, currency, status, balance_transactions,
    });
    return handler.handle({
      id: `evt_${event}`, type: `charge.dispute.${event}`,
      data: { object: { id: 'dp_audit', charge: 'ch_audit', amount: 10_000,
        currency, status, balance_transactions } },
    });
  };
  return { prisma, db, stripe, svc, transfers, purchase, sell, adjust, dispute };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('independent composed fees-top controls', () => {
  it('JPY is integer minor units: sale, full refund, repeat and future netting', async () => {
    const c = setup('jpy');
    await c.sell();
    expect(c.stripe.netTo('acct_audit')).toBe(9_480);
    expect(formatMoney(10_000, 'jpy')).toBe('10,000 JPY');
    await c.sell(10_000);
    await c.adjust(10_000);
    expect(c.stripe.netTo('acct_audit')).toBe(0);
    expect(c.db.recoveries[0]).toMatchObject({ amount_cents: 520, currency: 'jpy' });
    const sent = c.stripe.reverseTransfer.mock.calls.length;
    await c.adjust(10_000);
    expect(c.stripe.reverseTransfer.mock.calls.length).toBe(sent);
    c.stripe.charges.set('ch_next', makeCharge({
      id: 'ch_next', amount: 10_000, fee: 320, currency: 'jpy',
    }));
    await c.svc.settleCharge({ purchase: c.purchase, charge_id: 'ch_next' });
    expect(c.stripe.netTo('acct_audit')).toBe(8_960);
    expect(c.db.recoveries[0]).toMatchObject({ collected_cents: 520, status: 'collected' });
  });

  it('a real second-page matching reversal is recovered after request-key expiry without re-send', async () => {
    const c = setup();
    await c.sell();
    await c.sell(2_000);
    c.stripe.reversalResponsesLost = 1;
    c.stripe.failListReversals = true;
    await expect(c.adjust(2_000)).rejects.toBeInstanceOf(ReversalUncertainError);
    const matching = c.stripe.reversals[0];
    expect(matching.amount).toBe(2_000);
    // A later, unrelated operation on this same transfer precedes the sought receipt.
    c.stripe.failListReversals = false;
    await c.stripe.reverseTransfer({
      transfer_id: matching.transfer, amount: 1, idempotencyKey: 'external_other_operation',
    });
    const newest = c.stripe.reversals[1];
    c.stripe.expireIdempotencyKeys();
    c.stripe.reversalListPageSize = 1;
    c.stripe.listTransferReversals.mockClear();
    const sent = c.stripe.reverseTransfer.mock.calls.length;
    await c.adjust(2_000);
    expect(c.stripe.listTransferReversals).toHaveBeenCalledWith(
      matching.transfer, { limit: 100, starting_after: newest.id },
    );
    expect(c.db.reversalOps?.[0]).toMatchObject({
      status: 'succeeded', stripe_reversal_id: matching.id, amount_cents: 2_000,
    });
    expect(c.stripe.reverseTransfer.mock.calls.length).toBe(sent);
    expect(c.stripe.reversals).toHaveLength(2);
    expect(c.stripe.netTo('acct_audit')).toBe(7_479);
  });

  it('a pre-existing invoice cursor survives list rejection, then resumes and pays a missed charge once', async () => {
    const c = setup();
    await c.sell();
    const now = new Date();
    const created = Math.floor(now.getTime() / 1000);
    c.stripe.paidInvoices.push(
      { id: 'in_done', amount_paid: 10_000, charge: 'ch_audit', subscription: 'sub_audit', created: created - 10 },
      { id: 'in_renew', amount_paid: 10_000, charge: 'ch_renew', subscription: 'sub_audit', created: created - 20 },
    );
    c.db.leases?.push({
      name: INVOICE_BACKFILL_CURSOR, holder: 'cursor', cursor: 'in_done',
      acquired_at: now, updated_at: now, lease_until: now,
    });
    c.stripe.charges.set('ch_renew', makeCharge({ id: 'ch_renew', amount: 10_000, fee: 320 }));
    c.stripe.listPaidInvoices.mockRejectedValueOnce(new Error('closed_test_failure'));
    await c.svc.runSettlementSweep(now);
    expect(c.db.leases?.find(r => r.name === INVOICE_BACKFILL_CURSOR)?.cursor).toBe('in_done');
    expect(c.stripe.listPaidInvoices).toHaveBeenLastCalledWith(
      expect.objectContaining({ starting_after: 'in_done' }),
    );
    await c.svc.runSettlementSweep(now);
    expect(c.stripe.netTo('acct_audit')).toBe(18_960);
    await c.svc.runSettlementSweep(now);
    expect(c.stripe.netTo('acct_audit')).toBe(18_960);
    expect(c.db.transfers).toHaveLength(2);
  });

  it('incomplete later refund page leaves settlement awaiting and sends nothing, then converges', async () => {
    const c = setup();
    c.stripe.charges.set('ch_audit', makeCharge({
      id: 'ch_audit', amount: 10_000, fee: 320, amount_refunded: 2_000,
    }));
    c.stripe.refundsByCharge.set('ch_audit', [
      { id: 're_2', status: 'succeeded', amount: 1_000 },
      { id: 're_1', status: 'succeeded', amount: 1_000 },
    ]);
    c.stripe.refundListPageSize = 1;
    const realList = c.stripe.listChargeRefunds.getMockImplementation()!;
    c.stripe.listChargeRefunds.mockImplementation(async (charge, after) =>
      after ? { data: [], has_more: true } : realList(charge, after));
    expect((await c.svc.settleCharge({ purchase: c.purchase, charge_id: 'ch_audit' })).status).toBe('awaiting_fee');
    expect(c.stripe.createTransfer).not.toHaveBeenCalled();
    c.stripe.listChargeRefunds.mockImplementation(realList);
    await c.svc.settleCharge({ purchase: c.purchase, charge_id: 'ch_audit' });
    expect(c.stripe.netTo('acct_audit')).toBe(7_480);
  });

  it('one-time access policy is unchanged on dispute creation (control for the recurring-only ruling)', async () => {
    const c = setup('usd', 'one_time');
    await c.sell();
    await c.dispute('created', 'needs_response');
    expect(c.db.purchases[0].entitlement_active).toBe(true);
    expect(c.db.purchases[0].status).toBe('disputed');
  });
});

describe('DEPENDENCY R-DISPUTE-PAUSE: outside F5/F6, route to runtime owners before release', () => {
  it('a recurring plan with no failed renewal ends access immediately when any charge is disputed', async () => {
    const c = setup();
    await c.sell();
    await c.dispute('created', 'needs_response');
    expect(c.db.purchases[0].entitlement_active).toBe(false);
  });
  it('a won recurring dispute does not automatically restore the plan status or access', async () => {
    const c = setup();
    await c.sell();
    await c.dispute('created', 'needs_response');
    // Model access already ended by the required pause implementation.
    c.db.purchases[0].entitlement_active = false;
    await c.dispute('closed', 'won');
    expect(c.db.purchases[0].status).not.toBe('paid');
    expect(c.db.purchases[0].entitlement_active).toBe(false);
  });
});
