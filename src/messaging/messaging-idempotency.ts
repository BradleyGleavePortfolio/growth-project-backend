import { HttpStatus } from '@nestjs/common';
import { IDEMPOTENCY_KEY_RE } from './messaging.dto';
import { messagingError, MESSAGING_ERRORS } from './messaging-errors';

/**
 * A3-MSG-CORE — fold the optional `Idempotency-Key` header into the body's
 * `client_message_id`. The header must be a UUID (the shape the body field
 * accepts, 400 `messaging.idempotency_key_invalid` otherwise); when both are
 * present they must match (400 `messaging.idempotency_key_mismatch`). Returns
 * the effective key, or undefined when neither is sent (legacy clients).
 */
export function resolveIdempotencyKey(
  header: string | undefined,
  bodyKey: string | undefined,
): string | undefined {
  const h = typeof header === 'string' ? header.trim() : '';
  if (!h) return bodyKey;
  if (!IDEMPOTENCY_KEY_RE.test(h)) {
    throw messagingError(HttpStatus.BAD_REQUEST, MESSAGING_ERRORS.IDEMPOTENCY_KEY_INVALID);
  }
  if (bodyKey && bodyKey.toLowerCase() !== h.toLowerCase()) {
    throw messagingError(HttpStatus.BAD_REQUEST, MESSAGING_ERRORS.IDEMPOTENCY_KEY_MISMATCH);
  }
  return bodyKey ?? h.toLowerCase();
}
