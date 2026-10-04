/**
 * AUD-OPUS-S12-119 probe (Claude Opus 5.5 lens, agent 119 wave) on #343 @ 19678ce7.
 * Real PackageSelectionSheet + real usePackagePurchase; only the network, the
 * Stripe native module, storage, theme and Sentry are synthetic.
 *   Q1 controls: no HTTP answer on payment-intent -> not-confirmed copy with the
 *      key reference; the next tap replays the SAME idempotency key.
 *   Q2 control: renewing sheet confirmed, then the plan read says ended ->
 *      neutral ended copy with support + reference, never a no-charge claim.
 *   Q3 control: "Continue to the app" (no onOpenPlan) closes through onDismiss,
 *      never onPaymentSuccess, and writes no 24-hour skip timestamp.
 *   Q4 control: one-time plan made free since the list loaded: "Adding your
 *      free plan." while the claim runs (Opus B-343-6 replay).
 *   Q5 INFO (C-343-8): PAYMENT_ALREADY_COMPLETE without onOpenPlan: the notice
 *      says "Open your plan" while the only action reads "Continue to the app".
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const PKG_A = '3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f';
const PKG_MONTHLY = '99999999-8888-4777-8666-555555555555';
const SECRETS = {
  client_secret: 'pi_synthetic_secret_example',
  ephemeral_key: 'ek_synthetic',
  customer_id: 'cus_synthetic',
  publishable_key: 'pk_test_synthetic',
};

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
  clientPaymentsApi: { getEntitlement: () => mockGetEntitlement(), getPurchases: () => mockGetPurchases() },
}));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
const mockInitPaymentSheet = jest.fn();
const mockPresent = jest.fn();
const mockStripeModule: Record<string, unknown> = {};
function installStripe() {
  mockStripeModule.initStripe = async () => undefined;
  mockStripeModule.initPaymentSheet = (...a: unknown[]) => mockInitPaymentSheet(...a);
  mockStripeModule.presentPaymentSheet = (...a: unknown[]) => mockPresent(...a);
}
installStripe();
jest.mock('@stripe/stripe-react-native', () => mockStripeModule);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PackageSelectionSheet: typeof import('../PackageSelectionSheet').default = require('../PackageSelectionSheet').default;

const PACKAGES = [
  { id: PKG_A, name: 'Strength 12 weeks', amount_cents: 14900, currency: 'usd', billing_type: 'one_time', interval: null },
  { id: PKG_MONTHLY, name: 'Monthly coaching', amount_cents: 9900, currency: 'usd', billing_type: 'recurring', interval: 'month' },
];

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers: {} },
    config: { headers: {} },
  });
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function mountAndSelect(pkgId: string, extra: Record<string, unknown> = {}) {
  const onDismiss = jest.fn();
  const onPaymentSuccess = jest.fn();
  const r = await render(
    <PackageSelectionSheet
      visible onDismiss={onDismiss} onPaymentSuccess={onPaymentSuccess}
      entitlementPollDelaysMs={[0]} planPollDelaysMs={[0]} recheckDelaysMs={[0]} {...extra}
    />,
  );
  await waitFor(() => expect(r.getByTestId(`package-card-${pkgId}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`package-card-${pkgId}`));
  await fireEvent.press(r.getByTestId('select-plan-btn'));
  return Object.assign(r, { onDismiss, onPaymentSuccess });
}

const PURCHASE = 'abcdef12-3456-4789-8abc-def012345678';
const NO_CHARGE = /nothing was charged|not charged|did not go through|did not start/i;
const SUB_INTENT = {
  mode: 'payment', purchase_id: PURCHASE, ...SECRETS,
  plan: { amount_cents: 9900, currency: 'usd', interval: 'month', interval_count: 1, first_charge_cents: 9900, one_time_cents: 0, trial_days: 0 },
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mmkv = require('../../storage/mmkv') as { prefsStorage: { set: jest.Mock } };

beforeEach(() => {
  jest.clearAllMocks();
  installStripe();
  process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_build';
  mockGet.mockResolvedValue({ data: { packages: PACKAGES } });
  mockInitPaymentSheet.mockResolvedValue({});
  mockPresent.mockResolvedValue({});
  mockGetEntitlement.mockResolvedValue({ ok: true, data: { active: true } });
  mockGetPurchases.mockResolvedValue({ ok: true, data: [] });
});

const keysOf = (url: string) =>
  mockPost.mock.calls.filter((c) => c[0] === url).map((c) => (c[1] as { idempotency_key: string }).idempotency_key);

describe('Q1 no HTTP answer on payment-intent', () => {
  it('not-confirmed copy with the key reference; the next tap replays the same key', async () => {
    const timeout = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED', request: {}, config: {} });
    mockPost.mockImplementation((url: string) => {
      if (url === '/v1/checkout/payment-intent') return Promise.reject(timeout);
      return Promise.reject(httpError(404, { error: 'Not Found' }));
    });
    const r = await mountAndSelect(PKG_A);
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    const msg = r.getByTestId('payment-error').props.children as string;
    const [k1] = keysOf('/v1/checkout/payment-intent');
    expect(msg).not.toMatch(NO_CHARGE);
    expect(msg).toContain(k1.slice(0, 8));
    expect(r.getByTestId('payment-support')).toBeTruthy();
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(keysOf('/v1/checkout/payment-intent')).toHaveLength(2));
    expect(keysOf('/v1/checkout/payment-intent')[1]).toBe(k1);
  });
});

describe('Q2 renewing sheet confirmed, then the plan read says ended', () => {
  it('neutral ended copy, support and reference, never a no-charge claim', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === '/v1/checkout/subscription-intent') return { data: SUB_INTENT };
      throw httpError(404, { error: 'Not Found' });
    });
    mockGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/v1/checkout/subscriptions/'))
        return { data: { purchase_id: PURCHASE, package_id: PKG_MONTHLY, state: 'ended', entitlement_active: false, checkout_state: 'ended' } };
      return { data: { packages: PACKAGES } };
    });
    const r = await mountAndSelect(PKG_MONTHLY);
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    const msg = r.getByTestId('payment-error').props.children as string;
    expect(mockPresent).toHaveBeenCalledTimes(1);
    expect(msg).not.toMatch(NO_CHARGE);
    expect(msg).toContain('abcdef12');
    expect(r.getByTestId('payment-support')).toBeTruthy();
    expect(r.queryByTestId('payment-success')).toBeNull();
  });
});

describe('Q3 Continue to the app without a plan destination', () => {
  it('closes through onDismiss, never onPaymentSuccess, and writes no skip timestamp', async () => {
    mockPost.mockImplementation(() => Promise.reject(httpError(500, { error: 'INTERNAL', request_id: 'f00dbabe-1234' })));
    const r = await mountAndSelect(PKG_A);
    await waitFor(() => expect(r.getByTestId('payment-open-plan')).toBeTruthy());
    expect(r.getByText('Continue to the app')).toBeTruthy();
    mmkv.prefsStorage.set.mockClear();
    await fireEvent.press(r.getByTestId('payment-open-plan'));
    expect(r.onDismiss).toHaveBeenCalledTimes(1);
    expect(r.onPaymentSuccess).not.toHaveBeenCalled();
    expect(mmkv.prefsStorage.set).not.toHaveBeenCalled();
  });
});

describe('Q4 one-time plan made free since the list loaded', () => {
  it('"Adding your free plan." while the claim runs, never "Payment received"', async () => {
    const held = deferred<{ data: { active: boolean } }>();
    mockPost.mockImplementation((url: string) => {
      if (url === '/v1/checkout/payment-intent')
        return Promise.reject(httpError(400, { error: 'PACKAGE_IS_FREE', message: 'This package is free.' }));
      if (url === `/v1/packages/${PKG_A}/claim-free`) return held.promise;
      return Promise.reject(httpError(404, { error: 'Not Found' }));
    });
    const r = await mountAndSelect(PKG_A);
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(`/v1/packages/${PKG_A}/claim-free`));
    expect(r.getByTestId('payment-confirming').props.children).toBe('Adding your free plan.');
    held.resolve({ data: { active: true } });
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
  });
});

describe('Q5 INFO (C-343-8) PAYMENT_ALREADY_COMPLETE without a plan destination', () => {
  it('a notice that says "Open your plan" offers an action with that name', async () => {
    mockPost.mockImplementation(() => Promise.reject(httpError(409, { error: 'PAYMENT_ALREADY_COMPLETE' })));
    const r = await mountAndSelect(PKG_A);
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    const msg = r.getByTestId('payment-error').props.children as string;
    expect(msg).toMatch(/Open your plan/);
    expect(r.queryByText('Open your plan')).toBeTruthy();
  });
});
