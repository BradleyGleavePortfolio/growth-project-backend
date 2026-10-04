/** Audit-only mounted lifecycle and dispute probes; never merge this file. */
import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DunningLockoutProvider, useDunning } from '../DunningLockoutProvider';
import { dunningLockoutStore } from '../dunningLockoutStore';
import { UpdateCardScreen } from '../UpdateCardScreen';
import { __resetStripeSdkForTests } from '../updateCard';

jest.mock('../../../theme/ThemeProvider', () => {
  const t = jest.requireActual('../../../theme/tokens').default;
  return { useTheme: () => ({ semanticColors: t.lightTokens, tokens: t, colorScheme: 'light' }) };
});
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('../../../services/api', () => ({
  __esModule: true,
  default: { get: (...args: unknown[]) => mockGet(...args), post: (...args: unknown[]) => mockPost(...args) },
}));
jest.mock('../../../services/sentry', () => ({ captureError: jest.fn() }));
jest.mock('../../../services/queryClient', () => ({ queryClient: { invalidateQueries: jest.fn() } }));
const mockSdk = {
  initStripe: jest.fn(async () => undefined),
  initPaymentSheet: jest.fn(async () => ({})),
  presentPaymentSheet: jest.fn(async () => ({})),
  handleNextAction: jest.fn(async () => ({})),
  handleURLCallback: jest.fn(async () => true),
};
jest.mock('@stripe/stripe-react-native', () => mockSdk);
const LOCKED = {
  enabled: true, state: 'locked', kind: 'payment', purchase_id: 'purchase-A',
  amount_cents: 15000, currency: 'usd', failed_at: '2026-10-01T00:00:00Z',
  lockout_at: '2026-10-11T00:00:00Z', locked_at: '2026-10-11T00:00:00Z',
  coach_name: 'Avery', card_last4: '4242', card_brand: 'visa', day: 10,
};
const CLEAR = { ...LOCKED, state: 'none' };
const QUOTE = {
  quote_id: 'q1', complete: true,
  lines: [{ invoice_id: 'in_A', purchase_id: 'purchase-A', currency: 'usd', amount_cents: 15000 }],
  totals: [{ currency: 'usd', amount_cents: 15000 }], disputes: [],
};
const SETUP = {
  setup_intent_id: 'seti_A', setup_intent_client_secret: 'seti_A_secret',
  ephemeral_key: 'ek_A', customer_id: 'cus_A', publishable_key: 'pk_test_backend',
  merchant_display_name: 'The Growth Project',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let refresh: (() => Promise<void>) | undefined;
function Reader() {
  const d = useDunning();
  refresh = d?.refresh;
  return <Text testID="status">{d?.status?.state ?? 'unknown'}</Text>;
}
function Provider({ children, card = false }: { children: React.ReactNode; card?: boolean }) {
  return (
    <DunningLockoutProvider
      enabled onMessageCoach={jest.fn()} onOpenDataExport={jest.fn()}
      onOpenDeleteAccount={jest.fn()} onSignOut={jest.fn()} onOpenUpdateCard={jest.fn()}
      getCurrentRouteName={() => card ? 'UpdateCard' : 'HomeMain'}
      subscribeToRouteChanges={() => () => undefined}
    >{children}</DunningLockoutProvider>
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  dunningLockoutStore.__resetForTests();
  __resetStripeSdkForTests();
  refresh = undefined;
  mockGet.mockReset();
  mockPost.mockReset();
  mockSdk.presentPaymentSheet.mockImplementation(async () => ({}));
  mockPost.mockImplementation(async (url: string) => {
    if (url.endsWith('/setup-intent')) return { data: SETUP };
    return { data: {
      outcome: 'paid', amount_paid_cents: 15000, amount_due_cents: 0,
      currency: 'usd', paid_totals: [{ currency: 'usd', amount_cents: 15000 }],
      due_totals: [], access_restored: true, access_state: 'restored',
    } };
  });
});

it('CONTROL: current locked status shows the full-screen lockout', async () => {
  mockGet.mockResolvedValue({ data: LOCKED });
  const screen = await render(<Provider><Reader /></Provider>);
  await screen.findByTestId('dunning-lockout-screen');
  expect(dunningLockoutStore.isLocked()).toBe(true);
});
it('B-353-1: a retired provider cannot relock the next account after its clear read', async () => {
  const old = deferred<{ data: typeof LOCKED }>();
  mockGet.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ data: CLEAR })
    .mockRejectedValue(new Error('Network Error'));
  const accountA = await render(<Provider><Reader /></Provider>);
  await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
  await accountA.unmount(); // identity cache gate unmounts account A on logout
  const accountB = await render(<Provider><Reader /></Provider>);
  await waitFor(() => expect(accountB.getByTestId('status').props.children).toBe('none'));
  await act(async () => old.resolve({ data: LOCKED }));
  expect(accountB.queryByTestId('dunning-lockout-screen')).toBeNull();
  expect(dunningLockoutStore.isLocked()).toBe(false);
});
it('B-353-1: an older clear status response cannot overwrite the newer lockout read', async () => {
  const old = deferred<{ data: typeof CLEAR }>();
  mockGet.mockReturnValueOnce(old.promise).mockResolvedValue({ data: LOCKED });
  const screen = await render(<Provider><Reader /></Provider>);
  await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
  await act(async () => { await refresh?.(); });
  await screen.findByTestId('dunning-lockout-screen');
  await act(async () => old.resolve({ data: CLEAR }));
  expect(screen.queryByTestId('dunning-lockout-screen')).not.toBeNull();
  expect(dunningLockoutStore.isLocked()).toBe(true);
});
it('B-353-2: leaving while the quote is pending prevents later setup and sheet presentation', async () => {
  const quote = deferred<{ data: typeof QUOTE }>();
  mockGet.mockImplementation((url: string) => url.endsWith('/quote') ? quote.promise : Promise.resolve({ data: CLEAR }));
  const screen = await render(<Provider card><UpdateCardScreen /></Provider>);
  // RTL 14 adopts the async onPress return. Keep it pending until the
  // controlled network result arrives instead of awaiting it here.
  const pressed = fireEvent.press(screen.getByTestId('update-card-add'));
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/v1/checkout/payment-method/quote'));
  await screen.unmount();
  await act(async () => { quote.resolve({ data: QUOTE }); await pressed; });
  expect(mockPost).not.toHaveBeenCalled();
  expect(mockSdk.presentPaymentSheet).not.toHaveBeenCalled();
});
it('B-353-2: a late native return after screen retirement cannot launch a confirm/pay request', async () => {
  const present = deferred<Record<string, unknown>>();
  mockSdk.presentPaymentSheet.mockImplementation(() => present.promise);
  mockGet.mockImplementation(async (url: string) => ({ data: url.endsWith('/quote') ? QUOTE : CLEAR }));
  const screen = await render(<Provider card><UpdateCardScreen /></Provider>);
  const pressed = fireEvent.press(screen.getByTestId('update-card-add'));
  await waitFor(() => expect(mockSdk.presentPaymentSheet).toHaveBeenCalledTimes(1));
  await screen.unmount();
  await act(async () => { present.resolve({}); await pressed; });
  expect(mockPost.mock.calls.some(([url]) => url.endsWith('/confirm'))).toBe(false);
});
it('B-353-3: dispute lockout gives truthful dispute recovery, not a card-update promise', async () => {
  mockGet.mockResolvedValue({ data: { ...LOCKED, kind: 'dispute' } });
  const screen = await render(<Provider><Reader /></Provider>);
  await screen.findByTestId('dunning-lockout-screen');
  expect(screen.queryByText(/add a card that works/i)).toBeNull();
  expect(screen.queryByText(/reversed|disput/i)).not.toBeNull();
});
it('B-353-3: saving a card for a dispute-only quote still explains unresolved access', async () => {
  mockGet.mockImplementation(async (url: string) => ({
    data: url.endsWith('/quote')
      ? { quote_id: 'q_dispute', complete: true, lines: [], totals: [],
          disputes: [{ purchase_id: 'purchase-A', coach_name: 'Avery', amount_cents: 15000, currency: 'usd' }] }
      : { ...LOCKED, kind: 'dispute' },
  }));
  mockPost.mockImplementation(async (url: string) => ({
    data: url.endsWith('/setup-intent') ? SETUP : {
      outcome: 'saved', amount_paid_cents: 0, amount_due_cents: 0, currency: 'usd',
      paid_totals: [], due_totals: [], access_restored: false, access_state: 'unchanged',
      plans: [{ purchase_id: 'purchase-A', dispute_open: true }],
    },
  }));
  const screen = await render(<Provider card><UpdateCardScreen /></Provider>);
  await fireEvent.press(screen.getByTestId('update-card-add'));
  await screen.findByTestId('update-card-result-saved');
  expect(screen.queryByText(/reversed|disput/i)).not.toBeNull();
});
it('CONTROL: a current mounted payment flow completes and shows paid receipt', async () => {
  mockGet.mockImplementation(async (url: string) => ({ data: url.endsWith('/quote') ? QUOTE : CLEAR }));
  const screen = await render(<Provider card><UpdateCardScreen /></Provider>);
  await fireEvent.press(screen.getByTestId('update-card-add'));
  await screen.findByTestId('update-card-result-paid');
  expect(mockPost).toHaveBeenCalledWith('/v1/checkout/payment-method/confirm', {
    setup_intent_id: 'seti_A',
    approved_invoices: [{ invoice_id: 'in_A', amount_cents: 15000, currency: 'usd' }],
  });
});
