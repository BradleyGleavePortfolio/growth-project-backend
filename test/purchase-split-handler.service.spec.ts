import type { ClientPurchase } from '@prisma/client';
import { PurchaseSplitHandlerService } from '../src/checkout/purchase-split-handler.service';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { FakeStripe, asPrisma, makeCharge, makeSettlementPrisma } from './utils/settlement-fakes';

// End-to-end test of the post-charge split flow (S-FEE):
//   onChargeSucceeded -> ChargeSettlement + ledger slices written from
//   Stripe's ACTUAL fee, coach (and head-coach) transfers posted with
//   source_transaction = the charge. Pre-S-FEE destination charges keep the
//   legacy head-coach-only flow.

function makeService() {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const fee = new FeePolicyService(asPrisma(prisma));
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const settlements = new ChargeSettlementService(asPrisma(prisma), stripe, fee, ledger, transfers);
  const svc = new PurchaseSplitHandlerService(
    asPrisma(prisma),
    stripe,
    fee,
    ledger,
    transfers,
    settlements,
  );
  // $100.00 US card charge: Stripe fee 2.9% + 30c = $3.20.
  stripe.charges.set(
    'ch_test',
    makeCharge({ id: 'ch_test', amount: 10_000, fee: 320, payment_intent: 'pi_abc' }),
  );
  return { svc, db, stripe };
}

function purchase(overrides: Record<string, unknown>): ClientPurchase {
  const row: Record<string, unknown> = {
    id: 'p-solo',
    client_user_id: 'cli-1',
    coach_user_id: 'coach-solo',
    package_id: 'pk',
    amount_cents: 10_000,
    currency: 'usd',
    stripe_payment_intent_id: 'pi_abc',
    stripe_subscription_id: null,
    billing_type: 'one_time',
    status: 'paid',
    source: null,
    ...overrides,
  };
  return row as ClientPurchase;
}

const SOLO_PURCHASE = purchase({});
const SUB_PURCHASE = purchase({ id: 'p-sub', client_user_id: 'cli-2', coach_user_id: 'sub-1' });

function withTeam(db: ReturnType<typeof makeService>['db'], headAccount = true) {
  db.accounts.push({ coach_user_id: 'sub-1', stripe_account_id: 'acct_sub' });
  if (headAccount) db.accounts.push({ coach_user_id: 'head-1', stripe_account_id: 'acct_head' });
  db.assignments.push({
    sub_coach_id: 'sub-1',
    head_coach_id: 'head-1',
    archived_at: null,
    created_at: new Date(),
  });
}

describe('PurchaseSplitHandlerService (end-to-end)', () => {
  describe('solo PT', () => {
    it('settles price - actual Stripe fee - 2% to the coach from the charge', async () => {
      const { svc, db, stripe } = makeService();
      db.accounts.push({ coach_user_id: 'coach-solo', stripe_account_id: 'acct_solo' });
      const result = await svc.onChargeSucceeded({ purchase: SOLO_PURCHASE });
      expect(result).toEqual({ charge_id: 'ch_test', ledger_entries: 3, transfer_enqueued: true });
      const slice = (kind: string) => db.ledger.find((e) => e.kind === kind)!;
      expect(slice('application_fee')).toMatchObject({
        amount_cents: 200,
        status: 'posted',
        stripe_charge_id: 'ch_test',
      });
      expect(slice('stripe_fee')).toMatchObject({
        amount_cents: 320,
        status: 'posted',
        stripe_charge_id: 'ch_test',
      });
      expect(slice('destination')).toMatchObject({
        amount_cents: 9_480,
        status: 'posted',
        payee_user_id: 'coach-solo',
      });
      expect(stripe.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 9_480,
          destination: 'acct_solo',
          source_transaction: 'ch_test',
        }),
      );
      expect(db.settlements[0]).toMatchObject({
        gross_cents: 10_000,
        stripe_fee_cents: 320,
        platform_fee_cents: 200,
        head_coach_split_cents: 0,
        coach_net_cents: 9_480,
      });
    });
  });

  describe('sub-coach', () => {
    it('writes four ledger slices and posts coach + head-coach transfers with source_transaction=ch_test', async () => {
      const { svc, db, stripe } = makeService();
      withTeam(db);
      const result = await svc.onChargeSucceeded({ purchase: SUB_PURCHASE });
      expect(result.ledger_entries).toBe(4);
      expect(result.transfer_enqueued).toBe(true);

      const hcs = db.ledger.find((e) => e.kind === 'head_coach_split')!;
      expect(hcs).toMatchObject({ amount_cents: 500, payee_user_id: 'head-1', status: 'posted' });
      expect(hcs.stripe_transfer_id).toMatch(/^tr_/);
      const dest = db.ledger.find((e) => e.kind === 'destination')!;
      expect(dest.amount_cents).toBe(8_980);

      expect(stripe.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 500,
          destination: 'acct_head',
          source_transaction: 'ch_test',
        }),
      );
      expect(stripe.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 8_980,
          destination: 'acct_sub',
          source_transaction: 'ch_test',
        }),
      );
      expect(db.transfers.every((t) => t.status === 'succeeded')).toBe(true);
    });

    it('is idempotent: re-invoking onChargeSucceeded does not double-post', async () => {
      const { svc, db, stripe } = makeService();
      withTeam(db);
      await svc.onChargeSucceeded({ purchase: SUB_PURCHASE });
      await svc.onChargeSucceeded({ purchase: SUB_PURCHASE });
      await svc.onChargeSucceeded({ purchase: SUB_PURCHASE });
      expect(db.transfers).toHaveLength(2);
      expect(db.ledger).toHaveLength(4);
      expect(stripe.createTransfer).toHaveBeenCalledTimes(2);
    });

    it('head coach without a Connect account: the sub-coach keeps the split', async () => {
      const { svc, db, stripe } = makeService();
      withTeam(db, false);
      const result = await svc.onChargeSucceeded({ purchase: SUB_PURCHASE });
      expect(result.ledger_entries).toBe(3);
      expect(stripe.createTransfer).toHaveBeenCalledTimes(1);
      expect(stripe.createTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 9_480, destination: 'acct_sub' }),
      );
    });
  });

  it('seller without a Connect account: nothing moves until payout setup is done', async () => {
    const { svc, db, stripe } = makeService();
    const result = await svc.onChargeSucceeded({ purchase: SOLO_PURCHASE });
    expect(result.ledger_entries).toBe(0);
    expect(result.transfer_enqueued).toBe(false);
    expect(db.ledger).toHaveLength(0);
    expect(db.settlements[0]).toMatchObject({ status: 'awaiting_fee' });
    expect(db.settlements[0].last_error).toMatch(/no connected Stripe account/);
    expect(stripe.createTransfer).not.toHaveBeenCalled();
  });

  it('free packages and $0 invite-code grants never settle', async () => {
    const { svc, db, stripe } = makeService();
    const grant = purchase({ id: 'p-free', amount_cents: 0, source: 'invite_code' });
    const result = await svc.onChargeSucceeded({ purchase: grant });
    const zeroInvoice = await svc.onChargeSucceeded({
      purchase: SOLO_PURCHASE,
      invoice_amount_cents: 0,
    });
    expect(result).toEqual({ charge_id: null, ledger_entries: 0, transfer_enqueued: false });
    expect(zeroInvoice).toEqual({ charge_id: null, ledger_entries: 0, transfer_enqueued: false });
    expect(db.settlements).toHaveLength(0);
    expect(stripe.retrieveCharge).not.toHaveBeenCalled();
  });

  it('pre-S-FEE destination charge: legacy head-coach flow, no coach transfer', async () => {
    const { svc, db, stripe } = makeService();
    withTeam(db);
    stripe.charges.set(
      'ch_test',
      makeCharge({
        id: 'ch_test',
        amount: 10_000,
        fee: 320,
        payment_intent: 'pi_abc',
        legacy_application_fee_amount: 700,
      }),
    );
    const result = await svc.onChargeSucceeded({ purchase: SUB_PURCHASE });
    expect(result.ledger_entries).toBe(3);
    expect(db.settlements[0]).toMatchObject({ status: 'legacy_destination' });
    expect(stripe.createTransfer).toHaveBeenCalledTimes(1);
    expect(stripe.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 500,
        destination: 'acct_head',
        source_transaction: 'ch_test',
      }),
    );
  });
});
