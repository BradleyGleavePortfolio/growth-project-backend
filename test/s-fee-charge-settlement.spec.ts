// S-FEE — coach payout fee math, end to end against in-memory fakes.
//
// Mechanism under test: separate charges and transfers with on_behalf_of.
// The platform charges the client the listed price, reads Stripe's ACTUAL
// fee from the charge's balance transaction, and transfers
//   coach_net = gross - stripe_fee - TGP 2% (- head-coach split)
// with source_transaction = the charge. TGP keeps exactly its fee, so the
// platform net of every charge is >= 0, including after refunds and disputes
// (what a transfer reversal cannot recover becomes a PayeeRecovery netted
// from the coach's next payout).
//
// No live Stripe calls: FakeStripe returns objects shaped like real Stripe
// Charge / BalanceTransaction / Transfer / TransferReversal objects.
import type {
  ChargeSettlement,
  ClientPurchase,
  ConnectTransfer,
  PayeeRecovery,
  SplitLedgerEntry,
} from '@prisma/client';
import { ChargeSettlementService } from '../src/connect/fees/charge-settlement.service';
import { coachNetCents } from '../src/connect/fees/coach-net';
import { FeePolicyService } from '../src/connect/fees/fee-policy.service';
import { settlementIdentityDrift } from '../src/connect/fees/reconciliation.service';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../src/connect/fees/transfer-orchestrator.service';
import { computeAdjustedTargets, computeChargeSplit } from '../src/payouts-v2/platform-fee.service';
import {
  FakeStripe,
  asPrisma,
  intlCardFeeCents,
  makeCharge,
  makeSettlementPrisma,
  usCardFeeCents,
  type Row,
} from './utils/settlement-fakes';

const COACH = 'coach-1';
const HEAD = 'head-1';

function purchaseRow(overrides: Partial<ClientPurchase> = {}): ClientPurchase {
  const base: Row = {
    id: 'cp-1',
    coach_user_id: COACH,
    client_user_id: 'client-1',
    package_id: 'pkg-1',
    amount_cents: 4_900,
    currency: 'usd',
    billing_type: 'recurring',
    status: 'active',
    source: null,
    stripe_payment_intent_id: null,
    stripe_subscription_id: 'sub_1',
    created_at: new Date('2026-10-01T12:00:00Z'),
    ...overrides,
  };
  return base as ClientPurchase;
}

function setup(opts: { headCoach?: boolean; headCoachAccount?: boolean } = {}) {
  const { prisma, db } = makeSettlementPrisma();
  const stripe = new FakeStripe();
  const feePolicy = new FeePolicyService(asPrisma(prisma));
  const ledger = new SplitLedgerService(asPrisma(prisma));
  const transfers = new TransferOrchestratorService(asPrisma(prisma), stripe, ledger);
  const svc = new ChargeSettlementService(asPrisma(prisma), stripe, feePolicy, ledger, transfers);
  db.accounts.push({ coach_user_id: COACH, stripe_account_id: 'acct_coach' });
  if (opts.headCoach) {
    db.assignments.push({
      sub_coach_id: COACH,
      head_coach_id: HEAD,
      archived_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    });
    if (opts.headCoachAccount !== false) {
      db.accounts.push({ coach_user_id: HEAD, stripe_account_id: 'acct_head' });
    }
  }
  const purchase = purchaseRow();
  db.purchases.push(purchase as Row);

  const settlementFor = (chargeId: string) =>
    db.settlements.find((s) => s.stripe_charge_id === chargeId)!;
  // Reconciliation identity for one charge (drift must be 0).
  const identity = (chargeId: string) => {
    const s = settlementFor(chargeId);
    const charge = stripe.charges.get(chargeId)!;
    const bt = charge.balance_transaction as { amount: number; fee: number };
    return settlementIdentityDrift({
      settlement: s as ChargeSettlement,
      ledger: db.ledger as SplitLedgerEntry[],
      transfers: db.transfers.filter((t) => t.settlement_id === s.id) as ConnectTransfer[],
      recoveries: db.recoveries.filter((r) => r.settlement_id === s.id) as PayeeRecovery[],
      stripe: {
        gross_cents: bt.amount,
        fee_cents: bt.fee,
        refunded_cents: charge.amount_refunded ?? 0,
      },
    });
  };
  return { prisma, db, stripe, svc, purchase, settlementFor, identity };
}

describe('S-FEE worked examples (computeChargeSplit, the single fee function)', () => {
  // gross, Stripe's actual fee, platform 2% (floored), coach net.
  const cases: Array<[string, number, number, number, number]> = [
    ['$19.99 US card', 1_999, usCardFeeCents(1_999), 39, 1_872],
    ['$49.00 US card (owner offer)', 4_900, usCardFeeCents(4_900), 98, 4_630],
    ['$50.00 US card', 5_000, usCardFeeCents(5_000), 100, 4_725],
    ['$200.00 US card', 20_000, usCardFeeCents(20_000), 400, 18_990],
    ['$1000.00 US card', 100_000, usCardFeeCents(100_000), 2_000, 95_070],
    ['$200.00 international card', 20_000, intlCardFeeCents(20_000), 400, 18_690],
  ];
  it.each(cases)('%s', (_label, gross, fee, platform, coach) => {
    const split = computeChargeSplit({
      gross_cents: gross,
      stripe_fee_cents: fee,
      platform_bps: 200,
      rail: 'card',
    });
    expect(split.platform_fee_cents).toBe(platform);
    expect(split.coach_net_cents).toBe(coach);
    expect(split.platform_net_cents).toBe(platform);
    expect(split.stripe_fee_cents + split.platform_fee_cents + split.coach_net_cents).toBe(gross);
  });

  it('Stripe fee values used by the table', () => {
    expect(usCardFeeCents(1_999)).toBe(88);
    expect(usCardFeeCents(4_900)).toBe(172);
    expect(intlCardFeeCents(20_000)).toBe(910);
  });

  it('head-coach split: $100 sub-coach sale', () => {
    const split = computeChargeSplit({
      gross_cents: 10_000,
      stripe_fee_cents: usCardFeeCents(10_000),
      platform_bps: 200,
      head_coach_bps: 500,
      rail: 'card',
    });
    expect(split).toMatchObject({
      stripe_fee_cents: 320,
      platform_fee_cents: 200,
      head_coach_split_cents: 500,
      coach_net_cents: 8_980,
      platform_net_cents: 200,
    });
  });

  it('ACH follows the owner ruling strictly: actual fee + 2%, no savings share', () => {
    const split = computeChargeSplit({
      gross_cents: 20_000,
      stripe_fee_cents: 160,
      platform_bps: 200,
      rail: 'bank_debit',
    });
    expect(split.platform_fee_cents).toBe(400);
    expect(split.coach_net_cents).toBe(19_440);
  });
});

describe('S-FEE invariant: platform net >= 0 for every charge', () => {
  // Deterministic pseudo-random sweep (LCG) so failures reproduce.
  let seed = 20261001;
  const rnd = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  it('holds for 5000 charges across fees, splits, refunds and disputes', () => {
    for (let i = 0; i < 5_000; i += 1) {
      const gross = 50 + rnd(2_000_000);
      const fee = rnd(4) === 0 ? rnd(gross + 1) : Math.min(gross, Math.round(gross * 0.044) + 30);
      const headBps = rnd(3) === 0 ? 500 : 0;
      const split = computeChargeSplit({
        gross_cents: gross,
        stripe_fee_cents: fee,
        platform_bps: 200,
        head_coach_bps: headBps,
        rail: 'card',
      });
      expect(split.platform_net_cents).toBeGreaterThanOrEqual(0);
      expect(split.platform_fee_cents).toBeLessThanOrEqual(Math.floor(gross * 0.02));
      expect(
        split.stripe_fee_cents +
          split.platform_fee_cents +
          split.head_coach_split_cents +
          split.coach_net_cents,
      ).toBe(gross);

      const refunded = rnd(3) === 0 ? rnd(gross + 1) : 0;
      const withdrawn = rnd(4) === 0 ? gross - refunded : 0;
      const disputeFee = withdrawn > 0 ? 1_500 : rnd(10) === 0 ? 1_500 : 0;
      const t = computeAdjustedTargets(split, {
        refunded_cents: refunded,
        dispute_withdrawn_cents: withdrawn,
        dispute_fee_cents: disputeFee,
      });
      expect(t.platform_net_cents).toBe(t.platform_fee_cents);
      expect(t.platform_net_cents).toBeGreaterThanOrEqual(0);
      expect(t.head_coach_split_cents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('ChargeSettlementService', () => {
  it('$49/month: first charge and renewal each transfer $46.30 from their own charge', async () => {
    const { svc, stripe, db, purchase, identity } = setup();
    stripe.charges.set('ch_first', makeCharge({ id: 'ch_first', amount: 4_900, fee: 172 }));
    stripe.charges.set('ch_renew', makeCharge({ id: 'ch_renew', amount: 4_900, fee: 172 }));

    const first = await svc.settleCharge({ purchase, charge_id: 'ch_first', invoice_id: 'in_1' });
    const renewal = await svc.settleCharge({ purchase, charge_id: 'ch_renew', invoice_id: 'in_2' });
    expect(first.status).toBe('settled');
    expect(renewal.status).toBe('settled');

    expect(stripe.createTransfer).toHaveBeenCalledTimes(2);
    const calls = stripe.createTransfer.mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({
      amount: 4_630,
      destination: 'acct_coach',
      source_transaction: 'ch_first',
      idempotencyKey: 'tgp-settle-ch_first-coach',
    });
    expect(calls[1]).toMatchObject({
      amount: 4_630,
      destination: 'acct_coach',
      source_transaction: 'ch_renew',
      idempotencyKey: 'tgp-settle-ch_renew-coach',
    });

    for (const ch of ['ch_first', 'ch_renew']) {
      const s = db.settlements.find((x) => x.stripe_charge_id === ch)!;
      expect(s).toMatchObject({
        status: 'settled',
        gross_cents: 4_900,
        stripe_fee_cents: 172,
        platform_fee_cents: 98,
        head_coach_split_cents: 0,
        coach_net_cents: 4_630,
      });
      const slices = db.ledger.filter((e) => e.stripe_charge_id === ch);
      expect(slices.map((e) => [e.kind, e.amount_cents]).sort()).toEqual([
        ['application_fee', 98],
        ['destination', 4_630],
        ['stripe_fee', 172],
      ]);
      expect(identity(ch)).toEqual({ drift_cents: 0, platform_net_cents: 98, notes: [] });
    }
    expect(stripe.netTo('acct_coach')).toBe(9_260);
  });

  it('is idempotent: webhook re-delivery and the sweeper never double pay', async () => {
    const { svc, stripe, db, purchase } = setup();
    stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
    await svc.settleCharge({ purchase, charge_id: 'ch_1' });
    const again = await svc.settleCharge({ purchase, charge_id: 'ch_1' });
    await svc.settleCharge({ purchase, charge_id: 'ch_1' });
    expect(again.status).toBe('already_settled');
    expect(db.settlements).toHaveLength(1);
    expect(db.transfers).toHaveLength(1);
    expect(db.ledger).toHaveLength(3);
    expect(stripe.netTo('acct_coach')).toBe(4_630);
  });

  it('international card: the coach bears the actual (higher) Stripe fee', async () => {
    const { svc, stripe, purchase, identity } = setup();
    stripe.charges.set('ch_intl', makeCharge({ id: 'ch_intl', amount: 20_000, fee: 910 }));
    await svc.settleCharge({
      purchase: { ...purchase, amount_cents: 20_000 },
      charge_id: 'ch_intl',
    });
    expect(stripe.netTo('acct_coach')).toBe(18_690);
    expect(identity('ch_intl').platform_net_cents).toBe(400);
  });

  it('free $0 packages and invite-code grants never settle, transfer or post revenue', async () => {
    const { svc, stripe, db } = setup();
    const grant = purchaseRow({
      id: 'cp-free',
      amount_cents: 0,
      source: 'invite_code',
    } as Partial<ClientPurchase>);
    const outcome = await svc.settleCharge({ purchase: grant, charge_id: 'ch_none' });
    const all = await svc.settlePurchase(grant);
    const adj = await svc.applyAdjustments({
      purchase: grant,
      charge_id: 'ch_none',
      refunded_cents: 0,
    });
    expect(outcome.status).toBe('skipped_free');
    expect(all.map((o) => o.status)).toEqual(['skipped_free']);
    expect(adj).toBe('skipped_free');
    expect(stripe.retrieveCharge).not.toHaveBeenCalled();
    expect(stripe.createTransfer).not.toHaveBeenCalled();
    expect(db.settlements).toHaveLength(0);
    expect(db.ledger).toHaveLength(0);
    expect(db.recoveries).toHaveLength(0);
  });

  it('a $0 charge (100% coupon) on a paid package is skipped', async () => {
    const { svc, stripe, db, purchase } = setup();
    stripe.charges.set('ch_zero', makeCharge({ id: 'ch_zero', amount: 0, fee: 0 }));
    const outcome = await svc.settleCharge({ purchase, charge_id: 'ch_zero' });
    expect(outcome.status).toBe('skipped_free');
    expect(db.settlements).toHaveLength(0);
    expect(stripe.createTransfer).not.toHaveBeenCalled();
  });

  it('waits (no guess) until Stripe reports the fee, then settles from the sweeper', async () => {
    const { svc, stripe, db, purchase } = setup();
    const charge = makeCharge({ id: 'ch_wait', amount: 4_900, fee: 172 });
    stripe.charges.set('ch_wait', { ...charge, balance_transaction: 'txn_ch_wait' });
    const waiting = await svc.settleCharge({ purchase, charge_id: 'ch_wait' });
    expect(waiting.status).toBe('awaiting_fee');
    expect(waiting.reason).toMatch(/balance transaction/);
    expect(stripe.createTransfer).not.toHaveBeenCalled();

    stripe.charges.set('ch_wait', charge);
    db.settlements[0].updated_at = new Date(Date.now() - 120_000);
    const swept = await svc.runSettlementSweep(new Date());
    expect(swept.settled).toBe(1);
    expect(stripe.netTo('acct_coach')).toBe(4_630);
  });

  it('legacy destination charges (pre-S-FEE renewals) are recorded, never transferred again', async () => {
    const { svc, stripe, db, purchase } = setup();
    stripe.charges.set(
      'ch_old',
      makeCharge({ id: 'ch_old', amount: 4_900, fee: 172, legacy_application_fee_amount: 98 }),
    );
    const outcome = await svc.settleCharge({ purchase, charge_id: 'ch_old' });
    expect(outcome.status).toBe('legacy_destination');
    expect(db.settlements[0]).toMatchObject({
      status: 'legacy_destination',
      mechanism: 'legacy_destination',
      platform_fee_cents: 98,
    });
    expect(stripe.createTransfer).not.toHaveBeenCalled();
    expect(
      await svc.applyAdjustments({ purchase, charge_id: 'ch_old', refunded_cents: 4_900 }),
    ).toBe('legacy');
  });

  it('head-coach split: two transfers from the same charge', async () => {
    const { svc, stripe, purchase, identity } = setup({ headCoach: true });
    stripe.charges.set('ch_team', makeCharge({ id: 'ch_team', amount: 10_000, fee: 320 }));
    await svc.settleCharge({
      purchase: { ...purchase, amount_cents: 10_000 },
      charge_id: 'ch_team',
    });
    expect(stripe.netTo('acct_coach')).toBe(8_980);
    expect(stripe.netTo('acct_head')).toBe(500);
    const keys = stripe.createTransfer.mock.calls.map((c) => c[0].idempotencyKey).sort();
    expect(keys).toEqual(['tgp-settle-ch_team-coach', 'tgp-settle-ch_team-head_coach']);
    expect(identity('ch_team')).toEqual({ drift_cents: 0, platform_net_cents: 200, notes: [] });
  });

  it('head coach without a connected account: the sub-coach keeps the split', async () => {
    const { svc, stripe, db, purchase } = setup({ headCoach: true, headCoachAccount: false });
    stripe.charges.set('ch_team', makeCharge({ id: 'ch_team', amount: 10_000, fee: 320 }));
    await svc.settleCharge({
      purchase: { ...purchase, amount_cents: 10_000 },
      charge_id: 'ch_team',
    });
    expect(stripe.netTo('acct_coach')).toBe(9_480);
    expect(db.settlements[0]).toMatchObject({
      head_coach_split_cents: 0,
      head_coach_user_id: null,
      platform_fee_cents: 200,
    });
  });

  describe('refunds', () => {
    it('full refund: reverse the coach transfer; the coach owes the non-returned fee; TGP nets 0', async () => {
      const { svc, stripe, db, purchase, identity } = setup();
      stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
      await svc.settleCharge({ purchase, charge_id: 'ch_1' });
      stripe.charges.set(
        'ch_1',
        makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }),
      );

      expect(
        await svc.applyAdjustments({ purchase, charge_id: 'ch_1', refunded_cents: 4_900 }),
      ).toBe('adjusted');
      expect(stripe.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 4_630 }),
      );
      expect(db.recoveries).toHaveLength(1);
      expect(db.recoveries[0]).toMatchObject({
        payee_user_id: COACH,
        amount_cents: 172,
        status: 'open',
        reason: 'refund',
      });
      expect(db.settlements[0]).toMatchObject({
        target_platform_fee_cents: 0,
        target_coach_net_cents: -172,
      });
      expect(identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 0, notes: [] });

      // Re-delivered refund webhook: nothing moves twice.
      expect(
        await svc.applyAdjustments({ purchase, charge_id: 'ch_1', refunded_cents: 4_900 }),
      ).toBe('unchanged');
      expect(stripe.reverseTransfer).toHaveBeenCalledTimes(1);
      expect(db.recoveries).toHaveLength(1);

      // The next renewal nets the $1.72 before transferring.
      stripe.charges.set('ch_2', makeCharge({ id: 'ch_2', amount: 4_900, fee: 172 }));
      await svc.settleCharge({ purchase, charge_id: 'ch_2' });
      const renewalTransfer = db.transfers.find((t) => t.source_stripe_charge_id === 'ch_2')!;
      expect(renewalTransfer).toMatchObject({
        amount_cents: 4_458,
        netted_recovery_cents: 172,
        status: 'succeeded',
      });
      expect(db.recoveries[0]).toMatchObject({ status: 'collected', collected_cents: 172 });
      expect(identity('ch_2')).toEqual({ drift_cents: 0, platform_net_cents: 98, notes: [] });
      expect(identity('ch_1').drift_cents).toBe(0);
    });

    it('partial refund of $20 on $49: coach keeps $26.70, TGP keeps $0.58', async () => {
      const { svc, stripe, purchase, identity } = setup();
      stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
      await svc.settleCharge({ purchase, charge_id: 'ch_1' });
      stripe.charges.set(
        'ch_1',
        makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 2_000 }),
      );
      await svc.applyAdjustments({ purchase, charge_id: 'ch_1', refunded_cents: 2_000 });
      expect(stripe.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1_960 }),
      );
      expect(stripe.netTo('acct_coach')).toBe(2_670);
      expect(identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 58, notes: [] });
    });

    it('reversal refused (coach already paid out): the full amount becomes a recovery', async () => {
      const { svc, stripe, db, purchase, identity } = setup();
      stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
      await svc.settleCharge({ purchase, charge_id: 'ch_1' });
      stripe.failReversals = true;
      stripe.charges.set(
        'ch_1',
        makeCharge({ id: 'ch_1', amount: 4_900, fee: 172, amount_refunded: 4_900 }),
      );
      await svc.applyAdjustments({ purchase, charge_id: 'ch_1', refunded_cents: 4_900 });
      expect(db.recoveries[0]).toMatchObject({ amount_cents: 4_802, status: 'open' });
      expect(identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 0, notes: [] });
    });

    it('refund on a head-coach sale reverses both legs', async () => {
      const { svc, stripe, purchase, identity } = setup({ headCoach: true });
      const p = { ...purchase, amount_cents: 10_000 };
      stripe.charges.set('ch_team', makeCharge({ id: 'ch_team', amount: 10_000, fee: 320 }));
      await svc.settleCharge({ purchase: p, charge_id: 'ch_team' });
      stripe.charges.set(
        'ch_team',
        makeCharge({ id: 'ch_team', amount: 10_000, fee: 320, amount_refunded: 10_000 }),
      );
      await svc.applyAdjustments({ purchase: p, charge_id: 'ch_team', refunded_cents: 10_000 });
      expect(stripe.netTo('acct_head')).toBe(0);
      expect(stripe.netTo('acct_coach')).toBe(0);
      expect(identity('ch_team')).toEqual({ drift_cents: 0, platform_net_cents: 0, notes: [] });
    });
  });

  describe('disputes', () => {
    async function disputed(outcome: 'won' | 'lost') {
      const ctx = setup();
      const { svc, stripe, purchase } = ctx;
      stripe.charges.set('ch_1', makeCharge({ id: 'ch_1', amount: 4_900, fee: 172 }));
      await svc.settleCharge({ purchase, charge_id: 'ch_1' });
      // charge.dispute.created: Stripe withdraws the amount + $15 fee.
      await svc.applyAdjustments({
        purchase,
        charge_id: 'ch_1',
        dispute: { withdrawn_cents: 4_900, fee_cents: 1_500 },
      });
      if (outcome === 'won') {
        // charge.dispute.closed (won): funds reinstated; the fee is kept by Stripe.
        await svc.applyAdjustments({
          purchase,
          charge_id: 'ch_1',
          dispute: { withdrawn_cents: 0, fee_cents: 1_500 },
        });
      }
      return ctx;
    }

    it('created / lost: reverse the coach transfer; the coach owes the dispute fee; TGP nets 0', async () => {
      const { stripe, db, identity } = await disputed('lost');
      expect(stripe.reverseTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 4_630 }),
      );
      expect(db.recoveries[0]).toMatchObject({
        amount_cents: 1_672,
        status: 'open',
        reason: 'dispute',
      });
      expect(identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 0, notes: [] });
    });

    it('won: release the recovery and pay the coach back, net of the kept fee', async () => {
      const { stripe, db, identity } = await disputed('won');
      expect(db.recoveries[0]).toMatchObject({ amount_cents: 0, status: 'released' });
      const reinstate = db.transfers.find((t) => t.kind === 'coach_reinstate')!;
      expect(reinstate).toMatchObject({
        amount_cents: 3_130,
        status: 'succeeded',
        source_stripe_charge_id: null,
      });
      expect(stripe.netTo('acct_coach')).toBe(3_130);
      expect(identity('ch_1')).toEqual({ drift_cents: 0, platform_net_cents: 98, notes: [] });
    });
  });

  it('coach net is one definition (earnings summary and connect metrics)', () => {
    // posted ledger (net of reversals) minus recoveries owed.
    expect(coachNetCents(4_630 + 4_630 - 4_630, 172)).toBe(4_458);
  });
});
