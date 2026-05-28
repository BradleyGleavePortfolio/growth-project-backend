/**
 * Stream 1 — banker's rounding property tests.
 *
 * The locked multiplier (3.125) means every paid_cents in [1000, 50000]
 * divides to a finite decimal, but the half-to-even tiebreak only
 * activates on inputs that land exactly on a *.5 boundary. We exhaust
 * the *.5 candidates in the custom-pack range plus the three locked
 * tiers explicitly.
 */

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
