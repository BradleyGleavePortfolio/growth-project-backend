// GC-3 (#GC-TRIAL op 1) — after a web trial, the first real charge settles
// the 2% fee like any renewal. The trial's own $0 invoice has no charge and
// settles nothing; nothing is taken on the trial day. Same settlement fakes
// as the S-FEE renewal specs. No live Stripe.
import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { FakeStripe, asPrisma, makeCharge, makeSettlementPrisma, type Row } from './utils/settlement-fakes';

const COACH = 'coach-alex';
const NOW = new Date('2026-11-07T04:00:00Z');
const secondsAgo = (days: number) => Math.floor((NOW.getTime() - days * 86_400_000) / 1000);

// The purchase a web trial's conversion writes (guest-checkout.service.ts):
// recurring, its subscription, the SetupIntent in the PaymentIntent slot,
// and the trial marker.
function webTrialPurchase(): ClientPurchase {
  const row: Row = {
    id: 'cp-web-trial',
    coach_user_id: COACH,
    client_user_id: 'client-jane',
    package_id: 'pkg-trial',
    amount_cents: 14_900,
    currency: 'usd',
    billing_type: 'recurring',
    status: 'active',
    entitlement_active: true,
    source: null,
    stripe_payment_intent_id: 'seti_webtrial01',
    stripe_subscription_id: 'sub_webtrial01',
    trial_days: 7,
    trial_started_at: new Date('2026-10-30T17:00:00Z'),
    trial_ends_at: new Date('2026-11-06T17:00:00Z'),
    created_at: new Date('2026-10-30T17:00:00Z'),
  };
  return row as ClientPurchase;
}

function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const feePolicy = new FeePolicyService(asPrisma(prisma));
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc = new ChargeSettlementService(asPrisma(prisma), stripe, feePolicy, ledger, transfers);
  db.accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_alex' });
  const purchase = webTrialPurchase();
  db.purchases.push(purchase as Row);
  return { db, stripe, svc, purchase };
}

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('GC-3 — the renewal after a web trial settles the 2% fee', () => {
  it('settlePurchase skips the $0 trial invoice and settles the first real charge once (2% + Stripe fee off the coach net)', async () => {
    const ctx = setup();
    ctx.stripe.charges.set('ch_first_real', makeCharge({ id: 'ch_first_real', amount: 14_900, fee: 462 }));
    ctx.stripe.listInvoices.mockResolvedValue({
      data: [
        { id: 'in_first_real', amount_paid: 14_900, charge: 'ch_first_real' },
        { id: 'in_trial', amount_paid: 0, charge: null },
      ],
    });

    const outcomes = await ctx.svc.settlePurchase(ctx.purchase);

    expect(outcomes.map((o) => o.status)).toEqual(['settled']);
    expect(ctx.db.settlements).toHaveLength(1);
    expect(ctx.db.settlements[0]).toMatchObject({
      stripe_charge_id: 'ch_first_real',
      stripe_invoice_id: 'in_first_real',
      purchase_id: 'cp-web-trial',
      // 14,900 − 462 Stripe fee − 298 (2%) = 14,140.
      target_coach_net_cents: 14_140,
    });
    expect(ctx.stripe.netTo('acct_alex')).toBe(14_140);
    // The SetupIntent in the PaymentIntent slot is never read as a payment.
    expect(ctx.stripe.retrievePaymentIntent).not.toHaveBeenCalled();

    // Replayed: nobody is paid twice.
    await ctx.svc.settlePurchase(ctx.purchase);
    expect(ctx.stripe.netTo('acct_alex')).toBe(14_140);
  });

  it('a lost renewal webhook is still found by the sweep; the trial invoice (no charge) is not settled', async () => {
    const ctx = setup();
    ctx.stripe.charges.set('ch_first_real', makeCharge({ id: 'ch_first_real', amount: 14_900, fee: 462 }));
    ctx.stripe.paidInvoices.push(
      { id: 'in_trial', amount_paid: 0, charge: null, subscription: 'sub_webtrial01', created: secondsAgo(8) },
      { id: 'in_first_real', amount_paid: 14_900, charge: 'ch_first_real', subscription: 'sub_webtrial01', created: secondsAgo(1) },
    );

    await ctx.svc.runSettlementSweep(NOW);

    expect(ctx.db.settlements.map((s) => s.stripe_charge_id)).toEqual(['ch_first_real']);
    expect(ctx.db.settlements[0].target_coach_net_cents).toBe(14_140);
  });
});
