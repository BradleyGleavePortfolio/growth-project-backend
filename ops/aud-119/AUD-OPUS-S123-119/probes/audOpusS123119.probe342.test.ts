/**
 * AUD-OPUS-S12-119 probe (Claude Opus 5.5 lens, agent 119 wave) on #342 @ 0b1985f4.
 *   R1 controls: Stripe minor units per currency, including the Intl fallback
 *      path (some Android JSC builds throw on uncommon codes), HUF/TWD
 *      (two-decimal charges), ISK/UGX (two-decimal amounts, shown whole).
 *   R2 controls: every PACKAGE_PAYMENT_COPY string obeys the copy rules.
 *   R3 INFO (C-342-7): a non-transport exception with no HTTP status is told
 *      as "could not reach the server" (records today's wording only).
 */
import { PACKAGE_PAYMENT_COPY, describeBackendFailure } from '../packagePayment';
import { formatCurrencyCents } from '../../utils/currency';

jest.mock('../../services/api', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));

const NO_CHARGE = /nothing was charged|not charged|did not go through|did not start/i;
const num = (t: string) => Number(t.replace(/[^\d.-]/g, ''));

describe('R1 minor units per currency', () => {
  it.each([
    ['jpy', 4900, 4900], ['krw', 15000, 15000], ['xpf', 1200, 1200],
    ['kwd', 4900, 4.9], ['bhd', 12340, 12.34],
    ['huf', 100050, 1000.5], ['twd', 80045, 800.45],
    ['isk', 500, 5], ['ugx', 500000, 5000],
    ['usd', 4900, 49], ['eur', 1999, 19.99], ['gbp', 1, 0.01],
  ])('%s %d -> %d display units (Intl path)', (cur, minor, major) => {
    expect(num(formatCurrencyCents(minor, cur))).toBeCloseTo(major, 5);
  });

  it.each([
    ['jpy', 4900, 'JPY 4900'], ['kwd', 4900, 'KWD 4.900'], ['isk', 500, 'ISK 5'],
    ['usd', 4900, 'USD 49.00'], ['ugx', 500000, 'UGX 5000'],
  ])('%s %d falls back to "%s" when Intl throws', (cur, minor, text) => {
    const real = Intl.NumberFormat;
    (Intl as { NumberFormat: unknown }).NumberFormat = function () { throw new RangeError('synthetic JSC'); };
    try {
      expect(formatCurrencyCents(minor, cur)).toBe(text);
    } finally {
      (Intl as { NumberFormat: unknown }).NumberFormat = real;
    }
  });

  it('null and missing values never throw and default to USD', () => {
    expect(num(formatCurrencyCents(null, null))).toBe(0);
    expect(num(formatCurrencyCents(undefined))).toBe(0);
    expect(formatCurrencyCents(4900, undefined)).toMatch(/49\.00/);
  });
});

describe('R2 copy rules over every string', () => {
  const strings: string[] = [];
  for (const v of Object.values(PACKAGE_PAYMENT_COPY)) {
    if (typeof v === 'string') strings.push(v);
    else if (typeof v === 'function') {
      try { strings.push(String((v as (...a: unknown[]) => unknown)('ref12345', '$49.00', 'June 1'))); } catch { /* shape */ }
      try { strings.push(String((v as (...a: unknown[]) => unknown)(null, null, null))); } catch { /* shape */ }
    }
  }
  it('collected copy', () => expect(strings.length).toBeGreaterThan(60));
  it.each(strings.map((s) => [s]))('%s', (s) => {
    expect(s).not.toMatch(/!/);
    expect(s).not.toMatch(/\b(we|our|us|we're|we'll|I)\b/);
    expect(s).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
  it('noAnswer keeps the reference, offers the plan and never claims no charge', () => {
    expect(PACKAGE_PAYMENT_COPY.noAnswer('ab12cd34')).toContain('ab12cd34');
    expect(PACKAGE_PAYMENT_COPY.noAnswer('ab12cd34')).not.toMatch(NO_CHARGE);
    expect(PACKAGE_PAYMENT_COPY.noAnswer(null)).not.toMatch(/reference/);
  });
});

describe('R3 INFO (C-342-7) no HTTP status', () => {
  it('a timeout (request sent, answer lost) is told as "could not reach the server"', () => {
    const timeout = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED', request: {}, config: {} });
    const n = describeBackendFailure(timeout, 'payment_intent', 'ab12cd34');
    expect(n.cause).toBe('no_answer');
    expect(n.message).toMatch(/could not reach the server/);
    expect(n.message).not.toMatch(NO_CHARGE);
  });
  it('a plain TypeError (no request at all) gets the same transport copy', () => {
    const n = describeBackendFailure(new TypeError('synthetic adapter bug'), 'payment_intent', 'ab12cd34');
    expect(n.cause).toBe('no_answer');
  });
});

// ── AUD-OPUS-S123-119 additions at #342 @ e3226f3b ─────────────────────────
describe('S4 B-342-1 residual: refusals evaluated before the key lookup (production 3e9a9a75 checkout.service.ts:444-490)', () => {
  const coded = (status: number, error: string) => ({ response: { status, data: { error } } });
  it.each([['payment_intent'], ['subscription_intent'], ['claim_free']] as const)(
    'PACKAGE_NOT_FOUND on %s after an unclear attempt: no no-charge claim, key kept, attempt reference',
    (step) => {
      const n = describeBackendFailure(coded(404, 'PACKAGE_NOT_FOUND'), step, 'ab12cd34');
      expect(n.message).not.toMatch(NO_CHARGE);
      expect(n.message).toContain('ab12cd34');
      expect(n.retireKey).toBeUndefined();
      expect(n.support).toBe(true);
    },
  );
  it('share link wording: no no-charge claim and no reload', () => {
    const n = describeBackendFailure(coded(404, 'PACKAGE_NOT_FOUND'), 'payment_intent', 'ab12cd34', { surface: 'share_link' });
    expect(n.message).not.toMatch(NO_CHARGE);
    expect(n.reload).toBeUndefined();
  });
  it('EVIDENCE (C): CLIENT_NOT_FOUND is also checked before the key lookup and still says nothing was charged', () => {
    const n = describeBackendFailure(coded(404, 'CLIENT_NOT_FOUND'), 'payment_intent', 'ab12cd34');
    // eslint-disable-next-line no-console
    console.log(`S4 CLIENT_NOT_FOUND copy: ${n.message}`);
    expect(n.message).toMatch(/nothing was charged/);
  });
});
