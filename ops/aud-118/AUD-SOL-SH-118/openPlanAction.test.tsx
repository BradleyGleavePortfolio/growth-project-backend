/**
 * OR-112-22: the Day 1 / package_prompt sheet takes payment for ONE-TIME
 * plans through POST /v1/checkout/payment-intent and the native PaymentSheet.
 * Renewing plans: PackageSelectionSheet.subscription.test.tsx (B-RECUR-MOB).
 *
 * Failing before: on main the sheet POSTed { package_id, idempotency_key } to
 * /v1/checkout/sessions (400 under forbidNonWhitelisted; that route never
 * returns PaymentSheet secrets), passed no customerId, and showed the same
 * generic "Payment failed. Please try again." for every cause.
 *
 * The real sheet is mounted; only the network (api), the Stripe native module,
 * storage, theme and Sentry are mocked. Copy is asserted as literal strings so
 * this file does not depend on the new module to load.
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

// Backend contract, growth-project-backend main 9cfd70d6:
//   src/checkout/checkout.controller.ts
//     export class CreatePaymentIntentDto {
//       @IsUUID() package_id!: string;
//       @IsUUID() idempotency_key!: string;
//     }
//     @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
//     @Post('payment-intent')   (controller prefix 'v1/checkout')
//   src/checkout/checkout.service.ts createPaymentIntentForClient returns
//     { client_secret, ephemeral_key, customer_id, publishable_key }
const BACKEND_DTO_FIELDS = ['idempotency_key', 'package_id'];
// class-validator IsUUID() (version 'all' via validator.js isUUID).
const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PKG_A = '3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f';
const PKG_B = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
const PKG_FREE = '11111111-2222-4333-8444-555555555555';
const PKG_MONTHLY = '99999999-8888-4777-8666-555555555555';

const SECRETS = {
  client_secret: 'pi_test_123_secret_abc',
  ephemeral_key: 'ek_test_456',
  customer_id: 'cus_test_789',
  publishable_key: 'pk_test_backend',
};

jest.mock('../../theme/ThemeProvider', () => {
  const realTokens = jest.requireActual('../../theme/tokens').default;
  return {
    useTheme: () => ({
      tokens: realTokens,
      semanticColors: realTokens.lightTokens,
      colorScheme: 'light',
    }),
  };
});
jest.mock('../../storage/mmkv', () => ({
  prefsStorage: {
    getStringAsync: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
  },
}));
jest.mock('../../hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 'client-1', role: 'student' }),
}));
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
  },
}));
const mockGetEntitlement = jest.fn();
jest.mock('../../api/clientPaymentsApi', () => ({
  clientPaymentsApi: { getEntitlement: () => mockGetEntitlement() },
}));
const mockCapture = jest.fn();
jest.mock('../../services/sentry', () => ({
  captureError: (...a: unknown[]) => mockCapture(...a),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const mockInitStripe = jest.fn();
const mockInitPaymentSheet = jest.fn();
const mockPresent = jest.fn();
// Mutable so one test can remove the native module.
const mockStripeModule: Record<string, unknown> = {};
function installStripe() {
  mockStripeModule.initStripe = (...a: unknown[]) => mockInitStripe(...a);
  mockStripeModule.initPaymentSheet = (...a: unknown[]) => mockInitPaymentSheet(...a);
  mockStripeModule.presentPaymentSheet = (...a: unknown[]) => mockPresent(...a);
  mockStripeModule.useStripe = () => ({
    initPaymentSheet: (...a: unknown[]) => mockInitPaymentSheet(...a),
    presentPaymentSheet: (...a: unknown[]) => mockPresent(...a),
  });
}
installStripe();
jest.mock('@stripe/stripe-react-native', () => mockStripeModule);

// Required (not imported) so the Stripe mock is populated before the sheet
// module loads: main's sheet read `useStripe` once at module load, and an
// import would be hoisted above installStripe().
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PackageSelectionSheet: typeof import('../PackageSelectionSheet').default =
  require('../PackageSelectionSheet').default;

const PACKAGES = [
  { id: PKG_A, name: 'Strength 12 weeks', amount_cents: 14900, currency: 'usd', billing_type: 'one_time', interval: null, description: null },
  { id: PKG_B, name: 'Starter 4 weeks', amount_cents: 4900, currency: 'usd', billing_type: 'one_time', interval: null, description: null },
  { id: PKG_FREE, name: 'Free taster', amount_cents: 0, currency: 'usd', billing_type: 'one_time', interval: null, description: null },
  { id: PKG_MONTHLY, name: 'Monthly coaching', amount_cents: 9900, currency: 'usd', billing_type: 'recurring', interval: 'month', description: null },
];

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers: {} },
    config: { headers: { 'X-Request-Id': 'abcdef12-sent-0000-0000-000000000000' } },
  });
}

/** Owner copy rules: no generic "try again later", no first person, no exclamation marks. */
function expectCopyRules(text: string) {
  expect(text).not.toMatch(/try again later/i);
  expect(text).not.toMatch(/something went wrong/i);
  expect(text).not.toMatch(/^please try again\.?$/i);
  expect(text).not.toMatch(/!/);
  expect(text).not.toMatch(/\b(we|we're|our|us|I|I'm|me|my)\b/);
}

async function mountAndSelect(pkgId = PKG_A, props: Partial<React.ComponentProps<typeof PackageSelectionSheet>> = {}) {
  const onPaymentSuccess = jest.fn();
  const onDismiss = jest.fn();
  const r = await render(
    <PackageSelectionSheet
      visible
      onDismiss={onDismiss}
      onPaymentSuccess={onPaymentSuccess}
      entitlementPollDelaysMs={[0, 0]}
      {...props}
    />,
  );
  await waitFor(() => expect(r.getByTestId(`package-card-${pkgId}`)).toBeTruthy());
  await fireEvent.press(r.getByTestId(`package-card-${pkgId}`));
  return { ...r, onPaymentSuccess, onDismiss };
}

async function pressSelect(r: Awaited<ReturnType<typeof mountAndSelect>>) {
  await fireEvent.press(r.getByTestId('select-plan-btn'));
}

/** The success moment shows; Continue leaves the sheet the paid way. */
async function finishSuccess(r: Awaited<ReturnType<typeof mountAndSelect>>) {
  await waitFor(() => expect(r.getByTestId('payment-success')).toBeTruthy());
  expect(r.onPaymentSuccess).not.toHaveBeenCalled();
  await fireEvent.press(r.getByTestId('payment-continue'));
  expect(r.onPaymentSuccess).toHaveBeenCalledTimes(1);
}

function paymentIntentCalls() {
  return mockPost.mock.calls.filter((c) => c[0] === '/v1/checkout/payment-intent');
}

const savedKey = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;
afterAll(() => {
  if (savedKey === undefined) delete process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  else process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = savedKey;
});

beforeEach(() => {
  jest.clearAllMocks();
  installStripe();
  // A build key is present, as in an EAS build (main checked it before the POST).
  process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_build';
  mockGet.mockResolvedValue({ data: { packages: PACKAGES } });
  mockPost.mockImplementation(async (url: string) => {
    if (url === '/v1/checkout/payment-intent') return { data: { ...SECRETS } };
    throw httpError(404, { error: 'Not Found', message: `Cannot POST ${url}` });
  });
  mockInitStripe.mockResolvedValue(undefined);
  mockInitPaymentSheet.mockResolvedValue({});
  mockPresent.mockResolvedValue({});
  mockGetEntitlement.mockResolvedValue({ ok: true, data: { active: true } });
});

describe('PackageSelectionSheet pays through POST /v1/checkout/payment-intent', () => {
  it('sends exactly the backend DTO body and gives PaymentSheet the customer, ephemeral key and client secret', async () => {
    const r = await mountAndSelect();
    await pressSelect(r);
    await waitFor(() => expect(mockPost).toHaveBeenCalled());

    // The request: route and a body the backend DTO accepts (no extra field).
    expect(mockPost.mock.calls[0][0]).toBe('/v1/checkout/payment-intent');
    const body = mockPost.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(BACKEND_DTO_FIELDS);
    expect(body.package_id).toBe(PKG_A);
    expect(body.package_id).toMatch(IS_UUID);
    expect(body.idempotency_key).toMatch(IS_UUID);

    await finishSuccess(r);
    expect(mockPost.mock.calls.map((c) => c[0])).toEqual(['/v1/checkout/payment-intent']);

    expect(mockInitStripe).toHaveBeenCalledWith(
      expect.objectContaining({ publishableKey: 'pk_test_backend' }),
    );
    expect(mockInitPaymentSheet).toHaveBeenCalledTimes(1);
    const params = mockInitPaymentSheet.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toEqual(
      expect.objectContaining({
        customerId: 'cus_test_789',
        customerEphemeralKeySecret: 'ek_test_456',
        paymentIntentClientSecret: 'pi_test_123_secret_abc',
        merchantDisplayName: 'The Growth Project',
        allowsDelayedPaymentMethods: false,
      }),
    );
    // TGP theme (OR-110-2): the sheet follows the app's tokens and colour scheme.
    expect(params.style).toBe('alwaysLight');
    expect(params.appearance).toEqual(expect.objectContaining({ colors: expect.any(Object) }));
    expect(mockPresent).toHaveBeenCalledTimes(1);
    // Success waits for the webhook-driven entitlement, as the rest of the app reads it.
    expect(mockGetEntitlement).toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('uses the build publishable key when the backend sends none', async () => {
    mockPost.mockResolvedValueOnce({ data: { ...SECRETS, publishable_key: '' } });
    const r = await mountAndSelect();
    await pressSelect(r);
    await finishSuccess(r);
    expect(mockInitStripe).toHaveBeenCalledWith(expect.objectContaining({ publishableKey: 'pk_test_build' }));
  });

  it('a 200 without the PaymentSheet secrets is a support case, never a sheet with empty keys', async () => {
    mockPost.mockResolvedValueOnce({ data: { client_secret: 'pi_test_123_secret_abc', ephemeral_key: '', customer_id: '' } });
    const r = await mountAndSelect();
    await pressSelect(r);
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    expect(r.getByTestId('payment-support')).toBeTruthy();
    expect(JSON.stringify(mockCapture.mock.calls)).not.toContain('pi_test_123_secret_abc');
  });

  it('shows the price from amount_cents (the backend field)', async () => {
    const r = await mountAndSelect();
    expect(r.getByText('$149.00 once')).toBeTruthy();
    expect(r.getByText('$99.00 a month')).toBeTruthy();
    expect(r.getByText('Free')).toBeTruthy();
    expect(r.queryByText(/NaN/)).toBeNull();
  });

  it('cancel shows no error, does not finish, and the retry reuses the same idempotency key', async () => {
    mockPresent.mockResolvedValueOnce({ error: { code: 'Canceled', message: 'The payment flow has been canceled' } });
    const r = await mountAndSelect();
    await pressSelect(r);
    await waitFor(() => expect(mockPresent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(r.getByTestId('select-plan-btn').props.accessibilityState.disabled).toBe(false));
    expect(r.queryByTestId('payment-error')).toBeNull();
    expect(r.onPaymentSuccess).not.toHaveBeenCalled();

    await pressSelect(r);
    await finishSuccess(r);
    const keys = paymentIntentCalls().map((c) => (c[1] as { idempotency_key: string }).idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('a different package gets a new idempotency key', async () => {
    mockPresent.mockResolvedValueOnce({ error: { code: 'Canceled', message: 'canceled' } });
    const r = await mountAndSelect(PKG_A);
    await pressSelect(r);
    await waitFor(() => expect(mockPresent).toHaveBeenCalledTimes(1));
    await fireEvent.press(r.getByTestId(`package-card-${PKG_B}`));
    await pressSelect(r);
    await finishSuccess(r);
    const calls = paymentIntentCalls().map((c) => c[1] as { package_id: string; idempotency_key: string });
    expect(calls.map((c) => c.package_id)).toEqual([PKG_A, PKG_B]);
    expect(calls[0].idempotency_key).not.toBe(calls[1].idempotency_key);
  });

  it('when the entitlement has not landed yet, says the payment went through and offers Continue', async () => {
    mockGetEntitlement.mockResolvedValue({ ok: true, data: { active: false } });
    const r = await mountAndSelect();
    await pressSelect(r);
    await waitFor(() => expect(r.getByTestId('payment-confirmed-pending')).toBeTruthy());
    expect(r.getByText(
      'Your payment went through. Your plan can take a minute to show in the app. Choose Continue to carry on.',
    )).toBeTruthy();
    expect(r.onPaymentSuccess).not.toHaveBeenCalled();
    await fireEvent.press(r.getByTestId('payment-continue'));
    expect(r.onPaymentSuccess).toHaveBeenCalledTimes(1);
  });
});

describe('specific copy per cause', () => {
  async function failWith(setup: () => void) {
    setup();
    const r = await mountAndSelect();
    await pressSelect(r);
    await waitFor(() => expect(r.getByTestId('payment-error')).toBeTruthy());
    const text = r.getByTestId('payment-error').props.children as string;
    expectCopyRules(text);
    expect(r.onPaymentSuccess).not.toHaveBeenCalled();
    return { r, text };
  }

  it('offline (no response): connection copy, nothing charged, no Stripe call', async () => {
    const { r, text } = await failWith(() =>
      mockPost.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { config: {} })),
    );
    expect(text).toBe(
      'This phone is offline, so the payment did not start and nothing was charged. Check your connection, then start again.',
    );
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    expect(r.queryByTestId('payment-support')).toBeNull();
  });

  it('card declined (Stripe Failed + declineCode)', async () => {
    const { text } = await failWith(() =>
      mockPresent.mockResolvedValueOnce({ error: { code: 'Failed', message: 'Your card was declined.', declineCode: 'generic_decline', type: 'card_error' } }),
    );
    expect(text).toBe(
      'Your bank declined this card, so nothing was charged. Start again with a different card, or ask your bank about the decline.',
    );
  });

  it('insufficient funds', async () => {
    const { text } = await failWith(() =>
      mockPresent.mockResolvedValueOnce({ error: { code: 'Failed', message: 'x', declineCode: 'insufficient_funds', type: 'card_error' } }),
    );
    expect(text).toBe('This card does not have enough funds, so nothing was charged. Start again with a different card.');
  });

  it('bank authentication failed (3DS)', async () => {
    const { text } = await failWith(() =>
      mockPresent.mockResolvedValueOnce({ error: { code: 'Failed', message: 'x', stripeErrorCode: 'payment_intent_authentication_failure' } }),
    );
    expect(text).toBe(
      'Your bank could not confirm this payment, so nothing was charged. Start again to confirm with your bank, or use a different card.',
    );
  });

  it('package no longer offered (404 PACKAGE_NOT_FOUND)', async () => {
    const { text } = await failWith(() =>
      mockPost.mockRejectedValueOnce(httpError(404, { error: 'PACKAGE_NOT_FOUND', message: 'Package not available' })),
    );
    expect(text).toBe('This plan is no longer offered, so nothing was charged. Pull down to see your coach’s current plans, or message your coach.');
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('coach not set up for payments (409 COACH_NOT_PAYOUT_READY)', async () => {
    const { text } = await failWith(() =>
      mockPost.mockRejectedValueOnce(httpError(409, { error: 'COACH_NOT_PAYOUT_READY', message: 'x' })),
    );
    expect(text).toBe(
      'Your coach cannot take card payments right now, so this plan cannot start and nothing was charged. Message your coach, then choose the plan once they are ready.',
    );
  });

  it('payment still being set up (503 PAYMENT_IN_PROGRESS) and the retry keeps the key', async () => {
    const { r, text } = await failWith(() =>
      mockPost.mockRejectedValueOnce(httpError(503, { error: 'PAYMENT_IN_PROGRESS', message: 'x' })),
    );
    expect(text).toBe(
      'This payment is still being set up. Wait a few seconds, then start again. You will not be charged twice.',
    );
    await pressSelect(r);
    await finishSuccess(r);
    const keys = paymentIntentCalls().map((c) => (c[1] as { idempotency_key: string }).idempotency_key);
    expect(keys[0]).toBe(keys[1]);
  });

  it('too many attempts (429) names the wait', async () => {
    const { text } = await failWith(() =>
      mockPost.mockRejectedValueOnce(httpError(429, { statusCode: 429, error: 'Too Many Requests', message: 'x', retryAfter: 3600 })),
    );
    expect(text).toBe('There have been too many payment attempts, so this one did not start. Wait 60 minutes, then start again.');
  });

  it('payments not configured (503 CONNECT_NOT_CONFIGURED): support email, reference, Sentry', async () => {
    const { r, text } = await failWith(() =>
      mockPost.mockRejectedValueOnce(
        httpError(503, { error: 'CONNECT_NOT_CONFIGURED', message: 'x', request_id: 'req98765-aaaa-bbbb' }),
      ),
    );
    expect(text).toBe('Card payments are not switched on for this app yet, so nothing was charged. Email support and quote reference req98765.');
    expect(r.getByTestId('payment-error-reference').props.children).toBe('Reference req98765');
    expect(r.getByTestId('payment-support')).toBeTruthy();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('anything else: support email with the server reference, reported to Sentry without secrets', async () => {
    const { r, text } = await failWith(() =>
      mockPost.mockRejectedValueOnce(httpError(500, { error: 'INTERNAL', message: 'boom', request_id: 'f00dbabe-1234' })),
    );
    // B-342-1: an unmapped answer proves nothing about money: no no-charge claim.
    expect(text).toBe(
      'This step did not finish, and its result is not confirmed yet. Open your plan in Membership to see where it stands before you start again. If it is still unclear, email support and quote reference f00dbabe.',
    );
    expect(r.getByTestId('payment-open-plan')).toBeTruthy();
    expect(r.getByTestId('payment-support')).toBeTruthy();
    expect(mockCapture).toHaveBeenCalledTimes(1);
    const [err, ctx] = mockCapture.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toEqual(expect.objectContaining({ status: 500, code: 'INTERNAL', reference: 'f00dbabe' }));
  });

  it('an unknown PaymentSheet failure never sends the client secret or ephemeral key to Sentry', async () => {
    const { r } = await failWith(() =>
      mockPresent.mockResolvedValueOnce({ error: { code: 'Failed', message: 'pi_test_123_secret_abc is in a bad state' } }),
    );
    expect(r.getByTestId('payment-support')).toBeTruthy();
    expect(mockCapture).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(mockCapture.mock.calls.map(([e, c]) => [String((e as Error).message), c]));
    expect(sent).not.toContain('pi_test_123_secret_abc');
    expect(sent).not.toContain('ek_test_456');
    expect(sent).not.toContain('secret');
    // The reference is this attempt's key prefix, which support can find on the purchase row.
    const key = (paymentIntentCalls()[0][1] as { idempotency_key: string }).idempotency_key;
    expect(r.getByTestId('payment-error-reference').props.children).toBe(`Reference ${key.slice(0, 8)}`);
  });

  it('no publishable key anywhere: payments-off copy with support, nothing presented', async () => {
    const { r, text } = await failWith(() => {
      delete process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY;
      mockPost.mockResolvedValueOnce({ data: { ...SECRETS, publishable_key: '' } });
    });
    const key = (paymentIntentCalls()[0][1] as { idempotency_key: string }).idempotency_key;
    expect(text).toBe(
      `Card payments are not switched on for this app yet, so nothing was charged. Email support and quote reference ${key.slice(0, 8)}.`,
    );
    expect(r.getByTestId('payment-support')).toBeTruthy();
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('a build without the Stripe native module says to update the app and never mints a PaymentIntent', async () => {
    const { text } = await failWith(() => {
      delete mockStripeModule.initStripe;
      delete mockStripeModule.initPaymentSheet;
      delete mockStripeModule.presentPaymentSheet;
      delete mockStripeModule.useStripe;
    });
    expect(text).toBe(
      'Card payments need the latest version of the app. Update the app from your app store, then choose your plan again.',
    );
    expect(paymentIntentCalls()).toHaveLength(0);
  });
});

describe('plans the payment-intent route must not charge', () => {
  it('a $0 plan is claimed through /claim-free and never reaches Stripe', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url === `/v1/packages/${PKG_FREE}/claim-free`) return { data: { active: true, status: 'created' } };
      throw httpError(404, { error: 'Not Found', message: 'x' });
    });
    const r = await mountAndSelect(PKG_FREE);
    await pressSelect(r);
    await finishSuccess(r);
    expect(mockPost.mock.calls.map((c) => c[0])).toEqual([`/v1/packages/${PKG_FREE}/claim-free`]);
    expect(mockInitPaymentSheet).not.toHaveBeenCalled();
  });

  it('a renewing plan is never sold as a one-off PaymentIntent (it goes to subscription-intent)', async () => {
    const r = await mountAndSelect(PKG_MONTHLY);
    await pressSelect(r);
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(paymentIntentCalls()).toHaveLength(0);
    expect(mockPost.mock.calls[0][0]).toBe('/v1/checkout/subscription-intent');
  });
});

describe('AUD-SOL-SH-118 B-343-3 actual Day 1 callback configuration', () => {
  it('an uncertain Open your plan action cannot silently use the payment-success/leave-onboarding callback', async () => {
    // Both actual Day1WinScreen call sites omit onOpenPlan. RootNavigator's
    // onComplete callback enters the main app or a logger, not Membership.
    mockPost.mockRejectedValueOnce(httpError(500, { error: 'INTERNAL', request_id: 'f00dbabe-1234' }));
    const r = await mountAndSelect();
    await pressSelect(r);
    await waitFor(() => expect(r.getByTestId('payment-open-plan')).toBeTruthy());
    expect(r.queryByTestId('payment-success')).toBeNull();
    await fireEvent.press(r.getByTestId('payment-open-plan'));
    expect(r.onPaymentSuccess).not.toHaveBeenCalled();
  });

  it('control: an explicit plan-navigation callback receives the unknown plan id without payment success', async () => {
    const onOpenPlan = jest.fn();
    mockPost.mockRejectedValueOnce(httpError(500, { error: 'INTERNAL', request_id: 'f00dbabe-1234' }));
    const r = await mountAndSelect(PKG_A, { onOpenPlan });
    await pressSelect(r);
    await waitFor(() => expect(r.getByTestId('payment-open-plan')).toBeTruthy());
    await fireEvent.press(r.getByTestId('payment-open-plan'));
    expect(onOpenPlan).toHaveBeenCalledWith(null);
    expect(r.onPaymentSuccess).not.toHaveBeenCalled();
  });
});
