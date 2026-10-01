/**
 * Upstream (Anthropic SDK) error classification for Roman.
 *
 * Two jobs:
 *   1. Decide whether a failed PRIMARY call may be retried on the FALLBACK
 *      model: `not_found_error` / HTTP 404 (retired or unknown model), 529
 *      (overloaded) and any 5xx. Client-side 4xx (400 bad request, 401, 403,
 *      429 rate limit) are NOT retried: the fallback would fail the same way
 *      or, for 429, make the situation worse.
 *   2. Produce a LOG-SAFE description. Upstream messages can carry request or
 *      response text, so Roman logs only the error class, HTTP status and the
 *      Anthropic error `type` (plan §6.5 "Logs must never contain prompts or
 *      replies").
 */

export interface UpstreamErrorDescription {
  /** Error class name (e.g. NotFoundError, APIConnectionError, AbortError). */
  name: string;
  /** HTTP status when the SDK exposes one. */
  status: number | null;
  /** Anthropic error `type` (e.g. not_found_error, overloaded_error). */
  type: string | null;
  /** True for client aborts (our own AbortController). */
  aborted: boolean;
}

export function describeUpstreamError(err: unknown): UpstreamErrorDescription {
  const e = (err ?? {}) as {
    name?: unknown;
    status?: unknown;
    error?: { type?: unknown; error?: { type?: unknown } } | null;
    constructor?: { name?: string };
  };
  const name =
    typeof e.name === 'string' && e.name
      ? e.name
      : typeof e.constructor?.name === 'string'
        ? e.constructor.name
        : 'Error';
  const status = typeof e.status === 'number' ? e.status : null;
  // The SDK nests the body as `error: { type: 'error', error: { type, message } }`.
  const nestedType = e.error?.error?.type ?? e.error?.type ?? null;
  const type = typeof nestedType === 'string' && nestedType !== 'error' ? nestedType : null;
  const aborted = name === 'AbortError' || name === 'APIUserAbortError';
  return { name, status, type, aborted };
}

/** True when the error means "try the fallback model". */
export function isFallbackEligible(d: UpstreamErrorDescription): boolean {
  if (d.aborted) return false;
  if (d.type === 'not_found_error' || d.type === 'overloaded_error' || d.type === 'api_error')
    return true;
  if (d.status === 404 || d.status === 529) return true;
  if (d.status !== null && d.status >= 500) return true;
  // Network-level failures (no status) — a connection error may be transient.
  if (
    d.status === null &&
    (d.name === 'APIConnectionError' || d.name === 'APIConnectionTimeoutError')
  )
    return true;
  return false;
}

/** True when the error indicates the model id itself is not served. */
export function isNotFound(d: UpstreamErrorDescription): boolean {
  return d.type === 'not_found_error' || d.status === 404;
}

/** One-line, PII-free log fragment. */
export function formatUpstreamError(d: UpstreamErrorDescription): string {
  return `class=${d.name} status=${d.status ?? '-'} type=${d.type ?? '-'}`;
}
