/**
 * AUD-OPUS-S123-119 probe (Claude Opus 5.5 lens, agent 119) — mobile #344 @ 7e17d142.
 * Probe only; never merged. Real YourPlansPanel, planActions and packagePayment;
 * only the network, theme and Sentry are mocked.
 *   P1 FINDING  a free trial ended with End my plan: the outcome line must not
 *               say the client paid for the period (nothing was ever charged).
 *   P2 EVIDENCE a dispute-paused plan as backend D2c #705 + R2 #679 planView
 *               emit it (Stripe status active, entitlement false -> state
 *               'confirming', no actions): what the card says.
 *   P3 copy rules over every Your plans / plan-action / list string.
 *   P4 control  2A outcome in a zero-decimal currency: whole yen, never /100.
 *   P5 control  a failed Keep my plan retries with the same key; success
 *               shows the canonical view even when the refresh read fails.
 *   P6 EVIDENCE scheduled outcome wording on a paid active plan.
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
const panelModule = require('../purchase/YourPlansPanel') as typeof import('../purchase/YourPlansPanel');
const YourPlansPanel = panelModule.default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const actions = require('../../lib/planActions') as typeof import('../../lib/planActions');

const PURCHASE = '0f0e0d0c-0b0a-4908-8706-050403020100';
const PERIOD_END = '2026-11-02T12:00:00.000Z';
function planView(state: string, overrides: Record<string, unknown> = {}) {
  return {
    purchase_id: PURCHASE, package_id: 'pkg-monthly', package_name: 'Monthly coaching', coach_user_id: 'coach-1',
    state, status: state, entitlement_active: state !== 'ended' && state !== 'confirming',
    amount_cents: 9900, currency: 'usd', interval: 'month', interval_count: 1,
    current_period_end: PERIOD_END, next_charge_at: state === 'ended' ? null : PERIOD_END,
    cancel_at_period_end: false, access_ends_at: null, trial_days: 0,
    trial_ends_at: state === 'trialing' ? PERIOD_END : null,
    can_cancel: ['active', 'trialing', 'past_due'].includes(state), can_resume: false, can_resubscribe: state === 'ended',
    last_payment_error: null, checkout_state: null,
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
function confirmDestructive() {
  return jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons) => {
    (buttons ?? []).find((b) => b.style === 'destructive')?.onPress?.();
  });
}
const lineOf = (r: Awaited<ReturnType<typeof render>>) =>
  String(r.getByTestId(`your-plan-line-${PURCHASE}`).props.children);

beforeEach(() => {
  jest.clearAllMocks();
  lists = [[planView('active')]];
  mockGet.mockImplementation(async (url: string) => {
    if (url === '/v1/checkout/subscriptions') {
      const next = lists.length > 1 ? lists.shift() : lists[0];
      if (next instanceof Error) throw next;
      return { data: { plans: next } };
    }
    throw httpError(404, { error: 'Not Found' });
  });
});

describe('P1 FINDING ending a free trial', () => {
  it('the scheduled outcome never says the period was paid for', async () => {
    lists = [
      [planView('trialing', { trial_days: 7 })],
      [planView('trialing', { trial_days: 7, cancel_at_period_end: true, next_charge_at: null, access_ends_at: PERIOD_END, can_cancel: false, can_resume: true })],
    ];
    mockPost.mockImplementation(async () => ({
      data: {
        outcome: 'scheduled', purchase_id: PURCHASE, access_ends_at: PERIOD_END, voided_invoice_count: 0,
        voided_amount_cents: 0, currency: 'usd', paid_period_kept: false, message: 'x',
      },
    }));
    const spy = confirmDestructive();
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    await waitFor(() => expect(mockGet.mock.calls.length).toBe(2));
    const line = lineOf(r);
    // eslint-disable-next-line no-console
    console.log(`P1 trial outcome line: ${line}`);
    expect(line).not.toMatch(/paid for/);
    spy.mockRestore();
  });
});

describe('P2 EVIDENCE dispute-paused plan (R-DISPUTE-PAUSE) as the backend lists it today', () => {
  it('records the card line and actions', async () => {
    lists = [[planView('confirming', { status: 'active', entitlement_active: false, can_cancel: false, can_resume: false, next_charge_at: null })]];
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-line-${PURCHASE}`)).toBeTruthy());
    const line = lineOf(r);
    // eslint-disable-next-line no-console
    console.log(`P2 dispute-paused card line: ${line}`);
    expect(line).toBe('Confirming this plan with Stripe. It shows here within a minute.');
    expect(r.queryByTestId(`your-plan-end-${PURCHASE}`)).toBeNull();
    expect(r.queryByTestId(`your-plan-keep-${PURCHASE}`)).toBeNull();
  });
});

describe('P3 copy rules', () => {
  const strings: string[] = [];
  const Y = panelModule.YOUR_PLANS_COPY as Record<string, unknown>;
  const A = actions.PLAN_ACTION_COPY as Record<string, unknown>;
  const L = actions.PLANS_LIST_COPY as Record<string, unknown>;
  const outcomes = [
    { outcome: 'ended', accessEndsAt: PERIOD_END, voidedAmountCents: 9900, currency: 'usd', paidPeriodKept: false },
    { outcome: 'ended', accessEndsAt: PERIOD_END, voidedAmountCents: 0, currency: null, paidPeriodKept: false },
    { outcome: 'scheduled', accessEndsAt: PERIOD_END, voidedAmountCents: 0, currency: 'usd', paidPeriodKept: true },
    { outcome: 'scheduled', accessEndsAt: null, voidedAmountCents: 0, currency: 'usd', paidPeriodKept: false },
    { outcome: 'already_ended', accessEndsAt: null, voidedAmountCents: 0, currency: 'usd', paidPeriodKept: false },
  ] as const;
  for (const src of [Y, A, L]) {
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'string') strings.push(v);
      else if (typeof v === 'function' && k !== 'outcome') {
        for (const arg of [['cancel', 'abcd1234'], ['resume', null], ['November 2, 2026', null], ['$99.00', 'November 2, 2026']])
          strings.push(String((v as (...a: unknown[]) => unknown)(...arg)));
      }
    }
  }
  for (const o of outcomes) strings.push(actions.PLAN_ACTION_COPY.outcome(o as never));
  it.each(strings.map((s) => [s]))('%s', (s) => {
    expect(s).not.toMatch(/\b(we|our|us|I)\b/i);
    expect(s).not.toMatch(/!/);
    expect(s).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(s).not.toMatch(/undefined|null|NaN/);
  });
});

describe('P4 control 2A outcome in a zero-decimal currency', () => {
  it('JPY voided amount is whole yen', () => {
    const s = actions.PLAN_ACTION_COPY.outcome({ outcome: 'ended', accessEndsAt: null, voidedAmountCents: 500, currency: 'jpy', paidPeriodKept: false });
    expect(s).toMatch(/500/);
    expect(s).not.toMatch(/5\.00/);
  });
});

describe('P5 control Keep my plan', () => {
  it('a failed resume retries with the same key; success shows the canonical view though the refresh fails', async () => {
    const scheduled = planView('active', { cancel_at_period_end: true, next_charge_at: null, access_ends_at: PERIOD_END, can_cancel: false, can_resume: true });
    lists = [[scheduled], [scheduled], httpError(503, { error: 'SERVICE_UNAVAILABLE' }) as never];
    let n = 0;
    mockPost.mockImplementation(async () => {
      n += 1;
      if (n === 1) throw httpError(503, { code: 'PLAN_CHANGE_RESULT_UNKNOWN', error: 'PLAN_CHANGE_RESULT_UNKNOWN' });
      return { data: planView('active') };
    });
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-keep-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-keep-${PURCHASE}`));
    await waitFor(() => expect(r.getByTestId('your-plan-error')).toBeTruthy());
    await waitFor(() => expect(r.getByTestId(`your-plan-keep-${PURCHASE}`).props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(r.getByTestId(`your-plan-keep-${PURCHASE}`));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    const keys = mockPost.mock.calls.map((c) => (c[1] as { idempotency_key: string }).idempotency_key);
    expect(keys[0]).toBe(keys[1]);
    await waitFor(() => expect(lineOf(r)).toMatch(/^Next charge of/));
    expect(lineOf(r)).not.toMatch(/Nothing more is charged/);
  });
});

describe('P6 EVIDENCE scheduled outcome wording on a paid plan', () => {
  it('records the line', () => {
    const s = actions.PLAN_ACTION_COPY.outcome({ outcome: 'scheduled', accessEndsAt: PERIOD_END, voidedAmountCents: 0, currency: 'usd', paidPeriodKept: false });
    // eslint-disable-next-line no-console
    console.log(`P6 scheduled line: ${s}`);
    expect(s).toMatch(/^Your plan is ended\. Access continues until/);
  });
});
