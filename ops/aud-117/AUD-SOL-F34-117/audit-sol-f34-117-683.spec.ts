import type { ChargeSettlement, ClientPurchase, ConnectTransfer, PayeeRecovery, SplitLedgerEntry } from '@prisma/client';
import { ChargeSettlementService, convertedRefundedCents } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { ReconciliationService, settlementIdentityDrift } from '../src/connect/fees/reconciliation.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { FakeStripe, Table, asPrisma, makeCharge, makeSettlementPrisma, type Row } from './utils/settlement-fakes';

function setup(fx = false) {
  const { prisma, db } = makeSettlementPrisma();
  Object.assign(prisma, { reconciliationSnapshot: new Table([], { prefix: 'rs', unique: ['purchase_id'] }) });
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(asPrisma(prisma), stripe, new FeePolicyService(asPrisma(prisma)), ledger, transfers);
  const purchase = {
    id: 'cp_1', coach_user_id: 'coach_1', client_user_id: 'client_1', package_id: 'pkg_1',
    amount_cents: fx ? 10_000 : 4_900, currency: fx ? 'cad' : 'usd', status: 'paid',
    source: null, billing_type: 'one_time', stripe_payment_intent_id: null, stripe_subscription_id: null,
    created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_1' });
  stripe.charges.set('ch_1', fx ? {
    ...makeCharge({ id: 'ch_1', amount: 10_000, fee: 200, currency: 'cad' }),
    balance_transaction: { id: 'txn_ch_1', amount: 8_000, fee: 200, net: 7_800, currency: 'usd' },
  } : makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
  return { prisma, db, stripe, settlements, purchase };
}

it('FX late partial refund keeps the actual client currency and amount in the notice', async () => {
  const c = setup(true);
  await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
  Object.assign(c.stripe, { listChargeRefunds: jest.fn(async () => ({
    data: [{ id: 're_1', status: 'succeeded', amount: 2_500, currency: 'cad',
      balance_transaction: { id: 'txn_re_1', amount: -2_000, currency: 'usd' } }],
    has_more: false,
  })) });
  await c.settlements.applyAdjustments({ purchase: c.purchase, charge_id: 'ch_1', refunded_cents: 2_500 });
  expect(c.stripe.netTo('acct_1')).toBe(5_640);
  const notice = c.db.notices?.[0];
  console.log('OBSERVATION_FX_NOTICE', JSON.stringify(notice));
  expect(String(notice?.body)).toContain('25.00');
  expect(String(notice?.body)).toMatch(/CAD|CA\$/);
});

it('a provably never-sent pending transfer is not subtracted from platform cash', async () => {
  const c = setup();
  c.stripe.createTransfer.mockRejectedValueOnce(new StripeConnectApiError('outage', 503, null, 'api_error'));
  await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
  expect(c.stripe.netTo('acct_1')).toBe(0);
  expect(c.db.transfers[0]).toMatchObject({ status: 'pending', stripe_transfer_id: null });
  const position = settlementIdentityDrift({
    settlement: c.db.settlements[0] as ChargeSettlement,
    ledger: c.db.ledger as SplitLedgerEntry[],
    transfers: c.db.transfers as ConnectTransfer[],
    recoveries: c.db.recoveries as PayeeRecovery[],
    stripe: { gross_cents: 4_900, fee_cents: 172, refunded_cents: 0 },
  });
  const rec = await new ReconciliationService(asPrisma(c.prisma), c.stripe).reconcilePurchase('cp_1');
  expect(rec).toMatchObject({ status: 'unknown', stripe: { transfers_cents: 0 } });
  console.log('OBSERVATION_PENDING_CASH', JSON.stringify({ position, rec }));
  expect(position.platform_cash_cents).toBe(4_728);
});

it('an explicitly incomplete refund list without a cursor is unavailable, never zero debits', async () => {
  const c = setup(true);
  Object.assign(c.stripe, { listChargeRefunds: jest.fn(async () => ({ data: [], has_more: true })) });
  await expect(convertedRefundedCents(c.stripe, 'ch_1', 'usd')).rejects.toThrow('SFEE_REFUND_STATE_UNAVAILABLE');
});

it('control: a full refund debit higher than original settlement gross is recovered exactly once', async () => {
  const c = setup(true);
  await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
  Object.assign(c.stripe, { listChargeRefunds: jest.fn(async () => ({
    data: [{ id: 're_full', status: 'succeeded',
      balance_transaction: { id: 'txn_re_full', amount: -8_500, currency: 'usd' } }],
    has_more: false,
  })) });
  const args = { purchase: c.purchase, charge_id: 'ch_1', refunded_cents: 10_000 };
  await c.settlements.applyAdjustments(args);
  await c.settlements.applyAdjustments(args);
  expect(c.stripe.netTo('acct_1')).toBe(0);
  expect(c.db.settlements[0].target_coach_net_cents).toBe(-860);
  expect(c.db.recoveries.reduce((n, r) => n + Number(r.amount_cents), 0)).toBe(860);
});
