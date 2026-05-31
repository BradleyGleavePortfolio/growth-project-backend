/**
 * PR-HK-0 — Wearables foundation constants.
 *
 * Centralized, dependency-free configuration defaults for the wearables
 * module. Connectors and the ingestion lane read these rather than
 * hardcoding magic numbers (50-Failures #18 — config over hardcode).
 *
 * Backoff defaults are tuned for cloud provider APIs (Oura/Whoop/Strava/…)
 * which return 429s with retry windows in the low single-digit seconds.
 */

/** Nest module + DI token name. */
export const WEARABLES_MODULE_NAME = 'WearablesModule';

/**
 * Default per-call HTTP timeout (ms) for {@link ProviderHttpClient}. Every
 * provider call is bounded; callers may override per request but the timeout
 * is never optional (50-Failures #35 — no unbounded network waits).
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/**
 * Capped exponential backoff defaults for transient provider failures
 * (429 / 5xx / network). Retries are bounded and the delay is capped so a
 * misbehaving provider can never wedge a worker (50-Failures #50).
 */
export const BACKOFF_DEFAULTS = {
  /** Maximum number of RETRIES after the initial attempt (so ≤ 4 total tries). */
  maxRetries: 3,
  /** Base delay (ms) for the first retry; doubles each subsequent retry. */
  baseDelayMs: 250,
  /** Hard ceiling (ms) on any single backoff delay, before jitter. */
  maxDelayMs: 5_000,
  /**
   * Full-jitter factor in [0,1]. Actual delay = random in
   * [delay * (1 - jitterFactor), delay]. Spreads retry storms across a
   * fleet so providers are not hit in lockstep.
   */
  jitterFactor: 0.5,
} as const;

/**
 * HTTP status codes considered transient (worth retrying). 408 request
 * timeout, 425 too early, 429 rate limited, and 5xx server errors. 4xx
 * client errors (other than these) are PERMANENT and are never retried —
 * retrying a 400/401/403 just wastes the budget and hides the real bug.
 */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

/**
 * Default insight-cache TTL (hours). Ingestion invalidates affected cache
 * rows on new data; this is the passive expiry ceiling. Mirrors the 6h TTL
 * documented for WearableInsightCache in Agent 2 §2.7.
 */
export const INSIGHT_CACHE_TTL_HOURS = 6;
