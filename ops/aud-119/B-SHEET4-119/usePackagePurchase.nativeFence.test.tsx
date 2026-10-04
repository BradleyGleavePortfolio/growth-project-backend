/**
 * B-SHEET4-119 (agent 119), mobile #343 B-343-1 (Sol) and #342 B-342-1 (Sol).
 *   B-343-1  every await in the sheet path, fulfilled or rejected, is fenced:
 *            a rejected initStripe / initPaymentSheet after logout, login or
 *            unmount publishes no notice, no reference and no Sentry event.
 *   B-342-1  after an unclear card step, a same-key retry that meets an
 *            archived package never says nothing was charged; the key stays.
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
const mockCapture = jest.fn();
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: { post: (...a: unknown[]) => mockPost(...a), get: (...a: unknown[]) => mockGet(...a) },
}));
jest.mock('../../services/sentry', () => ({ captureError: (...a: unknown[]) => mockCapture(...a) }));
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
const NO_CHARGE = /nothing was charged|not charged|did not go through/i;
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
const mount = () => renderHook(() => usePackagePurchase({
  surface: 'sheet', appearance: {}, colorScheme: 'light',
  planPollDelaysMs: [0], entitlementPollDelaysMs: [0], recheckDelaysMs: [0],
}));
const natives = { initStripe: mockInitStripe, initPaymentSheet: mockInitSheet };
beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockResolvedValue({ data: intent });
  mockGet.mockResolvedValue({ data: null });
  mockInitStripe.mockResolvedValue(undefined);
  mockInitSheet.mockResolvedValue({});
  mockPresent.mockResolvedValue({ error: { code: 'Canceled' } });
});

describe('B-343-1 rejected native initialization is fenced like a fulfilled one', () => {
  const cases = (['initStripe', 'initPaymentSheet'] as const).flatMap((call) =>
    ([['one-time', oneTime], ['renewing', renewing]] as const).flatMap(([label, pkg]) =>
      (['logout', 'login'] as const).map((event) => [call, label, event, pkg] as const)));

  it.each(cases)('%s rejects after %s %s: no old notice, reference or report', async (call, _l, event, pkg) => {
    const held = deferred<never>();
    natives[call].mockReturnValueOnce(held.promise);
    const h = await mount();
    let running!: Promise<void>;
    await act(async () => { running = h.result.current.start(pkg); });
    await waitFor(() => expect(natives[call]).toHaveBeenCalledTimes(1));
    await act(async () => {
      authEvents.emit(event);
      held.reject(new Error('Synthetic native rejection after account change'));
      await running;
    });
    expect(mockPresent).not.toHaveBeenCalled();
    if (call === 'initStripe') expect(mockInitSheet).not.toHaveBeenCalled();
    expect(h.result.current.state).toEqual(expect.objectContaining({ phase: 'idle', packageId: null, notice: null }));
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it.each([['initStripe'], ['initPaymentSheet']] as const)('%s rejects after unmount: no report', async (call) => {
    const held = deferred<never>();
    natives[call].mockReturnValueOnce(held.promise);
    const h = await mount();
    let running!: Promise<void>;
    await act(async () => { running = h.result.current.start(oneTime); });
    await waitFor(() => expect(natives[call]).toHaveBeenCalledTimes(1));
    await act(async () => { await h.unmount(); });
    await act(async () => { held.reject(new Error('Synthetic native rejection after unmount')); await running; });
    expect(mockPresent).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it.each([['initStripe'], ['initPaymentSheet']] as const)('control: %s rejects on the same account: actionable notice', async (call) => {
    natives[call].mockRejectedValueOnce(new Error('Synthetic native failure'));
    const h = await mount();
    await act(async () => { await h.result.current.start(renewing); });
    expect(h.result.current.state.notice).toEqual(expect.objectContaining({ cause: 'stripe_sheet_init_threw', support: true }));
    expect(h.result.current.state.notice?.reference).toEqual(expect.any(String));
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});

describe('B-342-1 an archived package after an unclear card step', () => {
  it.each([['one-time', oneTime], ['renewing', renewing]] as const)('%s: same key, no no-charge claim, plan and support kept', async (_l, pkg) => {
    mockPresent.mockRejectedValueOnce(new Error('Synthetic lost confirmation'));
    const h = await mount();
    await act(async () => { await h.result.current.start(pkg); });
    const unclear = h.result.current.state.notice;
    expect(unclear?.checkAgain).toBe(true);
    mockPost.mockRejectedValueOnce({ response: { status: 404, data: { error: 'PACKAGE_NOT_FOUND' } } });
    await act(async () => { await h.result.current.start(pkg); });
    const keys = mockPost.mock.calls.map(([, body]) => (body as { idempotency_key: string }).idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const n = h.result.current.state.notice;
    expect(n?.message).toMatch(/^This plan is no longer offered/);
    expect(n?.message).not.toMatch(NO_CHARGE);
    expect(n).toEqual(expect.objectContaining({ support: true, openPlan: true, reference: unclear?.reference }));
    // The key survives: the next tap still replays the same attempt.
    await act(async () => { await h.result.current.start(pkg); });
    expect((mockPost.mock.calls[2][1] as { idempotency_key: string }).idempotency_key).toBe(keys[0]);
  });
});
