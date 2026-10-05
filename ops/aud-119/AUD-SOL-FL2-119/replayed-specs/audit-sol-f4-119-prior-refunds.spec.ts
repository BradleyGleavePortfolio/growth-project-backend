import type { ClientPurchase } from '@prisma/client';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import { FakeStripe, asPrisma, makeCharge, makeSettlementPrisma, type Row } from './utils/settlement-fakes';

it('all canonical refund identities and amounts are retained when the embedded page omits an older refund', async () => {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(asPrisma(prisma), stripe, new FeePolicyService(asPrisma(prisma)), ledger, transfers);
  const notificationStub: object = { createNotification: jest.fn(async () => ({ id: 'n_1' })) };
  const purchase = {
    id: 'cp_1', coach_user_id: 'coach_1', client_user_id: 'client_1', package_id: 'pkg_1',
    amount_cents: 4_900, currency: 'usd', status: 'paid', source: null, billing_type: 'one_time',
    stripe_payment_intent_id: null, stripe_subscription_id: null, entitlement_active: true,
    created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_1' });
  stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
  await settlements.settleCharge({ purchase, charge_id: 'ch_1' });
  const recent = Array.from({ length: 10 }, (_, i) => ({ id: `re_recent_${i}`, amount: 400, status: 'succeeded', charge: 'ch_1', currency: 'usd' }));
  const older = { id: 're_older', amount: 900, status: 'succeeded', charge: 'ch_1', currency: 'usd' };
  Object.assign(stripe, { listChargeRefunds: jest.fn(async () => ({ data: [...recent, older], has_more: false })) });
  stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }));
  const refunds = new RefundDisputeHandlerService(asPrisma(prisma), stripe, ledger, transfers,
    new PayoutReadinessService(asPrisma(prisma), stripe), notificationStub as NotificationsService,
    undefined, undefined, settlements);
  const event = { id: 'evt_truncated', type: 'charge.refunded', data: { object: {
    id: 'ch_1', amount: 4_900, amount_refunded: 4_900, refunded: true, refunds: { data: recent, has_more: true },
  } } };
  await refunds.handle(event);
  await refunds.handle(event);
  expect(db.settlements[0].refunded_cents).toBe(4_900);
  expect(stripe.netTo('acct_1')).toBe(0);
  console.log('OBSERVATION_CANONICAL_REFUNDS', JSON.stringify({ refund_rows: db.refunds, settlement_refunded: db.settlements[0].refunded_cents }));
  expect(db.refunds.map((r) => r.stripe_refund_id)).toContain('re_older');
  expect(db.refunds.reduce((n, r) => n + Number(r.amount_cents), 0)).toBe(4_900);
});
