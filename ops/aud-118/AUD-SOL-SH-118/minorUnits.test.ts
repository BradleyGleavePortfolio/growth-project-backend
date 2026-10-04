import { money, planTerms, purchasableFromCoachPackage } from '../planTerms';

function numeric(text: string) {
  return Number(text.replace(/[^\d.-]/g, ''));
}

describe('AUD-SOL-SH-118 package terms use Stripe presentment minor units', () => {
  it('JPY 4900 minor units are 4900 yen, not 49 yen', () => {
    // Backend accepts a three-letter currency and sends the stored amount
    // unchanged as Stripe's unit_amount/amount.
    const p = purchasableFromCoachPackage({
      id: '11111111-2222-4333-8444-555555555555',
      name: 'Synthetic yen plan', billing_type: 'recurring',
      amount_cents: 4900, currency: 'jpy', interval: 'month',
    });
    expect(p).not.toBeNull();
    expect(numeric(money(p!.amountCents, p!.currency))).toBe(4900);
    expect(planTerms(p!).cta).toContain(money(4900, 'jpy'));
  });

  it('KWD 4900 minor units are 4.900 dinars, not 49 dinars', () => {
    expect(numeric(money(4900, 'kwd'))).toBe(4.9);
  });

  it('control: USD 4900 minor units remain 49 dollars', () => {
    expect(numeric(money(4900, 'usd'))).toBe(49);
  });
});
