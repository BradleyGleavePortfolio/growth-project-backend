/**
 * AUD-OPUS-P12-117 probe (audit only, never merge) — mobile #343 @ af984441.
 * Real sheet, hook and copy; only network, Stripe native module, storage,
 * theme and Sentry are mocked (same harness as PackageSelectionSheet.recur3).
 *
 * B-343-1: a one-time card step that ended WITHOUT a clear answer shows
 * "Payment received. Setting up your plan." while the purchase is being read,
 * before the app knows whether anything was charged.
 * B-342-1 (through this hook): PAYMENT_RETRY from subscription-intent (backend
 * #679 inProgress(true): result not confirmed, incl. paid after close) is told
 * as "nothing was charged".
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const PKG_MONTHLY = '99999999-8888-4777-8666-555555555555';
const PKG_ONCE = 'dddddddd-eeee-4fff-8000-111111111111';

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
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PackageSelectionSheet: typeof import('../PackageSelectionSheet').default =
  require('../PackageSelectionSheet').default;

const PACKAGES = [
  { id: PKG_MONTHLY, name: 'Monthly coaching', amount_cents: 9900, currency: 'usd', billing_type: 'recurring', interval: 'month', description: null },
  { id: PKG_ONCE, name: 'Strength 12 weeks', amount_cents: 14900, currency: 'usd', billing_type: 'one_time', interval: null, description: null },
];

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers: {} },
    config: { headers: {} },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_build';
  mockGet.mockImplementation(async (url: string) => {
    if (url === '/v1/clients/me/coach/packages') return { data: { packages: PACKAGES } };
    throw httpError(404, { error: 'Not Found' });
  });
  mockPost.mockImplementation(async (url: string) => {
    if (url === '/v1/checkout/payment-intent') {
      return { data: { client_secret: 'pi_once_secret_q', ephemeral_key: 'ek_once', customer_id: 'cus_once', publishable_key: 'pk_test_backend' } };
    }
    throw httpError(404, { error: 'Not Found' });
  });
  mockInitStripe.mockResolvedValue(undefined);
  mockInitPaymentSheet.mockResolvedValue({});
  mockPresent.mockResolvedValue({});
  mockGetEntitlement.mockResolvedValue({ ok: true, data: { active: false } });
  mockGetPurchases.mockResolvedValue({ ok: true, data: [] });
});

async function mountAndSelect(pkgId: string) {
  const r = await render(
    <PackageSelectionSheet
      visible
      onDismiss={jest.fn()}
      onPaymentSuccess={jest.fn()}
      onOpenPlan={jest.fn()}
      planPollDelaysMs={[0, 0, 0]}
      entitlementPollDelaysMs={[0, 0]}
      recheckDelaysMs={[0, 0]}
    />,
  );
  await waitFor(() => expect(r.getByTestId(`package-card-${pkgId}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`package-card-${pkgId}`));
  return r;
}

describe('B-343-1 an unknown one-time outcome is never shown as a received payment', () => {
  it('the native call threw; while the purchase is read the sheet must not say "Payment received"', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockPresent.mockRejectedValueOnce(new Error('bridge lost the response'));
    mockGetPurchases.mockImplementation(
      () =>
        new Promise((res) => {
          release = res;
        }),
    );
    const r = await mountAndSelect(PKG_ONCE);
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(mockGetPurchases).toHaveBeenCalled());
    const progress = r.queryByTestId('payment-confirming');
    const text = progress ? String(progress.props.children) : '';
    release({ ok: true, data: [] });
    expect(text).not.toMatch(/payment received/i);
  });
});

describe('B-342-1 through the hook: PAYMENT_RETRY on subscription-intent', () => {
  it('a result the backend has not confirmed is never told as "nothing was charged"', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === '/v1/checkout/subscription-intent') {
        throw httpError(503, {
          code: 'PAYMENT_RETRY',
          error: 'PAYMENT_RETRY',
          message:
            'The last attempt to start this plan did not finish, and its result is not confirmed yet. Open Your plan to check whether it started before you try again.',
        });
      }
      throw httpError(404, { error: 'Not Found' });
    });
    const r = await mountAndSelect(PKG_MONTHLY);
    await fireEvent.press(r.getByTestId('select-plan-btn'));
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    expect(String(r.getByTestId('payment-error').props.children)).not.toMatch(/nothing was charged/i);
  });
});
