/** Independent audit-only probes; never merge. */
import { normalizeCardUpdate } from '../dunningApi';
import { cardUpdateOutcomeCopy } from '../dunningErrorCopy';
import { runNativeCardUpdate, type StripeSdk } from '../updateCard';

const mockPost = jest.fn();
jest.mock('../../../services/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: (...args: unknown[]) => mockPost(...args) },
}));
jest.mock('../../../services/sentry', () => ({ captureError: jest.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const SETUP = {
  setup_intent_id: 'seti_A', setup_intent_client_secret: 'seti_A_secret',
  ephemeral_key: 'ek_A', customer_id: 'cus_A', publishable_key: 'pk_test_backend',
  merchant_display_name: 'The Growth Project',
};
const OPTIONS = {
  surface: 'audit', colorScheme: 'light' as const,
  primaryButtonLabel: 'Save card', approved: [], retryDelaysMs: [],
};
beforeEach(() => { jest.clearAllMocks(); mockPost.mockReset(); });

it('R-DISPUTE-PAUSE: a mixed paid/disputed result must not promise automatic access restoration', () => {
  const r = normalizeCardUpdate({
    outcome: 'paid', amount_paid_cents: 15000, amount_due_cents: 0, currency: 'usd',
    paid_totals: [{ currency: 'usd', amount_cents: 15000 }], due_totals: [],
    access_state: 'partial', access_restored: false,
    plans: [{ purchase_id: 'p_paid', dispute_open: false }, { purchase_id: 'p_disputed', dispute_open: true }],
  });
  const body = cardUpdateOutcomeCopy(r).body;
  expect(body).toContain('$150.00 went through');
  // Owner D1 (JOBS120): old "settle" anchor is superseded, not the boundary.
  expect(body).toMatch(/access has ended and billing is paused/i);
  expect(body).toMatch(/coach[^.]*decides whether to restart/i);
  expect(body).toMatch(/does not restart on its own or with a new card/i);
  expect(body).not.toMatch(/settle|sort it out/i);
  expect(body).not.toMatch(/Your plan updates within a few minutes/);
});
it('R-DISPUTE-PAUSE: dispute-only save says billing paused, access ended, coach controls restarting', () => {
  const r = normalizeCardUpdate({
    outcome: 'saved', amount_paid_cents: 0, amount_due_cents: 0, currency: 'usd',
    paid_totals: [], due_totals: [], access_state: 'unchanged', access_restored: false,
    plans: [{ purchase_id: 'p_disputed', dispute_open: true }],
  });
  const body = cardUpdateOutcomeCopy(r).body;
  expect(body).toMatch(/billing is paused/i);
  expect(body).toMatch(/access has ended/i);
  expect(body).toMatch(/coach.*restart/i);
});
it('ownership: retirement while initStripe awaits must prevent a fresh native PaymentSheet initialization', async () => {
  const init = deferred<void>();
  let current = true;
  mockPost.mockResolvedValue({ data: SETUP });
  const sdk = {
    initStripe: jest.fn(() => init.promise),
    initPaymentSheet: jest.fn(async () => ({})),
    presentPaymentSheet: jest.fn(async () => ({})),
    handleNextAction: jest.fn(async () => ({})),
    handleURLCallback: jest.fn(async () => true),
  } as unknown as StripeSdk;
  const run = runNativeCardUpdate({ ...OPTIONS, sdk, isCurrent: () => current });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(sdk.initStripe).toHaveBeenCalledTimes(1);
  current = false;
  init.resolve();
  expect(await run).toEqual({ kind: 'retired' });
  expect(sdk.initPaymentSheet).not.toHaveBeenCalled();
  expect(sdk.presentPaymentSheet).not.toHaveBeenCalled();
});
it('CONTROL: non-disputed partial payment keeps the existing eventual-access message', () => {
  const r = normalizeCardUpdate({
    outcome: 'paid', amount_paid_cents: 15000, amount_due_cents: 0, currency: 'usd',
    paid_totals: [{ currency: 'usd', amount_cents: 15000 }], due_totals: [],
    access_state: 'partial', access_restored: false,
    plans: [{ purchase_id: 'p_paid', dispute_open: false }],
  });
  expect(cardUpdateOutcomeCopy(r).body).toContain('Your plan updates within a few minutes');
});
it('ownership: retired account A must not replace account B native sheet before B presents it', async () => {
  const aStripe = deferred<void>();
  const bSheet = deferred<Record<string, unknown>>();
  const aStarted = deferred<void>();
  const bInitialized = deferred<void>();
  let aCurrent = true;
  let nativeCustomer: string | undefined;
  const displayedCustomers: Array<string | undefined> = [];
  const setupB = { ...SETUP, setup_intent_id: 'seti_B', setup_intent_client_secret: 'seti_B_secret', customer_id: 'cus_B', ephemeral_key: 'ek_B' };
  mockPost
    .mockResolvedValueOnce({ data: SETUP })
    .mockResolvedValueOnce({ data: setupB })
    .mockResolvedValue({ data: {
      outcome: 'saved', amount_paid_cents: 0, amount_due_cents: 0,
      paid_totals: [], due_totals: [], access_state: 'unchanged', access_restored: false,
    } });
  // The native SDK has one module-owned PaymentSheet, not one per React screen.
  const sdk = {
    initStripe: jest.fn()
      .mockImplementationOnce(() => { aStarted.resolve(); return aStripe.promise; })
      .mockResolvedValue(undefined),
    initPaymentSheet: jest.fn((params: { customerId?: string }) => {
      nativeCustomer = params.customerId;
      if (params.customerId === 'cus_B') {
        bInitialized.resolve();
        return bSheet.promise;
      }
      return Promise.resolve({});
    }),
    presentPaymentSheet: jest.fn(async () => {
      displayedCustomers.push(nativeCustomer);
      return {};
    }),
    handleNextAction: jest.fn(async () => ({})),
    handleURLCallback: jest.fn(async () => true),
  } as unknown as StripeSdk;
  const a = runNativeCardUpdate({ ...OPTIONS, sdk, isCurrent: () => aCurrent });
  await aStarted.promise;
  aCurrent = false;
  const b = runNativeCardUpdate({ ...OPTIONS, sdk, isCurrent: () => true });
  await bInitialized.promise;
  aStripe.resolve();
  expect(await a).toEqual({ kind: 'retired' });
  bSheet.resolve({});
  expect((await b).kind).toBe('done');
  expect(displayedCustomers).toEqual(['cus_B']);
});
