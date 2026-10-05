import { Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { ReconciliationService } from '../src/connect/fees/reconciliation.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import {
  FakeStripe, Table, asPrisma, makeCharge, makeSettlementPrisma, type Row,
} from './utils/settlement-fakes';

function setup() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const fee = new FeePolicyService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(asPrisma(prisma), stripe, fee, ledger, transfers);
  const purchase = {
    id: 'cp_audit', coach_user_id: 'coach_audit', client_user_id: 'client_audit',
    package_id: 'pkg_audit', amount_cents: 4_900, currency: 'usd',
    status: 'paid', source: null, billing_type: 'one_time',
    stripe_payment_intent_id: 'pi_audit', stripe_subscription_id: null,
    created_at: new Date(),
  } as ClientPurchase;
  db.purchases.push(purchase as Row);
  db.accounts.push({ coach_user_id: purchase.coach_user_id, stripe_account_id: 'acct_audit' });
  stripe.charges.set('ch_audit', makeCharge({ id: 'ch_audit', amount: 4_900, fee: 172 }));
  return { prisma, db, stripe, settlements, purchase };
}

afterEach(() => jest.restoreAllMocks());

describe('Independent F3 actual-service boundary probes', () => {
  it('control: same-currency partial refund reverses the actual USD debit', async () => {
    const { stripe, settlements, purchase } = setup();
    await settlements.settleCharge({ purchase, charge_id: 'ch_audit' });
    await settlements.applyAdjustments({ purchase, charge_id: 'ch_audit', refunded_cents: 2_000 });
    expect(stripe.netTo('acct_audit')).toBe(2_630);
  });

  it('FX: CAD presentment cents must not be subtracted as USD settlement cents', async () => {
    const { db, stripe, settlements, purchase } = setup();
    const cadPurchase = { ...purchase, amount_cents: 10_000, currency: 'cad' };
    const charge = makeCharge({ id: 'ch_fx', amount: 10_000, fee: 200 });
    // A CAD 100 charge settled as USD 80, with USD 2 actual processing fee.
    // The CAD 25 succeeded refund withdrew USD 20 at the fixture's 0.8 rate.
    stripe.charges.set('ch_fx', {
      ...charge, currency: 'cad', amount_refunded: 2_500,
      balance_transaction: {
        id: 'txn_fx', amount: 8_000, fee: 200, net: 7_800, currency: 'usd',
      },
    });
    await settlements.settleCharge({ purchase: cadPurchase, charge_id: 'ch_fx' });
    expect(db.settlements[0]).toMatchObject({ gross_cents: 8_000, currency: 'usd' });
    // USD 80 - USD 2 processing - USD 1.60 platform - USD 20 refund.
    expect(stripe.netTo('acct_audit')).toBe(5_640);
  });

  it('reconciliation cannot attest paid/ok when Stripe has never created the pending transfer', async () => {
    const { prisma, db, stripe, settlements, purchase } = setup();
    stripe.createTransfer.mockRejectedValueOnce(
      new StripeConnectApiError('temporary provider outage', 503, null, 'api_error'),
    );
    await settlements.settleCharge({ purchase, charge_id: 'ch_audit' });
    expect(db.transfers[0]).toMatchObject({ status: 'pending', stripe_transfer_id: null });
    expect(stripe.netTo('acct_audit')).toBe(0);
    Object.assign(prisma, {
      reconciliationSnapshot: new Table([], { prefix: 'rs', unique: ['purchase_id'] }),
    });
    const reconciliation = new ReconciliationService(asPrisma(prisma), stripe);
    const result = await reconciliation.reconcilePurchase(purchase.id);
    expect(result).not.toMatchObject({ status: 'ok', drift_cents: 0 });
    expect(result.stripe.transfers_cents).toBe(0);
  });

  it('a failed notice DB write must not export arbitrary diagnostic text to centralized logs', async () => {
    const { prisma, stripe, settlements, purchase } = setup();
    await settlements.settleCharge({ purchase, charge_id: 'ch_audit' });
    const canary = 'AUDIT_MESSAGE_BODY_contact_at_example_invalid';
    prisma.payoutAdjustmentNotice.create.mockRejectedValueOnce(new Error(canary));
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    stripe.charges.set('ch_audit',
      makeCharge({ id: 'ch_audit', amount: 4_900, fee: 172, amount_refunded: 2_000 }));
    await settlements.applyAdjustments({ purchase, charge_id: 'ch_audit', refunded_cents: 2_000 });
    expect(stripe.netTo('acct_audit')).toBe(2_630);
    expect([...errors.mock.calls, ...warns.mock.calls].map((c) => String(c[0])).join('\n'))
      .not.toContain(canary);
  });
});
