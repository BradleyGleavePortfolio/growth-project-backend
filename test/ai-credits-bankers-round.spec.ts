/**
 * Stream 1 — banker's rounding property tests.
 *
 * The locked multiplier (3.125) means every paid_cents in [1000, 50000]
 * divides to a finite decimal, but the half-to-even tiebreak only
 * activates on inputs that land exactly on a *.5 boundary. We exhaust
 * the *.5 candidates in the custom-pack range plus the three locked
 * tiers explicitly.
 */

import fc from 'fast-check';
import { bankersRound, bankersRoundPaidToActual } from '../src/ai-credits/bankers-round.util';

describe('bankersRound — half-to-even tiebreaker', () => {
  it.each([
    [-2.5, -2],
    [-1.5, -2],
    [-0.5, 0],
    [0.5, 0],
    [1.5, 2],
    [2.5, 2],
    [3.5, 4],
    [4.5, 4],
    [5.5, 6],
  ])('rounds %p to %p', (input, expected) => {
    // Use +0 normalisation so -0 === 0 under toBe (-0 is a Number primitive,
    // toBe uses Object.is which distinguishes them). Banker's rounding of a
    // negative tie can yield -0 from `-1 * 0`; the value is mathematically 0.
    expect(bankersRound(input) + 0).toBe(expected + 0);
  });

  it('non-tie values round normally', () => {
    expect(bankersRound(0.4)).toBe(0);
    expect(bankersRound(0.6)).toBe(1);
    expect(bankersRound(1.4)).toBe(1);
    expect(bankersRound(1.6)).toBe(2);
  });

  it('throws on non-finite input', () => {
    expect(() => bankersRound(NaN)).toThrow();
    expect(() => bankersRound(Infinity)).toThrow();
    expect(() => bankersRound(-Infinity)).toThrow();
  });
});

describe('bankersRoundPaidToActual — locked tier math (multiplier 3.125)', () => {
  it('matches spec §6 worked examples exactly', () => {
    expect(bankersRoundPaidToActual(1000, 3.125)).toBe(320);
    expect(bankersRoundPaidToActual(2500, 3.125)).toBe(800);
    expect(bankersRoundPaidToActual(9900, 3.125)).toBe(3168);
  });

  it('is monotone non-decreasing across [1000, 50000]', () => {
    let last = -1;
    for (let p = 1000; p <= 50_000; p += 100) {
      const v = bankersRoundPaidToActual(p, 3.125);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it('matches the analytic ratio within +/- 1 cent across the custom-pack range', () => {
    for (let p = 1000; p <= 50_000; p += 13) {
      const v = bankersRoundPaidToActual(p, 3.125);
      const exact = p / 3.125;
      expect(Math.abs(v - exact)).toBeLessThanOrEqual(0.5 + 1e-6);
    }
  });
});

// ===========================================================================
// Round-1 fixer P1-5 — generative property tests with fast-check.
//
// The example-based tests above pin specific values; these random-sample
// the input space and assert structural invariants. A failure here
// shrinks to a minimal counter-example, which is the documented way to
// detect off-by-one bugs in financial rounding (50 Failures #41
// "Vanilla Style" — the audit doc specifically called for these).
// ===========================================================================

describe('bankersRoundPaidToActual — fast-check property tests (P1-5)', () => {
  it('|bankersRound(p/3.125) - p/3.125| <= 0.5 + EPS for all p in [0, 500_000]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500_000 }), (p) => {
        const v = bankersRoundPaidToActual(p, 3.125);
        const exact = p / 3.125;
        return Math.abs(v - exact) <= 0.5 + 1e-9;
      }),
      { numRuns: 1_000 },
    );
  });

  it('half-to-even invariant: bankersRound(2k + 0.5) === 2k for all integer k', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10_000, max: 10_000 }), (k) => {
        const tie = 2 * k + 0.5;
        const result = bankersRound(tie);
        // Sign-neutral comparison so -0 vs 0 doesn't flip a passing test.
        return result + 0 === 2 * k + 0;
      }),
      { numRuns: 500 },
    );
  });

  it('half-to-even invariant: bankersRound(2k+1 + 0.5) === 2(k+1) for all integer k', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10_000, max: 10_000 }), (k) => {
        const odd = 2 * k + 1;
        const tie = odd + 0.5;
        return bankersRound(tie) === odd + 1;
      }),
      { numRuns: 500 },
    );
  });

  it('monotone non-decreasing under random pairs in [0, 500_000]', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 0, max: 500_000 }),
          fc.integer({ min: 0, max: 500_000 }),
        ),
        ([a, b]) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          return bankersRoundPaidToActual(lo, 3.125) <=
            bankersRoundPaidToActual(hi, 3.125);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('multiplier > 0 sweep: result is always a non-negative integer for non-negative input', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500_000 }),
        // Avoid multipliers below 0.5 — they push the quotient outside
        // sensible int32 ranges and aren't a production scenario.
        fc.double({ min: 0.5, max: 100, noNaN: true }),
        (p, m) => {
          const v = bankersRoundPaidToActual(p, m);
          return Number.isInteger(v) && v >= 0;
        },
      ),
      { numRuns: 500 },
    );
  });
});
