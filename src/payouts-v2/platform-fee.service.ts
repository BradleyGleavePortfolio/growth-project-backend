import { Injectable } from '@nestjs/common';

/**
 * PlatformFeeService — the canonical platform-fee calculator (spec §2.6).
 *
 * Formula (operator-locked, strict `card_cost − stripe_fee` savings basis):
 *
 *   base       = floor(amount_cents * 0.02)                 // 2% base (S-FEE: floored)
 *   card_cost  = round(amount_cents * 0.029) + 30           // Stripe US card: 2.9% + $0.30
 *   savings    = max(0, card_cost - stripe_fee_cents)       // only when the actual rail is cheaper
 *   platform_fee_cents = base + round(0.5 * savings)        // 2% + 50% of the savings
 *   coach_net_cents    = amount_cents - platform_fee_cents - stripe_fee_cents
 *
 * The savings term is only positive when the ACTUAL rail (`stripe_fee_cents`)
 * costs less than a card charge would have — i.e. only for the future
 * ACH-from-client path (Stripe ACH 0.8% capped at $5.00). For card payments the
 * actual Stripe fee equals card_cost so `savings = 0` and the fee is exactly 2%.
 *
 * All math is integer-cents (base floored, savings share rounded). No floats persisted.
 * This service is the single source for fee math across checkout, payout-ops
 * earnings summaries, and coach-facing receipts.
 *
 * WORKED EXAMPLES (spec §2.7) — reproduced exactly by `compute`:
 *
 *   $50  card  : amount=5000,   stripe=175  -> savings=0    -> { platform_fee:100,  coach_net:4725 }
 *   $200 card  : amount=20000,  stripe=610  -> savings=0    -> { platform_fee:400,  coach_net:18990 }
 *   $200 ACH   : amount=20000,  stripe=160  -> savings=450  -> { platform_fee:625,  coach_net:19215 }
 *   $1000 card : amount=100000, stripe=2930 -> savings=0    -> { platform_fee:2000, coach_net:95070 }
 *   $1000 ACH  : amount=100000, stripe=500  -> savings=2430 -> { platform_fee:3215, coach_net:96285 }
 *
 * NOTE ON THE $1,000 ACH ROW (spec §2.7).
 * ----------------------------------------
 * The spec appendix table shows an operator-STATED figure of $32.65 / $962.35
 * built on a $25.30 savings basis ($1.00 of headroom above the strict
 * derivation). The strict, mechanically-correct derivation —
 * `card_cost − stripe_fee = $29.30 − $5.00 = $24.30` — yields a $32.15 fee and
 * a $962.85 coach net. This service implements the STRICT derivation (the
 * operator-locked corrected formula `2% + 50% × (card_cost − stripe_actual_cost)`):
 * it is internally consistent with every other row, with the §2.6 formula
 * comment, and with the $200 ACH row. The $1.00 headroom variant is flagged to
 * the operator for a future audit (spec §2.7 note) rather than special-cased
 * here — a fee calculator with a single magic-cased row is a correctness hazard.
 */
export interface PlatformFeeInput {
  amount_cents: number;
  stripe_fee_cents: number;
}

export interface PlatformFeeResult {
  platform_fee_cents: number;
  coach_net_cents: number;
}

/**
 * FEE FORMULA — EXACT DERIVATION (Gate 5 worked-example documentation).
 * =====================================================================
 * The platform fee is computed in integer cents as:
 *
 *   cardCost     = round(0.029 × gross) + 30      // what a US card charge WOULD cost
 *   base         = round(0.02 × gross)            // 2% platform base take
 *   savings      = max(0, cardCost − stripe_actual_cost)
 *   platform_fee = base + round(0.5 × savings)    // 2% + 50% of the rail savings
 *   coach_net    = gross − platform_fee − stripe_actual_cost
 *
 * `stripe_actual_cost` (the `stripe_fee_cents` argument) is the ACTUAL fee the
 * chosen rail charges. For the ACH-from-client path it is Stripe ACH 0.8%
 * CAPPED at $5.00 (500 cents) — so for any gross >= $625 the ACH fee is exactly
 * the $5.00 cap. For a real card it equals `cardCost`, making `savings = 0`.
 *
 * WORKED EXAMPLE — $1,000 ACH (gross = 100000 cents):
 *   cardCost            = round(0.029 × 100000) + 30 = 2900 + 30 = 2930
 *   stripe_actual_cost  = 500            // Stripe ACH 0.8% capped at $5.00
 *   savings             = 2930 − 500     = 2430
 *   base                = round(0.02 × 100000)       = 2000
 *   platform_fee        = 2000 + round(0.5 × 2430) = 2000 + 1215 = 3215  = $32.15
 *   coach_net           = 100000 − 3215 − 500        = 96285             = $962.85
 *
 * This is the STRICT, mechanically-correct derivation and it is exactly what
 * `compute({ amount_cents: 100000, stripe_fee_cents: 500 })` returns; the
 * worked-example test in `test/payouts-v2.spec.ts` asserts `3215 / 96285` and
 * references this derivation.
 *
 * AUDITOR NOTE (R1 brief-drift, do not "fix"): an audit pass computed $36.10
 * using DIFFERENT inputs — `cardCost = $33.00` and `stripe_actual_cost = $0.80`
 * (an uncapped 0.8% on $100, not the $5.00 ACH cap). Those inputs do not match
 * this service: the ACH fee here is the $5.00 CAP (500 cents), not 0.8% of
 * gross, and `cardCost` is `round(0.029 × gross) + 30 = 2930`, not 3300. With
 * the source's inputs the result is $32.15 / $962.85, which is what ships.
 */
// ===========================================================================
// S-FEE — the single source of truth for coach-package charge math.
// ===========================================================================
//
// Owner ruling 2026-09-30 17:53: the client pays the listed price; the coach's
// payout is the price minus the ACTUAL card processing fee minus TGP's 2% (minus
// the head-coach split when the seller is a sub-coach). No client surcharge.
//
// Every checkout path (Checkout Session, in-app Payment Sheet, guest storefront,
// subscriptions and their renewals) settles through `computeChargeSplit` AFTER
// Stripe reports the charge's balance transaction, so `stripe_fee_cents` is the
// real `balance_transaction.fee` (international card, currency conversion and
// any other surcharge Stripe applied are all inside it). Refunds and disputes
// re-derive the targets through `computeAdjustedTargets`. Nothing else in the
// codebase may compute a platform fee, head-coach split or coach net.
//
// Rounding doctrine (unchanged from FeePolicyService): the platform fee and the
// head-coach split are FLOORED to whole cents, so the coach absorbs no rounding
// against them. The coach net is the exact residual, so the four slices always
// sum to the gross. The platform net of every charge equals the platform fee,
// which is >= 0 by construction.

/** Default platform take: 2.00% in basis points. */
export const PLATFORM_FEE_BPS_DEFAULT = 200;

/**
 * Payment rail that funded the charge. `card` covers every card-funded method
 * (cards, wallets, Link). `bank_debit` covers ACH Direct Debit
 * (`us_bank_account`). Both follow the owner ruling of 2026-09-30 strictly:
 * coach net = price - actual Stripe fee - TGP 2%, with no savings term.
 * `unknown` is the legacy payouts-v2 caller (`compute()`, feature-flagged
 * off), which keeps its operator-locked 50% rail-savings share.
 */
export type PaymentRail = 'card' | 'bank_debit' | 'unknown';

export interface ChargeSplitInput {
  /** Gross charge in the settlement currency (balance_transaction.amount). */
  gross_cents: number;
  /** Actual Stripe processing fee (balance_transaction.fee). */
  stripe_fee_cents: number;
  /** Platform take in bps. Defaults to 200 (2.00%). */
  platform_bps?: number;
  /** Head-coach split in bps; 0 for a solo coach. */
  head_coach_bps?: number;
  rail?: PaymentRail;
}

export interface ChargeSplit {
  gross_cents: number;
  stripe_fee_cents: number;
  platform_fee_cents: number;
  head_coach_split_cents: number;
  /** May be negative only when fees exceed the gross (coach owes the rest). */
  coach_net_cents: number;
  /** What TGP keeps after Stripe's fee and every transfer. Always >= 0. */
  platform_net_cents: number;
  /** Rail savings vs a US card charge (legacy payouts-v2 caller only); 0 for live checkout. */
  savings_cents: number;
}

export interface ChargeAdjustments {
  /** Cumulative refunded amount on the charge (charge.amount_refunded). */
  refunded_cents: number;
  /** Disputed principal currently withdrawn from the platform (net of reinstatement). */
  dispute_withdrawn_cents: number;
  /** Dispute fees Stripe kept (net of any fee Stripe returned). */
  dispute_fee_cents: number;
}

export interface AdjustedTargets {
  remaining_gross_cents: number;
  platform_fee_cents: number;
  head_coach_split_cents: number;
  /** Negative when the coach owes TGP (e.g. the non-returned fee on a full refund). */
  coach_net_cents: number;
  platform_net_cents: number;
}

const CARD_REFERENCE_RATE = 0.029;
const CARD_REFERENCE_FIXED_CENTS = 30;
const RAIL_SAVINGS_SHARE = 0.5;

function assertCents(value: number, field: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `PlatformFeeService: ${field} must be a non-negative integer number of cents (got ${value})`,
    );
  }
  return value;
}

function assertBps(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(
      `PlatformFeeService: ${field} must be an integer between 0 and 10000 bps (got ${value})`,
    );
  }
  return value;
}

/** What a Stripe US card charge of `amountCents` would cost (savings reference only). */
export function cardReferenceFeeCents(amountCents: number): number {
  return Math.round(amountCents * CARD_REFERENCE_RATE) + CARD_REFERENCE_FIXED_CENTS;
}

/** The platform's base slice of a gross amount at `bps`, floored to whole cents. */
export function platformBaseFeeCents(grossCents: number, bps: number): number {
  return Math.floor((grossCents * bps) / 10_000);
}

/** The head-coach slice of a gross amount at `bps`, floored to whole cents. */
export function headCoachSplitCents(grossCents: number, bps: number): number {
  return Math.floor((grossCents * bps) / 10_000);
}

/**
 * Split one settled charge. Pure, integer-cents, deterministic.
 *
 *   platform_fee = floor(gross * platform_bps / 10000) + round(0.5 * savings)
 *   head_coach   = floor(gross * head_coach_bps / 10000)
 *   coach_net    = gross - stripe_fee - platform_fee - head_coach
 *   platform_net = gross - stripe_fee - coach_net - head_coach  (== platform_fee)
 *
 * `savings` is 0 for every live checkout rail (card and bank debit: the coach
 * pays the full actual Stripe fee and TGP takes exactly its bps, per the owner
 * ruling) and max(0, card_reference - stripe_fee) only for the legacy
 * payouts-v2 caller (rail `unknown`).
 */
export function computeChargeSplit(input: ChargeSplitInput): ChargeSplit {
  const gross = assertCents(input.gross_cents, 'gross_cents');
  const stripeFee = assertCents(input.stripe_fee_cents, 'stripe_fee_cents');
  const platformBps = assertBps(input.platform_bps ?? PLATFORM_FEE_BPS_DEFAULT, 'platform_bps');
  const headCoachBps = assertBps(input.head_coach_bps ?? 0, 'head_coach_bps');
  const rail: PaymentRail = input.rail ?? 'unknown';
  const savings = rail === 'unknown' ? Math.max(0, cardReferenceFeeCents(gross) - stripeFee) : 0;
  const platformFee =
    platformBaseFeeCents(gross, platformBps) + Math.round(RAIL_SAVINGS_SHARE * savings);
  const headCoach = headCoachSplitCents(gross, headCoachBps);
  const coachNet = gross - stripeFee - platformFee - headCoach;
  const platformNet = gross - stripeFee - coachNet - headCoach;
  return {
    gross_cents: gross,
    stripe_fee_cents: stripeFee,
    platform_fee_cents: platformFee,
    head_coach_split_cents: headCoach,
    coach_net_cents: coachNet,
    platform_net_cents: platformNet,
    savings_cents: savings,
  };
}

/**
 * Re-derive every party's target position for a charge after refunds and
 * disputes. Pure.
 *
 *   remaining     = gross - refunded - dispute_withdrawn
 *   platform_fee' = platform_fee                    (owner decision OR-111-1:
 *                   TGP keeps its 2% of the sale on every refund and dispute)
 *   head_coach'   = floor(head_coach * max(0, remaining) / gross)
 *   coach_net'    = remaining - stripe_fee - dispute_fee - platform_fee' - head_coach'
 *
 * Stripe does not return the original processing fee on a refund and keeps the
 * dispute fee, so both stay on the coach's side together with TGP's 2%: the
 * coach bears the refunded principal, every Stripe fee on the charge and TGP's
 * fee; TGP never pays any of them. The platform's net position is therefore
 * exactly platform_fee' = platform_fee >= 0 once recovery completes. A
 * negative coach_net' is what the coach owes on the charge: it is held from
 * the coach's next sale(s) by forward netting (never from a past sale).
 */
export function computeAdjustedTargets(
  split: ChargeSplit,
  adj: ChargeAdjustments,
): AdjustedTargets {
  const refunded = assertCents(adj.refunded_cents, 'refunded_cents');
  const withdrawn = assertCents(adj.dispute_withdrawn_cents, 'dispute_withdrawn_cents');
  const disputeFee = assertCents(adj.dispute_fee_cents, 'dispute_fee_cents');
  const gross = split.gross_cents;
  const remaining = gross - refunded - withdrawn;
  const kept = Math.max(0, Math.min(gross, remaining));
  const platformFee = split.platform_fee_cents;
  const headCoach = gross === 0 ? 0 : Math.floor((split.head_coach_split_cents * kept) / gross);
  const coachNet = remaining - split.stripe_fee_cents - disputeFee - platformFee - headCoach;
  const platformCash = gross - split.stripe_fee_cents - refunded - withdrawn - disputeFee;
  return {
    remaining_gross_cents: remaining,
    platform_fee_cents: platformFee,
    head_coach_split_cents: headCoach,
    coach_net_cents: coachNet,
    platform_net_cents: platformCash - coachNet - headCoach,
  };
}

/** Map a Stripe charge's `payment_method_details.type` onto a fee rail. */
export function railForPaymentMethodType(type: string | null | undefined): PaymentRail {
  if (type === 'us_bank_account' || type === 'ach_debit' || type === 'acss_debit') {
    return 'bank_debit';
  }
  return 'card';
}

@Injectable()
export class PlatformFeeService {
  // Rates live in the module-level single-source functions above
  // (card reference 2.9% + 30c, 2% base, 50% rail-savings share).

  /**
   * What a Stripe US card charge of `amount_cents` WOULD cost. Used only as the
   * savings reference; not the actual fee charged on a card (that is the
   * `stripe_fee_cents` the caller passes in, which for a real card equals this).
   */
  cardCostCents(amount_cents: number): number {
    return cardReferenceFeeCents(amount_cents);
  }

  /**
   * The canonical, USER-VISIBLE platform fee + coach net (spec §2.6).
   * Integer-cents in, integer-cents out. This is the number that appears on the
   * coach's ledger / receipts; the penny-delta against the actual Stripe-charged
   * figure is absorbed by the platform in internal reconciliation
   * (`reconcileInternal`), never surfaced to the coach.
   */
  compute(input: PlatformFeeInput): PlatformFeeResult {
    // S-FEE: delegates to the single fee function. `rail: 'unknown'` keeps the
    // payouts-v2 behaviour (savings term whenever the fee is below the card
    // reference). See the class-level derivation for the $1,000 ACH example.
    const split = computeChargeSplit({
      gross_cents: this.toCents(input.amount_cents, 'amount_cents'),
      stripe_fee_cents: this.toCents(input.stripe_fee_cents, 'stripe_fee_cents'),
      platform_bps: PLATFORM_FEE_BPS_DEFAULT,
      head_coach_bps: 0,
      rail: 'unknown',
    });
    return {
      platform_fee_cents: split.platform_fee_cents,
      coach_net_cents: split.coach_net_cents,
    };
  }

  /** Split a settled coach-package charge (see `computeChargeSplit`). */
  split(input: ChargeSplitInput): ChargeSplit {
    return computeChargeSplit(input);
  }

  /** Re-derive targets after refunds / disputes (see `computeAdjustedTargets`). */
  adjust(split: ChargeSplit, adj: ChargeAdjustments): AdjustedTargets {
    return computeAdjustedTargets(split, adj);
  }

  /**
   * Penny-absorb abstraction (operator-locked decision: PLATFORM ABSORBS the
   * delta). The coach's ledger shows the clean computed figure from `compute`;
   * internal reconciliation reports use the ACTUAL Stripe-charged figure. When
   * the actual Stripe charge differs from the computed value by a penny (e.g.
   * computed platform fee $32.15 vs an actual Stripe charge of $32.16), the
   * platform eats the delta — there is no "Adjustment: $0.01" line item on the
   * coach UI.
   *
   * Returns BOTH numbers so the reconciliation layer can record the actual
   * charge while the coach-facing surface keeps reading `coach_visible_fee_cents`.
   * `platform_absorbed_delta_cents` is `actual − computed` (positive = platform
   * paid more than the coach was shown; negative = platform retained more). It
   * is for internal reconciliation only and MUST NOT be rendered on the coach UI.
   */
  reconcileInternal(input: {
    amount_cents: number;
    stripe_fee_cents: number;
    actual_stripe_fee_cents: number;
  }): {
    coach_visible_fee_cents: number;
    coach_visible_net_cents: number;
    internal_actual_fee_cents: number;
    platform_absorbed_delta_cents: number;
  } {
    const visible = this.compute({
      amount_cents: input.amount_cents,
      stripe_fee_cents: input.stripe_fee_cents,
    });
    // The internal reconciliation fee recomputes against the ACTUAL fee Stripe
    // charged. The coach never sees this number; the platform absorbs any
    // difference vs. the clean coach-visible figure.
    const internal = this.compute({
      amount_cents: input.amount_cents,
      stripe_fee_cents: this.toCents(
        input.actual_stripe_fee_cents,
        'actual_stripe_fee_cents',
      ),
    });
    return {
      coach_visible_fee_cents: visible.platform_fee_cents,
      coach_visible_net_cents: visible.coach_net_cents,
      internal_actual_fee_cents: internal.platform_fee_cents,
      platform_absorbed_delta_cents:
        internal.platform_fee_cents - visible.platform_fee_cents,
    };
  }

  private toCents(value: number, field: string): number {
    return assertCents(value, field);
  }
}
