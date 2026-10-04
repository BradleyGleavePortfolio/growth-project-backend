import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import {
  ChargeSettlementService,
  chargeRefundsFromStripe,
} from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import {
  asPrisma,
  FakeStripe,
  makeCharge,
  makeSettlementPrisma,
  Table,
  type Row,
} from './utils/settlement-fakes';

function setup(fx = true, head = false) {
  const { prisma, db } = makeSettlementPrisma();
  Object.assign(prisma, {
    reconciliationSnapshot: new Table([], { prefix: 'rs', unique: ['purchase_id'] }),
  });
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const policy = new FeePolicyService(asPrisma(prisma));
  if (head) jest.spyOn(policy, 'resolveHeadCoachId').mockResolvedValue('head_1');
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(
    asPrisma(prisma), stripe, policy, ledger, transfers,
  );
  const purchase = {
    id: 'cp_probe', coach_user_id: 'coach_1', client_user_id: 'client_1', package_id: 'pkg_1',
    amount_cents: 10_000, currency: fx ? 'cad' : 'usd', status: 'active', source: null,
    billing_type: 'recurring', stripe_payment_intent_id: null,
    stripe_subscription_id: 'sub_probe', created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_coach' });
  if (head) {
    db.accounts.push({ coach_user_id: 'head_1', stripe_account_id: 'acct_head' });
    jest.spyOn(policy, 'resolvePolicy').mockResolvedValue({
      platform_application_fee_bps: 200, head_coach_split_bps: 500, source: 'default',
    });
  }
  const ready = (refunded = 0) => ({
    ...makeCharge({ id: 'ch_probe', amount: 10_000, fee: 200,
      currency: fx ? 'cad' : 'usd', amount_refunded: refunded }),
    balance_transaction: {
      id: 'txn_probe', amount: 8_000, fee: 200, net: 7_800, currency: 'usd',
    },
  });
  stripe.charges.set('ch_probe', ready());
  const refund = (client = 2_500, debit = 2_000, status = 'succeeded') => ({
    id: 're_probe', status, amount: client, currency: fx ? 'cad' : 'usd',
    balance_transaction: { id: 'txn_refund', amount: -debit, currency: 'usd' },
  });
  const complete = () => Object.assign(stripe, {
    listChargeRefunds: jest.fn(async () => ({ data: [refund()], has_more: false })),
  });
  return { prisma, db, stripe, settlements, purchase, ready, refund, complete };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it.each(['no balance transaction', 'first Stripe read unavailable'])(
  'a deferred FX refund is re-denominated when the fee becomes available: %s',
  async (failure) => {
    const c = setup();
    c.stripe.charges.set('ch_probe', { ...c.ready(2_500), balance_transaction: null });
    if (failure === 'first Stripe read unavailable') {
      c.stripe.retrieveCharge.mockRejectedValueOnce(
        new StripeConnectApiError('outage', 503, null, 'api_error'),
      );
    }
    expect((await c.settlements.settleCharge({
      purchase: c.purchase, charge_id: 'ch_probe',
    })).status).toBe('awaiting_fee');
    c.db.refunds.push({
      id: 'local_re', stripe_refund_id: 're_probe', stripe_charge_id: 'ch_probe',
      status: 'succeeded', amount_cents: 2_500, currency: 'cad',
    });
    expect(await c.settlements.applyAdjustments({
      purchase: c.purchase, charge_id: 'ch_probe', refunded_cents: 2_500,
    })).toBe('deferred');
    expect(c.db.settlements[0]).toMatchObject({
      status: 'awaiting_fee', currency: 'cad', refunded_cents: 2_500,
    });
    c.stripe.charges.set('ch_probe', c.ready(2_500));
    c.complete();
    await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_probe' });
    await c.settlements.applyAdjustments({
      purchase: c.purchase, charge_id: 'ch_probe', refunded_cents: 2_500,
    });
    const rec = await new ReconciliationService(asPrisma(c.prisma), c.stripe)
      .reconcilePurchase(c.purchase.id);
    console.log('AUD117_PROVISIONAL_FX', {
      failure, row: c.db.settlements[0], external: c.stripe.netTo('acct_coach'), rec,
    });
    expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 2_000 });
    expect(c.stripe.netTo('acct_coach')).toBe(5_640);
    expect(rec).toMatchObject({ status: 'ok', drift_cents: 0 });
  },
);

it('control: an early FX refund with its fee already available pays the correct net', async () => {
  const c = setup();
  c.stripe.charges.set('ch_probe', c.ready(2_500));
  c.complete();
  await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_probe' });
  expect(c.db.settlements[0]).toMatchObject({ currency: 'usd', refunded_cents: 2_000 });
  expect(c.stripe.netTo('acct_coach')).toBe(5_640);
});

it.each([false, true])('late FX refund preserves client notice and money, head=%s', async (head) => {
  const c = setup(true, head);
  await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_probe' });
  c.stripe.charges.set('ch_probe', c.ready(2_500));
  c.complete();
  await c.settlements.applyAdjustments({
    purchase: c.purchase, charge_id: 'ch_probe', refunded_cents: 2_500,
  });
  for (const n of c.db.notices ?? []) {
    expect(n).toMatchObject({
      currency: 'usd', customer_refunded_cents: 2_000,
      client_currency: 'cad', client_refunded_cents: 2_500,
    });
    expect(String(n.body)).toMatch(/^A client got 25\.00 CAD back, \$20\.00 after conversion\./);
  }
  expect(c.db.notices).toHaveLength(head ? 2 : 1);
  expect(c.stripe.netTo('acct_coach')).toBe(head ? 5_340 : 5_640);
  if (head) expect(c.stripe.netTo('acct_head')).toBe(300);
});

it.each([
  null, {}, { data: [] }, { has_more: false }, { data: [], has_more: true },
  { data: [{ id: 're_bad', status: 'succeeded', amount: NaN, currency: 'cad' }], has_more: false },
])('malformed or incomplete refund list stays unavailable: %j', async (page) => {
  const c = setup();
  Object.assign(c.stripe, { listChargeRefunds: jest.fn(async () => page) });
  await expect(chargeRefundsFromStripe(c.stripe, 'ch_probe', 'usd'))
    .rejects.toMatchObject({ code: 'SFEE_REFUND_STATE_UNAVAILABLE' });
});

it('a canonical pending refund moves no money during early settlement or reconciliation', async () => {
  const c = setup();
  c.stripe.charges.set('ch_probe', c.ready(2_500));
  Object.assign(c.stripe, {
    listChargeRefunds: jest.fn(async () => ({ data: [c.refund(2_500, 2_000, 'pending')], has_more: false })),
  });
  await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_probe' });
  expect(c.stripe.netTo('acct_coach')).toBe(7_640);
  expect(c.db.settlements[0].refunded_cents).toBe(0);
  expect(await new ReconciliationService(asPrisma(c.prisma), c.stripe)
    .reconcilePurchase(c.purchase.id)).toMatchObject({ status: 'ok', drift_cents: 0 });
});

it('a failed notice write in the same clock millisecond retains its durable retry flag', async () => {
  jest.useFakeTimers({
    doNotFake: ['performance', 'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate',
      'nextTick', 'queueMicrotask', 'hrtime'],
  });
  try {
    const c = setup();
    await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_probe' });
    c.stripe.charges.set('ch_probe', c.ready(2_500));
    c.complete();
    c.prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error('synthetic write failure'));
    expect(await c.settlements.applyAdjustments({
      purchase: c.purchase, charge_id: 'ch_probe', refunded_cents: 2_500,
    })).toBe('adjusted');
    console.log('AUD117_NOTICE_RETRY_FLAG', {
      noticeCount: c.db.notices?.length,
      flag: c.db.settlements[0].reconcile_requested_at,
      external: c.stripe.netTo('acct_coach'),
    });
    expect(c.stripe.netTo('acct_coach')).toBe(5_640);
    expect(c.db.notices).toHaveLength(0);
    expect(c.db.settlements[0].reconcile_requested_at).toBeInstanceOf(Date);
  } finally {
    jest.useRealTimers();
  }
});
