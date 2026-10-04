/**
 * B-SHEET-118 (agent 118) round on split S2 (#343), real hook, synthetic
 * external boundaries:
 *   B-343-1 (Sol)  no payable native sheet after unmount / sign-out.
 *   B-343-2        per-package keys: A unknown -> B -> A replays A's key.
 *   B-343-3        #661 replay answers drive the key and the next action.
 *   B-343-1 (Opus) an unclear one-time result is read as "checking".
 *   B-343-4        a pinned trial date is reviewed before any card step.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { usePackagePurchase } from '../usePackagePurchase';
import { PACKAGE_PAYMENT_COPY } from '../../lib/packagePayment';
import type { PurchasablePackage } from '../../lib/planTerms';
import { authEvents } from '../../utils/authEvents';

const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: { post: (...a: unknown[]) => mockPost(...a), get: (...a: unknown[]) => mockGet(...a) },
}));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));
const mockPurchases = jest.fn();
jest.mock('../../api/clientPaymentsApi', () => ({
  clientPaymentsApi: {
    getPurchases: () => mockPurchases(),
    getEntitlement: async () => ({ ok: true, data: { active: false } }),
  },
}));
const mockInitSheet = jest.fn();
const mockPresent = jest.fn();
jest.mock('@stripe/stripe-react-native', () => ({
  initStripe: async () => undefined,
  initPaymentSheet: (...a: unknown[]) => mockInitSheet(...a),
  presentPaymentSheet: (...a: unknown[]) => mockPresent(...a),
}));

const A: PurchasablePackage = {
  id: '11111111-2222-4333-8444-555555555555', name: 'Synthetic A', amountCents: 4900, currency: 'usd',
  renewing: false, interval: null, intervalCount: 1, oneTimeCents: 0, trialDays: 0,
};
const B = { ...A, id: '99999999-8888-4777-8666-555555555555', name: 'Synthetic B' };
const recurring: PurchasablePackage = { ...A, renewing: true, interval: 'month' };
const secrets = {
  client_secret: 'pi_synthetic_secret_example', ephemeral_key: 'ek_synthetic',
  customer_id: 'cus_synthetic', publishable_key: 'pk_test_synthetic',
};
const plan = {
  amount_cents: 4900, currency: 'usd', interval: 'month', interval_count: 1,
  first_charge_cents: 4900, one_time_cents: 0, trial_days: 0,
};
const intent = { ...secrets, mode: 'payment', purchase_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', plan };
const lostAnswer = () => new Error('Synthetic lost confirmation response');
const reply = (status: number, code: string) => ({ response: { status, data: { error: code, request_id: 'cafe0123-1' } } });
const keys = () => mockPost.mock.calls.map(([, body]) => (body as { idempotency_key: string }).idempotency_key);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

async function mount(now?: () => Date) {
  const onEntitled = jest.fn();
  const hook = await renderHook(() =>
    usePackagePurchase({
      surface: 'sheet', appearance: {}, colorScheme: 'light', now,
      entitlementPollDelaysMs: [0], planPollDelaysMs: [0], recheckDelaysMs: [0], onEntitled,
    }),
  );
  return { ...hook, onEntitled };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockImplementation(async (path: string) => ({ data: path.includes('subscription-intent') ? intent : secrets }));
  mockGet.mockResolvedValue({ data: null });
  mockInitSheet.mockResolvedValue({});
  mockPresent.mockResolvedValue({ error: { code: 'Canceled' } });
  mockPurchases.mockResolvedValue({ ok: true, data: [] });
});

describe('B-343-1 (Sol) a flow that outlived its screen or account never opens a sheet', () => {
  it('unmount while the one-time intent is held', async () => {
    const held = deferred<{ data: typeof secrets }>();
    mockPost.mockReturnValueOnce(held.promise);
    const h = await mount();
    let running!: Promise<void>;
    await act(async () => { running = h.result.current.start(A); });
    await h.unmount();
    await act(async () => { held.resolve({ data: secrets }); await running; });
    expect(mockInitSheet).not.toHaveBeenCalled();
    expect(mockPresent).not.toHaveBeenCalled();
  });

  it('unmount while the subscription sheet initializes', async () => {
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

  it.each(['logout', 'login'])('%s while the intent is held: no sheet, state cleared, keys of the old account dropped', async (event) => {
    const held = deferred<{ data: typeof secrets }>();
    mockPost.mockReturnValueOnce(held.promise);
    const h = await mount();
    let running!: Promise<void>;
    await act(async () => { running = h.result.current.start(A); });
    await act(async () => { authEvents.emit(event); held.resolve({ data: secrets }); await running; });
    expect(mockInitSheet).not.toHaveBeenCalled();
    expect(h.result.current.state.phase).toBe('idle');
    expect(h.result.current.busy).toBe(false);
    await act(async () => { await h.result.current.start(A); });
    expect(keys()[1]).not.toBe(keys()[0]);
  });
});

describe('B-343-2 keys are kept per package', () => {
  it('A unknown -> B canceled -> A replays the A key', async () => {
    mockPresent.mockRejectedValueOnce(lostAnswer());
    const h = await mount();
    await act(async () => { await h.result.current.start(A); });
    expect(h.result.current.state.notice?.checkAgain).toBe(true);
    await act(async () => { await h.result.current.start(B); });
    await act(async () => { await h.result.current.start(A); });
    expect(keys()[2]).toBe(keys()[0]);
    expect(keys()[1]).not.toBe(keys()[0]);
  });
});

describe('B-343-3 finished replays (backend #661)', () => {
  it('PAYMENT_CHECKOUT_CLOSED retires the key', async () => {
    mockPost.mockRejectedValue(reply(409, 'PAYMENT_CHECKOUT_CLOSED'));
    const h = await mount();
    await act(async () => { await h.result.current.start(A); });
    await act(async () => { await h.result.current.start(A); });
    expect(keys()[1]).not.toBe(keys()[0]);
    expect(mockPresent).not.toHaveBeenCalled();
  });

  it('PAYMENT_ALREADY_COMPLETE refreshes the entitlement and offers the plan', async () => {
    mockPost.mockRejectedValueOnce(reply(409, 'PAYMENT_ALREADY_COMPLETE'));
    const h = await mount();
    await act(async () => { await h.result.current.start(A); });
    expect(h.onEntitled).toHaveBeenCalledTimes(1);
    expect(h.result.current.state.notice).toEqual(
      expect.objectContaining({ message: PACKAGE_PAYMENT_COPY.alreadyComplete, openPlan: true }),
    );
    expect(mockPresent).not.toHaveBeenCalled();
  });

  it('PAYMENT_REFUNDED_OR_IN_REVIEW keeps the key and never opens a sheet', async () => {
    mockPost.mockRejectedValue(reply(409, 'PAYMENT_REFUNDED_OR_IN_REVIEW'));
    const h = await mount();
    await act(async () => { await h.result.current.start(A); });
    await act(async () => { await h.result.current.start(A); });
    expect(keys()[1]).toBe(keys()[0]);
    expect(h.result.current.state.notice).toEqual(expect.objectContaining({ support: true, openPlan: true }));
    expect(mockPresent).not.toHaveBeenCalled();
  });
});

describe('B-343-1 (Opus) an unclear one-time result is never "Payment received"', () => {
  it('reading the purchase after a lost answer is flagged as checking', async () => {
    const held = deferred<{ ok: boolean; data: unknown[] }>();
    mockPresent.mockRejectedValueOnce(lostAnswer());
    mockPurchases.mockReturnValueOnce(held.promise);
    const h = await mount();
    let running!: Promise<void>;
    await act(async () => { running = h.result.current.start(A); });
    await waitFor(() => expect(mockPurchases).toHaveBeenCalledTimes(1));
    expect(h.result.current.state).toEqual(expect.objectContaining({ phase: 'confirming', checking: true }));
    await act(async () => { held.resolve({ ok: true, data: [] }); await running; });
    expect(h.result.current.state.checking).toBe(false);
  });
});

describe('B-343-4 a resumed trial keeps its pinned first-charge date', () => {
  it('a pinned date that differs from the shown date is reviewed before any card step, then the same key replays', async () => {
    const now = new Date(2026, 9, 4, 1, 0, 0);
    const pinned = new Date(2026, 9, 10, 13, 0, 0).toISOString();
    const trial = { ...recurring, trialDays: 7 };
    const setup = {
      ...intent, mode: 'setup', client_secret: 'seti_synthetic_secret_example',
      plan: { ...plan, first_charge_cents: 0, trial_days: 7, trial_ends_at: pinned },
    };
    mockPost.mockResolvedValue({ data: setup });
    const h = await mount(() => now);
    await act(async () => { await h.result.current.start(trial); });
    expect(mockInitSheet).not.toHaveBeenCalled();
    expect(h.result.current.state.phase).toBe('idle');
    expect(h.result.current.state.priceChange).toEqual(
      expect.objectContaining({ message: PACKAGE_PAYMENT_COPY.termsReviewTrialDate }),
    );
    expect(h.result.current.state.priceChange?.pkg.trialEndsAt).toBe(pinned);
    await act(async () => { await h.result.current.confirmNewPrice(); });
    expect(keys()[1]).toBe(keys()[0]);
    expect(mockInitSheet).toHaveBeenCalledTimes(1);
  });
});

describe('AUD-SOL-SH-118 residual uncertainty and account fences', () => {
  it('a one-time unknown result followed by a timeout on the same key never becomes proven unpaid', async () => {
    mockPresent.mockRejectedValueOnce(lostAnswer());
    const h = await mount();
    await act(async () => { await h.result.current.start(A); });
    expect(h.result.current.state.notice?.checkAgain).toBe(true);
    mockPost.mockRejectedValueOnce(Object.assign(new Error('Synthetic timeout'), { code: 'ECONNABORTED', request: {} }));
    await act(async () => { await h.result.current.start(A); });
    expect(keys()[1]).toBe(keys()[0]);
    expect(h.result.current.state.notice?.message).not.toMatch(/nothing was charged|not charged|did not go through/i);
  });

  it.each(['logout', 'login'])('%s during a held plan read that later rejects cannot publish old-account slow progress', async (event) => {
    const held = deferred<{ data: unknown }>();
    mockPresent.mockResolvedValueOnce({});
    mockGet.mockReturnValueOnce(held.promise);
    const h = await mount();
    let running!: Promise<void>;
    await act(async () => { running = h.result.current.start(recurring); });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    await act(async () => {
      authEvents.emit(event);
      held.reject(new Error('Synthetic plan read lost after account change'));
      await running;
    });
    expect(h.onEntitled).not.toHaveBeenCalled();
    expect(h.result.current.state.phase).toBe('idle');
    expect(h.result.current.state.packageId).toBeNull();
  });

  it('account change during the first failed poll cannot issue another old-account plan read', async () => {
    const held = deferred<{ data: unknown }>();
    mockPresent.mockResolvedValueOnce({});
    mockGet.mockReturnValueOnce(held.promise);
    const h = await renderHook(() => usePackagePurchase({
      surface: 'sheet', appearance: {}, colorScheme: 'light',
      planPollDelaysMs: [0, 0], entitlementPollDelaysMs: [0], recheckDelaysMs: [0],
    }));
    let running!: Promise<void>;
    await act(async () => { running = h.result.current.start(recurring); });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    await act(async () => {
      authEvents.emit('logout');
      held.reject(new Error('Synthetic plan read lost after account change'));
      await running;
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('control: account change during a successful plan read drops the old entitlement', async () => {
    const held = deferred<{ data: unknown }>();
    mockPresent.mockResolvedValueOnce({});
    mockGet.mockReturnValueOnce(held.promise);
    const h = await mount();
    let running!: Promise<void>;
    await act(async () => { running = h.result.current.start(recurring); });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    await act(async () => {
      authEvents.emit('logout');
      held.resolve({ data: {
        purchase_id: intent.purchase_id, package_id: recurring.id,
        state: 'active', entitlement_active: true,
      } });
      await running;
    });
    expect(h.onEntitled).not.toHaveBeenCalled();
    expect(h.result.current.state.phase).toBe('idle');
  });
});
