/**
 * Round-2 NEW-P2-2 behavioural tests.
 *
 * The round-1 fix added an AbortSignal.timeout to `StripeApiService.post()`.
 * The round-2 audit found that `cancelSubscription` (DELETE + cancel-at-
 * period-end POST) and `deleteSubscriptionItem` (DELETE) still bypassed
 * the timeout. The round-2 fix extracts a `stripeFetch` chokepoint and
 * routes all four `fetchImpl` callers through it.
 *
 * This spec verifies BEHAVIOURALLY (not via grep) that each of the
 * previously-unprotected methods now surfaces the same StripeApiError
 * envelope on upstream hang that `post()` already did.
 *
 * Pattern mirrors the round-1 T13 timeout test in
 * `test/ai-credits-stream1.spec.ts`:
 *   - real timers (Node's AbortSignal.timeout is libuv-backed; fake
 *     timers don't drive it)
 *   - STRIPE_API_TIMEOUT_MS set to the 1000 ms floor so the test
 *     finishes well inside Jest's per-test budget
 *   - fetchImpl swapped for a function that hangs until the signal
 *     aborts, then rejects with a DOMException-style TimeoutError
 *     (matching real Node 22+ fetch behaviour)
 */

import { StripeApiError, StripeApiService } from '../src/billing/stripe-api.service';

// Helper: a fetchImpl that mirrors Node's real fetch behaviour under
// AbortSignal.timeout — never resolves on its own; rejects with
// TimeoutError once the signal aborts.
function makeHangingFetch(): jest.Mock {
  return jest.fn(
    (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal: AbortSignal | undefined = init?.signal;
        if (!signal) {
          // If production code forgets the signal, fail the test
          // loudly rather than hang the suite.
          reject(new Error('TEST FAILURE: fetchImpl invoked without AbortSignal'));
          return;
        }
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          reject(err);
        });
      }),
  );
}

// A fetchImpl that resolves immediately with a well-formed Stripe-like
// envelope. Used for the happy-path regression tests — confirms the
// helper extraction did not break the non-timeout path.
function makeHappyFetch(body: object, status = 200): jest.Mock {
  return jest.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// Test subclass — exposes the protected fetchImpl. Same pattern as
// test/stripe-api.service.spec.ts.
class TestStripe extends StripeApiService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public override fetchImpl: any = jest.fn();
}

describe('Round-2 NEW-P2-2 — stripeFetch helper applies timeout to ALL outbound Stripe calls', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      // Min clamp in resolveStripeApiTimeoutMs is 1000ms; floor is fine
      // for failure-mode tests, well inside Jest's 10s default.
      STRIPE_API_TIMEOUT_MS: '1000',
    };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // -------------------------------------------------------------------------
  // Timeout paths — each method must surface the same StripeApiError 504.
  // -------------------------------------------------------------------------

  it('cancelSubscription (immediate DELETE) translates upstream hang to StripeApiError(504, request_timeout)', async () => {
    const svc = new TestStripe();
    svc.fetchImpl = makeHangingFetch();
    await expect(
      svc.cancelSubscription({
        subscriptionId: 'sub_hang_del',
        immediately: true,
        idempotencyKey: 'idem-cancel-del',
      }),
    ).rejects.toMatchObject({
      // toMatchObject doesn't assert constructor identity; combine
      // with toBeInstanceOf for full coverage.
      stripeCode: 'request_timeout',
      stripeType: 'api_connection_error',
      httpStatus: 504,
    });
    await expect(
      svc.cancelSubscription({
        subscriptionId: 'sub_hang_del_2',
        immediately: true,
        idempotencyKey: 'idem-cancel-del-2',
      }),
    ).rejects.toBeInstanceOf(StripeApiError);
    // Path label MUST appear in the error message so timeout-error logs
    // are greppable per subscription.
    try {
      await svc.cancelSubscription({
        subscriptionId: 'sub_hang_del_3',
        immediately: true,
        idempotencyKey: 'idem-cancel-del-3',
      });
      throw new Error('TEST FAILURE: cancelSubscription did not reject');
    } catch (err) {
      expect(String((err as Error).message)).toContain('/subscriptions/sub_hang_del_3');
    }
  }, 8_000);

  it('cancelSubscription (cancel-at-period-end POST) translates upstream hang to StripeApiError(504, request_timeout)', async () => {
    const svc = new TestStripe();
    svc.fetchImpl = makeHangingFetch();
    await expect(
      svc.cancelSubscription({
        subscriptionId: 'sub_hang_post',
        immediately: false,
        idempotencyKey: 'idem-cancel-post',
      }),
    ).rejects.toMatchObject({
      stripeCode: 'request_timeout',
      stripeType: 'api_connection_error',
      httpStatus: 504,
    });
  }, 5_000);

  it('deleteSubscriptionItem (DELETE) translates upstream hang to StripeApiError(504, request_timeout)', async () => {
    const svc = new TestStripe();
    svc.fetchImpl = makeHangingFetch();
    await expect(
      svc.deleteSubscriptionItem({
        subscriptionItemId: 'si_hang_del',
        idempotencyKey: 'idem-del-si',
      }),
    ).rejects.toMatchObject({
      stripeCode: 'request_timeout',
      stripeType: 'api_connection_error',
      httpStatus: 504,
    });
    try {
      await svc.deleteSubscriptionItem({
        subscriptionItemId: 'si_hang_del_2',
        idempotencyKey: 'idem-del-si-2',
      });
      throw new Error('TEST FAILURE: deleteSubscriptionItem did not reject');
    } catch (err) {
      expect(String((err as Error).message)).toContain('/subscription_items/si_hang_del_2');
    }
  }, 5_000);

  // -------------------------------------------------------------------------
  // Happy paths — confirm the helper extraction did NOT break the
  // non-timeout code paths. These exercise the same methods with a
  // fetchImpl that resolves immediately; if the refactor mis-wired the
  // method/URL/body, these would fail.
  // -------------------------------------------------------------------------

  it('cancelSubscription (immediate) happy path still uses DELETE + correct URL', async () => {
    const svc = new TestStripe();
    svc.fetchImpl = makeHappyFetch({ id: 'sub_x', status: 'canceled' });
    const result = await svc.cancelSubscription({
      subscriptionId: 'sub_x',
      immediately: true,
      idempotencyKey: 'idem-immediate',
    });
    expect(result.id).toBe('sub_x');
    expect(svc.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = svc.fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://api.stripe.com/v1/subscriptions/sub_x');
    expect(init.method).toBe('DELETE');
    expect(init.headers['Idempotency-Key']).toBe('idem-immediate');
    // R2: the helper threads an AbortSignal in; assert it is present.
    expect(init.signal).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('cancelSubscription (cancel-at-period-end) happy path still uses POST + cancel_at_period_end=true', async () => {
    const svc = new TestStripe();
    svc.fetchImpl = makeHappyFetch({ id: 'sub_y', status: 'active', cancel_at_period_end: true });
    const result = await svc.cancelSubscription({
      subscriptionId: 'sub_y',
      immediately: false,
      idempotencyKey: 'idem-pend',
    });
    expect(result.cancel_at_period_end).toBe(true);
    const [url, init] = svc.fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://api.stripe.com/v1/subscriptions/sub_y');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('cancel_at_period_end=true');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('deleteSubscriptionItem happy path still uses DELETE + correct URL + idempotency header', async () => {
    const svc = new TestStripe();
    svc.fetchImpl = makeHappyFetch({ id: 'si_x', deleted: true });
    const result = await svc.deleteSubscriptionItem({
      subscriptionItemId: 'si_x',
      idempotencyKey: 'idem-del',
    });
    expect(result.id).toBe('si_x');
    expect(result.deleted).toBe(true);
    const [url, init] = svc.fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://api.stripe.com/v1/subscription_items/si_x');
    expect(init.method).toBe('DELETE');
    expect(init.headers['Idempotency-Key']).toBe('idem-del');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // -------------------------------------------------------------------------
  // Caller-supplied signal composition — confirm that an externally-
  // cancelled signal surfaces as 499 client_closed_request (not 504),
  // and that the timeout signal still fires when the caller didn't
  // cancel.
  // -------------------------------------------------------------------------
  //
  // NOTE: cancelSubscription and deleteSubscriptionItem do not yet
  // expose a caller-supplied signal in their argument shape. The
  // composition path inside stripeFetch is exercised when post()
  // is invoked from a future caller that threads its own signal —
  // for now, the composition is dead code on the call sites we have,
  // but the helper is correct by construction (verified by AbortSignal.any
  // contract). Round-3 audit can wire a caller-signal API if needed.

  it('translates a generic AbortError that is NOT from our timeout signal as 499', async () => {
    // We can't easily inject a caller signal into the public methods
    // above, but we CAN exercise the dispatch logic by invoking
    // stripeFetch directly through a subclass that exposes it.
    class ExposedStripe extends StripeApiService {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      public override fetchImpl: any = jest.fn();
      public callStripeFetch(url: string, init: RequestInit, pathForError: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this as any).stripeFetch(url, init, pathForError);
      }
    }
    const svc = new ExposedStripe();
    // External (non-timeout) AbortController, cancelled by caller.
    const callerAbort = new AbortController();
    svc.fetchImpl = jest.fn(
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('TEST FAILURE: stripeFetch did not pass signal'));
            return;
          }
          signal.addEventListener('abort', () => {
            const err = new Error('aborted by caller');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    // Schedule the caller-side abort BEFORE invoking stripeFetch so
    // the abort fires while the fetch promise is pending. AbortSignal.any
    // forwards the abort to the merged signal; stripeFetch then sees
    // an AbortError whose timeoutSignal.aborted is false.
    setTimeout(() => callerAbort.abort(), 50);
    await expect(
      svc.callStripeFetch(
        'https://api.stripe.com/v1/test',
        { method: 'POST', signal: callerAbort.signal },
        '/test',
      ),
    ).rejects.toMatchObject({
      stripeCode: 'client_closed_request',
      httpStatus: 499,
    });
  }, 5_000);
});
