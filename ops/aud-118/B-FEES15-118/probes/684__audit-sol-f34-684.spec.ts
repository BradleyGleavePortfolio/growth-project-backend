import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { PayoutNoticeService } from '../src/checkout/payout-notice.service';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { PayoutReadinessService } from '../src/connect/fees/payout-readiness.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import type { NotificationsService } from '../src/notifications/notifications.service';
import {
  FakeStripe, asPrisma, makeCharge, makeSettlementPrisma, type Row,
} from './utils/settlement-fakes';

function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const fee = new FeePolicyService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(asPrisma(prisma), stripe, fee, ledger, transfers);
  const notificationStub: object = {
    createNotification: jest.fn(async () => ({ id: 'n_audit' })),
    channelGate: jest.fn(async () => 'off'),
  };
  const notifications = notificationStub as NotificationsService;
  const notices = new PayoutNoticeService(asPrisma(prisma), notifications);
  const readiness = new PayoutReadinessService(asPrisma(prisma), stripe);
  const refunds = new RefundDisputeHandlerService(
    asPrisma(prisma), stripe, ledger, transfers, readiness, notifications,
    undefined, undefined, settlements, notices,
  );
  const purchase = {
    id: 'cp_audit', coach_user_id: 'coach_audit', client_user_id: 'client_audit',
    package_id: 'pkg_audit', amount_cents: 4_900, currency: 'usd',
    status: 'paid', source: null, entitlement_active: true, billing_type: 'one_time',
    // No saved PI is needed: routing resolves through the real settlement.
    stripe_payment_intent_id: null, stripe_subscription_id: null, created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: purchase.coach_user_id, stripe_account_id: 'acct_audit' });
  stripe.charges.set('ch_audit', makeCharge({ id: 'ch_audit', amount: 4_900, fee: 172 }));
  return { prisma, db, stripe, settlements, purchase, refunds, notices, notifications };
}

afterEach(() => jest.restoreAllMocks());

describe('Independent F4 actual-service boundary probes', () => {
  it('control: complete refund list converges a fully refunded sale exactly once', async () => {
    const { db, stripe, settlements, purchase, refunds } = setup();
    await settlements.settleCharge({ purchase, charge_id: 'ch_audit' });
    stripe.charges.set('ch_audit',
      makeCharge({ id: 'ch_audit', amount: 4_900, fee: 172, amount_refunded: 4_900 }));
    const event = {
      id: 'evt_control', type: 'charge.refunded',
      data: { object: {
        id: 'ch_audit', amount: 4_900, amount_refunded: 4_900, refunded: true,
        refunds: { data: [{ id: 're_full', amount: 4_900, status: 'succeeded' }] },
      } },
    };
    await refunds.handle(event);
    await refunds.handle(event);
    expect(stripe.netTo('acct_audit')).toBe(0);
    expect(db.settlements[0].refunded_cents).toBe(4_900);
    expect(db.recoveries[0].amount_cents).toBe(270);
  });

  it('truncated latest-10 refund list still uses the canonical cumulative amount_refunded', async () => {
    const { db, stripe, settlements, purchase, refunds } = setup();
    await settlements.settleCharge({ purchase, charge_id: 'ch_audit' });
    stripe.charges.set('ch_audit',
      makeCharge({ id: 'ch_audit', amount: 4_900, fee: 172, amount_refunded: 4_900 }));
    // First delivered event after eleven dashboard partial refunds.
    // Stripe embeds only its latest ten: 10 * USD 4, omitting an earlier USD 9.
    const embedded = Array.from({ length: 10 }, (_, i) => ({
      id: `re_recent_${i}`, amount: 400, status: 'succeeded',
    }));
    const event = {
      id: 'evt_truncated', type: 'charge.refunded',
      data: { object: {
        id: 'ch_audit', amount: 4_900, amount_refunded: 4_900, refunded: true,
        refunds: { data: embedded, has_more: true },
      } },
    };
    await refunds.handle(event);
    await refunds.handle(event);
    expect(db.purchases[0]).toMatchObject({ status: 'refunded', entitlement_active: false });
    expect(db.settlements[0].refunded_cents).toBe(4_900);
    expect(stripe.netTo('acct_audit')).toBe(0);
    expect(db.recoveries[0].amount_cents).toBe(270);
  });

  it('failed in-app delivery must not send message bodies or arbitrary errors to logs', async () => {
    const { db, settlements, purchase, refunds, notifications } = setup();
    await settlements.settleCharge({ purchase, charge_id: 'ch_audit' });
    await settlements.applyAdjustments({ purchase, charge_id: 'ch_audit', refunded_cents: 2_000 });
    expect(db.notices).toHaveLength(1);
    const canary = 'AUDIT_NOTICE_BODY_contact_at_example_invalid';
    jest.spyOn(notifications, 'createNotification').mockRejectedValueOnce(new Error(canary));
    const warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await refunds.deliverPayoutNotices('ch_audit');
    expect(db.notices?.[0].inapp_status).toBe('failed');
    expect(warns.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(canary);
  });
});
