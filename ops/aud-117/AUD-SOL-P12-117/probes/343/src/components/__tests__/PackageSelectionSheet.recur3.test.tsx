/**
 * B-RECUR-3 (agent 115) — mobile#334 fix round for Sol's B-334-3 and B-334-4,
 * paired with backend#654 fix round 2.
 *
 * Every case marked (failed before) failed at 0629d50601618af7a51d0f92c4bbf828001dba7a:
 *   B-334-3 a card sheet that ended without a clear answer (the native call
 *           threw, timed out, lost the connection, or failed without any card
 *           detail) was reported at once as "did not go through and nothing
 *           was charged", without reading the purchase it already had, even
 *           when the backend showed the plan paid;
 *   B-334-4 the terms the backend answered (trial no longer offered, one-time
 *           part, currency, cadence) were never reconciled with what the
 *           client was shown before a chargeable sheet opened, the one-time
 *           part was not sent at all, and a removed trial could be resurrected
 *           (`fresh.trialDays || pkg.trialDays`).
 *
 * Only the network, the Stripe native module, storage, theme and Sentry are
 * mocked; the real sheet, hook and copy run.
 */
import React from 'react';
import { act, fireEvent, render, renderHook, waitFor, within } from '@testing-library/react-native';

const PKG_MONTHLY = '99999999-8888-4777-8666-555555555555';
const PKG_TRIAL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PKG_COMBO = 'cccccccc-dddd-4eee-8fff-000000000000';
const PKG_ONCE = 'dddddddd-eeee-4fff-8000-111111111111';
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
const mockGetPurchases = jest.fn();
jest.mock('../../api/clientPaymentsApi', () => ({
  clientPaymentsApi: {
    getEntitlement: () => mockGetEntitlement(),
    getPurchases: () => mockGetPurchases(),
  },
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
  { id: PKG_COMBO, name: 'Kickoff plus monthly', amount_cents: 20000, currency: 'usd', billing_type: 'one_time', interval: null, recurring_amount_cents: 5000, recurring_interval: 'month', description: null },
  { id: PKG_ONCE, name: 'Strength 12 weeks', amount_cents: 14900, currency: 'usd', billing_type: 'one_time', interval: null, description: null },
];

const MONTHLY_PLAN = {
  amount_cents: 9900, currency: 'usd', interval: 'month', interval_count: 1,
  first_charge_cents: 9900, one_time_cents: 0, trial_days: 0, trial_ends_at: null,
  package_id: PKG_MONTHLY, package_name: 'Monthly coaching',
};
const TRIAL_PLAN = {
  ...MONTHLY_PLAN, amount_cents: 4900, first_charge_cents: 0, trial_days: 7,
  trial_ends_at: '2026-10-10T12:00:00.000Z', package_id: PKG_TRIAL, package_name: 'Trial coaching',
};
const COMBO_PLAN = {
  ...MONTHLY_PLAN, amount_cents: 5000, first_charge_cents: 25000, one_time_cents: 20000,
  package_id: PKG_COMBO, package_name: 'Kickoff plus monthly',
};

function intent(mode: 'payment' | 'setup' | 'none', plan: Record<string, unknown> = MONTHLY_PLAN) {
  return {
    mode,
    client_secret: mode === 'setup' ? 'seti_test_1_secret_zzz' : mode === 'payment' ? 'pi_test_sub_secret_yyy' : '',
    ephemeral_key: mode === 'none' ? '' : 'ek_test_sub',
    customer_id: 'cus_test_sub',
    publishable_key: mode === 'none' ? '' : 'pk_test_backend',
    purchase_id: PURCHASE,
    subscription_id: 'sub_test_1',
    status: 'incomplete',
    reused: false,
    plan,
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
    checkout_state: null,
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
  expect(text).not.toMatch(/try again later/i);
  expect(text).not.toMatch(/!/);
  expect(text).not.toMatch(/\b(we|we're|our|us|I|I'm|me)\b/);
}

let planResponses: unknown[] = [];
let intentResponses: unknown[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER;
  delete process.env.EXPO_PUBLIC_GOOGLE_PAY_ENABLED;
  process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_build';
  planResponses = [planView('active')];
  intentResponses = [intent('payment')];
  mockGet.mockImplementation(async (url: string) => {
    if (url === '/v1/clients/me/coach/packages') return { data: { packages: PACKAGES } };
    if (url === `/v1/checkout/subscriptions/${PURCHASE}`) {
      const next = planResponses.length > 1 ? planResponses.shift() : planResponses[0];
      if (next instanceof Error) throw next;
      return { data: next };
    }
    throw httpError(404, { error: 'Not Found' });
  });
  mockPost.mockImplementation(async (url: string) => {
    if (url === '/v1/checkout/subscription-intent') {
      const next = intentResponses.length > 1 ? intentResponses.shift() : intentResponses[0];
      if (next instanceof Error) throw next;
      return { data: next };
    }
    if (url === '/v1/checkout/payment-intent') {
      return { data: { client_secret: 'pi_once_secret_q', ephemeral_key: 'ek_once', customer_id: 'cus_once', publishable_key: 'pk_test_backend' } };
    }
    throw httpError(404, { error: 'Not Found', message: `Cannot POST ${url}` });
  });
  mockInitStripe.mockResolvedValue(undefined);
  mockInitPaymentSheet.mockResolvedValue({});
  mockPresent.mockResolvedValue({});
  mockGetEntitlement.mockResolvedValue({ ok: true, data: { active: false } });
  mockGetPurchases.mockResolvedValue({ ok: true, data: [] });
});

async function mountAndSelect(pkgId = PKG_MONTHLY) {
  const onPaymentSuccess = jest.fn();
  const r = await render(
    <PackageSelectionSheet
      visible
      onDismiss={jest.fn()}
      onPaymentSuccess={onPaymentSuccess}
      onOpenPlan={jest.fn()}
      planPollDelaysMs={[0, 0, 0]}
      entitlementPollDelaysMs={[0, 0]}
      recheckDelaysMs={[0, 0]}
    />,
  );
  await waitFor(() => expect(r.getByTestId(`package-card-${pkgId}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`package-card-${pkgId}`));
  return { ...r, onPaymentSuccess };
}

const subIntentCalls = () => mockPost.mock.calls.filter((c) => c[0] === '/v1/checkout/subscription-intent');
const keysOf = () => subIntentCalls().map((c) => (c[1] as { idempotency_key: string }).idempotency_key);
const errorText = (r: Awaited<ReturnType<typeof mountAndSelect>>): string =>
  String(r.getByTestId('payment-error').props.children);
const NO_CHARGE = /nothing was charged/i;

describe('B-334-3 an unknown card-step outcome is read, never reported as no charge', () => {
  it('(failed before) the native call throws but the plan is paid -> success, never the no-charge copy', async () => {
    mockPresent.mockRejectedValueOnce(new Error('bridge lost the response'));
    planResponses = [planView('active')];
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    expect(r.queryByText(NO_CHARGE)).toBeNull();
    expect(mockGet.mock.calls.some((c) => c[0] === `/v1/checkout/subscriptions/${PURCHASE}`)).toBe(true);
  });

  it('(failed before) a failure without card detail while Stripe shows no payment -> proven no charge; the retry replays the same key', async () => {
    mockPresent.mockResolvedValueOnce({ error: { code: 'Failed', message: 'x' } });
    planResponses = [planView('confirming', { checkout_state: 'awaiting_payment' })];
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    const text = errorText(r);
    expect(text).toBe(
      'The payment form closed before the payment finished. Stripe shows no payment for this plan, so nothing was charged. Start again when you are ready.',
    );
    expectCopyRules(text);
    planResponses = [planView('active')];
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    const keys = keysOf();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('(failed before) a timeout while Stripe cannot tell -> outcome unknown (no no-charge claim), reference, Check again finds the plan', async () => {
    mockPresent.mockResolvedValueOnce({ error: { code: 'Timeout', message: 'x' } });
    planResponses = [planView('confirming', { checkout_state: 'unknown' })];
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-check-again')).toBeTruthy());
    const text = errorText(r);
    expect(text).not.toMatch(NO_CHARGE);
    expect(text).toMatch(/not yet clear whether this payment went through/);
    expectCopyRules(text);
    expect(r.getByTestId('payment-error-reference')).toBeTruthy();
    expect(r.getByTestId('payment-support')).toBeTruthy();
    expect(JSON.stringify(mockCapture.mock.calls)).not.toMatch(/secret|ek_test|seti_|pi_test/);

    planResponses = [planView('active')];
    await fireEvent.press(r.getByTestId('payment-check-again'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
  });

  it('(failed before) a dropped connection while the payment is processing keeps confirming, then succeeds', async () => {
    mockPresent.mockResolvedValueOnce({ error: { code: 'Failed', type: 'api_connection_error' } });
    planResponses = [
      planView('confirming', { checkout_state: 'processing' }),
      planView('confirming', { checkout_state: 'processing' }),
      planView('active'),
    ];
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    expect(r.queryByText(NO_CHARGE)).toBeNull();
  });

  it('(failed before) the plan read itself fails -> outcome unknown, never a no-charge claim', async () => {
    mockPresent.mockRejectedValueOnce(new Error('bridge lost the response'));
    planResponses = [httpError(503, { code: 'STRIPE_CHECKOUT_ERROR' })];
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-check-again')).toBeTruthy());
    expect(errorText(r)).not.toMatch(NO_CHARGE);
  });

  it('(failed before) a trial whose card sheet threw while Stripe shows no saved card -> the trial has not started, nothing charged', async () => {
    intentResponses = [intent('setup', TRIAL_PLAN)];
    mockPresent.mockRejectedValueOnce(new Error('bridge lost the response'));
    planResponses = [planView('confirming', { package_id: PKG_TRIAL, checkout_state: 'awaiting_card' })];
    const r = await mountAndSelect(PKG_TRIAL);
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    expect(errorText(r)).toBe(
      'The card form closed before your card was saved, so the trial has not started and nothing was charged. Start again when you are ready.',
    );
  });

  it('control: a card decline is a definite answer (no plan read)', async () => {
    mockPresent.mockResolvedValueOnce({ error: { code: 'Failed', declineCode: 'generic_decline', type: 'card_error' } });
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    expect(errorText(r)).toMatch(/Your bank declined this card, so nothing was charged/);
    expect(mockGet.mock.calls.some((c) => c[0] === `/v1/checkout/subscriptions/${PURCHASE}`)).toBe(false);
  });

  it('(failed before) one-time: the native call throws but the purchase is paid -> success', async () => {
    mockPresent.mockRejectedValueOnce(new Error('bridge lost the response'));
    mockGetPurchases.mockResolvedValue({
      ok: true,
      data: [{ id: 'p1', package_id: PKG_ONCE, status: 'paid', entitlement_active: true }],
    });
    const r = await mountAndSelect(PKG_ONCE);
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    expect(r.queryByText(NO_CHARGE)).toBeNull();
  });

  it('(failed before) one-time: unknown and no paid purchase yet -> outcome unknown with Check again, which finds the purchase', async () => {
    mockPresent.mockResolvedValueOnce({ error: { code: 'Timeout' } });
    const r = await mountAndSelect(PKG_ONCE);
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-check-again')).toBeTruthy());
    expect(errorText(r)).not.toMatch(NO_CHARGE);
    mockGetPurchases.mockResolvedValue({
      ok: true,
      data: [{ id: 'p1', package_id: PKG_ONCE, status: 'paid', entitlement_active: true }],
    });
    await fireEvent.press(r.getByTestId('payment-check-again'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
  });

  it('unmount during the plan read after an unknown outcome: no state write, no further reads', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockPresent.mockRejectedValueOnce(new Error('bridge lost the response'));
    mockGet.mockImplementation(async (url: string) => {
      if (url === `/v1/checkout/subscriptions/${PURCHASE}`) {
        return new Promise((res) => {
          release = res;
        });
      }
      throw httpError(404, { error: 'Not Found' });
    });
    const pkg = purchasableFromCoachPackage(PACKAGES[0]);
    if (!pkg) throw new Error('fixture');
    const { result, unmount } = await renderHook(() =>
      usePackagePurchase({
        surface: 'sheet',
        appearance: {},
        colorScheme: 'light',
        planPollDelaysMs: [0],
        entitlementPollDelaysMs: [0],
        recheckDelaysMs: [0, 0, 0],
      }),
    );
    let done: Promise<void> = Promise.resolve();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await act(async () => {
        done = result.current.start(pkg);
        for (let i = 0; i < 50 && mockGet.mock.calls.length === 0; i += 1) {
          await Promise.resolve();
        }
      });
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.current.state.phase).toBe('confirming');
      await unmount();
      release({ data: planView('active') });
      await done;
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.current.state.phase).toBe('confirming');
      const logged = JSON.stringify(errSpy.mock.calls);
      expect(logged).not.toMatch(/unmounted component|not wrapped in act/);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('C-334-3 the confirm poll never reports after unmount', () => {
  it('(failed before) uncertain -> processing, unmount during the next plan read: no entitlement callback, no success', async () => {
    let release: (v: unknown) => void = () => undefined;
    let reads = 0;
    mockPresent.mockRejectedValueOnce(new Error('bridge lost the response'));
    mockGet.mockImplementation(async (url: string) => {
      if (url === `/v1/checkout/subscriptions/${PURCHASE}`) {
        reads += 1;
        if (reads === 1) return { data: planView('confirming', { checkout_state: 'processing' }) };
        return new Promise((res) => {
          release = res;
        });
      }
      throw httpError(404, { error: 'Not Found' });
    });
    const pkg = purchasableFromCoachPackage(PACKAGES[0]);
    if (!pkg) throw new Error('fixture');
    const onEntitled = jest.fn();
    const { result, unmount } = await renderHook(() =>
      usePackagePurchase({
        surface: 'sheet',
        appearance: {},
        colorScheme: 'light',
        planPollDelaysMs: [0, 0],
        entitlementPollDelaysMs: [0],
        recheckDelaysMs: [0, 0],
        onEntitled,
      }),
    );
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = result.current.start(pkg);
      for (let i = 0; i < 100 && reads < 2; i += 1) {
        await Promise.resolve();
      }
    });
    expect(reads).toBe(2);
    await unmount();
    release({ data: planView('active') });
    await done;
    expect(onEntitled).not.toHaveBeenCalled();
    expect(result.current.state.phase).not.toBe('success');
    expect(reads).toBe(2);
  });
});

describe('B-334-4 the answered terms are reviewed before any chargeable sheet', () => {
  it('(failed before) shown a 7-day trial, the backend answers no trial (already used) -> review, no sheet; confirm replays the same key and pays', async () => {
    const noTrial = { ...TRIAL_PLAN, trial_days: 0, first_charge_cents: 4900, trial_ends_at: null };
    intentResponses = [intent('payment', noTrial)];
    planResponses = [planView('active', { package_id: PKG_TRIAL, amount_cents: 4900 })];
    const r = await mountAndSelect(PKG_TRIAL);
    expect(r.getByTestId('select-plan-btn').props.accessibilityLabel).toBe('Start free trial');
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('price-changed')).toBeTruthy());
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    const msg = String(r.getByTestId('price-changed-message').props.children);
    expect(msg).toBe(
      'This plan no longer includes a free trial for you, so it starts with a charge today. Nothing was charged yet. Review the current terms, then confirm to continue.',
    );
    expectCopyRules(msg);
    const confirm = r.getByTestId('price-confirm-btn');
    expect(confirm.props.accessibilityLabel).toBe('Subscribe for $49.00 a month');
    expect(within(r.getByTestId('price-changed-terms')).queryByText(/free/i)).toBeNull();
    await fireEvent.press(confirm);
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    const params = mockInitPaymentSheet.mock.calls[0][0] as Record<string, unknown>;
    expect(params.paymentIntentClientSecret).toBe('pi_test_sub_secret_yyy');
    expect(params.setupIntentClientSecret).toBeUndefined();
    const keys = keysOf();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(r.getByText('Your plan is active')).toBeTruthy();
  });

  it('(failed before) the request carries the one-time part shown (combo and pure renewing)', async () => {
    intentResponses = [intent('payment', COMBO_PLAN)];
    const r = await mountAndSelect(PKG_COMBO);
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    expect(subIntentCalls()[0][1]).toEqual(
      expect.objectContaining({ expected_amount_cents: 5000, expected_one_time_cents: 20000 }),
    );
  });

  it('(failed before) a combo whose one-time part moved -> review, no sheet', async () => {
    intentResponses = [intent('payment', { ...COMBO_PLAN, one_time_cents: 25000, first_charge_cents: 30000 })];
    const r = await mountAndSelect(PKG_COMBO);
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('price-changed')).toBeTruthy());
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    expect(String(r.getByTestId('price-changed-message').props.children)).toMatch(/terms of this plan changed/);
    expect(r.getByTestId('price-confirm-btn').props.accessibilityLabel).toBe('Subscribe, pay $300.00 today');
  });

  it('(failed before) a cadence change (monthly -> every 3 months) -> review, no sheet', async () => {
    intentResponses = [intent('payment', { ...MONTHLY_PLAN, interval_count: 3 })];
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('price-changed')).toBeTruthy());
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    expect(r.getByTestId('price-confirm-btn').props.accessibilityLabel).toBe('Subscribe for $99.00 every 3 months');
  });

  it('(failed before) PACKAGE_PRICE_CHANGED read from the package never resurrects a removed trial', async () => {
    intentResponses = [httpError(409, { code: 'PACKAGE_PRICE_CHANGED', error: 'PACKAGE_PRICE_CHANGED', message: 'x' }), intent('payment', { ...TRIAL_PLAN, amount_cents: 5900, trial_days: 0, first_charge_cents: 5900, trial_ends_at: null })];
    const base = mockGet.getMockImplementation();
    mockGet.mockImplementation(async (url: string) => {
      if (url === `/v1/clients/me/coach/packages/${PKG_TRIAL}`) {
        return { data: { ...PACKAGES[1], amount_cents: 5900, trial_days: 0 } };
      }
      return base ? base(url) : undefined;
    });
    const r = await mountAndSelect(PKG_TRIAL);
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('price-changed')).toBeTruthy());
    expect(r.getByTestId('price-confirm-btn').props.accessibilityLabel).toBe('Subscribe for $59.00 a month');
    expect(within(r.getByTestId('price-changed-terms')).queryByText(/free/i)).toBeNull();
    await fireEvent.press(r.getByTestId('price-confirm-btn'));
    await waitFor(() => expect(mockInitPaymentSheet).toHaveBeenCalled());
    expect((mockInitPaymentSheet.mock.calls[0][0] as Record<string, unknown>).paymentIntentClientSecret).toBe('pi_test_sub_secret_yyy');
  });

  it('(failed before) PACKAGE_PRICE_CHANGED adopts the one-time part and cadence from the body', async () => {
    intentResponses = [
      httpError(409, { code: 'PACKAGE_PRICE_CHANGED', error: 'PACKAGE_PRICE_CHANGED', message: 'x', amount_cents: 5000, one_time_cents: 15000, first_charge_cents: 20000, currency: 'usd', interval: 'month', interval_count: 1 }),
    ];
    const r = await mountAndSelect(PKG_COMBO);
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('price-changed')).toBeTruthy());
    expect(r.getByTestId('price-confirm-btn').props.accessibilityLabel).toBe('Subscribe, pay $200.00 today');
  });

  it('mode none (paid without a sheet) -> no sheet, confirming, success', async () => {
    intentResponses = [intent('none')];
    planResponses = [planView('confirming', { checkout_state: 'paid' }), planView('active')];
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    expect(mockPresent).not.toHaveBeenCalled();
  });

  it('SUBSCRIPTION_ATTEMPT_EXPIRED terms_changed twice -> its own copy', async () => {
    const expired = () => httpError(409, { code: 'SUBSCRIPTION_ATTEMPT_EXPIRED', error: 'SUBSCRIPTION_ATTEMPT_EXPIRED', message: 'x', reason: 'terms_changed' });
    intentResponses = [expired(), expired(), intent('payment')];
    const r = await mountAndSelect();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    const text = errorText(r);
    expect(text).toBe(
      'The terms of this plan changed after that checkout started, so it was closed and nothing was charged. Choose the plan again to see the current terms.',
    );
    expectCopyRules(text);
  });

  it('AUD-SOL-P12-117: resumed unpaid trial with an earlier first-charge date requires review before card saving', async () => {
    // Pin this to a midnight-crossing retry that is still WELL INSIDE the
    // backend's 23-hour open-attempt age window (12 hours old, not 24).
    jest.useFakeTimers({ now: new Date('2026-10-04T05:00:00.000Z') });
    try {
    const displayedEnd = new Date();
    displayedEnd.setDate(displayedEnd.getDate() + 7);
    const pinnedEnd = new Date(Date.now() - 12 * 60 * 60 * 1000);
    pinnedEnd.setDate(pinnedEnd.getDate() + 7);
    const displayedDate = displayedEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const pinnedDate = pinnedEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    expect(pinnedDate).not.toBe(displayedDate);
    // Backend #679 reuses a still-payable trial within its 23-hour window.
    // Its trial_ends_at stays pinned to the old subscription, not "now + 7".
    intentResponses = [{
      ...intent('setup', { ...TRIAL_PLAN, trial_ends_at: pinnedEnd.toISOString() }),
      reused: true,
    }];
    const r = await mountAndSelect(PKG_TRIAL);
    expect(String(r.getByTestId('plan-terms-first-charge').props.children)).toContain(displayedDate);
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(subIntentCalls()).toHaveLength(1));
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    expect(r.getByTestId('price-changed')).toBeTruthy();
    expect(String(r.getByTestId('price-changed-terms-first-charge').props.children)).toContain(pinnedDate);
    } finally {
      jest.useRealTimers();
    }
  });
});
