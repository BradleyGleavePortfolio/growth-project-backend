/**
 * S-DUNNING-R3 — integer minor-unit money helpers for the client billing
 * actions. Amounts are never added across currencies: every total is a list
 * of { currency, amount_cents } with one entry per currency.
 */

export interface MoneyTotal {
  currency: string;
  amount_cents: number;
}

/** ISO 4217 currencies Stripe treats as zero-decimal (no minor unit). */
const ZERO_DECIMAL = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'ugx',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
]);

export function normalizeCurrency(currency: string | null | undefined): string {
  const c = typeof currency === 'string' ? currency.trim().toLowerCase() : '';
  return /^[a-z]{3}$/.test(c) ? c : 'usd';
}

/** Sum integer amounts per currency; one entry per currency, sorted by currency code. */
export function totalsByCurrency(
  items: Array<{ currency: string; amount_cents: number }>,
): MoneyTotal[] {
  const order: string[] = [];
  const sums = new Map<string, number>();
  for (const it of items) {
    if (!Number.isInteger(it.amount_cents) || it.amount_cents <= 0) continue;
    const cur = normalizeCurrency(it.currency);
    if (!sums.has(cur)) {
      order.push(cur);
      sums.set(cur, 0);
    }
    sums.set(cur, (sums.get(cur) ?? 0) + it.amount_cents);
  }
  // Alphabetical by currency code: a stable order for copy and quote digests.
  order.sort();
  return order.map((currency) => ({ currency, amount_cents: sums.get(currency) ?? 0 }));
}

/** One amount as the client reads it: "$150.00", "12,000 JPY", "45.50 EUR". */
export function formatMinor(cents: number, currency: string | null | undefined): string {
  const cur = normalizeCurrency(currency);
  const safe = Number.isInteger(cents) ? cents : 0;
  if (ZERO_DECIMAL.has(cur)) {
    return `${safe.toLocaleString('en-US')} ${cur.toUpperCase()}`;
  }
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const minor = String(abs % 100).padStart(2, '0');
  const body = `${whole}.${minor}`;
  if (cur === 'usd') return `${negative ? '-' : ''}$${body}`;
  return `${negative ? '-' : ''}${body} ${cur.toUpperCase()}`;
}

/** "$150.00", or "$150.00 and 45.50 EUR" for more than one currency. */
export function formatTotals(totals: MoneyTotal[]): string {
  const parts = totals.map((t) => formatMinor(t.amount_cents, t.currency));
  if (parts.length <= 1) return parts[0] ?? formatMinor(0, 'usd');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The single currency of a total list, or null when there are several. */
export function singleCurrency(totals: MoneyTotal[]): string | null {
  return totals.length === 1 ? totals[0].currency : null;
}
