// Independent exact-head acceptance probes; audit branch only, never merge.
import type { ClientPurchase } from '@prisma/client';
import { CheckoutWebhookHandlerService } from '../src/checkout/checkout-webhook-handler.service';
import { PayoutNoticeService } from '../src/checkout/payout-notice.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import type { EmailService } from '../src/email/email.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import { FakeStripe, Table, asPrisma, makeCharge, makeSettlementPrisma, type Row } from './utils/settlement-fakes';

function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const user = new Table([{ id: 'coach_1', email: 'synthetic@example.invalid', name: null }], { prefix: 'u' });
  Object.assign(prisma, { user, emailSendLog: new Table([], { prefix: 'em' }) });
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(asPrisma(prisma), stripe,
    new FeePolicyService(asPrisma(prisma)), ledger, transfers);
  const calls = {
    createNotification: jest.fn(async (..._args: unknown[]) => ({ id: 'n_1' })),
    channelGate: jest.fn(async (..._args: unknown[]) => 'enabled'),
    pushToUser: jest.fn(async (..._args: unknown[]) => ({ delivered: true, code: 'delivered' })),
    send: jest.fn(async (..._args: unknown[]) => ({ status: 'sent' })),
  };
  const stub: object = calls;
  const notices = new PayoutNoticeService(asPrisma(prisma), stub as NotificationsService, stub as EmailService);
  const refund = new RefundDisputeHandlerService(asPrisma(prisma), stripe, ledger, transfers,
    new PayoutReadinessService(asPrisma(prisma), stripe), stub as NotificationsService,
    undefined, undefined, settlements, notices);
  const checkout = new CheckoutWebhookHandlerService(asPrisma(prisma), stripe,
    undefined, undefined, refund);
  const purchase = {
    id: 'cp_1', coach_user_id: 'coach_1', client_user_id: 'client_1', package_id: 'pkg_1',
    amount_cents: 4900, currency: 'usd', status: 'paid', source: null,
    entitlement_active: true, billing_type: 'one_time', stripe_payment_intent_id: null,
    stripe_subscription_id: null, created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_1' });
  stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4900, fee: 172 }));
  return { prisma, db, stripe, settlements, notices, calls, purchase, refund, checkout, user };
}

afterEach(() => jest.restoreAllMocks());

const pending = {
  id: 'evt_pending', type: 'charge.refunded', data: { object: {
    id: 'ch_1', amount: 4900, amount_refunded: 0, refunded: false,
    refunds: { data: [{ id: 're_1', amount: 4900, status: 'pending', currency: 'usd' }], has_more: false },
  } },
};
const succeeded = (type: string) => ({
  id: `evt_${type}`, type, data: { object: {
    id: 're_1', charge: 'ch_1', amount: 4900, currency: 'usd', status: 'succeeded',
  } },
});

it('refund.updated reaches the production checkout router, applies the pending refund and delivers its notice', async () => {
  const c = setup();
  await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
  await c.checkout.handle(pending);
  c.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4900, fee: 172, amount_refunded: 4900 }));
  const result = await c.checkout.handle(succeeded('refund.updated'));
  console.log('OBS_ROUTE', JSON.stringify({ result, row: c.db.refunds[0], net: c.stripe.netTo('acct_1') }));
  expect(result).toMatchObject({ claimed: true, purchase_id: 'cp_1' });
  expect(c.db.refunds[0].status).toBe('succeeded');
  expect(c.stripe.netTo('acct_1')).toBe(0);
});

it('a succeeded async full refund also revokes access, not just money, without a second charge.refunded event', async () => {
  const c = setup();
  await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
  await c.checkout.handle(pending);
  c.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4900, fee: 172, amount_refunded: 4900 }));
  await c.checkout.handle(succeeded('charge.refund.updated'));
  // Passing money controls establish this is the implemented refund path.
  expect(c.stripe.netTo('acct_1')).toBe(0);
  expect(c.db.refunds[0].ledger_reversed).toBe(true);
  console.log('OBS_ASYNC_ENTITLEMENT', JSON.stringify(c.db.purchases[0]));
  expect(c.db.purchases[0]).toMatchObject({ status: 'refunded', entitlement_active: false });
});

it('refund.updated from the inner handler also schedules or delivers its exact-amount payout notice', async () => {
  const c = setup();
  await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
  await c.refund.handle(pending);
  c.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4900, fee: 172, amount_refunded: 4900 }));
  await c.refund.handle(succeeded('refund.updated'));
  expect(c.stripe.netTo('acct_1')).toBe(0);
  expect(c.db.notices?.length).toBeGreaterThan(0);
  expect(c.db.notices?.[0].inapp_status).toBe('sent');
});

async function notice(c: ReturnType<typeof setup>, started: number, patch: Row = {}) {
  await c.prisma.payoutAdjustmentNotice.create({ data: {
    id: 'pan_1', idempotency_key: 'pan_key_1', payee_user_id: 'coach_1',
    settlement_id: 'cs_1', stripe_charge_id: 'ch_1', purchase_id: 'cp_1',
    event: 'refund', title: 'A client was refunded', body: 'A client got $1.00 back.',
    created_at: new Date(started - 120000), ...patch,
  } });
}

it('B-684-3: a claim/read that consumes the deadline cannot start an in-app channel afterward', async () => {
  const c = setup();
  const started = Date.now();
  let clock = started;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  await notice(c, started, { push_status: 'off', email_status: 'disabled' });
  const update = c.prisma.payoutAdjustmentNotice.updateMany.getMockImplementation()!;
  c.prisma.payoutAdjustmentNotice.updateMany.mockImplementation(async (args) => {
    const result = await update(args);
    if (args.data.dispatch_claimed_at) clock = started + 480001;
    return result;
  });
  await c.notices.dispatchPending(new Date(started), 25, started + 480000);
  console.log('OBS_LATE_INAPP', JSON.stringify({ elapsed: clock - started, calls: c.calls.createNotification.mock.calls.length }));
  expect(c.calls.createNotification).not.toHaveBeenCalled();
  expect(c.db.notices?.[0].dispatched_at ?? null).toBeNull();
});

it('B-684-3: a delayed push gate cannot start the provider after the run deadline and notice claim expire', async () => {
  const c = setup();
  const started = Date.now();
  let clock = started;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  await notice(c, started, { inapp_status: 'sent', email_status: 'disabled' });
  c.calls.channelGate.mockImplementation(async () => {
    clock = started + 660000;
    return 'enabled';
  });
  await c.notices.dispatchPending(new Date(started), 25, started + 480000);
  console.log('OBS_LATE_PUSH', JSON.stringify({ elapsed: clock - started, calls: c.calls.pushToUser.mock.calls.length }));
  expect(c.calls.pushToUser).not.toHaveBeenCalled();
  expect(c.db.notices?.[0].push_status).toBe('pending');
});

it('B-684-3: a delayed email address lookup cannot start an email after the run deadline', async () => {
  const c = setup();
  const started = Date.now();
  let clock = started;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  await notice(c, started, { inapp_status: 'sent', push_status: 'off' });
  c.user.findUnique.mockImplementation(async () => {
    clock = started + 660000;
    return { id: 'coach_1', email: 'synthetic@example.invalid', name: null };
  });
  await c.notices.dispatchPending(new Date(started), 25, started + 480000);
  console.log('OBS_LATE_EMAIL', JSON.stringify({ elapsed: clock - started, calls: c.calls.send.mock.calls.length }));
  expect(c.calls.send).not.toHaveBeenCalled();
  expect(c.db.notices?.[0].email_status).toBe('pending');
});

it('B-684-3: a later batch row uses a fresh claim, so a second worker cannot push it simultaneously', async () => {
  const c = setup();
  const started = Date.now();
  jest.useFakeTimers({ now: started });
  try {
    await notice(c, started, { inapp_status: 'sent', email_status: 'disabled' });
    // Settlement work / previous notices used six minutes of this sweep.
    jest.setSystemTime(started + 360000);
    let entered = false;
    c.calls.pushToUser.mockImplementation(async () => {
      if (!entered) {
        entered = true;
        await c.notices.dispatchForCharge('ch_1');
      }
      return { delivered: true, code: 'delivered' };
    });
    await c.notices.dispatchPending(new Date(started), 25, started + 480000);
    console.log('OBS_STALE_CLAIM', JSON.stringify({ pushes: c.calls.pushToUser.mock.calls.length, notice: c.db.notices?.[0] }));
    expect(c.calls.pushToUser).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it('control: a spent budget starts no channel at all', async () => {
  const c = setup();
  const started = Date.now();
  await notice(c, started);
  await c.notices.dispatchPending(new Date(started), 25, started - 1);
  expect(c.calls.createNotification).not.toHaveBeenCalled();
  expect(c.calls.pushToUser).not.toHaveBeenCalled();
  expect(c.calls.send).not.toHaveBeenCalled();
});
