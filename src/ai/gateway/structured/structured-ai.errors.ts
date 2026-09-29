// L1-gw — typed, closed error surface for the fail-closed structured gateway.
//
// The legacy `AiGatewayService.invoke` catches every provider error and hands
// the caller a stub completion (review R581-B-B6). A learn step cannot be
// fail-closed on top of that: it cannot tell "the model said X" from "the
// provider was down and the stub echoed the prompt". This module gives the
// importer path a CLOSED set of outcome codes that the caller can switch on,
// and that the audit row records verbatim. Nothing here is ever swallowed.
//
// Codes (closed — adding one is a contract change for the learn service):
//   ai_unavailable       capability not allowed / gateway off / kill switch off /
//                        key missing / provider unwired or stub in production /
//                        spend cap or model unset in production
//   ai_budget_exhausted  daily spend cap would be exceeded by this call
//   ai_timeout           hard per-request timeout fired (retryable → fallback)
//   ai_rate_limited      provider returned 429            (retryable → fallback)
//   ai_provider_error    provider returned 5xx / transport (retryable → fallback)
//   ai_request_rejected  provider returned another 4xx, or the gateway rejected
//                        the request before sending (input over the token
//                        limit, provider refusal)          (not retryable)
//   ai_malformed_output  provider output was not exactly one JSON object
//                        conforming to the schema, or was truncated at
//                        max_tokens; `validation` carries the content-free
//                        validator errors and the raw object so the caller can
//                        build its one repair prompt      (not retryable)

export const AI_GATEWAY_ERROR_CODES = [
  'ai_unavailable',
  'ai_budget_exhausted',
  'ai_timeout',
  'ai_rate_limited',
  'ai_provider_error',
  'ai_request_rejected',
  'ai_malformed_output',
] as const;

export type AiGatewayErrorCode = (typeof AI_GATEWAY_ERROR_CODES)[number];

// Only these codes may trigger the configured next-model fallback. 4xx
// (other than 429) and malformed output are deterministic for the same
// request and are NOT retried on another model — a second paid call would
// not change the answer and would double spend.
export const RETRYABLE_AI_ERROR_CODES: ReadonlySet<AiGatewayErrorCode> =
  new Set<AiGatewayErrorCode>(['ai_timeout', 'ai_rate_limited', 'ai_provider_error']);

export function isAiGatewayErrorCode(v: unknown): v is AiGatewayErrorCode {
  return typeof v === 'string' && (AI_GATEWAY_ERROR_CODES as readonly string[]).includes(v);
}

export interface AiGatewayErrorDetail {
  // Short machine-readable reason (e.g. `capability-not-allowed`,
  // `provider-key-missing:anthropic`, `stub-in-production`). Never carries
  // prompt or response content.
  reason?: string;
  // Upstream HTTP status when the failure came from a provider response.
  httpStatus?: number | null;
  // Model that was being called when the error occurred (null before a
  // model was chosen, e.g. config refusals).
  model?: string | null;
  provider?: string | null;
  // 0-based attempt index across the ordered model list.
  attempt?: number;
}

// Validator output for `ai_malformed_output`. `errors` are JSON-pointer paths
// plus fixed detail strings (content-free by the validator's contract);
// `rawOutput` is the provider's object, returned to the caller ONLY (never
// logged or persisted by the gateway) so the record's repair call can quote it.
export interface AiValidationFailure {
  errors: readonly AiValidationError[];
  rawOutput: unknown;
}

export interface AiValidationError {
  path: string;
  detail: string;
}

export const MAX_VALIDATION_ERRORS = 64;
export const MAX_VALIDATION_FIELD_CHARS = 200;

// r3 (R592-c7A-02, R592-c7B-01): billed usage the provider reported on a
// response the adapter then REJECTED (truncation, refusal, wrong tool-call
// count, foreign block, ...). Carried on the error so the gateway settles the
// ACTUAL charge instead of refunding a paid call to zero.
export interface AiProviderUsage {
  promptTokens: number;
  responseTokens: number;
  // Model the provider reports it actually used.
  model: string;
  // Provider-side stop reason, when known.
  stopReason: string | null;
}

export class AiGatewayError extends Error {
  readonly code: AiGatewayErrorCode;
  readonly retryable: boolean;
  readonly detail: AiGatewayErrorDetail;
  // Present only for `ai_malformed_output` raised by schema validation.
  // Non-enumerable (R592-c7B-C06): a generic error serializer / logger that
  // walks own enumerable properties never sees the model's raw object.
  // `declare` so no class-field initializer can re-create it as enumerable.
  declare readonly validation?: AiValidationFailure;
  // Present when the provider returned (and billed) a response that was then
  // rejected. Absent ⇒ usage unknown (the ledger keeps the reservation).
  readonly usage?: AiProviderUsage;

  constructor(
    code: AiGatewayErrorCode,
    detail: AiGatewayErrorDetail = {},
    message?: string,
    validation?: AiValidationFailure,
    usage?: AiProviderUsage,
  ) {
    super(message ?? `${code}${detail.reason ? `: ${detail.reason}` : ''}`);
    this.name = 'AiGatewayError';
    this.code = code;
    this.retryable = RETRYABLE_AI_ERROR_CODES.has(code);
    this.detail = detail;
    if (validation) {
      Object.defineProperty(this, 'validation', {
        value: {
          errors: validation.errors.slice(0, MAX_VALIDATION_ERRORS).map((e) => ({
            path: String(e.path ?? '').slice(0, MAX_VALIDATION_FIELD_CHARS),
            detail: String(e.detail ?? '').slice(0, MAX_VALIDATION_FIELD_CHARS),
          })),
          rawOutput: validation.rawOutput,
        },
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
    if (usage) {
      this.usage = {
        promptTokens: nonNegInt(usage.promptTokens),
        responseTokens: nonNegInt(usage.responseTokens),
        model: String(usage.model ?? ''),
        stopReason: usage.stopReason == null ? null : String(usage.stopReason),
      };
    }
  }

  static is(e: unknown): e is AiGatewayError {
    return (
      e instanceof AiGatewayError ||
      (!!e &&
        typeof e === 'object' &&
        (e as { name?: string }).name === 'AiGatewayError' &&
        isAiGatewayErrorCode((e as { code?: unknown }).code))
    );
  }
}

// Map an arbitrary thrown value (SDK error, AbortError, plain Error) to a
// typed gateway error. Adapters call this so the gateway never sees a raw
// provider exception. `reasonPrefix` is a short, content-free label.
export function toAiGatewayError(
  err: unknown,
  ctx: { provider: string; model: string | null; attempt: number; timedOut?: boolean },
): AiGatewayError {
  if (AiGatewayError.is(err)) return err;
  const status = pickHttpStatus(err);
  const name = err && typeof err === 'object' ? (err as { name?: string }).name : undefined;
  const base: AiGatewayErrorDetail = {
    provider: ctx.provider,
    model: ctx.model,
    attempt: ctx.attempt,
    httpStatus: status,
  };
  if (
    ctx.timedOut ||
    name === 'AbortError' ||
    name === 'APIUserAbortError' ||
    name === 'APIConnectionTimeoutError'
  ) {
    return new AiGatewayError('ai_timeout', { ...base, reason: 'request-timeout' });
  }
  if (status === 429) {
    return new AiGatewayError('ai_rate_limited', { ...base, reason: 'http-429' });
  }
  if (status != null && status >= 500) {
    return new AiGatewayError('ai_provider_error', { ...base, reason: `http-${status}` });
  }
  if (status != null && status >= 400) {
    return new AiGatewayError('ai_request_rejected', { ...base, reason: `http-${status}` });
  }
  // Transport-level failure (DNS, socket reset, connection refused) — the
  // provider may be fine on the next model/region, so treat as retryable.
  return new AiGatewayError('ai_provider_error', { ...base, reason: 'transport-error' });
}

function nonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.ceil(v) : 0;
}

function pickHttpStatus(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    const s = e.status ?? e.statusCode ?? e.response?.status;
    return typeof s === 'number' ? s : null;
  }
  return null;
}
