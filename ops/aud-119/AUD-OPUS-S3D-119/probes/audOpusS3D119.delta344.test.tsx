/**
 * AUD-OPUS-S3D-119 probe (Claude Opus 5.5 lens, agent 119) — mobile #344 @ bc4387ac (FIX ROUND 5 delta).
 * Probe only; never merged. Real YourPlansPanel, planActions and packagePayment; only the network,
 * theme and Sentry are mocked. Plan views follow backend R2 planView (subscription-plan.ts @23d2c04c)
 * and the cancel replies follow D4 client-billing.service.ts @06307883 (cancelAtPeriodEnd persists
 * cancel_at_period_end before replying; endAccessNow sets status canceled).
 *   D1 2A ended receipt survives the post-cancel read that lists the plan as ended (card stays).
 *   D2 paid-meanwhile receipt survives the post-cancel read (active + cancel_at_period_end).
 *   D3 a list read started before End my plan and answered after it never overwrites the receipt.
 *   D4 a trial receipt is kept through a failed read, then dropped when a newer read shows renewing.
 *   D5 stale gate also covers a past_due card (no POST, no destructive button) and an offline failure.
 *   D6 trial whose scheduled end is after the trial end (converted) gets the paid wording.
 *   D7 copy rules over the new strings and both outcome wordings.
 *   D8 EVIDENCE the consent dialog body on a trialing plan.
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
const LATER_END = '2026-12-02T12:00:00.000Z';
function planView(state: string, overrides: Record<string, unknown> = {}) {
  return {
    purchase_id: PURCHASE, package_id: 'pkg-monthly', package_name: 'Monthly coaching', coach_user_id: 'coach-1',
    state, status: state, entitlement_active: state !== 'ended' && state !== 'confirming',
    amount_cents: 9900, currency: 'usd', interval: 'month', interval_count: 1,
    current_period_end: PERIOD_END, next_charge_at: state === 'ended' || state === 'trialing' ? null : PERIOD_END,
    cancel_at_period_end: false, access_ends_at: null, trial_days: 0,
    trial_ends_at: state === 'trialing' ? PERIOD_END : null,
    can_cancel: ['active', 'trialing', 'past_due'].includes(state), can_resume: false, can_resubscribe: state === 'ended',
    last_payment_error: null, checkout_state: null,
    ...overrides,
  };
}
const ENDED_VIEW = planView('ended', { status: 'canceled', access_ends_at: '2026-10-04T21:00:00.000Z', can_cancel: false });
const SCHEDULED_VIEW = (state: string) =>
  planView(state, { cancel_at_period_end: true, next_charge_at: null, access_ends_at: PERIOD_END, can_cancel: false, can_resume: true });
function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers: { 'x-request-id': 'req-7f3a9c21-aaaa' } },
    config: { headers: { 'X-Request-Id': 'req-7f3a9c21-aaaa' } },
  });
}
const offlineError = () => Object.assign(new Error('Network Error'), { request: {}, config: { headers: {} } });
const reply = (o: Record<string, unknown>) => ({
  data: { purchase_id: PURCHASE, voided_invoice_count: 0, voided_amount_cents: 0, currency: 'usd', paid_period_kept: false, message: 'x', ...o },
});
let lists: unknown[] = [];
const listCalls = () => mockGet.mock.calls.filter((c) => c[0] === '/v1/checkout/subscriptions').length;
function confirmDestructive() {
  return jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons) => {
    (buttons ?? []).find((b) => b.style === 'destructive')?.onPress?.();
  });
}
const lineOf = (r: Awaited<ReturnType<typeof render>>) =>
  String(r.getByTestId(`your-plan-line-${PURCHASE}`).props.children);

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  lists = [[planView('active')]];
  mockGet.mockImplementation(async (url: string) => {
    if (url === '/v1/checkout/subscriptions') {
      const next = lists.length > 1 ? lists.shift() : lists[0];
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return (next as () => Promise<unknown>)();
      return { data: { plans: next } };
    }
    throw httpError(404, { error: 'Not Found' });
  });
});

describe('D1 2A ended receipt vs the post-cancel read', () => {
  it('keeps the voided-amount line and the card when the read lists the plan as ended', async () => {
    lists = [[planView('active')], [ENDED_VIEW]];
    mockPost.mockResolvedValue(reply({ outcome: 'ended', access_ends_at: '2026-10-04T21:00:00.000Z', voided_amount_cents: 9900, voided_invoice_count: 1 }));
    confirmDestructive();
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    await waitFor(() => expect(listCalls()).toBe(2));
    await waitFor(() => expect(lineOf(r)).toMatch(/^This plan has ended, and access ended today\. The unpaid \$99\.00 is canceled/));
    expect(r.queryByTestId('your-plans-stale')).toBeNull();
  });
});

describe('D2 paid-meanwhile receipt vs the post-cancel read', () => {
  it('keeps the paid-period line when the read shows active with cancel_at_period_end', async () => {
    lists = [[planView('past_due')], [SCHEDULED_VIEW('active')]];
    mockPost.mockResolvedValue(reply({ outcome: 'scheduled', access_ends_at: PERIOD_END, paid_period_kept: true }));
    confirmDestructive();
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    await waitFor(() => expect(listCalls()).toBe(2));
    await waitFor(() => expect(lineOf(r)).toMatch(/^The latest payment went through before the plan ended/));
  });
});

describe('D3 a slow read answered after End my plan', () => {
  it('never overwrites the receipt or brings back End my plan', async () => {
    let release: (v: unknown) => void = () => undefined;
    const slow = () => new Promise((res) => { release = res; });
    lists = [[planView('trialing')], slow, [SCHEDULED_VIEW('trialing')]];
    mockPost.mockResolvedValue(reply({ outcome: 'scheduled', access_ends_at: PERIOD_END }));
    confirmDestructive();
    const r = await render(<YourPlansPanel reloadKey={0} />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    // a pull-to-refresh style reload that hangs; reloadKey change also clears receipts, so use the same key path:
    await r.rerender(<YourPlansPanel reloadKey={1} />);
    await waitFor(() => expect(listCalls()).toBe(2));
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    await waitFor(() => expect(listCalls()).toBe(3));
    await waitFor(() => expect(lineOf(r)).toBe('Your free trial ends on November 2, 2026, and nothing is charged.'));
    release({ data: { plans: [planView('trialing')] } });
    await new Promise((res) => setTimeout(res, 20));
    expect(lineOf(r)).toBe('Your free trial ends on November 2, 2026, and nothing is charged.');
    expect(r.queryByTestId(`your-plan-end-${PURCHASE}`)).toBeNull();
  });
});

describe('D4 trial receipt through failure, then superseded', () => {
  it('kept while reads fail, dropped when a newer read shows the trial renewing again', async () => {
    lists = [[planView('trialing')], httpError(503, { code: 'X_DOWN' }), httpError(503, { code: 'X_DOWN' }), [planView('trialing')]];
    mockPost.mockResolvedValue(reply({ outcome: 'scheduled', access_ends_at: PERIOD_END }));
    confirmDestructive();
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    await waitFor(() => expect(r.getByTestId('your-plans-stale')).toBeTruthy());
    expect(lineOf(r)).toBe('Your free trial ends on November 2, 2026, and nothing is charged.');
    await fireEvent.press(r.getByTestId('your-plans-retry'));
    await waitFor(() => expect(listCalls()).toBe(3));
    expect(lineOf(r)).toBe('Your free trial ends on November 2, 2026, and nothing is charged.');
    await fireEvent.press(r.getByTestId('your-plans-retry'));
    await waitFor(() => expect(lineOf(r)).toBe('Free trial until November 2, 2026, then $99.00 a month.'));
  });
});

describe('D5 stale gate', () => {
  it.each([
    ['past_due 503', planView('past_due'), httpError(503, { code: 'X_DOWN' })],
    ['active offline', planView('active'), offlineError()],
    ['trialing 500', planView('trialing'), httpError(500, { code: 'INTERNAL' })],
  ])('%s: End my plan sends nothing and offers a refresh', async (_n, plan, err) => {
    lists = [[plan], err, err];
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const r = await render(<YourPlansPanel reloadKey={0} />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await r.rerender(<YourPlansPanel reloadKey={1} />);
    await waitFor(() => expect(r.getByTestId('your-plans-stale')).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    expect(alert.mock.calls[0][0]).toBe('Refresh your plans first');
    expect((alert.mock.calls[0][2] ?? []).some((b) => b.style === 'destructive')).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('D6 converted trial', () => {
  it('a scheduled end after the trial end gets the paid wording', async () => {
    lists = [[planView('trialing')], [SCHEDULED_VIEW('active')]];
    mockPost.mockResolvedValue(reply({ outcome: 'scheduled', access_ends_at: LATER_END }));
    confirmDestructive();
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    await waitFor(() => expect(listCalls()).toBe(2));
    await waitFor(() => expect(lineOf(r)).toBe('Your plan will not renew. Access continues until December 2, 2026, and nothing more is charged.'));
  });
});

describe('D7 copy rules on the round-5 strings', () => {
  const Y = panelModule.YOUR_PLANS_COPY;
  const o = { outcome: 'scheduled', accessEndsAt: PERIOD_END, voidedAmountCents: 0, currency: 'usd', paidPeriodKept: false } as const;
  const strings = [
    Y.staleTitle, Y.staleBody, Y.staleRefresh, Y.endConfirmBody('November 2, 2026'), Y.endConfirmBody(null),
    actions.PLAN_ACTION_COPY.outcome(o, true), actions.PLAN_ACTION_COPY.outcome(o, false),
    actions.PLAN_ACTION_COPY.outcome({ ...o, accessEndsAt: null }, true),
  ];
  it.each(strings.map((s) => [s]))('%s', (s) => {
    expect(s).not.toMatch(/\b(we|our|us|I)\b/i);
    expect(s).not.toMatch(/!/);
    expect(s).not.toMatch(/undefined|null|NaN/);
    expect(s).not.toMatch(/paid for/);
  });
});

describe('D8 EVIDENCE trial consent dialog', () => {
  it('records the body', async () => {
    lists = [[planView('trialing')]];
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const r = await render(<YourPlansPanel />);
    await waitFor(() => expect(r.getByTestId(`your-plan-end-${PURCHASE}`)).toBeTruthy());
    await fireEvent.press(r.getByTestId(`your-plan-end-${PURCHASE}`));
    // eslint-disable-next-line no-console
    console.log(`D8 trial consent: ${alert.mock.calls[0][0]} | ${alert.mock.calls[0][1]}`);
    expect(alert.mock.calls[0][1]).toMatch(/until November 2, 2026/);
  });
});
