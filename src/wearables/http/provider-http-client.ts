import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  BACKOFF_DEFAULTS,
  DEFAULT_HTTP_TIMEOUT_MS,
  RETRYABLE_STATUS_CODES,
} from '../wearables.constants';

/**
 * PR-HK-0 — hardened HTTP client for all cloud provider calls.
 *
 * Every wearable provider request goes through this single client so the
 * resilience policy is implemented ONCE (50-Failures #15/#40 reuse, #35
 * mandatory timeout, #50 graceful degradation):
 *  - mandatory per-call timeout (default 10s, configurable per call);
 *  - capped exponential backoff with full jitter (≤3 retries, 250ms base,
 *    5s cap) on transient failures (429 / 5xx / network errors);
 *  - per-call structured logging (#34) — one line per attempt + outcome;
 *  - throws {@link ProviderHttpError} on permanent failure — NEVER a silent
 *    swallow (#36). Callers translate that into WearableConnection
 *    status='error' + last_error (fail-explicit posture, Agent 2 §0).
 *
 * Uses the platform global `fetch` (Node ≥18) — no new HTTP dependency
 * (50-Failures #10 prefer zero new deps).
 */

export interface ProviderHttpClientOptions {
  /** Per-call timeout in ms. Defaults to {@link DEFAULT_HTTP_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Max RETRIES after the first attempt. Defaults to backoff config. */
  maxRetries?: number;
  /** Base backoff delay (ms). Defaults to backoff config. */
  baseDelayMs?: number;
  /** Backoff delay ceiling (ms). Defaults to backoff config. */
  maxDelayMs?: number;
  /** Full-jitter factor in [0,1]. Defaults to backoff config. */
  jitterFactor?: number;
  /**
   * A label for log lines (e.g. "oura.backfill"). Helps trace which provider
   * call retried/failed without leaking URLs/tokens into logs.
   */
  label?: string;
}

export type ProviderRequestInit = RequestInit & ProviderHttpClientOptions;

/**
 * Thrown on permanent failure (retries exhausted, non-retryable status, or a
 * timeout/network error that did not recover). Carries the last status code
 * (if any) and the number of attempts made for observability.
 */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

/** Internal seam so tests can stub fetch and the sleep without real timers. */
export interface ProviderHttpDeps {
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class ProviderHttpClient {
  private readonly logger = new Logger(ProviderHttpClient.name);
  private readonly deps: ProviderHttpDeps;

  /**
   * @param deps optional dependency overrides. Production leaves this
   *   undefined and binds the global fetch + real timers; unit tests inject
   *   a stub fetch, a synchronous sleep, and a deterministic RNG to assert
   *   retry count and backoff cap without wall-clock waits.
   */
  constructor(@Optional() deps?: Partial<ProviderHttpDeps>) {
    this.deps = {
      fetchFn: deps?.fetchFn ?? globalThis.fetch.bind(globalThis),
      sleep: deps?.sleep ?? realSleep,
      random: deps?.random ?? Math.random,
    };
  }

  /**
   * Perform an HTTP request with timeout + capped jittered backoff.
   *
   * Retries on: network errors, request timeouts (AbortError), and any
   * status in {@link RETRYABLE_STATUS_CODES}. Does NOT retry other 4xx —
   * those are permanent and throw immediately so the bug surfaces.
   *
   * @returns the first successful (or non-retryable) {@link Response}.
   * @throws {ProviderHttpError} when the failure is permanent.
   */
  async request(url: string, init: ProviderRequestInit = {}): Promise<Response> {
    const {
      timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
      maxRetries = BACKOFF_DEFAULTS.maxRetries,
      baseDelayMs = BACKOFF_DEFAULTS.baseDelayMs,
      maxDelayMs = BACKOFF_DEFAULTS.maxDelayMs,
      jitterFactor = BACKOFF_DEFAULTS.jitterFactor,
      label,
      ...fetchInit
    } = init;

    const tag = label ?? 'provider-http';
    const totalAttempts = maxRetries + 1;
    let lastStatus: number | undefined;
    let lastCause: unknown;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, fetchInit, timeoutMs);

        if (response.ok) {
          this.logger.log(
            `[${tag}] attempt ${attempt}/${totalAttempts} succeeded (status=${response.status})`,
          );
          return response;
        }

        lastStatus = response.status;

        if (!RETRYABLE_STATUS_CODES.has(response.status)) {
          // Permanent client/server error — do not retry, fail loud.
          this.logger.error(
            `[${tag}] attempt ${attempt}/${totalAttempts} permanent failure (status=${response.status})`,
          );
          throw new ProviderHttpError(
            `${tag}: non-retryable HTTP ${response.status}`,
            attempt,
            response.status,
          );
        }

        this.logger.warn(
          `[${tag}] attempt ${attempt}/${totalAttempts} transient failure (status=${response.status})`,
        );
      } catch (err) {
        if (err instanceof ProviderHttpError) {
          // Already classified as permanent above — propagate.
          throw err;
        }
        // Network error or timeout (AbortError): transient, eligible for retry.
        lastCause = err;
        this.logger.warn(
          `[${tag}] attempt ${attempt}/${totalAttempts} network/timeout error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // If we have retries left, back off (capped + jittered) and try again.
      if (attempt < totalAttempts) {
        const delay = this.computeBackoffDelay(
          attempt,
          baseDelayMs,
          maxDelayMs,
          jitterFactor,
        );
        this.logger.debug(`[${tag}] backing off ${delay}ms before retry`);
        await this.deps.sleep(delay);
      }
    }

    // Retries exhausted.
    this.logger.error(
      `[${tag}] exhausted ${totalAttempts} attempts (lastStatus=${
        lastStatus ?? 'none'
      })`,
    );
    throw new ProviderHttpError(
      `${tag}: failed after ${totalAttempts} attempts`,
      totalAttempts,
      lastStatus,
      lastCause,
    );
  }

  /**
   * Compute the capped, full-jitter backoff for a given attempt number
   * (1-based). Exponential base: delay = baseDelay * 2^(attempt-1), capped at
   * maxDelay, then full-jitter scaled into
   * [delay * (1 - jitterFactor), delay].
   *
   * Exposed (not private) so the unit test can assert the cap directly.
   */
  computeBackoffDelay(
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number,
    jitterFactor: number,
  ): number {
    const exponential = baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(exponential, maxDelayMs);
    const clampedJitter = Math.min(Math.max(jitterFactor, 0), 1);
    const floor = capped * (1 - clampedJitter);
    const jittered = floor + this.deps.random() * (capped - floor);
    return Math.round(jittered);
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.deps.fetchFn(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
