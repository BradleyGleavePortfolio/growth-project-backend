import { act, renderHook, waitFor } from '@testing-library/react-native';
import { usePackagePurchase } from '../usePackagePurchase';
import type { PurchasablePackage } from '../../lib/planTerms';

const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: {
    post: (...args: unknown[]) => mockPost(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
}));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));
const mockPurchases = jest.fn();
const mockEntitlement = jest.fn();
jest.mock('../../api/clientPaymentsApi', () => ({
  clientPaymentsApi: {
    getPurchases: () => mockPurchases(),
    getEntitlement: () => mockEntitlement(),
  },
}));
const mockInitStripe = jest.fn();
const mockInitSheet = jest.fn();
const mockPresent = jest.fn();
jest.mock('@stripe/stripe-react-native', () => ({
  initStripe: (...args: unknown[]) => mockInitStripe(...args),
  initPaymentSheet: (...args: unknown[]) => mockInitSheet(...args),
  presentPaymentSheet: (...args: unknown[]) => mockPresent(...args),
}));

const A: PurchasablePackage = {
  id: '11111111-2222-4333-8444-555555555555',
  name: 'Synthetic A', amountCents: 4900, currency: 'usd',
  renewing: false, interval: null, intervalCount: 1, oneTimeCents: 0, trialDays: 0,
};
const B = { ...A, id: '99999999-8888-4777-8666-555555555555', name: 'Synthetic B' };
const recurring: PurchasablePackage = { ...A, renewing: true, interval: 'month' };
const secrets = {
  client_secret: 'pi_synthetic_secret_example',
  ephemeral_key: 'ek_synthetic', customer_id: 'cus_synthetic',
  publishable_key: 'pk_test_synthetic',
};
const intent = {
  ...secrets, mode: 'payment', purchase_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  plan: {
    amount_cents: 4900, currency: 'usd', interval: 'month', interval_count: 1,
    first_charge_cents: 4900, one_time_cents: 0, trial_days: 0,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function mount() {
  const onEntitled = jest.fn();
  const hook = await renderHook(() => usePackagePurchase({
    surface: 'sheet', appearance: {}, colorScheme: 'light',
    entitlementPollDelaysMs: [0], planPollDelaysMs: [0], recheckDelaysMs: [0],
    onEntitled,
  }));
  return { ...hook, onEntitled };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockImplementation(async (path: string) => ({
    data: path.includes('subscription-intent') ? intent : secrets,
  }));
  mockGet.mockResolvedValue({ data: null });
  mockInitStripe.mockResolvedValue(undefined);
  mockInitSheet.mockResolvedValue({});
  mockPresent.mockResolvedValue({ error: { code: 'Canceled' } });
  mockPurchases.mockResolvedValue({ ok: true, data: [] });
  mockEntitlement.mockResolvedValue({ ok: true, data: { active: false } });
});

describe('AUD-SOL-P12-117 P2 actual hook / synthetic external boundaries', () => {
  it('unmount while one-time intent response is held must not open a payable native sheet', async () => {
    const held = deferred<{ data: typeof secrets }>();
    mockPost.mockReturnValueOnce(held.promise);
    const h = await mount();
    let running!: Promise<void>;
    await act(async () => { running = h.result.current.start(A); });
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    await h.unmount();
    await act(async () => { held.resolve({ data: secrets }); await running; });
    expect(mockInitSheet).not.toHaveBeenCalled();
    expect(mockPresent).not.toHaveBeenCalled();
  });

  it('unmount while subscription sheet initialization is held must not present it later', async () => {
    const held = deferred<Record<string, never>>();
    mockInitSheet.mockReturnValueOnce(held.promise);
    const h = await mount();
    let running!: Promise<void>;
    await act(async () => { running = h.result.current.start(recurring); });
    await waitFor(() => expect(mockInitSheet).toHaveBeenCalledTimes(1));
    await h.unmount();
    await act(async () => { held.resolve({}); await running; });
    expect(mockPresent).not.toHaveBeenCalled();
  });

  it('A uncertain -> B canceled -> A must replay A key, not mint a second payable A intent', async () => {
    mockPresent
      .mockRejectedValueOnce(new Error('Synthetic lost confirmation response'))
      .mockResolvedValueOnce({ error: { code: 'Canceled' } })
      .mockResolvedValueOnce({ error: { code: 'Canceled' } });
    const h = await mount();
    await act(async () => { await h.result.current.start(A); });
    expect(h.result.current.state.notice?.checkAgain).toBe(true);
    await act(async () => { await h.result.current.start(B); });
    await act(async () => { await h.result.current.start(A); });
    const requests = mockPost.mock.calls.map(([, body]) => body);
    expect(requests.map((body) => body.package_id)).toEqual([A.id, B.id, A.id]);
    expect(requests[2].idempotency_key).toBe(requests[0].idempotency_key);
    expect(requests[1].idempotency_key).not.toBe(requests[0].idempotency_key);
  });

  it('PAYMENT_CHECKOUT_CLOSED must retire the key so the next tap can start again', async () => {
    mockPost.mockRejectedValue({
      response: { status: 409, data: { error: 'PAYMENT_CHECKOUT_CLOSED' } },
    });
    const h = await mount();
    await act(async () => { await h.result.current.start(A); });
    await act(async () => { await h.result.current.start(A); });
    expect(mockPost.mock.calls[1][1].idempotency_key).not.toBe(mockPost.mock.calls[0][1].idempotency_key);
    expect(mockPresent).not.toHaveBeenCalled();
  });

  it('control: same-package unknown retry keeps the original attempt key', async () => {
    mockPresent.mockRejectedValueOnce(new Error('Synthetic lost confirmation response'));
    const h = await mount();
    await act(async () => { await h.result.current.start(A); });
    await act(async () => { await h.result.current.start(A); });
    expect(mockPost.mock.calls[1][1].idempotency_key).toBe(mockPost.mock.calls[0][1].idempotency_key);
  });

  it('control: double start while the intent is held creates one request', async () => {
    const held = deferred<{ data: typeof secrets }>();
    mockPost.mockReturnValueOnce(held.promise);
    const h = await mount();
    let running!: Promise<void>;
    await act(async () => {
      running = h.result.current.start(A);
      await h.result.current.start(A);
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    await act(async () => { held.resolve({ data: secrets }); await running; });
    expect(mockPresent).toHaveBeenCalledTimes(1);
  });

  it('C-334-3 closure: unmount during confirming GET never calls entitlement callback', async () => {
    const held = deferred<{ data: unknown }>();
    mockPresent.mockResolvedValueOnce({});
    mockGet.mockReturnValueOnce(held.promise);
    const h = await mount();
    let running!: Promise<void>;
    await act(async () => { running = h.result.current.start(recurring); });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    await h.unmount();
    await act(async () => {
      held.resolve({ data: {
        purchase_id: intent.purchase_id, state: 'active', entitlement_active: true,
        package_id: A.id, amount_cents: 4900, currency: 'usd',
      } });
      await running;
    });
    expect(h.onEntitled).not.toHaveBeenCalled();
  });
});
