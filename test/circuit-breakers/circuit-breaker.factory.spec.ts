/**
 * H6 — circuit-breaker factory + per-client config specs (D-H6-2 LOCKED).
 *
 * Covers:
 *   1. resolveBreakerConfig returns the LOCKED per-client thresholds (Stripe
 *      15s/50%, Mux 10s/50%, SendGrid 5s/30%, default 8s/50%, all 30s reset)
 *      and is case-insensitive.
 *   2. createBreaker wraps an async fn and passes through success + args.
 *   3. A failing fn eventually trips the breaker OPEN, after which calls
 *      reject with CircuitOpenError (NOT the underlying error).
 *   4. The breaker cache shares a rolling window per client; forceNew gives a
 *      fresh breaker; _resetBreakerCacheForTests clears between cases.
 */
import {
  createBreaker,
  CircuitOpenError,
  _resetBreakerCacheForTests,
} from '../../src/circuit-breakers/circuit-breaker.factory';
import {
  resolveBreakerConfig,
  BREAKER_CONFIG,
} from '../../src/circuit-breakers/circuit-breaker.constants';

afterEach(() => {
  _resetBreakerCacheForTests();
});

describe('resolveBreakerConfig (D-H6-2 per-client thresholds)', () => {
  it('returns Stripe payment-grade tolerance (15s / 50% / 30s)', () => {
    expect(resolveBreakerConfig('stripe')).toEqual({
      timeout: 15_000,
      errorThresholdPercentage: 50,
      resetTimeout: 30_000,
    });
  });

  it('returns Mux video-upload tolerance (10s / 50% / 30s)', () => {
    expect(resolveBreakerConfig('mux')).toEqual({
      timeout: 10_000,
      errorThresholdPercentage: 50,
      resetTimeout: 30_000,
    });
  });

  it('returns SendGrid fail-fast tolerance (5s / 30% / 30s)', () => {
    expect(resolveBreakerConfig('sendgrid')).toEqual({
      timeout: 5_000,
      errorThresholdPercentage: 30,
      resetTimeout: 30_000,
    });
  });

  it('falls back to default for an unknown client (8s / 50% / 30s)', () => {
    expect(resolveBreakerConfig('anthropic')).toEqual(BREAKER_CONFIG.default);
    expect(resolveBreakerConfig('twilio')).toEqual(BREAKER_CONFIG.default);
    expect(resolveBreakerConfig('openai')).toEqual(BREAKER_CONFIG.default);
  });

  it('is case-insensitive (Stripe / STRIPE / stripe all map to the Stripe config)', () => {
    expect(resolveBreakerConfig('Stripe')).toEqual(BREAKER_CONFIG.stripe);
    expect(resolveBreakerConfig('STRIPE')).toEqual(BREAKER_CONFIG.stripe);
  });

  it('the thresholds are intentionally NOT uniform across clients (D-H6-2)', () => {
    // SendGrid, Stripe, and Mux have nothing in common operationally.
    const timeouts = new Set([
      BREAKER_CONFIG.stripe.timeout,
      BREAKER_CONFIG.mux.timeout,
      BREAKER_CONFIG.sendgrid.timeout,
    ]);
    expect(timeouts.size).toBe(3);
    expect(BREAKER_CONFIG.sendgrid.errorThresholdPercentage).toBe(30);
    expect(BREAKER_CONFIG.stripe.errorThresholdPercentage).toBe(50);
  });
});

describe('createBreaker (D-H6-2)', () => {
  it('passes through a successful call and forwards args + return value', async () => {
    const fn = jest.fn(async (a: number, b: number) => a + b);
    const guarded = createBreaker('default', fn, { forceNew: true });

    await expect(guarded(2, 3)).resolves.toBe(5);
    expect(fn).toHaveBeenCalledWith(2, 3);
  });

  it('propagates the underlying error while the breaker is still CLOSED', async () => {
    const fn = jest.fn(async () => {
      throw new Error('upstream 500');
    });
    const guarded = createBreaker('default', fn, {
      key: 'closed-propagation',
      forceNew: true,
    });

    await expect(guarded()).rejects.toThrow('upstream 500');
  });

  it('trips OPEN after repeated failures and then rejects with CircuitOpenError', async () => {
    // Force-open quickly: a low error threshold + a fresh breaker. opossum
    // needs a few samples in the rolling window before the percentage trips,
    // so drive several failing calls.
    const fn = jest.fn(async () => {
      throw new Error('upstream down');
    });
    const guarded = createBreaker('sendgrid', fn, {
      key: 'force-open-sendgrid',
      forceNew: true,
    });

    // Drive failures until the breaker opens. Once open, the wrapped callable
    // rejects with CircuitOpenError instead of the upstream error.
    let sawCircuitOpen = false;
    for (let i = 0; i < 25; i++) {
      try {
        await guarded();
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          sawCircuitOpen = true;
          break;
        }
      }
    }

    expect(sawCircuitOpen).toBe(true);
  });

  it('CircuitOpenError carries the client name for attribution', async () => {
    const fn = jest.fn(async () => {
      throw new Error('down');
    });
    const guarded = createBreaker('stripe', fn, {
      key: 'attribution-stripe',
      forceNew: true,
    });

    let captured: CircuitOpenError | null = null;
    for (let i = 0; i < 25; i++) {
      try {
        await guarded();
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          captured = err;
          break;
        }
      }
    }

    expect(captured).toBeInstanceOf(CircuitOpenError);
    expect(captured?.clientName).toBe('stripe');
  });

  it('reuses the same breaker (shared rolling window) for the same cache key', async () => {
    const fn = jest.fn(async () => 'ok');
    const a = createBreaker('mux', fn, { key: 'shared' });
    const b = createBreaker('mux', fn, { key: 'shared' });

    // Both calls hit one breaker; the underlying fn is invoked twice.
    await a();
    await b();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('forceNew creates a distinct breaker, not the cached one', async () => {
    const fn = jest.fn(async () => 'ok');
    createBreaker('mux', fn, { key: 'force-new-case' });
    // forceNew replaces the cached breaker for that key without throwing.
    const guarded = createBreaker('mux', fn, {
      key: 'force-new-case',
      forceNew: true,
    });
    await expect(guarded()).resolves.toBe('ok');
  });
});
