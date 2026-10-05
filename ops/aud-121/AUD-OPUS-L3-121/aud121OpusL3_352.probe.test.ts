/**
 * AUD-OPUS-L3-121 (lens Claude Opus 5.5, agent 121) probes for mobile #352 @ c89f719cd8f5863c4150af1da5b96e273df319d6.
 * Run at #354 68c7f080 (the L1 files are byte-identical at #352, #353 and #354). Never merge.
 * PROBE  = asserts the correct behaviour; expected to FAIL at this head (it proves a finding).
 * VERIFY = checks a fixed B (B-352-2 / B-352-3 / B-352-7) or a ruling; must PASS.
 * CONTROL = harness check; must PASS.
 * Owner ruling 6 (09:43 PDT 10-05): a dispute INQUIRY also pauses the plan; Stripe inquiries move no money
 * (https://docs.stripe.com/disputes/withdrawing), so copy shown for `kind: 'dispute'` must be true for both.
 */
import { normalizeDunningStatus, type CancelPlanResponse, type CardUpdateResponse, type QuoteDispute } from '../dunningApi';
import { cancelOutcomeCopy, cardUpdateOutcomeCopy, disputeNotSettledLine, disputePauseFacts } from '../dunningErrorCopy';
import { runNativeCardUpdate, type StripeSdk } from '../updateCard';

jest.mock('../../../services/sentry', () => ({ captureError: jest.fn() }));
const mockPost = jest.fn();
jest.mock('../../../services/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: (...args: unknown[]) => mockPost(...args) },
}));

const FIRST_PERSON = /\b(we|we're|we've|we'll|us|our|ours)\b/i;
const MONEY_MOVED = /\b(revers\w*|took back|taken back|refund\w*|charged back|chargeback)\b/i;
const FORBIDDEN = /settle|sort it out/i;

const DISPUTE: QuoteDispute = { purchase_id: 'p1', coach_name: 'Avery', currency: 'usd', amount_cents: null };
const ENDED: CancelPlanResponse = {
  outcome: 'ended',
  purchase_id: 'p1',
  access_ends_at: null,
  voided_invoice_count: 0,
  voided_amount_cents: 0,
  currency: 'usd',
  paid_period_kept: false,
  message: null,
};
function answer(over: Record<string, unknown>): CardUpdateResponse {
  return {
    outcome: 'saved',
    card_last4: '4242',
    card_brand: 'visa',
    amount_paid_cents: null,
    amount_due_cents: null,
    paid_totals: [],
    due_totals: [],
    access_restored: false,
    access_state: 'unchanged',
    quote: null,
    payment_intent_client_secret: null,
    decline_code: null,
    disputes: [DISPUTE],
    message: null,
    ...over,
  } as unknown as CardUpdateResponse;
}
const OUTCOMES = [
  'paid',
  'saved',
  'processing',
  'in_progress',
  'requires_action',
  'approval_required',
  'payment_uncertain',
  'failed',
  'declined',
] as const;

describe('B-352-9 (Opus 121): dispute copy is true for an inquiry (ruling 6: inquiries pause too and move no money)', () => {
  it('CONTROL: no dispute, no dispute line', () => {
    expect(disputeNotSettledLine([])).toBeNull();
  });

  it('PROBE: the card-update dispute line does not claim the bank reversed or took back money', () => {
    expect(disputeNotSettledLine([DISPUTE]) ?? '').not.toMatch(MONEY_MOVED);
  });

  it('PROBE: the dispute line with two plans does not claim payments were reversed', () => {
    const two = [DISPUTE, { ...DISPUTE, purchase_id: 'p2', coach_name: 'Blake' }];
    expect(disputeNotSettledLine(two) ?? '').not.toMatch(MONEY_MOVED);
  });

  it('PROBE: ending a disputed plan does not claim the bank had reversed a payment', () => {
    expect(cancelOutcomeCopy(ENDED, { dispute: true }).body).not.toMatch(MONEY_MOVED);
  });
});

describe('VERIFY B-352-7: R-DISPUTE-PAUSE facts, no "settle", no support fix, in every outcome', () => {
  it.each(OUTCOMES)('outcome %s with a dispute open: three facts, no settle / sort it out, no first person, no "!"', (outcome) => {
    const { title, body } = cardUpdateOutcomeCopy(
      answer({ outcome, paid_totals: outcome === 'paid' ? [{ currency: 'usd', amount_cents: 15000 }] : [] }),
    );
    const text = `${title} ${body}`;
    expect(text).not.toMatch(FORBIDDEN);
    expect(text).not.toMatch(FIRST_PERSON);
    expect(text).not.toContain('!');
    expect(body).toMatch(/access has ended/i);
    expect(body).toMatch(/billing is paused/i);
    expect(body).toMatch(/coach, Avery, decides whether to restart/i);
    expect(body).not.toMatch(/support/i);
  });

  it('every disputePauseFacts scope states the three facts and no settle', () => {
    for (const scope of ['account', 'plan', 'plans'] as const) {
      for (const coach of ['Avery', null]) {
        const s = disputePauseFacts(coach, scope);
        expect(s).toMatch(/ended/);
        expect(s).toMatch(/billing is paused/);
        expect(s).toMatch(/decides whether to restart/);
        expect(s).toMatch(/do(es)? not restart on (its|their) own or with a new card/);
        expect(s).not.toMatch(FORBIDDEN);
      }
    }
  });

  it('ending a disputed plan: no settle, no support fix, coach restarts', () => {
    const body = cancelOutcomeCopy(ENDED, { dispute: true }).body;
    expect(body).not.toMatch(FORBIDDEN);
    expect(body).not.toMatch(/support/i);
    expect(body).toMatch(/coach/i);
  });
});

describe('VERIFY B-352-2: mixed paid + disputed keeps the paid amount and scopes access news to the paid plan', () => {
  it.each(['updating', 'partial'] as const)('access_state %s: no "Your plan updates within a few minutes"', (access_state) => {
    const { title, body } = cardUpdateOutcomeCopy(
      answer({ outcome: 'paid', paid_totals: [{ currency: 'usd', amount_cents: 15000 }], access_state }),
    );
    expect(body).toContain('$150.00');
    expect(body).not.toMatch(/Your plan updates within a few minutes/);
    expect(body).toMatch(/The plan you paid for updates within a few minutes/);
    expect(title).toBe('Payment received');
  });

  it('restored: only the paid plan is active again', () => {
    const { body } = cardUpdateOutcomeCopy(
      answer({
        outcome: 'paid',
        paid_totals: [{ currency: 'usd', amount_cents: 15000 }],
        access_state: 'restored',
        access_restored: true,
      }),
    );
    expect(body).not.toMatch(/Your plan is active again/);
    expect(body).toMatch(/The plan you paid for is active again/);
  });

  it('processing with a dispute open: "The plan it pays for updates", never "Your plan updates"', () => {
    const { body } = cardUpdateOutcomeCopy(answer({ outcome: 'processing', due_totals: [{ currency: 'usd', amount_cents: 5000 }] }));
    expect(body).not.toMatch(/Your plan updates/);
  });

  it('CONTROL: without a dispute the plain plan wording stays', () => {
    const { body } = cardUpdateOutcomeCopy(
      answer({ outcome: 'paid', paid_totals: [{ currency: 'usd', amount_cents: 15000 }], access_state: 'updating', disputes: [] }),
    );
    expect(body).toMatch(/Your plan updates within a few minutes/);
  });
});

describe('VERIFY: D2c status contract (reason dispute_paused, no lock date)', () => {
  it('reason dispute_paused with kind null reads as a dispute and drops any lock date', () => {
    const s = normalizeDunningStatus({
      enabled: true,
      state: 'locked',
      kind: null,
      reason: 'dispute_paused',
      purchase_id: 'p1',
      currency: 'usd',
      lockout_at: '2030-01-01T00:00:00.000Z',
    });
    expect(s).toMatchObject({ kind: 'dispute', reason: 'dispute_paused', lockout_at: null });
  });
});

describe('VERIFY B-352-3: one owner for the shared native PaymentSheet (Opus 121 variant)', () => {
  const SETUP = {
    setup_intent_id: 'seti_A',
    setup_intent_client_secret: 'seti_A_secret',
    ephemeral_key: 'ek_A',
    customer_id: 'cus_A',
    publishable_key: 'pk_test_backend',
    merchant_display_name: 'The Growth Project',
  };
  const SETUP_B = { ...SETUP, setup_intent_id: 'seti_B', setup_intent_client_secret: 'seti_B_secret', ephemeral_key: 'ek_B', customer_id: 'cus_B' };
  const PAID = {
    outcome: 'paid',
    amount_paid_cents: 15000,
    amount_due_cents: 0,
    currency: 'usd',
    paid_totals: [{ currency: 'usd', amount_cents: 15000 }],
    due_totals: [],
    access_restored: true,
    access_state: 'restored',
  };
  const base = {
    surface: 'probe',
    colorScheme: 'light' as const,
    primaryButtonLabel: 'Save card',
    approved: [],
    retryDelaysMs: [0, 0],
  };
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  beforeEach(() => mockPost.mockReset());

  it('A already inside initPaymentSheet when B starts: A never presents and never confirms; B presents once with its own customer', async () => {
    const aSheet = deferred<Record<string, unknown>>();
    let aCurrent = true;
    let lastInitCustomer: string | undefined;
    const presentedFor: Array<string | undefined> = [];
    mockPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/setup-intent')) return { data: mockPost.mock.calls.length === 1 ? SETUP : SETUP_B };
      return { data: PAID };
    });
    const sdk = {
      initStripe: jest.fn(async () => undefined),
      initPaymentSheet: jest.fn((p: { customerId?: string }) => {
        lastInitCustomer = p.customerId;
        return p.customerId === 'cus_A' ? aSheet.promise : Promise.resolve({});
      }),
      presentPaymentSheet: jest.fn(async () => {
        presentedFor.push(lastInitCustomer);
        return {};
      }),
      handleNextAction: jest.fn(),
      handleURLCallback: jest.fn(),
    } as unknown as StripeSdk;
    const a = runNativeCardUpdate({ ...base, sdk, isCurrent: () => aCurrent });
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    expect(sdk.initPaymentSheet).toHaveBeenCalledTimes(1);
    aCurrent = false;
    const b = await runNativeCardUpdate({ ...base, sdk, isCurrent: () => true });
    aSheet.resolve({});
    expect(await a).toEqual({ kind: 'retired' });
    expect(b.kind).toBe('done');
    expect(presentedFor).toEqual(['cus_B']);
    const confirms = mockPost.mock.calls.filter(([url]) => String(url).endsWith('/confirm'));
    expect(confirms).toHaveLength(1);
    expect(confirms[0][1]).toMatchObject({ setup_intent_id: 'seti_B' });
  });
});
