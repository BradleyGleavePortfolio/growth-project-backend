/**
 * AUD-SOL-S12-119: fulfilled/rejected native initialization must have the
 * same account fence, and retries after an unclear payment retain truth.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { usePackagePurchase } from '../usePackagePurchase';
import { authEvents } from '../../utils/authEvents';
import type { PurchasablePackage } from '../../lib/planTerms';

const mockPost = jest.fn();
const mockGet = jest.fn();
const mockInitStripe = jest.fn();
const mockInitSheet = jest.fn();
const mockPresent = jest.fn();
jest.mock('../../services/api', () => ({
  __esModule: true, default: { post: (...a: unknown[]) => mockPost(...a), get: (...a: unknown[]) => mockGet(...a) },
}));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('../../api/clientPaymentsApi', () => ({
  clientPaymentsApi: {
    getPurchases: async () => ({ ok: true, data: [] }),
    getEntitlement: async () => ({ ok: true, data: { active: false } }),
  },
}));
jest.mock('@stripe/stripe-react-native', () => ({
  initStripe: (...a: unknown[]) => mockInitStripe(...a),
  initPaymentSheet: (...a: unknown[]) => mockInitSheet(...a),
  presentPaymentSheet: (...a: unknown[]) => mockPresent(...a),
}));

const oneTime: PurchasablePackage = {
  id: '11111111-2222-4333-8444-555555555555', name: 'Synthetic plan', amountCents: 4900, currency: 'usd',
  renewing: false, interval: null, intervalCount: 1, oneTimeCents: 0, trialDays: 0,
};
const renewing: PurchasablePackage = { ...oneTime, renewing: true, interval: 'month' };
const intent = {
  mode: 'payment', purchase_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  client_secret: 'pi_synthetic_secret_example', ephemeral_key: 'ek_synthetic',
  customer_id: 'cus_synthetic', publishable_key: 'pk_test_synthetic',
  plan: { amount_cents: 4900, currency: 'usd', interval: 'month', interval_count: 1, first_charge_cents: 4900, one_time_cents: 0, trial_days: 0 },
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
async function mount() {
  return renderHook(() => usePackagePurchase({
    surface: 'sheet', appearance: {}, colorScheme: 'light',
    planPollDelaysMs: [0], entitlementPollDelaysMs: [0], recheckDelaysMs: [0],
  }));
}
beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockResolvedValue({ data: intent });
  mockGet.mockResolvedValue({ data: null });
  mockInitStripe.mockResolvedValue(undefined);
  mockInitSheet.mockResolvedValue({});
  mockPresent.mockResolvedValue({ error: { code: 'Canceled' } });
});

it.each([
  ['one-time logout', oneTime, 'logout'],
  ['one-time login', oneTime, 'login'],
  ['renewing logout', renewing, 'logout'],
  ['renewing login', renewing, 'login'],
])('%s: rejected sheet initialization cannot publish the old account notice', async (_label, pkg, event) => {
  const held = deferred<Record<string, never>>();
  mockInitSheet.mockReturnValueOnce(held.promise);
  const h = await mount();
  let running!: Promise<void>;
  await act(async () => { running = h.result.current.start(pkg as PurchasablePackage); });
  await waitFor(() => expect(mockInitSheet).toHaveBeenCalledTimes(1));
  await act(async () => {
    authEvents.emit(event as string);
    held.reject(new Error('Synthetic initialization rejected after account change'));
    await running;
  });
  expect(mockPresent).not.toHaveBeenCalled();
  expect(h.result.current.state).toEqual(expect.objectContaining({ phase: 'idle', packageId: null, notice: null }));
});

it('control: fulfilled initialization after logout is correctly retired', async () => {
  const held = deferred<Record<string, never>>();
  mockInitSheet.mockReturnValueOnce(held.promise);
  const h = await mount();
  let running!: Promise<void>;
  await act(async () => { running = h.result.current.start(oneTime); });
  await waitFor(() => expect(mockInitSheet).toHaveBeenCalledTimes(1));
  await act(async () => { authEvents.emit('logout'); held.resolve({}); await running; });
  expect(mockPresent).not.toHaveBeenCalled();
  expect(h.result.current.state.notice).toBeNull();
});

it('control: same-account initialization rejection remains actionable', async () => {
  mockInitSheet.mockRejectedValueOnce(new Error('Synthetic native failure'));
  const h = await mount();
  await act(async () => { await h.result.current.start(oneTime); });
  expect(h.result.current.state.notice).toEqual(expect.objectContaining({ cause: 'stripe_sheet_init_threw', support: true }));
});

it('archived package on a same-key retry cannot undo an unknown native outcome', async () => {
  mockPresent.mockRejectedValueOnce(new Error('Synthetic lost confirmation'));
  const h = await mount();
  await act(async () => { await h.result.current.start(oneTime); });
  expect(h.result.current.state.notice?.checkAgain).toBe(true);
  mockPost.mockRejectedValueOnce({ response: { status: 404, data: { error: 'PACKAGE_NOT_FOUND' } } });
  await act(async () => { await h.result.current.start(oneTime); });
  const keys = mockPost.mock.calls.map(([, body]) => (body as { idempotency_key: string }).idempotency_key);
  expect(keys[1]).toBe(keys[0]);
  expect(h.result.current.state.notice?.message).not.toMatch(/nothing was charged|not charged|did not go through/i);
});
