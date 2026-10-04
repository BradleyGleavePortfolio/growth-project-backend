/**
 * AUD-OPUS-P12-117 probe (audit only, never merge) — mobile #342 @ 72821495.
 *
 * B-342-1: backend #679 @ 0e1cfde0 (B-679-6 / B-679-7) answers PAYMENT_RETRY,
 * STRIPE_CHECKOUT_ERROR (not proven no-charge) and SUBSCRIPTION_SETUP_UNAVAILABLE
 * (cancel not confirmed) on subscription-intent when the outcome is NOT
 * confirmed, including "paid or in flight although the attempt closed"
 * (PAYMENT_RETRY). The client copy must never claim "nothing was charged" then.
 *
 * C-342-1: backend isRecurringPackage() treats a combo whose recurring part is
 * $0 as a one-time sale; planTerms claims to mirror it exactly.
 */
jest.mock('../../services/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../services/sentry', () => ({ captureError: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { describeBackendFailure }: typeof import('../packagePayment') = require('../packagePayment');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { purchasableFromCoachPackage }: typeof import('../planTerms') = require('../planTerms');

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers: {} },
    config: { headers: {} },
  });
}

const CHECK_THEN_SUPPORT =
  'Open Your plan to check whether it started before you try again. If it keeps happening, contact support at support@example.invalid and include the reference shown with this message.';
const NO_CHARGE = /nothing was charged/i;

describe('B-342-1 an unconfirmed subscription-intent outcome is never told as no charge', () => {
  it('PAYMENT_RETRY (backend #679 inProgress(true): result not confirmed, incl. paid after close)', () => {
    const n = describeBackendFailure(
      httpError(503, {
        code: 'PAYMENT_RETRY',
        error: 'PAYMENT_RETRY',
        message: `The last attempt to start this plan did not finish, and its result is not confirmed yet. ${CHECK_THEN_SUPPORT}`,
      }),
      'subscription_intent',
      'abcd1234',
    );
    expect(n.message).not.toMatch(NO_CHARGE);
  });

  it('STRIPE_CHECKOUT_ERROR without the proven no-charge answer (stripeFailure(err) noCharge=false)', () => {
    const n = describeBackendFailure(
      httpError(502, {
        code: 'STRIPE_CHECKOUT_ERROR',
        error: 'STRIPE_CHECKOUT_ERROR',
        message: `The payment service did not answer as expected, so this step did not finish. ${CHECK_THEN_SUPPORT}`,
      }),
      'subscription_intent',
      'abcd1234',
    );
    expect(n.message).not.toMatch(NO_CHARGE);
  });

  it('SUBSCRIPTION_SETUP_UNAVAILABLE while closing is not confirmed (setupUnavailable(false))', () => {
    const n = describeBackendFailure(
      httpError(503, {
        code: 'SUBSCRIPTION_SETUP_UNAVAILABLE',
        error: 'SUBSCRIPTION_SETUP_UNAVAILABLE',
        message: `The card screen could not be prepared for this plan, and closing it is not confirmed yet. ${CHECK_THEN_SUPPORT}`,
      }),
      'subscription_intent',
      'abcd1234',
    );
    expect(n.message).not.toMatch(NO_CHARGE);
  });
});

describe('C-342-1 sale routing mirrors backend isRecurringPackage()', () => {
  it('a one-time package whose recurring part is $0 is a one-time sale (payment-intent), not a $0 subscription', () => {
    const p = purchasableFromCoachPackage({
      id: '11111111-2222-4333-8444-555555555555',
      name: 'Kickoff',
      amount_cents: 20000,
      currency: 'usd',
      billing_type: 'one_time',
      recurring_amount_cents: 0,
      recurring_interval: 'month',
    });
    expect(p?.renewing).toBe(false);
    expect(p?.amountCents).toBe(20000);
  });
});
