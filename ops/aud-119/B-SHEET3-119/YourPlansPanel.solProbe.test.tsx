/**
 * Independent AUD-SOL-SH3-118 probes at mobile #344 e7fcc5d2.
 * Real panel, API adapter, error mapper and copy; synthetic transport only.
 * Replayed by B-SHEET3-119 (agent 119) with three harness changes, no
 * assertion weakened: expo-clipboard is mocked (the support fallback imports
 * it); B-344-1 uses queryAllByText (the copy and the Email support action
 * both match the alternation); B-344-3 waits on End my plan, because the
 * canonical resume answer (can_resume false) removes Keep my plan.
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../theme/ThemeProvider', () => {
  const tokens = jest.requireActual('../../theme/tokens').default;
  return {
    useTheme: () => ({
      tokens,
      semanticColors: tokens.lightTokens,
      colorScheme: 'light',
    }),
  };
});
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
  },
}));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

import YourPlansPanel from '../purchase/YourPlansPanel';

const PLAN = {
  purchase_id: 'purchase-1',
  package_id: 'pkg-monthly',
  package_name: 'Monthly coaching',
  state: 'active',
  entitlement_active: true,
  amount_cents: 9900,
  currency: 'usd',
  interval: 'month',
  interval_count: 1,
  next_charge_at: '2026-11-02T12:00:00.000Z',
  cancel_at_period_end: false,
  access_ends_at: null,
  can_cancel: true,
  can_resume: false,
};
const ENDING = {
  ...PLAN,
  next_charge_at: null,
  cancel_at_period_end: true,
  access_ends_at: '2026-11-02T12:00:00.000Z',
  can_cancel: false,
  can_resume: true,
};
const LIST = '/v1/checkout/subscriptions';
const RESUME = `${LIST}/purchase-1/resume`;
const CANCEL = `${LIST}/purchase-1/cancel`;
const httpError = (status: number, code: string) =>
  Object.assign(new Error('synthetic HTTP error'), {
    response: {
      status,
      data: { code, error: code, request_id: 'abcd1234-ffff' },
      headers: {},
    },
    config: { headers: {} },
  });
const response = (plan: Record<string, unknown>) => ({ data: { plans: [plan] } });

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue(response(PLAN));
  mockPost.mockResolvedValue({ data: PLAN });
});
afterEach(() => {
  jest.restoreAllMocks();
});

it('control: a healthy active plan has a next charge and a cancellation action', async () => {
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId('your-plan-end-purchase-1')).toBeTruthy());
  expect(r.getByText(/Next charge of \$99\.00 a month/)).toBeTruthy();
});

it('control: a successful Keep my plan with a healthy reload shows renewing, not ending', async () => {
  mockGet.mockResolvedValueOnce(response(ENDING)).mockResolvedValue(response(PLAN));
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId('your-plan-keep-purchase-1')).toBeTruthy());
  await fireEvent.press(r.getByTestId('your-plan-keep-purchase-1'));
  await waitFor(() => expect(r.getByTestId('your-plan-end-purchase-1')).toBeTruthy());
  expect(mockPost).toHaveBeenCalledWith(RESUME, expect.objectContaining({ idempotency_key: expect.any(String) }));
  expect(r.queryByText(/Nothing more is charged/)).toBeNull();
});

it.each([404, 503])(
  'B-344-1: a subscriptions list HTTP %s has a visible truthful recovery instead of disappearing',
  async (status) => {
    mockGet.mockRejectedValue(httpError(status, status === 404 ? 'Not Found' : 'STRIPE_CHECKOUT_ERROR'));
    const r = await render(<YourPlansPanel />);
    await act(async () => { await Promise.resolve(); });
    expect(mockGet).toHaveBeenCalledWith(LIST);
    expect(r.queryAllByText(/could not load|cannot load|not available|not.*switched on|message.*coach|email support|check.*connection/i).length).toBeGreaterThan(0);
  },
);

it('B-344-2: End my plan during dunning warns that access ends immediately, not at the paid period end', async () => {
  mockGet.mockResolvedValue(response({
    ...PLAN,
    state: 'past_due',
    next_charge_at: null,
    entitlement_active: true,
  }));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId('your-plan-end-purchase-1')).toBeTruthy());
  await fireEvent.press(r.getByTestId('your-plan-end-purchase-1'));
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert.mock.calls[0][1]).toMatch(/access.*(now|immediately)|ends.*(now|immediately)/i);
  expect(alert.mock.calls[0][1]).not.toMatch(/stays active until the end of the period/i);
});

it('B-344-3: a confirmed resume is not still described as ending/no-more-charges when its reload fails', async () => {
  mockGet.mockResolvedValueOnce(response(ENDING)).mockRejectedValue(httpError(503, 'STRIPE_CHECKOUT_ERROR'));
  mockPost.mockResolvedValue({ data: PLAN });
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId('your-plan-keep-purchase-1')).toBeTruthy());
  await fireEvent.press(r.getByTestId('your-plan-keep-purchase-1'));
  await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(r.getByTestId('your-plan-end-purchase-1').props.accessibilityState.busy).toBe(false));
  expect(mockPost.mock.calls[0][0]).toBe(RESUME);
  expect(r.queryByText(/Ends on .*Nothing more is charged/)).toBeNull();
});

it('B-344-3: an older reload cannot overwrite a newer authoritative cancellation reload', async () => {
  const old = deferred<ReturnType<typeof response>>();
  mockGet.mockResolvedValueOnce(response(PLAN))
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValue(response(ENDING));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons) => {
    (buttons ?? []).find((b) => b.style === 'destructive')?.onPress?.();
  });
  const r = await render(<YourPlansPanel reloadKey={0} />);
  await waitFor(() => expect(r.getByTestId('your-plan-end-purchase-1')).toBeTruthy());
  await r.rerender(<YourPlansPanel reloadKey={1} />);
  await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  await fireEvent.press(r.getByTestId('your-plan-end-purchase-1'));
  await waitFor(() => expect(r.getByTestId('your-plan-keep-purchase-1')).toBeTruthy());
  expect(alert).toHaveBeenCalledTimes(1);
  expect(mockPost).toHaveBeenCalledWith(CANCEL, {});
  await act(async () => { old.resolve(response(PLAN)); await old.promise; });
  expect(r.queryByTestId('your-plan-end-purchase-1')).toBeNull();
  expect(r.getByTestId('your-plan-keep-purchase-1')).toBeTruthy();
});

it('B-344-4: an action failure asking for Email support exposes a working support action', async () => {
  mockGet.mockResolvedValue(response(ENDING));
  mockPost.mockRejectedValue(httpError(503, 'SUBSCRIPTION_SETUP_UNAVAILABLE'));
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId('your-plan-keep-purchase-1')).toBeTruthy());
  await fireEvent.press(r.getByTestId('your-plan-keep-purchase-1'));
  await waitFor(() => expect(r.getByTestId('your-plan-error')).toBeTruthy());
  expect(r.getByTestId('your-plan-error').props.children[0]).toMatch(/email support/i);
  expect(r.queryByRole('button', { name: /Email support/i })).not.toBeNull();
});

it('C-344-3: a held successful action does not launch a fresh list read after unmount', async () => {
  const held = deferred<{ data: typeof PLAN }>();
  mockGet.mockResolvedValue(response(ENDING));
  mockPost.mockImplementation(() => held.promise);
  const r = await render(<YourPlansPanel />);
  await waitFor(() => expect(r.getByTestId('your-plan-keep-purchase-1')).toBeTruthy());
  await fireEvent.press(r.getByTestId('your-plan-keep-purchase-1'));
  await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
  await r.unmount();
  await act(async () => { held.resolve({ data: PLAN }); await held.promise; });
  expect(mockGet).toHaveBeenCalledTimes(1);
});
