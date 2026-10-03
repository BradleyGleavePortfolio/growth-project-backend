// S-FEE round 9 (B-627-9 narrowed) — the HTTP-boundary half of the fix.
//   - StripeConnectApiService.createTransfer runs the caller's `beforeSend`
//     synchronously right before fetch, and makes no request when it throws.
//   - The send-start budget plus the Stripe client timeout ends far inside the
//     in-flight window, so no worker can take over a claim whose sender may
//     still start its request.
// This file uses the round 9 API, so on cd332bfa it does not compile.
import {
  STRIPE_CONNECT_TIMEOUT_MS,
  StripeConnectApiService,
} from '../src/connect/stripe-connect-api.service';
import {
  TRANSFER_IN_FLIGHT_MARGIN_MS,
  TRANSFER_SEND_START_BUDGET_MS,
  TransferSendExpiredError,
  transferInFlightWindowMs,
} from '../src/connect/fees/transfer-orchestrator.service';

class BoundaryStripe extends StripeConnectApiService {
  readonly events: string[] = [];
  protected fetchImpl: typeof fetch = async () => {
    this.events.push('fetch');
    return new Response(
      JSON.stringify({ id: 'tr_1', amount: 9_480, currency: 'usd', destination: 'acct_coach' }),
      { status: 200 },
    );
  };
}

const transferArgs = {
  amount: 9_480,
  currency: 'usd',
  destination: 'acct_coach',
  metadata: { tgp_transfer_op: 'tgp-op-1' },
  idempotencyKey: 'tgp-op-1',
};

describe('B-627-9 narrowed: the send-start check runs at the HTTP boundary', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_round9boundary0001';
  });
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  it('runs beforeSend right before the request and sends when it passes', async () => {
    const stripe = new BoundaryStripe();
    const out = await stripe.createTransfer({
      ...transferArgs,
      beforeSend: () => {
        stripe.events.push('beforeSend');
      },
    });
    expect(out.id).toBe('tr_1');
    expect(stripe.events).toEqual(['beforeSend', 'fetch']);
  });

  it('makes no request when beforeSend throws, and surfaces that error', async () => {
    const stripe = new BoundaryStripe();
    const expired = new TransferSendExpiredError('row-1', 31_000, TRANSFER_SEND_START_BUDGET_MS);
    await expect(
      stripe.createTransfer({
        ...transferArgs,
        beforeSend: () => {
          throw expired;
        },
      }),
    ).rejects.toBe(expired);
    expect(stripe.events).toEqual([]);
  });

  it('without beforeSend the request is unchanged', async () => {
    const stripe = new BoundaryStripe();
    await stripe.createTransfer(transferArgs);
    expect(stripe.events).toEqual(['fetch']);
  });
});

describe('B-627-9 narrowed: the start budget ends far inside the in-flight window', () => {
  it('start budget + Stripe timeout + 4 min of margin still fits in the window', () => {
    const window = transferInFlightWindowMs(STRIPE_CONNECT_TIMEOUT_MS);
    expect(TRANSFER_SEND_START_BUDGET_MS).toBe(30_000);
    expect(TRANSFER_SEND_START_BUDGET_MS + STRIPE_CONNECT_TIMEOUT_MS + 4 * 60_000).toBeLessThan(
      window,
    );
    // A longer configured timeout widens the window by the same amount.
    expect(transferInFlightWindowMs(60_000) - (TRANSFER_SEND_START_BUDGET_MS + 60_000)).toBe(
      TRANSFER_IN_FLIGHT_MARGIN_MS - TRANSFER_SEND_START_BUDGET_MS,
    );
  });

  it('the expired-send error names the row, the claim age and the budget, never money or people', () => {
    const err = new TransferSendExpiredError('row-1', 31_000, TRANSFER_SEND_START_BUDGET_MS);
    expect(err.code).toBe('SFEE_TRANSFER_SEND_ABANDONED');
    expect(err.message).toBe(
      'SFEE_TRANSFER_SEND_ABANDONED transfer=row-1: the send claim is 31000 ms old (start budget 30000 ms), ' +
        'so another worker may take it over; the create was not sent',
    );
  });
});
