/**
 * AUD-OPUS-S3E-119 (Claude Opus 5.5 lens, agent 119) — mobile #344 FIX ROUND 6 delta probe (B-344-3 residual).
 * Real panel and plan copy; only transport, theme, Sentry and clipboard are mocked. Fixtures follow the
 * backend contract: D4 cancelAtPeriodEnd persists Stripe current_period_end before replying
 * (client-billing.service.ts:1486-1492 @06307883) and R2 planView derives access_ends_at / trial_ends_at
 * from that same column (subscription-plan.ts:395-403 @23d2c04c).
 *   E1 real trial cancel: answer and immediate read name the same instant in different ISO spellings -> trial receipt stays.
 *   E2 real paid cancel, same spelling difference -> paid receipt stays.
 *   E3 dunning paid-meanwhile: read is active + scheduled at the same end -> the "kept the period" receipt stays.
 *   E4 answer without a date, read with a date -> read wins.
 *   E5 two plans: a disagreeing read for plan B never drops plan A's agreeing receipt.
 *   E6 failed read after cancel keeps the receipt (control); Try again with a disagreeing date drops it.
 *   E7 resume after a scheduled receipt clears it (control, unchanged).
 */
import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../theme/ThemeProvider', () => {
  const tokens = jest.requireActual('../../theme/tokens').default;
  return { useTheme: () => ({ tokens, semanticColors: tokens.lightTokens, colorScheme: 'light' }) };
});
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

import YourPlansPanel from '../purchase/YourPlansPanel';

const A = 'purchase-a';
const B = 'purchase-b';
const NOV = '2026-11-02T12:00:00.000Z';
const NOV_NO_MS = '2026-11-02T12:00:00Z';
const DEC = '2026-12-02T12:00:00.000Z';
const view = (id: string, state: string, o: Record<string, unknown> = {}) => ({
  purchase_id: id, package_id: 'pkg-1', package_name: `Plan ${id}`, state, status: state,
  entitlement_active: true, amount_cents: 9900, currency: 'usd', interval: 'month', interval_count: 1,
  current_period_end: NOV, next_charge_at: state === 'trialing' ? null : NOV, cancel_at_period_end: false,
  access_ends_at: null, trial_ends_at: state === 'trialing' ? NOV : null, can_cancel: true, can_resume: false, ...o,
});
const scheduled = (id: string, state: string, end = NOV) =>
  view(id, state, { cancel_at_period_end: true, next_charge_at: null, access_ends_at: end, current_period_end: end,
    trial_ends_at: state === 'trialing' ? end : null, can_cancel: false, can_resume: true });
const ok = (...plans: object[]) => ({ data: { plans } });
const http = (status: number) =>
  Object.assign(new Error('synthetic'), { response: { status, data: { code: 'X_DOWN' }, headers: { 'x-request-id': 'ref12345-zz' } }, config: { headers: {} } });
const answer = (id: string, o: object) => ({ data: { purchase_id: id, voided_invoice_count: 0, voided_amount_cents: 0, currency: 'usd', paid_period_kept: false, message: 'x', ...o } });
const autoConfirm = () =>
  jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons) => {
    (buttons ?? []).find((b) => b.style === 'destructive')?.onPress?.();
  });
const lineOf = (r: Awaited<ReturnType<typeof render>>, id = A) => r.getByTestId(`your-plan-line-${id}`).props.children;
const TRIAL_RECEIPT = 'Your free trial ends on November 2, 2026, and nothing is charged.';
const PAID_RECEIPT = 'Your plan will not renew. Access continues until November 2, 2026, and nothing more is charged.';

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

async function cancelFlow(first: object[], reads: Array<object | Error>, post: object, id = A) {
  mockGet.mockResolvedValueOnce(ok(...first));
  for (const x of reads) {
    if (x instanceof Error) mockGet.mockRejectedValueOnce(x);
    else mockGet.mockResolvedValueOnce(x);
  }
  mockPost.mockResolvedValue(post);
  autoConfirm();
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId(`your-plan-end-${id}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`your-plan-end-${id}`));
  await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  return r;
}

describe('E1-E3 backend-consistent immediate reads keep the receipt', () => {
  it('E1 trial cancel, same instant spelled differently: trial receipt stays', async () => {
    const r = await cancelFlow([view(A, 'trialing')], [ok(scheduled(A, 'trialing'))], answer(A, { outcome: 'scheduled', access_ends_at: NOV_NO_MS }));
    await waitFor(() => expect(lineOf(r)).toBe(TRIAL_RECEIPT));
  });
  it('E2 paid cancel, same instant spelled differently: paid receipt stays', async () => {
    const r = await cancelFlow([view(A, 'active')], [ok(scheduled(A, 'active'))], answer(A, { outcome: 'scheduled', access_ends_at: NOV_NO_MS }));
    await waitFor(() => expect(lineOf(r)).toBe(PAID_RECEIPT));
  });
  it('E3 dunning paid meanwhile: read active + scheduled at the same end keeps the receipt', async () => {
    const r = await cancelFlow([view(A, 'past_due')], [ok(scheduled(A, 'active'))], answer(A, { outcome: 'scheduled', access_ends_at: NOV, paid_period_kept: true }));
    await waitFor(() => expect(lineOf(r)).toMatch(/November 2, 2026/));
    expect(lineOf(r)).toMatch(/latest payment went through/);
    // eslint-disable-next-line no-console
    console.log(`E3 paid-meanwhile receipt: ${lineOf(r)}`);
  });
});

describe('E4 answer without a date', () => {
  it('a read with a date wins over a dateless scheduled receipt', async () => {
    const r = await cancelFlow([view(A, 'active')], [ok(scheduled(A, 'active'))], answer(A, { outcome: 'scheduled', access_ends_at: null }));
    await waitFor(() => expect(lineOf(r)).toBe('Ends on November 2, 2026. Nothing more is charged.'));
  });
});

describe('E5 per-plan independence', () => {
  it("plan B's read never drops plan A's agreeing receipt", async () => {
    const r = await cancelFlow([view(A, 'active'), view(B, 'active')], [ok(scheduled(A, 'active'), scheduled(B, 'active', DEC))],
      answer(A, { outcome: 'scheduled', access_ends_at: NOV }));
    await waitFor(() => expect(lineOf(r)).toBe(PAID_RECEIPT));
    expect(lineOf(r, B)).toBe('Ends on December 2, 2026. Nothing more is charged.');
  });
});

describe('E6 failed reads keep, successful disagreeing reads drop', () => {
  it('receipt survives the failed read, then Try again with a later date shows the read', async () => {
    mockGet.mockResolvedValueOnce(ok(view(A, 'trialing'))).mockRejectedValueOnce(http(503)).mockResolvedValue(ok(scheduled(A, 'active', DEC)));
    mockPost.mockResolvedValue(answer(A, { outcome: 'scheduled', access_ends_at: NOV }));
    autoConfirm();
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${A}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${A}`));
    await waitFor(() => expect(r.getByTestId('your-plans-stale')).toBeTruthy());
    expect(lineOf(r)).toBe(TRIAL_RECEIPT);
    await fireEvent.press(r.getByTestId('your-plans-retry'));
    await waitFor(() => expect(r.queryByTestId('your-plans-stale')).toBeNull());
    expect(lineOf(r)).toBe('Ends on December 2, 2026. Nothing more is charged.');
    expect(lineOf(r)).not.toMatch(/free trial/);
  });
});

describe('E7 resume clears the receipt (control)', () => {
  it('Keep my plan after a scheduled receipt shows the resumed plan', async () => {
    const r = await cancelFlow([view(A, 'active')], [ok(scheduled(A, 'active')), ok(view(A, 'active'))], answer(A, { outcome: 'scheduled', access_ends_at: NOV }));
    await waitFor(() => expect(lineOf(r)).toBe(PAID_RECEIPT));
    mockPost.mockResolvedValueOnce({ data: view(A, "active") });
    await fireEvent.press(r.getByTestId(`your-plan-keep-${A}`));
    await waitFor(() => expect(lineOf(r)).toBe('Next charge of $99.00 a month on November 2, 2026.'));
  });
});
