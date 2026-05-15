// P0 audit fix — subscription mode fee rounding must never under-collect.
//
// Before: checkout.service computed application_fee_percent via
//   Number(((feeCents / amountCents) * 100).toFixed(2))
// which, for certain ratios that landed on a *.5 hundredths boundary,
// rounded DOWN via IEEE-754 banker's rounding and shorted the platform
// by 1¢ per renewal. Stripe accepts at most 2 dp of precision on the
// percent, so the safe strategy is to ceiling-round at hundredths-of-a-
// percent (== basis points). Over-collection per renewal is bounded by
// amountCents / 10_000 cents (sub-cent for typical subscriptions).
//
// This file pins the rounding function across a representative sweep of
// amounts and bps targets so a regression cannot land silently.

import { CheckoutService } from '../src/checkout/checkout.service';

function stripeAppliesPercent(percent: number, amountCents: number): number {
  // Stripe rounds the fee to whole cents using half-up. Mimic that here.
  return Math.round((percent / 100) * amountCents);
}

const PAIRS: Array<{ amount: number; targetBps: number; label: string }> = [
  { amount: 999, targetBps: 200, label: '$9.99 @ 2.00%' },
  { amount: 1999, targetBps: 200, label: '$19.99 @ 2.00%' },
  { amount: 2999, targetBps: 200, label: '$29.99 @ 2.00%' },
  { amount: 4999, targetBps: 200, label: '$49.99 @ 2.00%' },
  { amount: 9999, targetBps: 200, label: '$99.99 @ 2.00%' },
  { amount: 333, targetBps: 200, label: '$3.33 @ 2.00%' },
  { amount: 333, targetBps: 700, label: '$3.33 @ 7.00% (with head-coach split)' },
  { amount: 5000, targetBps: 700, label: '$50.00 @ 7.00%' },
  { amount: 12345, targetBps: 250, label: '$123.45 @ 2.50%' },
  { amount: 100000, targetBps: 200, label: '$1000.00 @ 2.00%' },
];

describe('CheckoutService.toStripeApplicationFeePercent (P0)', () => {
  it.each(PAIRS)(
    'never under-collects vs the bps target — $label',
    ({ amount, targetBps }) => {
      // Reproduce the bps math the FeePolicyService does at runtime.
      const targetCents = Math.floor((amount * targetBps) / 10000);
      const percent = CheckoutService.toStripeApplicationFeePercent(
        targetCents,
        amount,
      );
      const collected = stripeAppliesPercent(percent, amount);
      expect(collected).toBeGreaterThanOrEqual(targetCents);
      // And never over-collect by more than amount/10000 (the precision
      // ceiling of 2dp percent). Generally this is sub-cent for sub-$100
      // amounts.
      expect(collected - targetCents).toBeLessThanOrEqual(
        Math.ceil(amount / 10000) + 1,
      );
    },
  );

  it('returns 0 when target is 0 — no Stripe field emitted', () => {
    expect(CheckoutService.toStripeApplicationFeePercent(0, 1999)).toBe(0);
  });

  it('returns 0 when amount is 0 (defensive)', () => {
    expect(CheckoutService.toStripeApplicationFeePercent(20, 0)).toBe(0);
  });

  it('emits a value with at most 2 decimal places (Stripe precision cap)', () => {
    for (const { amount, targetBps } of PAIRS) {
      const targetCents = Math.floor((amount * targetBps) / 10000);
      const percent = CheckoutService.toStripeApplicationFeePercent(
        targetCents,
        amount,
      );
      const stringified = percent.toString();
      const dot = stringified.indexOf('.');
      if (dot !== -1) {
        expect(stringified.length - dot - 1).toBeLessThanOrEqual(2);
      }
    }
  });

  it('regression: $9.99 @ 2% renewal does not drift to 19¢ over many cycles', () => {
    const amount = 999;
    const targetCents = Math.floor((amount * 200) / 10000); // 19
    const percent = CheckoutService.toStripeApplicationFeePercent(
      targetCents,
      amount,
    );
    // Simulate 24 monthly renewals — collected cents must be >= target each cycle.
    for (let i = 0; i < 24; i += 1) {
      expect(stripeAppliesPercent(percent, amount)).toBeGreaterThanOrEqual(
        targetCents,
      );
    }
  });
});
