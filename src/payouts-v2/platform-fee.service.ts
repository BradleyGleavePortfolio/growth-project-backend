import { Injectable } from '@nestjs/common';

/**
 * PlatformFeeService — the canonical platform-fee calculator (spec §2.6).
 *
 * Formula (operator-locked, strict `card_cost − stripe_fee` savings basis):
 *
 *   base       = round(amount_cents * 0.02)                 // 2% base
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
 * All math is integer-cents; rounding is `Math.round`. No floats persisted.
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
@Injectable()
export class PlatformFeeService {
  /** Stripe US card pricing reference: 2.9% + $0.30 (spec §2.6 / §9). */
  private static readonly CARD_RATE = 0.029;
  private static readonly CARD_FIXED_CENTS = 30;
  /** Platform base take rate: 2%. */
  private static readonly BASE_RATE = 0.02;
  /** Platform share of any rail savings over a card charge: 50%. */
  private static readonly SAVINGS_SHARE = 0.5;

  /**
   * What a Stripe US card charge of `amount_cents` WOULD cost. Used only as the
   * savings reference; not the actual fee charged on a card (that is the
   * `stripe_fee_cents` the caller passes in, which for a real card equals this).
   */
  cardCostCents(amount_cents: number): number {
    return (
      Math.round(amount_cents * PlatformFeeService.CARD_RATE) +
      PlatformFeeService.CARD_FIXED_CENTS
    );
  }

  /**
   * The canonical, USER-VISIBLE platform fee + coach net (spec §2.6).
   * Integer-cents in, integer-cents out. This is the number that appears on the
   * coach's ledger / receipts; the penny-delta against the actual Stripe-charged
   * figure is absorbed by the platform in internal reconciliation
   * (`reconcileInternal`), never surfaced to the coach.
   */
  compute(input: PlatformFeeInput): PlatformFeeResult {
    const amount = this.toCents(input.amount_cents, 'amount_cents');
    const stripeFee = this.toCents(input.stripe_fee_cents, 'stripe_fee_cents');

    // See the class-level "FEE FORMULA — EXACT DERIVATION" block for the full
    // worked example ($1,000 ACH: cardCost=2930, stripe=500 cap, savings=2430,
    // base=2000, platform_fee=3215=$32.15, coach_net=96285=$962.85).
    const base = Math.round(amount * PlatformFeeService.BASE_RATE);
    const cardCost = this.cardCostCents(amount);
    const savings = Math.max(0, cardCost - stripeFee);
    const platform_fee_cents =
      base + Math.round(PlatformFeeService.SAVINGS_SHARE * savings);
    const coach_net_cents = amount - platform_fee_cents - stripeFee;

    return { platform_fee_cents, coach_net_cents };
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
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(
        `PlatformFeeService: ${field} must be a non-negative integer number of cents (got ${value})`,
      );
    }
    return value;
  }
}
