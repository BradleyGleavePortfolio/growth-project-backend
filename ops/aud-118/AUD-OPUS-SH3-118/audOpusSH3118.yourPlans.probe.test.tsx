/**
 * AUD-OPUS-SH3-118 probe (Claude Opus 5.5 lens, agent 118) — mobile #344 @ e7fcc5d2.
 * Probe only; never merged. Real YourPlansPanel, real packagePayment copy;
 * only the network, theme and Sentry are mocked.
 *
 *   B-344-1  End my plan on a plan in dunning (state past_due, can_cancel true,
 *            backend #628 / D4 #690 runDunningCancel = owner ruling 2A: void the
 *            open invoice and end access NOW). The confirmation must not promise
 *            access until the period end, and the ended-now outcome must be told.
 *   B-344-2  A failed End my plan says what happened to the PLAN and offers a
 *            working support path (Email support + reference) for an unknown
 *            failure; offline copy never talks about a payment that "did not start".
 *   Controls: an active plan keeps the period-end copy; PLAN_ALREADY_ENDED copy.
 */
import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../theme/ThemeProvider', () => {
  const realTokens = jest.requireActual('../../theme/tokens').default;
  return {
    useTheme: () => ({ tokens: realTokens, semanticColors: realTokens.lightTokens, colorScheme: 'light' }),
  };
});
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const YourPlansPanel: typeof import('../purchase/YourPlansPanel').default = require('../purchase/YourPlansPanel').default;

const PURCHASE = '0f0e0d0c-0b0a-4908-8706-050403020100';
function planView(state: string, overrides: Record<string, unknown> = {}) {
  return {
    purchase_id: PURCHASE, package_id: 'pkg-monthly', package_name: 'Monthly coaching', coach_user_id: 'coach-1',
    state, status: state, entitlement_active: state !== 'ended',
    amount_cents: 9900, currency: 'usd', interval: 'month', interval_count: 1,
    current_period_end: '2026-11-02T12:00:00.000Z', next_charge_at: state === 'ended' ? null : '2026-11-02T12:00:00.000Z',
    cancel_at_period_end: false, access_ends_at: null, trial_days: 0, trial_ends_at: null,
    can_cancel: state !== 'ended', can_resume: false, can_resubscribe: state === 'ended',
    last_payment_error: state === 'past_due' ? 'Your last payment did not go through.' : null,
    checkout_state: null,
    ...overrides,
  };
}
function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers: { 'x-request-id': 'req-7f3a9c21-aaaa' } },
    config: { headers: { 'X-Request-Id': 'req-7f3a9c21-aaaa' } },
  });
}
let lists: unknown[][] = [];
function pressEndAndConfirm() {
  return jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons) => {
    (buttons ?? []).find((b) => b.style === 'destructive')?.onPress?.();
  });
}
const allText = (r: ReturnType<typeof render>) =>
  r.toJSON() ? JSON.stringify(r.toJSON()) : '';

beforeEach(() => {
  jest.clearAllMocks();
  lists = [[planView('active')]];
  mockGet.mockImplementation(async (url: string) => {
    if (url === '/v1/checkout/subscriptions') {
      const next = lists.length > 1 ? lists.shift() : lists[0];
      return { data: { plans: next } };
    }
    throw httpError(404, { error: 'Not Found' });
  });
  mockPost.mockImplementation(async () => ({ data: {} }));
});

describe('B-344-1 End my plan during dunning (owner ruling 2A: access ends now)', () => {
  it('the confirmation for a past_due plan does not promise access until the period end', async () => {
    lists = [[planView('past_due')]];
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    const body = String(alertSpy.mock.calls[0][1]);
    expect(body).not.toMatch(/stays active until/);
    alertSpy.mockRestore();
  });

  it('after the backend ends the plan now (outcome ended), the panel tells the client it ended', async () => {
    lists = [[planView('past_due')], [planView('ended', { access_ends_at: '2026-10-04T17:00:00.000Z' })]];
    mockPost.mockImplementation(async (url: string) => {
      if (url === `/v1/checkout/subscriptions/${PURCHASE}/cancel`) {
        return {
          data: {
            outcome: 'ended', purchase_id: PURCHASE, access_ends_at: '2026-10-04T17:00:00.000Z',
            voided_invoice_count: 1, voided_amount_cents: 9900, currency: 'usd', paid_period_kept: false,
            message: 'x',
          },
        };
      }
      throw new Error(`unexpected POST ${url}`);
    });
    const alertSpy = pressEndAndConfirm();
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    await waitFor(() => expect(mockGet.mock.calls.filter((c) => c[0] === '/v1/checkout/subscriptions').length).toBe(2));
    // Some confirmation of what happened must remain on screen.
    expect(allText(r)).toMatch(/ended/i);
    alertSpy.mockRestore();
  });
});

describe('B-344-2 a failed plan action says what happened to the plan, with a working next action', () => {
  it('an unknown failure (Stripe error on cancel) offers Email support with a reference', async () => {
    mockPost.mockImplementation(async () => {
      throw httpError(502, { code: 'STRIPE_REQUEST_FAILED', error: 'STRIPE_REQUEST_FAILED', message: 'x' });
    });
    const alertSpy = pressEndAndConfirm();
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    await waitFor(() => expect(r.getByTestId('your-plan-error')).toBeTruthy());
    expect(allText(r)).toMatch(/req-7f3a/);
    expect(r.queryByText('Email support')).toBeTruthy();
    alertSpy.mockRestore();
  });

  it('offline: the copy is about the plan change, not a payment that did not start', async () => {
    mockPost.mockImplementation(async () => {
      throw Object.assign(new Error('Network Error'), { config: { headers: {} } });
    });
    const alertSpy = pressEndAndConfirm();
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    await waitFor(() => expect(r.getByTestId('your-plan-error')).toBeTruthy());
    expect(allText(r)).not.toMatch(/payment did not start/);
    alertSpy.mockRestore();
  });

  it('recurring deployed without the cancel route (bare Nest 404): the copy says the plan did not change, not that the result is unconfirmed', async () => {
    mockPost.mockImplementation(async (url: string) => {
      throw httpError(404, { statusCode: 404, message: `Cannot POST ${url}`, error: 'Not Found' });
    });
    const alertSpy = pressEndAndConfirm();
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    await waitFor(() => expect(r.getByTestId('your-plan-error')).toBeTruthy());
    expect(allText(r)).not.toMatch(/not confirmed yet/);
    alertSpy.mockRestore();
  });
});

describe('controls (expected to pass at the PR head)', () => {
  it('today\'s production backend (no GET /v1/checkout/subscriptions, bare 404): the panel stays hidden', async () => {
    mockGet.mockImplementation(async () => {
      throw httpError(404, { statusCode: 404, message: 'Cannot GET /v1/checkout/subscriptions', error: 'Not Found' });
    });
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/v1/checkout/subscriptions'));
    expect(r.queryByTestId('your-plans')).toBeNull();
  });
  it('an active plan keeps the period-end confirmation', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    expect(String(alertSpy.mock.calls[0][1])).toBe(
      'Your plan stays active until November 2, 2026, and nothing more is charged after that.',
    );
    alertSpy.mockRestore();
  });

  it('a past_due plan shows the past-due line and still offers End my plan (can_cancel from the backend)', async () => {
    lists = [[planView('past_due')]];
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    expect(allText(r)).toMatch(/The last payment did not go through/);
  });

  it('PLAN_ALREADY_ENDED on Keep my plan gets its own copy', async () => {
    lists = [[planView('active', { cancel_at_period_end: true, can_cancel: false, can_resume: true, next_charge_at: null, access_ends_at: '2026-11-02T12:00:00.000Z' })]];
    mockPost.mockImplementation(async () => {
      throw httpError(409, { code: 'PLAN_ALREADY_ENDED', error: 'PLAN_ALREADY_ENDED', message: 'x' });
    });
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-keep-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-keep-${PURCHASE}`));
    await waitFor(() => expect(r.getByTestId('your-plan-error')).toBeTruthy());
    expect(allText(r)).toMatch(/This plan has already ended, so nothing changed/);
  });
});
