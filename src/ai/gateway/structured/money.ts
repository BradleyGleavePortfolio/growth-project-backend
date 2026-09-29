// L1-gw r3 — money for the importer.mapping spend ledger (R592-c7A-01, R592-c7B-C02).
//
// Every amount the ledger stores, sums or compares is an INTEGER number of
// micro-USD (1 USD = 1 000 000 µUSD). Prices are integers too (µUSD per million
// tokens, i.e. µUSD per token × 1e6). Arithmetic is done in BigInt and checked
// back into the safe-integer range, so there is no binary-float rounding
// anywhere in the admission decision.
//
// Rounding is always UP (ceil) for a cost: a strictly positive price and a
// strictly positive token count can never produce a 0 µUSD charge, so a
// configured $0 cap refuses every paid call (r2 rounded to six decimals and
// could round a tiny reservation to 0 — auditor A's finding).

export const MICROS_PER_USD = 1_000_000;

// Upper bound on any single amount / price the ledger accepts: 1e15 µUSD
// (one billion USD) keeps every product below Number.MAX_SAFE_INTEGER.
export const MAX_MICROS = 1_000_000_000_000_000;

// Decimal USD string ("20", "3.75", "0.000001") → integer µUSD. At most six
// decimal places (µUSD precision); more precision, signs, exponents or
// anything non-numeric is rejected (null). Never uses Number() on the string.
export function parseUsdToMicros(raw: string): number | null {
  const s = raw.trim();
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? '').padEnd(6, '0'));
  const micros = whole * BigInt(MICROS_PER_USD) + frac;
  return toSafeMicros(micros);
}

// Cost in µUSD of `tokens` at `priceMicrosPerMTok` (µUSD per million tokens),
// rounded UP. 0 tokens → 0; any positive token count at a positive price → ≥ 1.
export function tokenCostMicros(tokens: number, priceMicrosPerMTok: number): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw new RangeError('tokens must be a non-negative safe integer');
  if (!isMicros(priceMicrosPerMTok))
    throw new RangeError('price must be a non-negative safe integer in µUSD/MTok');
  const num = BigInt(tokens) * BigInt(priceMicrosPerMTok);
  const den = BigInt(MICROS_PER_USD);
  const cost = (num + den - 1n) / den; // ceil
  const out = toSafeMicros(cost);
  if (out === null) throw new RangeError('token cost exceeds the ledger bound');
  return out;
}

// True for a non-negative safe integer at or below MAX_MICROS.
export function isMicros(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_MICROS;
}

// Checked addition; throws if either operand is not µUSD or the sum overflows.
export function addMicros(a: number, b: number): number {
  if (!isMicros(a) || !isMicros(b)) throw new RangeError('operands must be µUSD integers');
  const sum = a + b;
  if (!isMicros(sum)) throw new RangeError('µUSD sum exceeds the ledger bound');
  return sum;
}

// Display only (audit metadata `usd_estimate`); never used in a decision.
export function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

// Whole cents, rounded UP (AICallLog.costCents is an integer cents column).
export function microsToCentsCeil(micros: number): number {
  return Math.ceil(micros / 10_000);
}

function toSafeMicros(v: bigint): number | null {
  if (v < 0n || v > BigInt(MAX_MICROS)) return null;
  return Number(v);
}
