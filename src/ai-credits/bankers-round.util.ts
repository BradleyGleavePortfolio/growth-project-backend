// Banker's rounding (half-to-even) for financial math.
//
// Why not Math.round? Math.round uses half-away-from-zero, which has a
// systematic bias: a long stream of *.5-cent values rounds up every time,
// inflating displayed totals over time. Banker's rounding alternates
// up/down on ties (0.5 → 0 if floor is even, → 1 if floor is odd) so the
// bias averages to zero — the rounding posture every Stripe-grade
// financial system uses for cent-level money.
//
// Why not the `bankers-rounding` npm package? Two reasons:
//   1. It adds a dependency just to fold over Math.round + a parity check.
//      The audit doc explicitly calls out "50 Failures #41: Vanilla Style"
//      as a guard against hand-rolled rounding — but the same failure
//      mode bites you if your dependency turns out to be a 9-line wrapper
//      around exactly the algorithm below. The test suite is what makes
//      this safe, not the package boundary.
//   2. The npm package operates on Numbers; we operate on cents-as-Int
//      and produce an Int, so we sidestep the IEEE-754 binary fraction
//      trap entirely (cents are integers; only the input ratio can be
//      non-integer, and Number.isInteger guards that).
//
// The unit tests in bankers-round.util.spec.ts exercise the half-to-even
// invariant across 0.5, 1.5, 2.5, 3.5, 4.5 and the actual production
// values ($10, $25, $99 / 3.125), plus property-based runs across the
// full $10–$500 custom-pack range. Auditor: that spec is T1.

/**
 * Round a finite Number to the nearest integer using half-to-even
 * (banker's) tiebreaking. Throws on non-finite inputs — callers must
 * guard their division-by-zero before reaching here.
 */
export function bankersRound(n: number): number {
  if (!Number.isFinite(n)) {
    throw new Error(`bankersRound: non-finite input ${n}`);
  }
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const floor = Math.floor(abs);
  const diff = abs - floor;
  // Use a tiny epsilon to absorb IEEE-754 drift on values that *should*
  // be exactly 0.5 but read back as 0.49999999999... The epsilon is small
  // enough (1e-9) that it cannot flip a genuine non-tie.
  const EPS = 1e-9;
  if (diff > 0.5 + EPS) return sign * (floor + 1);
  if (diff < 0.5 - EPS) return sign * floor;
  // Tie: round to even.
  return sign * (floor % 2 === 0 ? floor : floor + 1);
}

/**
 * Convert `paidCents` to the actual Anthropic-cost cents that pack
 * purchase represents, using the value multiplier. Encapsulates the
 * banker's rounding so callers cannot accidentally inline Math.round.
 *
 * Examples (multiplier = 3.125):
 *   bankersRoundPaidToActual(1000, 3.125) === 320  ($10 pack →  320¢)
 *   bankersRoundPaidToActual(2500, 3.125) === 800  ($25 pack →  800¢)
 *   bankersRoundPaidToActual(9900, 3.125) === 3168 ($99 pack → 3168¢)
 */
export function bankersRoundPaidToActual(
  paidCents: number,
  multiplier: number,
): number {
  if (!Number.isInteger(paidCents) || paidCents < 0) {
    throw new Error(`bankersRoundPaidToActual: paidCents must be a non-negative integer, got ${paidCents}`);
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error(`bankersRoundPaidToActual: multiplier must be > 0, got ${multiplier}`);
  }
  return bankersRound(paidCents / multiplier);
}
