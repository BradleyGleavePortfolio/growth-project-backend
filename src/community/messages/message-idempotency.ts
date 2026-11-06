import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
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

/**
 * The one message id an author's key names in a space: 122 bits of SHA-256, shaped as a version 4 UUID. Version 4,
 * not a name-based version, because every message-id check downstream accepts version 4 only (a reply's
 * parent_message_id, the voice reply link, the ack routes): a keyed message must be repliable like any other.
 */
export function keyedMessageId(senderId: string, cohortId: string, key: string): string {
  return keyedRowId(`community.message.key\0${senderId}\0${cohortId}\0${key}`);
}

/**
 * SEND-ONCE-SERVER: the same rule for every other keyed send, one place per kind so one key never names two rows:
 * a one-to-one message (`dm`, its dm_key), a post (`post`, its workspace), a post's or a challenge's comment
 * (`comment` / `challenge-comment`, the post or challenge), a Roman turn and its reply (`roman` / `roman-reply`,
 * the session). The space chat keeps keyedMessageId's derivation unchanged (its keyed rows already exist).
 */
export type KeyedPlace = 'dm' | 'post' | 'comment' | 'challenge-comment' | 'roman' | 'roman-reply';
export function keyedSendId(place: KeyedPlace, senderId: string, placeId: string, key: string): string {
  return keyedRowId(`send-once.key\0${place}\0${senderId}\0${placeId}\0${key}`);
}

/**
 * One transaction lock per keyed id, then the first row with it (a replay, `replayed: true`) or `write`'s new row.
 * Every keyed send takes this lock (FX-IDEM's), so two racing first sends land on one row, whatever its table.
 */
export async function keyedWrite<T>(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  id: string,
  find: () => Promise<T | null>,
  write: () => Promise<T>,
): Promise<{ row: T; replayed: boolean }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_COMMUNITY_MESSAGE_KEY}::int4, hashtext(${id}))`;
  const first = await find();
  return first ? { row: first, replayed: true } : { row: await write(), replayed: false };
}

function keyedRowId(name: string): string {
  const h = createHash('sha256').update(name).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
