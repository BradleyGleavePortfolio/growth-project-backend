// AUD-OPUS-FL-119 probe (Claude Opus 5.5 lens, agent 119) on #697 c2585c97 / #684 9fb9c48f. Harness copied from
// test/s-fee-r17-refund-routing-status-notice-boundaries.spec.ts (setup unchanged). Lost-update race on the refund status write.
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
import type { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import type { PartialRefundDecisionService } from '../src/regimes/partial-refund-decision.service';
import {
  FakeStripe,
  Table,
  asPrisma,
  makeCharge,
  makeSettlementPrisma,
  type Row,
} from './utils/settlement-fakes';

type RefundFixture = { id: string; status: string; amount: number; currency: string } & Row;

function setup(opts: { purchaseCents?: number } = {}) {
  const { prisma, db } = makeSettlementPrisma();
  const user = new Table([{ id: 'coach_1', email: 'payee@example.invalid', name: null }], {
    prefix: 'u',
  });
  Object.assign(prisma, { user, emailSendLog: new Table([], { prefix: 'em' }) });
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
  const fanoutFns = { cancelPendingForPurchase: jest.fn(async (..._a: unknown[]) => 0) };
  const decisionFns = { onPartialRefund: jest.fn(async (..._a: unknown[]) => undefined) };
  const fanout: object = fanoutFns;
  const decisions: object = decisionFns;
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
    fanout as PurchaseFanoutService,
    decisions as PartialRefundDecisionService,
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
    amount_cents: opts.purchaseCents ?? 4_900,
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
  stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
  const list = (data: RefundFixture[]) => stripe.refundsByCharge.set('ch_1', data);
  return {
    prisma,
    db,
    stripe,
    settlements,
    notices,
    refunds,
    router,
    fns,
    fanoutFns,
    decisionFns,
    list,
    user,
  };
}

const usd = (id: string, amount: number, status = 'succeeded'): RefundFixture => ({
  id,
  status,
  amount,
  currency: 'usd',
});
const refunded = (data: RefundFixture[]) => ({
  id: `evt_refunded_${data.map((r) => `${r.id}_${r.status}`).join('_')}`,
  type: 'charge.refunded',
  data: {
    object: {
      id: 'ch_1',
      amount: 4_900,
      amount_refunded: data.reduce((n, r) => n + (r.status === 'succeeded' ? r.amount : 0), 0),
      refunds: { data, has_more: false },
    },
  },
});
const update = (type: string, status: string, id = 're_1', amount = 4_900) => ({
  id: `evt_${type}_${id}_${status}`,
  type,
  data: { object: { id, object: 'refund', charge: 'ch_1', amount, status, failure_reason: null } },
});

async function settledWithPending(c: ReturnType<typeof setup>, id = 're_1', amount = 4_900) {
  await c.settlements.settleCharge({
    purchase: c.db.purchases[0] as ClientPurchase,
    charge_id: 'ch_1',
  });
  expect(c.stripe.netTo('acct_1')).toBe(4_630);
  c.list([usd(id, amount, 'pending')]);
  await c.router.handle(refunded([usd(id, amount, 'pending')]));
  expect(c.db.settlements[0].refunded_cents).toBe(0);
}

type UpdateArgs = { where: Row; data: Row };

// Runs `between` once, right before the first chargeRefund.update that writes status 'succeeded'
// (the stale worker's write, after its read of the row).
function interleaveBeforeSucceededWrite(c: ReturnType<typeof setup>, between: () => Promise<void>) {
  const tbl = c.prisma.chargeRefund as unknown as Table;
  const real = tbl.update.getMockImplementation() as (a: UpdateArgs) => Promise<Row>;
  let fired = false;
  tbl.update.mockImplementation(async (args: UpdateArgs) => {
    if (!fired && args?.data?.status === 'succeeded') {
      fired = true;
      await between();
    }
    return real(args);
  });
}

describe('AUD-OPUS-FL-119 L1-L3: a failure processed between a stale worker read and its status write', () => {
  it('L0 control: failed after succeeded (sequential) flags once and keeps the row failed', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900)]);
    await c.router.handle(update('refund.updated', 'succeeded'));
    c.list([usd('re_1', 4_900, 'failed')]);
    await c.router.handle(update('refund.updated', 'failed'));
    expect(c.db.refunds[0].status).toBe('failed');
    expect(c.db.settlements[0].reconcile_reason).toBe('SFEE_REFUND_FAILED_AFTER_APPLY');
  });

  it('L1 refund.updated succeeded redelivery races refund.updated failed: the row ends failed and the coach keeps 4,630', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900, 'failed')]);
    interleaveBeforeSucceededWrite(c, async () => {
      await c.router.handle(update('refund.updated', 'failed'));
    });
    await c.router.handle(update('refund.updated', 'succeeded'));
    // Stripe's final state is failed: no money may move, or (if it moved) the settlement is flagged.
    const flagged = c.db.settlements[0].reconcile_reason === 'SFEE_REFUND_FAILED_AFTER_APPLY';
    expect({ status: c.db.refunds[0].status, net: c.stripe.netTo('acct_1'), flagged }).toEqual({
      status: 'failed',
      net: 4_630,
      flagged: false,
    });
  });

  it('L2 same race while Stripe still lists the refund succeeded at the stale read: access and money stay', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900)]);
    interleaveBeforeSucceededWrite(c, async () => {
      c.list([usd('re_1', 4_900, 'failed')]);
      await c.router.handle(update('refund.updated', 'failed'));
    });
    await c.router.handle(update('charge.refund.updated', 'succeeded'));
    expect({
      status: c.db.refunds[0].status,
      net: c.stripe.netTo('acct_1'),
      purchase: c.db.purchases[0].status,
    }).toEqual({ status: 'failed', net: 4_630, purchase: 'paid' });
  });

  it('L3 a charge.refunded redelivery (snapshot succeeded) races refund.updated failed: the row ends failed', async () => {
    const c = setup();
    await settledWithPending(c);
    c.list([usd('re_1', 4_900, 'failed')]);
    interleaveBeforeSucceededWrite(c, async () => {
      await c.router.handle(update('refund.updated', 'failed'));
    });
    await c.router.handle(refunded([usd('re_1', 4_900)]));
    expect({
      status: c.db.refunds[0].status,
      net: c.stripe.netTo('acct_1'),
      refunded: c.db.settlements[0].refunded_cents,
    }).toEqual({ status: 'failed', net: 4_630, refunded: 0 });
  });
});
