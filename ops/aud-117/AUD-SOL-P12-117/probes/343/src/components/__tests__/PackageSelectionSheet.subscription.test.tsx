/**
 * B-RECUR-MOB (agent 114): renewing plans are SOLD from the Day 1 package
 * sheet as real subscriptions through the native, TGP-themed PaymentSheet
 * (OR-113-1), never refused and never sold as a one-off PaymentIntent.
 *
 * Failing before (PR #334 @ 5b6eb654): the sheet refused every renewing
 * plan with "Plans that renew each month or year are started from
 * Membership..." and never called POST /v1/checkout/subscription-intent.
 *
 * Backend contract: growth-project-backend #654 (agent/clinic/b-recur-subscriptions)
 *   POST /v1/checkout/subscription-intent { package_id, idempotency_key, expected_amount_cents?, expected_one_time_cents? }
 *     -> { mode: 'payment'|'setup', client_secret, ephemeral_key, customer_id,
 *          publishable_key, purchase_id, subscription_id, status, reused, plan{...} }
 *   GET  /v1/checkout/subscriptions/:purchaseId -> ClientPlanView
 *   GET  /v1/checkout/subscriptions             -> { plans: ClientPlanView[] }
 *
 * Only the network, the Stripe native module, storage, theme and Sentry are
 * mocked; the real sheet, hook and copy run.
 */
import React from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';

const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PKG_MONTHLY = '99999999-8888-4777-8666-555555555555';
const PKG_TRIAL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PKG_COMBO = 'cccccccc-dddd-4eee-8fff-000000000000';
const PURCHASE = '0f0e0d0c-0b0a-4908-8706-050403020100';

jest.mock('../../theme/ThemeProvider', () => {
  const realTokens = jest.requireActual('../../theme/tokens').default;
  return {
    useTheme: () => ({ tokens: realTokens, semanticColors: realTokens.lightTokens, colorScheme: 'light' }),
  };
});
jest.mock('../../storage/mmkv', () => ({
  prefsStorage: { getStringAsync: jest.fn(async () => null), set: jest.fn(async () => undefined) },
}));
jest.mock('../../hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 'client-1', role: 'student' }) }));
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));
const mockGetEntitlement = jest.fn();
jest.mock('../../api/clientPaymentsApi', () => ({
  clientPaymentsApi: { getEntitlement: () => mockGetEntitlement() },
}));
const mockCapture = jest.fn();
jest.mock('../../services/sentry', () => ({ captureError: (...a: unknown[]) => mockCapture(...a) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const mockInitStripe = jest.fn();
const mockInitPaymentSheet = jest.fn();
const mockPresent = jest.fn();
jest.mock('@stripe/stripe-react-native', () => ({
  initStripe: (...a: unknown[]) => mockInitStripe(...a),
  initPaymentSheet: (...a: unknown[]) => mockInitPaymentSheet(...a),
  presentPaymentSheet: (...a: unknown[]) => mockPresent(...a),
  useStripe: () => ({
    initPaymentSheet: (...a: unknown[]) => mockInitPaymentSheet(...a),
    presentPaymentSheet: (...a: unknown[]) => mockPresent(...a),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PackageSelectionSheet: typeof import('../PackageSelectionSheet').default =
  require('../PackageSelectionSheet').default;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { usePackagePurchase }: typeof import('../../hooks/usePackagePurchase') = require('../../hooks/usePackagePurchase');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { purchasableFromCoachPackage }: typeof import('../../lib/planTerms') = require('../../lib/planTerms');

const PACKAGES = [
  { id: PKG_MONTHLY, name: 'Monthly coaching', amount_cents: 9900, currency: 'usd', billing_type: 'recurring', interval: 'month', description: null },
  { id: PKG_TRIAL, name: 'Trial coaching', amount_cents: 4900, currency: 'usd', billing_type: 'recurring', interval: 'month', trial_days: 7, description: null },
  // Combo: one-time setup fee plus a renewing part (recurring_* columns).
  { id: PKG_COMBO, name: 'Kickoff plus monthly', amount_cents: 20000, currency: 'usd', billing_type: 'one_time', interval: null, recurring_amount_cents: 5000, recurring_interval: 'month', description: null },
];

function intent(mode: 'payment' | 'setup', overrides: Record<string, unknown> = {}) {
  return {
    mode,
    client_secret: mode === 'setup' ? 'seti_test_1_secret_zzz' : 'pi_test_sub_secret_yyy',
    ephemeral_key: 'ek_test_sub',
    customer_id: 'cus_test_sub',
    publishable_key: 'pk_test_backend',
    purchase_id: PURCHASE,
    subscription_id: 'sub_test_1',
    status: 'incomplete',
    reused: false,
    plan: {
      amount_cents: 9900, currency: 'usd', interval: 'month', interval_count: 1,
      first_charge_cents: 9900, one_time_cents: 0, trial_days: 0, trial_ends_at: null,
      package_id: PKG_MONTHLY, package_name: 'Monthly coaching',
    },
    ...overrides,
  };
}

function planView(state: string, overrides: Record<string, unknown> = {}) {
  return {
    purchase_id: PURCHASE, package_id: PKG_MONTHLY, package_name: 'Monthly coaching', coach_user_id: 'coach-1',
    state, status: state, entitlement_active: state === 'active' || state === 'trialing',
    amount_cents: 9900, currency: 'usd', interval: 'month', interval_count: 1,
    current_period_end: '2026-11-02T12:00:00.000Z', next_charge_at: '2026-11-02T12:00:00.000Z',
    cancel_at_period_end: false, access_ends_at: null, trial_days: 0, trial_ends_at: null,
    can_cancel: true, can_resume: false, can_resubscribe: false, last_payment_error: null,
    ...overrides,
  };
}

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers: {} },
    config: { headers: {} },
  });
}

function expectCopyRules(text: string) {
  expect(text).not.toMatch(/something went wrong/i);
  expect(text).not.toMatch(/^please try again\.?$/i);
  expect(text).not.toMatch(/try again later/i);
  expect(text).not.toMatch(/!/);
  expect(text).not.toMatch(/\b(we|we're|our|us|I|I'm|me)\b/);
}

let planResponses: unknown[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER;
  delete process.env.EXPO_PUBLIC_GOOGLE_PAY_ENABLED;
  process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_build';
  planResponses = [planView('active')];
  mockGet.mockImplementation(async (url: string) => {
    if (url === '/v1/clients/me/coach/packages') return { data: { packages: PACKAGES } };
    if (url === `/v1/checkout/subscriptions/${PURCHASE}`) {
      const next = planResponses.length > 1 ? planResponses.shift() : planResponses[0];
      return { data: next };
    }
    throw httpError(404, { error: 'Not Found' });
  });
  mockPost.mockImplementation(async (url: string) => {
    if (url === '/v1/checkout/subscription-intent') return { data: intent('payment') };
    throw httpError(404, { error: 'Not Found', message: `Cannot POST ${url}` });
  });
  mockInitStripe.mockResolvedValue(undefined);
  mockInitPaymentSheet.mockResolvedValue({});
  mockPresent.mockResolvedValue({});
  mockGetEntitlement.mockResolvedValue({ ok: true, data: { active: true } });
});

async function mountAndSelect(pkgId = PKG_MONTHLY, props: Record<string, unknown> = {}) {
  const onPaymentSuccess = jest.fn();
  const onDismiss = jest.fn();
  const onOpenPlan = jest.fn();
  const r = await render(
    <PackageSelectionSheet
      visible
      onDismiss={onDismiss}
      onPaymentSuccess={onPaymentSuccess}
      onOpenPlan={onOpenPlan}
      planPollDelaysMs={[0, 0, 0]}
      entitlementPollDelaysMs={[0]}
      {...props}
    />,
  );
  await waitFor(() => expect(r.getByTestId(`package-card-${pkgId}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`package-card-${pkgId}`));
  return { ...r, onPaymentSuccess, onDismiss, onOpenPlan };
}

const subIntentCalls = () => mockPost.mock.calls.filter((c) => c[0] === '/v1/checkout/subscription-intent');
const keysOf = () => subIntentCalls().map((c) => (c[1] as { idempotency_key: string }).idempotency_key);

describe('a renewing plan sells as a subscription', () => {
  it('posts subscription-intent, opens PaymentSheet in payment mode, confirms the plan, shows success', async () => {
    const r = await mountAndSelect();
    // Terms are visible before paying.
    expect(r.getByText(/Renews automatically/)).toBeTruthy();
    expect(r.getByText(/Cancel anytime/)).toBeTruthy();
    expect(r.getByTestId('select-plan-btn').props.accessibilityLabel).toBe('Subscribe for $99.00 a month');

    planResponses = [planView('confirming'), planView('active')];
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());

    expect(mockPost.mock.calls.map((c) => c[0])).toEqual(['/v1/checkout/subscription-intent']);
    const body = subIntentCalls()[0][1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expected_amount_cents', 'expected_one_time_cents', 'idempotency_key', 'package_id']);
    expect(body.expected_one_time_cents).toBe(0);
    expect(body.package_id).toBe(PKG_MONTHLY);
    expect(body.expected_amount_cents).toBe(9900);
    expect(body.idempotency_key).toMatch(IS_UUID);

    const params = mockInitPaymentSheet.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toEqual(
      expect.objectContaining({
        customerId: 'cus_test_sub',
        customerEphemeralKeySecret: 'ek_test_sub',
        paymentIntentClientSecret: 'pi_test_sub_secret_yyy',
        merchantDisplayName: 'The Growth Project',
      }),
    );
    expect(params.setupIntentClientSecret).toBeUndefined();
    expect(params.appearance).toEqual(expect.objectContaining({ colors: expect.any(Object) }));
    // Polled the plan until entitled.
    expect(mockGet.mock.calls.filter((c) => c[0] === `/v1/checkout/subscriptions/${PURCHASE}`).length).toBeGreaterThanOrEqual(2);
    expect(r.getByText('Your plan is active')).toBeTruthy();
    expect(r.onPaymentSuccess).not.toHaveBeenCalled();
    await fireEvent.press(r.getByTestId('payment-continue'));
    expect(r.onPaymentSuccess).toHaveBeenCalledTimes(1);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('a combo plan (one-time part + renewing part) goes to subscription-intent and shows both charges', async () => {
    mockPost.mockImplementation(async () => ({
      data: intent('payment', {
        plan: { ...intent('payment').plan, amount_cents: 5000, first_charge_cents: 25000, one_time_cents: 20000, package_id: PKG_COMBO },
      }),
    }));
    const r = await mountAndSelect(PKG_COMBO);
    expect(r.getByTestId('select-plan-btn').props.accessibilityLabel).toMatch(/\$250\.00 today/);
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    expect(subIntentCalls()).toHaveLength(1);
    expect(mockPost.mock.calls.some((c) => c[0] === '/v1/checkout/payment-intent')).toBe(false);
  });

  it('a trial uses PaymentSheet setup mode and states the first charge date', async () => {
    mockPost.mockImplementation(async () => ({
      data: intent('setup', {
        plan: { ...intent('setup').plan, amount_cents: 4900, first_charge_cents: 0, trial_days: 7, trial_ends_at: '2026-10-10T12:00:00.000Z', package_id: PKG_TRIAL, package_name: 'Trial coaching' },
      }),
    }));
    planResponses = [planView('trialing', { package_id: PKG_TRIAL, package_name: 'Trial coaching', amount_cents: 4900, trial_days: 7, trial_ends_at: '2026-10-10T12:00:00.000Z' })];
    const r = await mountAndSelect(PKG_TRIAL);
    expect(r.getByTestId('select-plan-btn').props.accessibilityLabel).toBe('Start free trial');
    expect(r.getByText(/Free for 7 days, then your first charge of \$49\.00/)).toBeTruthy();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    const params = mockInitPaymentSheet.mock.calls[0][0] as Record<string, unknown>;
    expect(params.setupIntentClientSecret).toBe('seti_test_1_secret_zzz');
    expect(params.paymentIntentClientSecret).toBeUndefined();
    expect(params.primaryButtonLabel).toBe('Start free trial');
    expect(r.getByText('Your trial has started')).toBeTruthy();
    expect(r.getAllByText(/October 10, 2026/).length).toBeGreaterThan(0);
  });

  it('a mode/secret mismatch (setup mode with a pi_ secret) is never handed to the sheet', async () => {
    mockPost.mockImplementation(async () => ({ data: intent('setup', { client_secret: 'pi_wrong_secret_x' }) }));
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('pi_wrong_secret_x');
  });
});

describe('confirming the plan', () => {
  it('poll timeout shows the calm slow state; Check again finishes when the plan lands', async () => {
    planResponses = [planView('confirming')];
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-confirm-slow')).toBeTruthy());
    const slow = r.getByText(/Stripe is still confirming your plan/);
    expectCopyRules(String(slow.props.children));
    expect(r.queryByTestId('payment-error')).toBeNull();
    expect(r.onPaymentSuccess).not.toHaveBeenCalled();

    planResponses = [planView('active')];
    await fireEvent.press(r.getByTestId('payment-check-again'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
  });

  it('a failed first charge says so plainly', async () => {
    planResponses = [planView('payment_failed')];
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    expect(r.getByTestId('payment-error').props.children).toBe(
      'Your card was not charged for this plan. Start again with a different card, or ask your bank about the payment.',
    );
  });
});

describe('one attempt, one key', () => {
  it('a double tap creates exactly one subscription attempt (the in-flight guard, before any re-render)', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockPost.mockImplementationOnce(() => new Promise((res) => { release = res; }));
    const pkg = purchasableFromCoachPackage(PACKAGES[0]);
    if (!pkg) throw new Error('fixture');
    const { result } = await renderHook(() =>
      usePackagePurchase({
        surface: 'sheet',
        appearance: {},
        colorScheme: 'light',
        planPollDelaysMs: [0],
        entitlementPollDelaysMs: [0],
      }),
    );
    await act(async () => {
      const first = result.current.start(pkg);
      const second = result.current.start(pkg);
      const third = result.current.start(pkg);
      release({ data: intent('payment') });
      await Promise.all([first, second, third]);
    });
    expect(subIntentCalls()).toHaveLength(1);
    expect(mockInitPaymentSheet).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe('success');
  });

  it('the sheet button is disabled while the attempt runs', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockPost.mockImplementationOnce(() => new Promise((res) => { release = res; }));
    const r = await mountAndSelect();
    const press = fireEvent.press(r.getByTestId('select-plan-btn'));
    await Promise.resolve();
    await Promise.resolve();
    await waitFor(() => expect(r.getByTestId('select-plan-btn').props.accessibilityState.disabled).toBe(true));
    await act(async () => {
      release({ data: intent('payment') });
      await press;
    });
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    expect(subIntentCalls()).toHaveLength(1);
  });

  it('cancel shows nothing alarming and the retry reuses the key; decline also keeps the key', async () => {
    mockPresent
      .mockResolvedValueOnce({ error: { code: 'Canceled', message: 'canceled' } })
      .mockResolvedValueOnce({ error: { code: 'Failed', declineCode: 'generic_decline', type: 'card_error' } });
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(mockPresent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(r.getByTestId('select-plan-btn').props.accessibilityState.disabled).toBe(false));
    expect(r.queryByTestId('payment-error')).toBeNull();

    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    expect(r.getByTestId('payment-error').props.children).toBe(
      'Your bank declined this card, so nothing was charged. Start again with a different card, or ask your bank about the decline.',
    );

    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    const keys = keysOf();
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('a network failure keeps the key for the retry', async () => {
    mockPost.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { config: {} }));
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    expect(r.getByTestId('payment-error').props.children).toBe(
      'This phone is offline, so the payment did not start and nothing was charged. Check your connection, then start again.',
    );
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    expect(new Set(keysOf()).size).toBe(1);
  });
});

describe('every backend code has its own calm copy and next action', () => {
  const cases: Array<[string, number, string]> = [
    ['PACKAGE_NOT_FOUND', 404, 'This plan is no longer offered, so nothing was charged. Pull down to see your coach’s current plans, or message your coach.'],
    ['CLIENT_NOT_FOUND', 404, 'Your account could not be found, so nothing was charged. Sign out, sign back in, then choose your plan.'],
    ['COACH_NOT_CONNECTED', 409, 'Your coach has not set up card payments yet, so this plan cannot start and nothing was charged. Message your coach, then choose the plan once they are set up.'],
    ['COACH_NOT_PAYOUT_READY', 409, 'Your coach cannot take card payments right now, so this plan cannot start and nothing was charged. Message your coach, then choose the plan once they are ready.'],
    ['CONTRACT_SIGNATURE_REQUIRED', 409, 'This plan needs a signed coaching agreement before payment, so nothing was charged. Message your coach for the agreement, then choose the plan again.'],
    ['PACKAGE_INTERVAL_INVALID', 409, 'This plan has no valid billing period, so it cannot start and nothing was charged. Message your coach to fix the plan.'],
    ['ONE_TIME_REQUIRES_PAYMENT_INTENT', 409, 'Your coach changed how this plan is billed, so nothing was charged. The plan now shows its current terms. Review them, then start again.'],
    ['PAYMENT_IN_PROGRESS', 503, 'This payment is still being set up. Wait a few seconds, then start again. You will not be charged twice.'],
  ];

  it.each(cases)('%s', async (code, status, copy) => {
    mockPost.mockRejectedValueOnce(httpError(status, { statusCode: status, code, error: code, message: 'x' }));
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    const text = r.getByTestId('payment-error').props.children as string;
    expect(text).toBe(copy);
    expectCopyRules(text);
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
  });

  it.each([
    ['SUBSCRIPTION_SETUP_UNAVAILABLE', 503],
    ['STRIPE_CHECKOUT_ERROR', 502],
    ['CONNECT_NOT_CONFIGURED', 503],
  ])('%s: a short reference, a support path and a Sentry report without secrets', async (code, status) => {
    mockPost.mockRejectedValueOnce(httpError(status, { code, error: code, message: 'x', request_id: 'abcd1234-ffff' }));
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    expectCopyRules(r.getByTestId('payment-error').props.children as string);
    expect(r.getByTestId('payment-error-reference').props.children).toBe('Reference abcd1234');
    expect(r.getByTestId('payment-support')).toBeTruthy();
    expect(mockCapture).toHaveBeenCalled();
    expect(JSON.stringify(mockCapture.mock.calls)).not.toMatch(/secret|ek_test|seti_|pi_test/);
  });

  it('PACKAGE_PRICE_CHANGED (price in the body) shows the new price; confirming reuses the same key', async () => {
    mockPost
      .mockRejectedValueOnce(
        httpError(409, { code: 'PACKAGE_PRICE_CHANGED', error: 'PACKAGE_PRICE_CHANGED', message: 'x', amount_cents: 12900, currency: 'usd' }),
      )
      // The confirmed attempt answers the price the client confirmed (B-334-4 checks it).
      .mockResolvedValueOnce({ data: intent('payment', { plan: { ...intent('payment').plan, amount_cents: 12900, first_charge_cents: 12900 } }) });
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('price-changed')).toBeTruthy());
    expect(r.getByText('The price of this plan changed from $99.00 to $129.00. Nothing was charged. Confirm the new price to continue.')).toBeTruthy();
    expect(r.queryByTestId('select-plan-btn')).toBeNull();
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();

    await fireEvent.press(r.getByTestId('price-confirm-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    const calls = subIntentCalls().map((c) => c[1] as { idempotency_key: string; expected_amount_cents: number });
    expect(calls).toHaveLength(2);
    expect(calls[1].expected_amount_cents).toBe(12900);
    expect(calls[0].idempotency_key).toBe(calls[1].idempotency_key);
  });

  it('PACKAGE_PRICE_CHANGED with the price stripped by the error envelope reads the package again', async () => {
    mockPost.mockRejectedValueOnce(httpError(409, { code: 'PACKAGE_PRICE_CHANGED', error: 'PACKAGE_PRICE_CHANGED', message: 'x' }));
    const base = mockGet.getMockImplementation();
    mockGet.mockImplementation(async (url: string) => {
      if (url === `/v1/clients/me/coach/packages/${PKG_MONTHLY}`) {
        return { data: { ...PACKAGES[0], amount_cents: 11900 } };
      }
      return base ? base(url) : undefined;
    });
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('price-changed')).toBeTruthy());
    expect(r.getByText(/from \$99\.00 to \$119\.00/)).toBeTruthy();
  });

  it('SUBSCRIPTION_ALREADY_ACTIVE routes to the plan (found through the plans list when the body has no id)', async () => {
    mockPost.mockRejectedValueOnce(httpError(409, { code: 'SUBSCRIPTION_ALREADY_ACTIVE', error: 'SUBSCRIPTION_ALREADY_ACTIVE', message: 'x' }));
    const base = mockGet.getMockImplementation();
    mockGet.mockImplementation(async (url: string) => {
      if (url === '/v1/checkout/subscriptions') return { data: { plans: [planView('active')] } };
      return base ? base(url) : undefined;
    });
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-open-plan')).toBeTruthy());
    expect(r.getByTestId('payment-error').props.children).toBe(
      'You already have this plan, so nothing more was charged. Open your plan to see your next charge date.',
    );
    await fireEvent.press(r.getByTestId('payment-open-plan'));
    expect(r.onOpenPlan).toHaveBeenCalledWith(PURCHASE);
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
  });
});

// B-RECUR-BE (agent 114), Opus B-334-1: every code backend #654 can answer has
// its own copy and next action, and an expired attempt never strands the
// client on a dead idempotency key. Failing before at 3fc925d4.
describe('backend #654 round 1 codes', () => {
  const expired = () =>
    httpError(409, { code: 'SUBSCRIPTION_ATTEMPT_EXPIRED', error: 'SUBSCRIPTION_ATTEMPT_EXPIRED', message: 'x' });

  it('SUBSCRIPTION_ATTEMPT_EXPIRED: starts once more with a fresh key and sells the plan', async () => {
    mockPost.mockRejectedValueOnce(expired());
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    const keys = keysOf();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toMatch(IS_UUID);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('SUBSCRIPTION_ATTEMPT_EXPIRED twice: specific copy, and the next tap uses a new key (never the dead one)', async () => {
    mockPost.mockRejectedValueOnce(expired()).mockRejectedValueOnce(expired());
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    const text = r.getByTestId('payment-error').props.children as string;
    expect(text).toBe(
      'That checkout ended before it finished, so nothing was charged. Choose the plan again to start a new checkout.',
    );
    expectCopyRules(text);
    expect(r.queryByTestId('payment-error-reference')).toBeNull();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    const keys = keysOf();
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    ['invite', 'Your coach already added this plan to your account with your invite, so nothing was charged. Open your plan to use it.'],
    ['free_claim', 'You already added this free plan to your account, so nothing was charged. Open your plan to use it.'],
    ['purchase', 'You already paid for this plan and it is still active, so nothing more was charged. Open your plan to use it.'],
  ])('PACKAGE_ALREADY_INCLUDED (%s): specific copy and Open your plan', async (by, copy) => {
    mockPost.mockRejectedValueOnce(
      httpError(409, {
        code: 'PACKAGE_ALREADY_INCLUDED',
        error: 'PACKAGE_ALREADY_INCLUDED',
        message: 'x',
        purchase_id: PURCHASE,
        included_by: by,
        access_expires_at: null,
      }),
    );
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-open-plan')).toBeTruthy());
    const text = r.getByTestId('payment-error').props.children as string;
    expect(text).toBe(copy);
    expectCopyRules(text);
    await fireEvent.press(r.getByTestId('payment-open-plan'));
    expect(r.onOpenPlan).toHaveBeenCalledWith(null);
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it.each([
    ['no_coach', 'This plan is from a coach you are not connected with yet, so it cannot be started from this account and nothing was charged. Ask that coach for their invite code, join with it, then open the link again.'],
    ['other_coach', 'This plan is from a different coach than yours, so it cannot be started from this account and nothing was charged. Message the coach who shared the link.'],
  ])('PACKAGE_COACH_NOT_CONNECTED (%s): specific copy', async (reason, copy) => {
    mockPost.mockRejectedValueOnce(
      httpError(409, { code: 'PACKAGE_COACH_NOT_CONNECTED', error: 'PACKAGE_COACH_NOT_CONNECTED', message: 'x', reason }),
    );
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    const text = r.getByTestId('payment-error').props.children as string;
    expect(text).toBe(copy);
    expectCopyRules(text);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('PACKAGE_IS_FREE from subscription-intent: the plan is claimed free, never a generic error', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === '/v1/checkout/subscription-intent') {
        throw httpError(409, { code: 'PACKAGE_IS_FREE', error: 'PACKAGE_IS_FREE', message: 'x' });
      }
      if (url === `/v1/packages/${PKG_MONTHLY}/claim-free`) return { data: { active: true } };
      throw httpError(404, { error: 'Not Found' });
    });
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    expect(mockPost.mock.calls.map((c) => c[0])).toEqual([
      '/v1/checkout/subscription-intent',
      `/v1/packages/${PKG_MONTHLY}/claim-free`,
    ]);
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
  });

  it('a share link sends its token with subscription-intent; other surfaces never do', async () => {
    const pkg = purchasableFromCoachPackage(PACKAGES[0]);
    if (!pkg) throw new Error('fixture');
    const token = 'AbCdEfGhIjKlMnOpQrStU';
    const { result } = await renderHook(() =>
      usePackagePurchase({
        surface: 'share_link',
        shareToken: token,
        appearance: {},
        colorScheme: 'light',
        planPollDelaysMs: [0],
        entitlementPollDelaysMs: [0],
      }),
    );
    await act(async () => {
      await result.current.start(pkg);
    });
    expect((subIntentCalls()[0][1] as Record<string, unknown>).share_token).toBe(token);

    mockPost.mockClear();
    const bad = await renderHook(() =>
      usePackagePurchase({
        surface: 'share_link',
        shareToken: '../x',
        appearance: {},
        colorScheme: 'light',
        planPollDelaysMs: [0],
        entitlementPollDelaysMs: [0],
      }),
    );
    await act(async () => {
      await bad.result.current.start(pkg);
    });
    expect(subIntentCalls()[0][1]).not.toHaveProperty('share_token');
  });
});

describe('Apple Pay / Google Pay are off by config (OR-113-2)', () => {
  it('no merchant ID: no wallet in the sheet and no merchantIdentifier', async () => {
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    const params = mockInitPaymentSheet.mock.calls[0][0] as Record<string, unknown>;
    expect(params.applePay).toBeUndefined();
    expect(params.googlePay).toBeUndefined();
    expect(mockInitStripe.mock.calls[0][0]).not.toHaveProperty('merchantIdentifier');
  });

  it('a valid merchant ID turns Apple Pay on (iOS)', async () => {
    process.env.EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER = 'merchant.com.example.tgp';
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    const params = mockInitPaymentSheet.mock.calls[0][0] as Record<string, unknown>;
    expect(params.applePay).toEqual({ merchantCountryCode: 'US' });
    expect(mockInitStripe.mock.calls[0][0]).toEqual(
      expect.objectContaining({ merchantIdentifier: 'merchant.com.example.tgp' }),
    );
  });
});
