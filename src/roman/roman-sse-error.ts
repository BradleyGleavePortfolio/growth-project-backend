/**
 * Roman SSE error frame — the cross-repo wire contract for
 * `event: error` on POST /roman/sessions/:id/messages.
 *
 * The mobile app parses this frame with a STRICT schema
 * (growth-project-mobile `src/api/romanApi.ts`, `RomanStreamErrorSchema =
 * z.object({ code: z.string(), message: z.string() }).strict()`). Any extra
 * key makes the app treat the whole stream as contract drift, so a consent
 * refusal or the calm ROMAN_UNAVAILABLE state would lose its code
 * (Opus B-626-2). The frame is therefore built here from an allowlist and
 * carries EXACTLY `code` and `message`, both strings.
 *
 * The support reference is not in the frame: it travels in the
 * `X-Request-ID` response header, which RequestIdMiddleware sets before the
 * stream opens and the controller repeats in `writeHead`.
 */
import { ROMAN_ERROR_UNAVAILABLE } from './roman.constants';

/** Exactly the keys the mobile strict parser accepts, in wire order. */
export const ROMAN_SSE_ERROR_KEYS = ['code', 'message'] as const;

export interface RomanSseErrorFrame {
  code: string;
  message: string;
}

/** Used when the thrown error carries no stable code + message pair. */
export const ROMAN_SSE_FALLBACK_ERROR: Readonly<RomanSseErrorFrame> = Object.freeze({
  code: ROMAN_ERROR_UNAVAILABLE,
  message: 'Roman is not available right now.',
});

function responseBodyOf(err: unknown): unknown {
  if (!err || typeof err !== 'object') return undefined;
  const getResponse = (err as { getResponse?: unknown }).getResponse;
  if (typeof getResponse === 'function') {
    return (getResponse as () => unknown).call(err);
  }
  return (err as { response?: unknown }).response;
}

/**
 * Map anything the stream threw to the strict `{ code, message }` frame.
 * A structured HttpException body keeps its own `code` and `message` (for
 * example `ai_consent_required`, `ai_egress_blocked`, `ROMAN_UNAVAILABLE`);
 * every other key (`requestId`, `retryAfterSeconds`, `statusCode`, ...) is
 * dropped. A body without a non-empty string code and message, or a raw
 * error, becomes the calm ROMAN_UNAVAILABLE frame (never a raw stack or SDK
 * string: AGENT_RULES #9).
 */
export function toRomanSseErrorFrame(err: unknown): RomanSseErrorFrame {
  const body = responseBodyOf(err);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { code, message } = body as { code?: unknown; message?: unknown };
    if (
      typeof code === 'string' &&
      code.length > 0 &&
      typeof message === 'string' &&
      message.length > 0
    ) {
      return { code, message };
    }
  }
  return { ...ROMAN_SSE_FALLBACK_ERROR };
}
