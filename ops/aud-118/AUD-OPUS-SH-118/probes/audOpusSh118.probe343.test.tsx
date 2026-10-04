/**
 * AUD-OPUS-SH-118 probe (Claude Opus 5.5 lens, agent 118 wave) on #343 @ fd739d58.
 * Real PackageSelectionSheet + real usePackagePurchase; only the network, the
 * Stripe native module, storage, theme and Sentry are synthetic.
 *
 *   P1 (finding candidate): a one-time plan the coach made free since the list
 *      loaded is rerouted to claim-free, and while that claim runs the sheet
 *      must not say "Payment received" (no payment exists).
 *   P2..P4: controls (must pass).
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
async function mountAndSelect(pkgId: string) {
  const r = await render(
    <PackageSelectionSheet visible onDismiss={jest.fn()} onPaymentSuccess={jest.fn()} entitlementPollDelaysMs={[0]} />,
  );
  await waitFor(() => expect(r.getByTestId(`package-card-${pkgId}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`package-card-${pkgId}`));
  await fireEvent.press(r.getByTestId('select-plan-btn'));
  return r;
}

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

describe('P1 one-time plan made free since the list loaded (reroute to claim-free)', () => {
  it('never says "Payment received" while the free claim runs', async () => {
    const held = deferred<{ data: { active: boolean } }>();
    mockPost.mockImplementation((url: string) => {
      if (url === '/v1/checkout/payment-intent')
        return Promise.reject(httpError(400, { error: 'PACKAGE_IS_FREE', message: 'This package is free.' }));
      if (url === `/v1/packages/${PKG_A}/claim-free`) return held.promise;
      return Promise.reject(httpError(404, { error: 'Not Found' }));
    });
    const r = await mountAndSelect(PKG_A);
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(`/v1/packages/${PKG_A}/claim-free`));
    const progress = r.getByTestId('payment-confirming').props.children as string;
    expect(mockPresent).not.toHaveBeenCalled();
    expect(progress).not.toMatch(/payment received/i);
    expect(progress).toBe('Adding your free plan.');
    held.resolve({ data: { active: true } });
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
  });
});

describe('controls', () => {
  it('P2 "Payment received" appears only after Stripe confirmed the one-time sheet', async () => {
    const held = deferred<{ ok: boolean; data: { active: boolean } }>();
    mockGetEntitlement.mockReturnValueOnce(held.promise);
    mockPost.mockImplementation(async (url: string) => {
      if (url === '/v1/checkout/payment-intent') return { data: { ...SECRETS } };
      throw httpError(404, { error: 'Not Found' });
    });
    const r = await mountAndSelect(PKG_A);
    await waitFor(() => expect(mockPresent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(r.getByTestId('payment-confirming').props.children).toBe('Payment received. Setting up your plan.'));
    held.resolve({ ok: true, data: { active: true } });
    await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
  });

  it('P3 production backend 643817b3 (no subscription-intent route): truthful renewing fallback, no sheet', async () => {
    mockPost.mockImplementation(async (url: string) => {
      // Exactly the HttpExceptionFilter envelope for an unmounted route.
      throw httpError(404, {
        statusCode: 404, message: `Cannot POST ${url}`, error: 'Not Found',
        timestamp: '2026-10-04T17:00:00.000Z', path: url, request_id: 'cafe0123-0000-4000-8000-000000000000',
      });
    });
    const r = await mountAndSelect(PKG_MONTHLY);
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    expect(mockPost.mock.calls[0][0]).toBe('/v1/checkout/subscription-intent');
    expect(mockPost.mock.calls.map((c) => c[0])).not.toContain('/v1/checkout/payment-intent');
    expect(r.getByTestId('payment-error').props.children).toBe(
      'This plan renews automatically, and renewing plans cannot be started from the app yet, so this plan did not start and nothing was charged. Message your coach to arrange it.',
    );
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
  });

  it('P4 one-time sheet threw: neutral checking copy, then outcome unknown with Check again', async () => {
    const held = deferred<{ ok: boolean; data: unknown[] }>();
    mockGetPurchases.mockReturnValueOnce(held.promise);
    mockPresent.mockRejectedValueOnce(new Error('synthetic lost answer'));
    mockPost.mockImplementation(async (url: string) => {
      if (url === '/v1/checkout/payment-intent') return { data: { ...SECRETS } };
      throw httpError(404, { error: 'Not Found' });
    });
    const r = await mountAndSelect(PKG_A);
    await waitFor(() => expect(mockGetPurchases).toHaveBeenCalledTimes(1));
    expect(r.getByTestId('payment-confirming').props.children).toBe('Checking whether the payment went through.');
    held.resolve({ ok: true, data: [] });
    await waitFor(() => expect(r.getByTestId('payment-check-again')).toBeTruthy());
    expect(r.getByTestId('payment-error').props.children).not.toMatch(/nothing was charged/i);
  });
});
