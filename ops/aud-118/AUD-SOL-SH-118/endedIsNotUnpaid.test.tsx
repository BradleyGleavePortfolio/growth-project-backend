import { act, renderHook } from '@testing-library/react-native';
import { usePackagePurchase } from '../usePackagePurchase';
import type { PurchasablePackage } from '../../lib/planTerms';

const mockGet = jest.fn();
const mockPresent = jest.fn();
jest.mock('../../services/api', () => ({
  __esModule: true,
  default: {
    post: async () => ({ data: {
      mode: 'payment', purchase_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      client_secret: 'pi_synthetic_secret_example', ephemeral_key: 'ek_synthetic',
      customer_id: 'cus_synthetic', publishable_key: 'pk_test_synthetic',
      plan: { amount_cents: 4900, currency: 'usd', interval: 'month', interval_count: 1,
        first_charge_cents: 4900, one_time_cents: 0, trial_days: 0 },
    } }),
    get: (...a: unknown[]) => mockGet(...a),
  },
}));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('@stripe/stripe-react-native', () => ({
  initStripe: async () => undefined,
  initPaymentSheet: async () => ({}),
  presentPaymentSheet: () => mockPresent(),
}));

const pkg: PurchasablePackage = {
  id: '11111111-2222-4333-8444-555555555555', name: 'Synthetic plan',
  amountCents: 4900, currency: 'usd', renewing: true, interval: 'month',
  intervalCount: 1, oneTimeCents: 0, trialDays: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPresent.mockRejectedValue(new Error('Synthetic lost confirmation response'));
});

describe('AUD-SOL-SH-118 an ended subscription is not proof that no payment ever succeeded', () => {
  it.each([
    ['ended', null],
    ['confirming', 'ended'],
  ])('canonical state %s / checkout %s never asserts an unpaid result', async (state, checkout) => {
    // Backend planView maps a canceled row to ended regardless of earlier
    // payment; readCheckoutState checks canceled before the paid invoice.
    mockGet.mockResolvedValue({ data: {
      purchase_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      package_id: pkg.id, state, entitlement_active: false, checkout_state: checkout,
    } });
    const h = await renderHook(() => usePackagePurchase({
      surface: 'sheet', appearance: {}, colorScheme: 'light',
      planPollDelaysMs: [0], recheckDelaysMs: [0],
    }));
    await act(async () => { await h.result.current.start(pkg); });
    expect(h.result.current.state.notice).not.toBeNull();
    expect(h.result.current.state.notice?.message).not.toMatch(/nothing was charged|not charged|did not go through/i);
  });

  it('control: an authoritative awaiting-payment read can retain the no-charge disposition', async () => {
    mockGet.mockResolvedValue({ data: {
      purchase_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      package_id: pkg.id, state: 'confirming', entitlement_active: false,
      checkout_state: 'awaiting_payment',
    } });
    const h = await renderHook(() => usePackagePurchase({
      surface: 'sheet', appearance: {}, colorScheme: 'light',
      planPollDelaysMs: [0], recheckDelaysMs: [0],
    }));
    await act(async () => { await h.result.current.start(pkg); });
    expect(h.result.current.state.notice?.message).toContain('Stripe shows no payment');
  });
});
