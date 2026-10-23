import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * FX-IDEM: Idempotency-Key on the space chat send. The phone's outbox keeps one key per pending message and sends
 * it again after a timeout or a lost reply; the same author, space and key must always land on one message.
 *
 * No key store and no migration: community_messages is range-partitioned on created_at, so a unique index
 * would have to include created_at and could not hold the key. Instead the key names the message id itself
 * (a name-based UUID of author + space + key), and the write takes a transaction lock on that id before it looks
 * for it (repository createKeyedCohortMessage). The key is honoured for the life of the message: it costs no
 * storage, and a phone that was offline may resend days later.
 */

/** The advisory-lock namespace for keyed sends ('cmid'); distinct from every other namespace in src/. */
export const LOCK_NS_COMMUNITY_MESSAGE_KEY = 0x636d6964;

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const IDEMPOTENCY_KEY_INVALID = {
  error: 'bad_request',
  code: 'community.message.idempotency_key_invalid',
} as const;

export const IDEMPOTENCY_KEY_REUSED = {
  error: 'conflict',
  code: 'community.message.idempotency_key_reused',
} as const;

/** The header as sent: absent or blank means no dedupe (the old behaviour); anything but a UUID is a 400. */
export function messageKey(raw: string | string[] | undefined): string | null {
  const key = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (!key) return null;
  if (!KEY_RE.test(key)) throw new BadRequestException(IDEMPOTENCY_KEY_INVALID);
  return key;
}

/** The one message id an author's key names in a space (RFC 9562 version 8: SHA-256, version and variant set). */
export function keyedMessageId(senderId: string, cohortId: string, key: string): string {
  const h = createHash('sha256').update(`community.message.key\0${senderId}\0${cohortId}\0${key}`).digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
