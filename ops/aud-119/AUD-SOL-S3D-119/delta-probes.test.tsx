/** Exact-head round-5 authority and consent challenges; transport only is synthetic. */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import YourPlansPanel from '../purchase/YourPlansPanel';

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

const ID = 'purchase-1';
const DATE = '2026-11-02T12:00:00.000Z';
const NEW_DATE = '2026-12-02T12:00:00.000Z';
const PLAN = {
  purchase_id: ID, package_id: 'pkg-1', package_name: 'Monthly coaching', state: 'active',
  entitlement_active: true, amount_cents: 9900, currency: 'usd', interval: 'month', interval_count: 1,
  next_charge_at: DATE, cancel_at_period_end: false, access_ends_at: null,
  can_cancel: true, can_resume: false,
};
const TRIAL = { ...PLAN, state: 'trialing', next_charge_at: null, trial_ends_at: DATE };
const ending = (p: object, date = DATE) => ({
  ...p, next_charge_at: null, cancel_at_period_end: true, access_ends_at: date, can_cancel: false, can_resume: true,
});
const ok = (p: object) => ({ data: { plans: [p] } });
const failure = (status = 503) => Object.assign(new Error('Synthetic failure'), {
  response: { status, data: status === 404 ? { error: 'Not Found' } : { code: 'STRIPE_UNAVAILABLE' } },
});
const receipt = () => ({ data: {
  outcome: 'scheduled', purchase_id: ID, access_ends_at: DATE, voided_amount_cents: 0,
  currency: 'usd', paid_period_kept: false,
} });
const confirm = () => jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons) => {
  (buttons ?? []).find((b) => b.style === 'destructive')?.onPress?.();
});
const line = (r: Awaited<ReturnType<typeof render>>) => r.getByTestId(`your-plan-line-${ID}`).props.children;
beforeEach(() => { mockGet.mockReset(); mockPost.mockReset(); });
afterEach(() => jest.restoreAllMocks());

it.each([PLAN, TRIAL])('confirmed state %# consent covers a newly overdue payment', async (p) => {
  mockGet.mockResolvedValue(ok(p));
  const dialog = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId(`your-plan-end-${ID}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`your-plan-end-${ID}`));
  expect(dialog.mock.calls[0][1]).toMatch(/If a payment is overdue, ending it ends access now instead and cancels the unpaid charge/);
  expect(dialog.mock.calls[0][1]).not.toMatch(/period you paid for/);
});

it.each([503, 404])('stale trial after status %s offers a refresh and sends no destructive action', async (status) => {
  mockGet.mockResolvedValueOnce(ok(TRIAL)).mockRejectedValueOnce(failure(status)).mockResolvedValue(ok(TRIAL));
  const dialog = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const r = await render(<YourPlansPanel reloadKey={0} />);
  await waitFor(() => expect(r.getByTestId(`your-plan-end-${ID}`)).toBeTruthy());
  await r.rerender(<YourPlansPanel reloadKey={1} />);
  await waitFor(() => expect(r.getByTestId('your-plans-stale')).toBeTruthy());
  await fireEvent.press(r.getByTestId(`your-plan-end-${ID}`));
  expect(dialog.mock.calls[0][0]).toBe('Refresh your plans first');
  expect(dialog.mock.calls[0][2]?.some((b) => b.style === 'destructive')).toBe(false);
  expect(mockPost).not.toHaveBeenCalled();
  await act(async () => { dialog.mock.calls[0][2]?.[1]?.onPress?.(); });
  await waitFor(() => expect(r.queryByTestId('your-plans-stale')).toBeNull());
});

it('a newer successful read with a different access-end date supersedes a scheduled receipt even if cancellation is still scheduled', async () => {
  // A later remote Keep + End can leave cancel_at_period_end=true again,
  // but its canonical access end belongs to the current period, not this receipt.
  mockGet.mockResolvedValueOnce(ok(PLAN)).mockRejectedValueOnce(failure()).mockResolvedValue(ok(ending(PLAN, NEW_DATE)));
  mockPost.mockResolvedValue(receipt());
  confirm();
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId(`your-plan-end-${ID}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`your-plan-end-${ID}`));
  await waitFor(() => expect(r.getByTestId('your-plans-stale')).toBeTruthy());
  expect(line(r)).toMatch(/November 2, 2026/);
  await fireEvent.press(r.getByTestId('your-plans-retry'));
  await waitFor(() => expect(r.queryByTestId('your-plans-stale')).toBeNull());
  expect(r.getByTestId(`your-plan-keep-${ID}`)).toBeTruthy();
  expect(line(r)).toMatch(/December 2, 2026/);
  expect(line(r)).not.toMatch(/November 2, 2026/);
});

it('a newer paid-period view must not retain an old free-trial receipt', async () => {
  mockGet.mockResolvedValueOnce(ok(TRIAL)).mockRejectedValueOnce(failure()).mockResolvedValue(ok(ending(PLAN, NEW_DATE)));
  mockPost.mockResolvedValue(receipt());
  confirm();
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId(`your-plan-end-${ID}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`your-plan-end-${ID}`));
  await waitFor(() => expect(r.getByTestId('your-plans-stale')).toBeTruthy());
  expect(line(r)).toMatch(/Your free trial ends on November 2, 2026, and nothing is charged/);
  await fireEvent.press(r.getByTestId('your-plans-retry'));
  await waitFor(() => expect(r.queryByTestId('your-plans-stale')).toBeNull());
  expect(line(r)).toMatch(/December 2, 2026/);
  expect(line(r)).not.toMatch(/free trial|nothing is charged/i);
});

it('control: an agreeing newer view preserves the free-trial receipt', async () => {
  mockGet.mockResolvedValueOnce(ok(TRIAL)).mockResolvedValue(ok(ending(TRIAL)));
  mockPost.mockResolvedValue(receipt());
  confirm();
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId(`your-plan-end-${ID}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`your-plan-end-${ID}`));
  await waitFor(() => expect(r.getByTestId(`your-plan-keep-${ID}`)).toBeTruthy());
  expect(line(r)).toBe('Your free trial ends on November 2, 2026, and nothing is charged.');
});
