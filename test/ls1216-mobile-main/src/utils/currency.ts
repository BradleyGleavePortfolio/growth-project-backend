// Minimal currency helpers used by the payments surface. Stripe minor units
// -> display.
//
// B-342-3 (Sol): every amount from the backend is Stripe's integer amount in
// the currency's smallest unit (docs.stripe.com/currencies), so the divisor
// depends on the currency: zero-decimal currencies (JPY, KRW, ...) are whole
// units, three-decimal ones (KWD, BHD, ...) are thousandths. ISK and UGX are
// two-decimal in Stripe amounts but have no fractions, so they display whole.
// A tiny try/catch fallback stays because some lower-end Android JSC builds
// fail on uncommon ISO codes: the fallback yields a readable string instead
// of crashing the screen.

const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
const WHOLE_DISPLAY = new Set(['ISK', 'UGX']);

/** How a Stripe amount of this currency maps to display units. */
export function currencyMinorUnits(currency: string | null | undefined): {
  /** amount / 10^exponent = display units. */
  exponent: number;
  /** Fraction digits shown. */
  fractionDigits: number;
} {
  const iso = (currency ?? 'usd').toUpperCase();
  if (ZERO_DECIMAL.has(iso)) return { exponent: 0, fractionDigits: 0 };
  if (THREE_DECIMAL.has(iso)) return { exponent: 3, fractionDigits: 3 };
  if (WHOLE_DISPLAY.has(iso)) return { exponent: 2, fractionDigits: 0 };
  return { exponent: 2, fractionDigits: 2 };
}

/** Format a Stripe minor-unit amount (named for its historic cents callers). */
export function formatCurrencyCents(
  cents: number | null | undefined,
  currency: string | null | undefined = 'usd',
): string {
  const iso = (currency ?? 'usd').toUpperCase();
  const { exponent, fractionDigits } = currencyMinorUnits(iso);
  const amount = (cents ?? 0) / 10 ** exponent;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: iso,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(amount);
  } catch {
    return `${iso} ${amount.toFixed(fractionDigits)}`;
  }
}

// Parse a UI string like "$199.00" or "199" back into integer cents. Returns
// null when the input isn't a sensible non-negative number, so callers can
// validate without writing their own regex.
export function parseDollarsToCents(input: string): number | null {
  if (!input) return null;
  const cleaned = input.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}
