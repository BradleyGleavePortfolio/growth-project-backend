/** Independent audit-only continuation probes; never merge. */
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
const tick = () => new Promise((resolve) => setImmediate(resolve));
const setup = (account: string) => ({
  setup_intent_id: `seti_${account}`,
  setup_intent_client_secret: `seti_${account}_secret`,
  ephemeral_key: `ek_${account}`,
  customer_id: `cus_${account}`,
  publishable_key: 'pk_test_backend',
  merchant_display_name: 'The Growth Project',
});
const OPTIONS = {
  surface: 'audit', colorScheme: 'light' as const,
  primaryButtonLabel: 'Save card', approved: [], retryDelaysMs: [],
};
const SAVED = {
  outcome: 'saved', amount_paid_cents: 0, amount_due_cents: 0,
  paid_totals: [], due_totals: [], access_state: 'unchanged', access_restored: false,
};
beforeEach(() => {
  mockPost.mockReset();
  mockPost.mockImplementation(async (url: string) => ({ data: url.endsWith('/setup-intent') ? setup('A') : SAVED }));
});

it('CONTROL: a single live native-sheet owner presents and confirms its own setup', async () => {
  const sdk = {
    initStripe: jest.fn(async () => undefined),
    initPaymentSheet: jest.fn(async () => ({})),
    presentPaymentSheet: jest.fn(async () => ({})),
    handleNextAction: jest.fn(async () => ({})),
    handleURLCallback: jest.fn(async () => true),
  } as unknown as StripeSdk;
  expect((await runNativeCardUpdate({ ...OPTIONS, sdk, isCurrent: () => true })).kind).toBe('done');
  expect(mockPost).toHaveBeenCalledWith('/v1/checkout/payment-method/confirm', {
    setup_intent_id: 'seti_A', approved_invoices: [],
  });
});

it('B-352-3: retired A presentation teardown must not erase current B native sheet', async () => {
  const aPresented = deferred<void>();
  const finishA = deferred<void>();
  const finishBInit = deferred<Record<string, unknown>>();
  let aCurrent = true;
  let nativeCustomer: string | undefined;
  const shown: Array<string | undefined> = [];
  mockPost
    .mockResolvedValueOnce({ data: setup('A') })
    .mockResolvedValueOnce({ data: setup('B') })
    .mockResolvedValue({ data: SAVED });
  const sdk = {
    initStripe: jest.fn(async () => undefined),
    initPaymentSheet: jest.fn((params: { customerId?: string }) => {
      nativeCustomer = params.customerId;
      return params.customerId === 'cus_B' ? finishBInit.promise : Promise.resolve({});
    }),
    presentPaymentSheet: jest.fn(async () => {
      const customer = nativeCustomer;
      shown.push(customer);
      if (customer === 'cus_A') {
        aPresented.resolve();
        await finishA.promise;
        // Mirrors pinned iOS StripeSdkImpl.presentPaymentSheet:
        // completion clears self.paymentSheet, not the presenting instance.
        nativeCustomer = undefined;
        return {};
      }
      return customer ? {} : { error: { code: 'Failed', message: 'No payment sheet has been initialized yet.' } };
    }),
    handleNextAction: jest.fn(async () => ({})),
    handleURLCallback: jest.fn(async () => true),
  } as unknown as StripeSdk;
  const a = runNativeCardUpdate({ ...OPTIONS, sdk, isCurrent: () => aCurrent });
  await aPresented.promise;
  aCurrent = false;
  const b = runNativeCardUpdate({ ...OPTIONS, sdk, isCurrent: () => true });
  await tick();
  finishA.resolve();
  expect(await a).toEqual({ kind: 'retired' });
  finishBInit.resolve({});
  expect((await b).kind).toBe('done');
  expect(shown).toEqual(['cus_A', 'cus_B']);
  expect(mockPost).toHaveBeenCalledWith('/v1/checkout/payment-method/confirm', {
    setup_intent_id: 'seti_B', approved_invoices: [],
  });
});

it('B-352-3: a superseded but still mounted presentation cannot confirm its old setup', async () => {
  const aPresented = deferred<void>();
  const finishA = deferred<void>();
  let nativeCustomer: string | undefined;
  mockPost
    .mockResolvedValueOnce({ data: setup('A') })
    .mockResolvedValueOnce({ data: setup('B') })
    .mockResolvedValue({ data: SAVED });
  const sdk = {
    initStripe: jest.fn(async () => undefined),
    initPaymentSheet: jest.fn(async (params: { customerId?: string }) => {
      nativeCustomer = params.customerId;
      return {};
    }),
    presentPaymentSheet: jest.fn(async () => {
      if (nativeCustomer === 'cus_A') {
        aPresented.resolve();
        await finishA.promise;
      }
      return {};
    }),
    handleNextAction: jest.fn(async () => ({})),
    handleURLCallback: jest.fn(async () => true),
  } as unknown as StripeSdk;
  const a = runNativeCardUpdate({ ...OPTIONS, sdk, isCurrent: () => true });
  await aPresented.promise;
  const b = runNativeCardUpdate({ ...OPTIONS, sdk, isCurrent: () => true });
  await tick();
  finishA.resolve();
  const outcomes = await Promise.all([a, b]);
  expect(outcomes[0]).toEqual({ kind: 'retired' });
  expect(outcomes[1].kind).toBe('done');
  const confirms = mockPost.mock.calls.filter(([url]) => String(url).endsWith('/confirm'));
  expect(confirms).toEqual([['/v1/checkout/payment-method/confirm', {
    setup_intent_id: 'seti_B', approved_invoices: [],
  }]]);
});
