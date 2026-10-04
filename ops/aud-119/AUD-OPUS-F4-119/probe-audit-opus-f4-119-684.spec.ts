// Lens probe AUD-OPUS-F4-119 (Claude Opus 5.5, agent 119) on backend #684 @ 6b13af56. Never merge.
//   R1-R2  refund.updated (Stripe's non-deprecated refund event) reaches the money path through the
//          real webhook router (CheckoutWebhookHandlerService), like charge.refund.updated (R0 control)
//   S1-S4  a refund status Stripe already reported as failed is terminal: a late, older event that
//          still says succeeded must not move money or rewrite the row
//   S5     control: refund.updated(succeeded) before charge.refunded for an unseen refund converges once
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
import { FakeStripe, asPrisma, makeCharge, makeSettlementPrisma, type Row } from './utils/settlement-fakes';

type RefundFixture = { id: string; status: string; amount: number; currency: string } & Row;

function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const fee = new FeePolicyService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(asPrisma(prisma), stripe, fee, ledger, transfers);
  const fns = {
    createNotification: jest.fn(async (..._a: unknown[]): Promise<{ id: string } | null> => ({
      id: 'n_1',
    })),
    channelGate: jest.fn(async (..._a: unknown[]) => 'enabled'),
    pushToUser: jest.fn(async (..._a: unknown[]) => ({ delivered: true, code: 'delivered' })),
    send: jest.fn(async (..._a: unknown[]) => ({ status: 'sent' })),
  };
  const stub: object = fns;
  const notices = new PayoutNoticeService(
    asPrisma(prisma),
    stub as NotificationsService,
    stub as EmailService,
  );
  const refunds = new RefundDisputeHandlerService(
    asPrisma(prisma),
    stripe,
    ledger,
    transfers,
    new PayoutReadinessService(asPrisma(prisma), stripe),
    stub as NotificationsService,
    undefined,
    undefined,
    settlements,
    notices,
  );
  const router = new CheckoutWebhookHandlerService(
    asPrisma(prisma),
    stripe,
    undefined,
    undefined,
    refunds,
  );
  const purchase = {
    id: 'cp_1',
    coach_user_id: 'coach_1',
    client_user_id: 'client_1',
    package_id: 'pkg_1',
    amount_cents: 4_900,
    currency: 'usd',
    status: 'paid',
    source: null,
    entitlement_active: true,
    billing_type: 'one_time',
    stripe_payment_intent_id: null,
    stripe_subscription_id: null,
    created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_1' });
  const charge = (amount_refunded = 0) =>
    makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded });
  stripe.charges.set('ch_1', charge());
  const listRefunds = (data: RefundFixture[]) =>
    Object.assign(stripe, { listChargeRefunds: jest.fn(async () => ({ data, has_more: false })) });
  return { prisma, db, stripe, settlements, refunds, router, purchase, charge, listRefunds };
}

const usd = (id: string, amount: number, status = 'succeeded'): RefundFixture => ({
  id,
  status,
  amount,
  currency: 'usd',
  charge: 'ch_1',
});
const refundedEvent = (amountRefunded: number, data?: Row[]) => ({
  id: `evt_refunded_${amountRefunded}_${data?.length ?? 'none'}`,
  type: 'charge.refunded',
  data: {
    object: {
      id: 'ch_1',
      amount: 4_900,
      amount_refunded: amountRefunded,
      refunded: amountRefunded >= 4_900,
      ...(data ? { refunds: { data, has_more: false } } : {}),
    },
  },
});
const updated = (type: string, status: string, id = 're_ach', amount = 4_900) => ({
  id: `evt_${type}_${id}_${status}`,
  type,
  data: { object: { id, object: 'refund', charge: 'ch_1', amount, status, failure_reason: null } },
});

async function settled() {
  const c = setup();
  await c.settlements.settleCharge({ purchase: c.purchase, charge_id: 'ch_1' });
  expect(c.stripe.netTo('acct_1')).toBe(4_630);
  return c;
}

async function pendingAch(c: Awaited<ReturnType<typeof settled>>) {
  // Current API versions embed no refund list: the handler reads Stripe's list (pending).
  c.stripe.charges.set('ch_1', c.charge(4_900));
  c.listRefunds([usd('re_ach', 4_900, 'pending')]);
  await c.router.handle(refundedEvent(4_900));
  expect(c.db.settlements[0].refunded_cents).toBe(0);
}

afterEach(() => jest.restoreAllMocks());

describe('R: refund status updates through the real webhook router', () => {
  it('R0 control: charge.refund.updated(succeeded) via the router moves the refund once', async () => {
    const c = await settled();
    await pendingAch(c);
    await c.router.handle(updated('charge.refund.updated', 'succeeded'));
    expect(c.db.settlements[0].refunded_cents).toBe(4_900);
    expect(c.stripe.netTo('acct_1')).toBe(0);
  });

  it('R1 refund.updated(succeeded) via the router moves the refund once', async () => {
    const c = await settled();
    await pendingAch(c);
    const out = await c.router.handle(updated('refund.updated', 'succeeded'));
    expect(out).toMatchObject({ claimed: true, purchase_id: 'cp_1' });
    expect(c.db.settlements[0].refunded_cents).toBe(4_900);
    expect(c.stripe.netTo('acct_1')).toBe(0);
  });

  it('R2 refund.updated(failed) via the router records the failure on the refund row', async () => {
    const c = await settled();
    await pendingAch(c);
    await c.router.handle(updated('refund.updated', 'failed'));
    expect(c.db.refunds.find((r) => r.stripe_refund_id === 're_ach')?.status).toBe('failed');
  });
});

describe('S: a failed refund is terminal; a late older event never moves money', () => {
  it('S1 pending -> failed processed, then the older succeeded update arrives late: coach keeps 4,630', async () => {
    const c = await settled();
    await pendingAch(c);
    c.stripe.charges.set('ch_1', c.charge(0));
    await c.router.handle(updated('charge.refund.updated', 'failed'));
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
    // Stripe retries the earlier succeeded delivery (it failed the first time, e.g. charge lock busy).
    await c.router.handle(updated('charge.refund.updated', 'succeeded'));
    expect(c.db.settlements[0].refunded_cents).toBe(0);
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
    expect(c.stripe.reversals).toHaveLength(0);
  });

  it('S2 the late succeeded update leaves the refund row failed', async () => {
    const c = await settled();
    await pendingAch(c);
    c.stripe.charges.set('ch_1', c.charge(0));
    await c.router.handle(updated('charge.refund.updated', 'failed'));
    await c.router.handle(updated('charge.refund.updated', 'succeeded'));
    expect(c.db.refunds.find((r) => r.stripe_refund_id === 're_ach')?.status).toBe('failed');
  });

  it('S3 applied, then failed (alert), then a late duplicate succeeded: the row stays failed', async () => {
    const c = await settled();
    await pendingAch(c);
    await c.router.handle(updated('charge.refund.updated', 'succeeded'));
    expect(c.stripe.netTo('acct_1')).toBe(0);
    c.stripe.charges.set('ch_1', c.charge(0));
    await c.router.handle(updated('charge.refund.updated', 'failed'));
    await c.router.handle(updated('refund.updated', 'succeeded'));
    await c.router.handle(updated('charge.refund.updated', 'succeeded', 're_ach', 4_900));
    expect(c.db.refunds.find((r) => r.stripe_refund_id === 're_ach')?.status).toBe('failed');
    expect(c.stripe.reversals).toHaveLength(1);
  });

  it('S4 older API (embedded complete list): failed recorded first, late charge.refunded snapshot says succeeded: nothing moves', async () => {
    const c = await settled();
    c.stripe.charges.set('ch_1', c.charge(0));
    // The refund failed and its update was processed before the original charge.refunded retry.
    await c.router.handle(updated('charge.refund.updated', 'failed', 're_card', 4_900));
    expect(c.db.refunds.find((r) => r.stripe_refund_id === 're_card')?.status).toBe('failed');
    await c.router.handle(refundedEvent(4_900, [usd('re_card', 4_900, 'succeeded')]));
    expect(c.db.settlements[0].refunded_cents).toBe(0);
    expect(c.stripe.netTo('acct_1')).toBe(4_630);
  });

  it('S5 control: refund.updated(succeeded) before charge.refunded (unseen refund) converges once', async () => {
    const c = await settled();
    c.stripe.charges.set('ch_1', c.charge(4_900));
    c.listRefunds([usd('re_ach', 4_900, 'succeeded')]);
    await c.refunds.handle(updated('charge.refund.updated', 'succeeded'));
    await c.router.handle(refundedEvent(4_900));
    expect(c.db.settlements[0].refunded_cents).toBe(4_900);
    expect(c.stripe.netTo('acct_1')).toBe(0);
    expect(c.stripe.reversals).toHaveLength(1);
  });
});
