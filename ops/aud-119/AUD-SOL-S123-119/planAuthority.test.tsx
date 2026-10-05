/**
 * Independent exact-head P3 tests: cancellation consent and the authority
 * of successful reads after an earlier action receipt.
 */
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
const PLAN = {
  purchase_id: ID, package_id: 'pkg-1', package_name: 'Monthly coaching', state: 'active',
  entitlement_active: true, amount_cents: 9900, currency: 'usd', interval: 'month', interval_count: 1,
  next_charge_at: '2026-11-02T12:00:00.000Z', cancel_at_period_end: false, access_ends_at: null,
  can_cancel: true, can_resume: false,
};
const ENDING = { ...PLAN, next_charge_at: null, cancel_at_period_end: true, access_ends_at: PLAN.next_charge_at, can_cancel: false, can_resume: true };
const ok = (plan: object) => ({ data: { plans: [plan] } });
const fail = () => Object.assign(new Error('Synthetic read failure'), { response: { status: 503, data: { code: 'STRIPE_UNAVAILABLE' } } });
const receipt = (outcome: 'ended' | 'scheduled') => ({
  data: { outcome, purchase_id: ID, access_ends_at: outcome === 'ended' ? '2026-10-04T20:00:00Z' : PLAN.next_charge_at, voided_amount_cents: outcome === 'ended' ? 9900 : 0, currency: 'usd', paid_period_kept: false },
});
const confirm = () => jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons) => {
  (buttons ?? []).find((b) => b.style === 'destructive')?.onPress?.();
});
beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

it('a newer successful retry read supersedes the old cancel receipt if another session kept the plan', async () => {
  mockGet.mockResolvedValueOnce(ok(PLAN)).mockRejectedValueOnce(fail()).mockResolvedValue(ok(PLAN));
  mockPost.mockResolvedValue(receipt('scheduled'));
  confirm();
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId(`your-plan-end-${ID}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`your-plan-end-${ID}`));
  await waitFor(() => expect(r.getByTestId('your-plans-stale')).toBeTruthy());
  expect(r.getByTestId(`your-plan-line-${ID}`).props.children).toMatch(/nothing more is charged/i);
  await fireEvent.press(r.getByTestId('your-plans-retry'));
  await waitFor(() => expect(r.queryByTestId('your-plans-stale')).toBeNull());
  expect(r.getByTestId(`your-plan-end-${ID}`)).toBeTruthy();
  expect(r.getByTestId(`your-plan-line-${ID}`).props.children).toMatch(/Next charge of \$99\.00 a month/);
  expect(r.getByTestId(`your-plan-line-${ID}`).props.children).not.toMatch(/nothing more is charged/i);
});

it('control: a scheduled receipt survives the immediate failed reload until an authoritative refresh', async () => {
  mockGet.mockResolvedValueOnce(ok(PLAN)).mockRejectedValue(fail());
  mockPost.mockResolvedValue(receipt('scheduled'));
  confirm();
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId(`your-plan-end-${ID}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`your-plan-end-${ID}`));
  await waitFor(() => expect(r.getByTestId('your-plans-stale')).toBeTruthy());
  expect(r.getByTestId(`your-plan-line-${ID}`).props.children).toMatch(/Access continues until November 2, 2026/);
});

it('a stale active card warns about immediate ending if the plan entered dunning before cancel', async () => {
  mockGet.mockResolvedValueOnce(ok(PLAN)).mockRejectedValue(fail());
  const dialog = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const r = await render(<YourPlansPanel reloadKey={0} />);
  await waitFor(() => expect(r.getByTestId(`your-plan-end-${ID}`)).toBeTruthy());
  await r.rerender(<YourPlansPanel reloadKey={1} />);
  await waitFor(() => expect(r.getByTestId('your-plans-stale')).toBeTruthy());
  await fireEvent.press(r.getByTestId(`your-plan-end-${ID}`));
  // The billing route branches on the current server state, not this stale
  // active card: dunning cancellation voids the open invoice and ends now.
  expect(dialog.mock.calls[0][1]).toMatch(/access.*(now|immediately)|ends.*(now|immediately)|check.*(current|latest)|refresh.*before/i);
});

it('control: period-end cancel uses its canonical returned outcome and Keep my plan uses its canonical resumed view', async () => {
  mockGet.mockResolvedValueOnce(ok(PLAN)).mockResolvedValueOnce(ok(ENDING)).mockRejectedValue(fail());
  mockPost.mockResolvedValueOnce(receipt('scheduled')).mockResolvedValueOnce({ data: PLAN });
  confirm();
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId(`your-plan-end-${ID}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`your-plan-end-${ID}`));
  await waitFor(() => expect(r.getByTestId(`your-plan-keep-${ID}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`your-plan-keep-${ID}`));
  await waitFor(() => expect(r.getByTestId('your-plans-stale')).toBeTruthy());
  expect(r.getByTestId(`your-plan-line-${ID}`).props.children).toMatch(/Next charge of \$99\.00 a month/);
});
