import type { ClientPurchase } from '@prisma/client';
import { PayoutNoticeService } from '../src/checkout/payout-notice.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import type { EmailService } from '../src/email/email.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import {
  FakeStripe,
  makeCharge,
  makeSettlementPrisma,
  asPrisma,
  type Row,
} from './utils/settlement-fakes';

// AUD-OPUS-F34-117 probe (lens only, never merged). Async-rail refund (ACH / bank debit):
// Stripe sends charge.refunded when the refund is CREATED (status pending) and the terminal
// status only as a refund update. Sequence measured by Stripe's own connector docs:
// bank transfer: refund.created(PENDING) -> charge.refunded -> refund.updated(succeeded).
function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const fee = new FeePolicyService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(asPrisma(prisma), stripe, fee, ledger, transfers);
  const fns = {
    createNotification: jest.fn(async (..._a: unknown[]): Promise<{ id: string } | null> => ({ id: 'n_1' })),
    channelGate: jest.fn(async (..._a: unknown[]) => 'enabled'),
    pushToUser: jest.fn(async (..._a: unknown[]) => ({ delivered: true, code: 'delivered' })),
    send: jest.fn(async (..._a: unknown[]) => ({ status: 'sent' })),
  };
  const stub: object = fns;
  const notifications = stub as NotificationsService;
  const email = stub as EmailService;
  const notices = new PayoutNoticeService(asPrisma(prisma), notifications, email);
  const readiness = new PayoutReadinessService(asPrisma(prisma), stripe);
  const refunds = new RefundDisputeHandlerService(
    asPrisma(prisma), stripe, ledger, transfers, readiness, notifications,
    undefined, undefined, settlements, notices,
  );
  const purchase = {
    id: 'cp_1', coach_user_id: 'coach_1', client_user_id: 'client_1', package_id: 'pkg_1',
    amount_cents: 4_900, currency: 'usd', status: 'paid', source: null,
    entitlement_active: true, billing_type: 'one_time', stripe_payment_intent_id: null,
    stripe_subscription_id: null, created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: 'coach_1', stripe_account_id: 'acct_1' });
  stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
  return { db, stripe, settlements, refunds, purchase };
}

const refunded = (amountRefunded: number, status: string) => ({
  id: 'evt_refunded', type: 'charge.refunded',
  data: { object: {
    id: 'ch_1', amount: 4_900, amount_refunded: amountRefunded, refunded: amountRefunded >= 4_900,
    refunds: { data: [{ id: 're_ach', amount: 4_900, status }], has_more: false },
  } },
});
const refundUpdated = (status: string) => ({
  id: `evt_updated_${status}`, type: 'charge.refund.updated',
  data: { object: { id: 're_ach', charge: 'ch_1', amount: 4_900, status, failure_reason: null } },
});

describe('AUD-OPUS-F34-117: async-rail refund status transitions on a settlement charge', () => {
  it('P1 pending refund (amount_refunded counts it): no money moves until it succeeds', async () => {
    const ctx = setup();
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    expect(ctx.stripe.netTo('acct_1')).toBe(4_630);
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }));
    await ctx.refunds.handle(refunded(4_900, 'pending'));
    expect(ctx.db.settlements[0].refunded_cents).toBe(0);
    expect(ctx.stripe.netTo('acct_1')).toBe(4_630);
  });

  it('P2 the pending refund then fails: the coach keeps the sale', async () => {
    const ctx = setup();
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }));
    await ctx.refunds.handle(refunded(4_900, 'pending'));
    // Stripe returns the funds to the platform balance (failure_balance_transaction).
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 0 }));
    await ctx.refunds.handle(refundUpdated('failed'));
    expect(ctx.db.settlements[0].refunded_cents).toBe(0);
    expect(ctx.stripe.netTo('acct_1')).toBe(4_630);
  });

  it('P3 pending at charge.refunded (amount_refunded excludes it), then succeeded: the refund converges', async () => {
    const ctx = setup();
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    await ctx.refunds.handle(refunded(0, 'pending'));
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }));
    await ctx.refunds.handle(refundUpdated('succeeded'));
    expect(ctx.db.settlements[0].refunded_cents).toBe(4_900);
    expect(ctx.stripe.netTo('acct_1')).toBe(0);
  });

  it('P4 control: pending at charge.refunded (amount_refunded counts it), then succeeded: converged', async () => {
    const ctx = setup();
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }));
    await ctx.refunds.handle(refunded(4_900, 'pending'));
    await ctx.refunds.handle(refundUpdated('succeeded'));
    expect(ctx.db.settlements[0].refunded_cents).toBe(4_900);
    expect(ctx.stripe.netTo('acct_1')).toBe(0);
  });

  it('P5 control: a succeeded card refund converges once', async () => {
    const ctx = setup();
    await ctx.settlements.settleCharge({ purchase: ctx.purchase, charge_id: 'ch_1' });
    ctx.stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }));
    await ctx.refunds.handle(refunded(4_900, 'succeeded'));
    await ctx.refunds.handle(refunded(4_900, 'succeeded'));
    expect(ctx.db.settlements[0].refunded_cents).toBe(4_900);
    expect(ctx.stripe.netTo('acct_1')).toBe(0);
    expect(ctx.stripe.reversals).toHaveLength(1);
  });
});
