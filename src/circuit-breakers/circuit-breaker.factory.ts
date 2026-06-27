// H6 — Opossum circuit-breaker factory (D-H6-2 LOCKED).
//
// createBreaker(clientName, fn) wraps an async function in a per-client
// Opossum breaker configured from circuit-breaker.constants.ts and returns
// a callable with the same signature. When the breaker is open (or the
// half-open probe fails), the call rejects with CircuitOpenError, which the
// global CircuitOpenFilter maps to a 503 ServiceUnavailable.
//
// Design notes:
//   - One breaker instance per (clientName, fn identity). Repeated calls
//     for the same logical client reuse the same breaker so the rolling
//     error window is shared — that is the whole point of a breaker. The
//     cache key is clientName by default; pass a distinct `key` to scope
//     finer (e.g. one breaker per Stripe endpoint).
//   - We do NOT enable Opossum's fallback — a fallback would mask the
//     outage. The breaker's job is to fail fast and loud (CircuitOpenError
//     -> 503), not to fake success (NO FAKE SUCCESS doctrine).

import CircuitBreaker from 'opossum';
import { resolveBreakerConfig } from './circuit-breaker.constants';

// Domain error raised when a breaker rejects a call because it is open.
// Carries the client name so the filter and logs can attribute the outage.
export class CircuitOpenError extends Error {
  readonly clientName: string;
  constructor(clientName: string) {
    super(`Circuit open for upstream client: ${clientName}`);
    this.name = 'CircuitOpenError';
    this.clientName = clientName;
  }
}

// Opossum tags its open-circuit rejection with code 'EOPENBREAKER'. We also
// defensively match the name/message so a version bump that renames the
// code still maps cleanly.
function isOpossumOpenError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as { code?: string; name?: string; message?: string };
  return (
    e.code === 'EOPENBREAKER' ||
    e.name === 'OpenCircuitError' ||
    (typeof e.message === 'string' && e.message.includes('Breaker is open'))
  );
}

// Minimum number of requests in the rolling window before the error
// percentage can trip the breaker open. This is NOT one of the three
// per-client values LOCKED by D-H6-2 (timeout / errorThresholdPercentage /
// resetTimeout); it is a factory-level guard so that a tiny burst of failures
// (e.g. a single caller's 2-3 internal retries against a hung upstream) cannot
// self-trip the circuit before the threshold percentage is statistically
// meaningful. opossum's default is 0, which trips on the very first failing
// sample — too eager for a payment/email/AI path where one slow call must
// still surface its real upstream error. A sustained stream of failures under
// real load still trips well within the rolling window.
const VOLUME_THRESHOLD = 20;

// Cache of live breakers keyed by client/scope so the rolling window is
// shared across calls. Module-scoped on purpose.
const breakerCache = new Map<string, CircuitBreaker>();

export interface CreateBreakerOptions {
  // Override the cache key (default = clientName). Use to scope a breaker
  // narrower than the client (e.g. `${clientName}:charges`).
  key?: string;
  // Test seam: inject a clock or force a fresh breaker.
  forceNew?: boolean;
}

// Wrap `fn` in a per-client breaker and return a callable with the same
// args/return type. Throws CircuitOpenError when the breaker is open.
export function createBreaker<A extends unknown[], R>(
  clientName: string,
  fn: (...args: A) => Promise<R>,
  opts: CreateBreakerOptions = {},
): (...args: A) => Promise<R> {
  const cacheKey = opts.key ?? clientName;
  const config = resolveBreakerConfig(clientName);

  let breaker = breakerCache.get(cacheKey);
  if (!breaker || opts.forceNew) {
    breaker = new CircuitBreaker(fn as (...args: unknown[]) => Promise<unknown>, {
      timeout: config.timeout,
      errorThresholdPercentage: config.errorThresholdPercentage,
      resetTimeout: config.resetTimeout,
      // Min samples before the percentage can trip (see VOLUME_THRESHOLD).
      volumeThreshold: VOLUME_THRESHOLD,
      // Name surfaces in Opossum stats/events for observability.
      name: clientName,
    });
    breakerCache.set(cacheKey, breaker);
  }

  const liveBreaker = breaker;
  return async (...args: A): Promise<R> => {
    try {
      return (await liveBreaker.fire(...args)) as R;
    } catch (err) {
      if (isOpossumOpenError(err)) {
        throw new CircuitOpenError(clientName);
      }
      throw err;
    }
  };
}

// Test/ops helper: clear the breaker cache (e.g. between test cases). Not
// used by production code.
export function _resetBreakerCacheForTests(): void {
  for (const b of breakerCache.values()) {
    b.shutdown();
  }
  breakerCache.clear();
}
