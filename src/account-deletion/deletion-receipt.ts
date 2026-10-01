import * as crypto from 'crypto';

/**
 * Deletion completion receipt (B-608-10, mobile #313 B-313-5).
 *
 * When a finalized account's Supabase identity is removed, the tombstone's
 * `supabase_id` becomes `deleted-r1:<sha256>` of the removed auth id instead
 * of a value that forgets it. The original sub is not stored; only a token
 * whose verified `sub` hashes to the same value can match it. That lets the
 * person's own token (still valid, or expired within the window) learn
 * "this account was deleted" (403 ACCOUNT_DELETED, or the receipt endpoint)
 * instead of a bare 401. After DELETION_RECEIPT_DAYS the nightly cron
 * replaces the hash with `deleted-<user id>`, so the link is not kept for ever.
 */
export const TOMBSTONE_AUTH_PREFIX = 'deleted-';
export const RECEIPT_KEY_PREFIX = `${TOMBSTONE_AUTH_PREFIX}r1:`;
export const DELETION_RECEIPT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function deletionReceiptKey(supabaseId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`tgp-deletion-receipt:v1:${supabaseId}`)
    .digest('hex');
  return `${RECEIPT_KEY_PREFIX}${digest}`;
}

/** A receipt is honoured only for DELETION_RECEIPT_DAYS after the erasure. */
export function isReceiptLive(deletedAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!deletedAt) return false;
  return now.getTime() - deletedAt.getTime() <= DELETION_RECEIPT_DAYS * DAY_MS;
}

export function receiptCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - DELETION_RECEIPT_DAYS * DAY_MS);
}

/** Body of the 403 the guard and the receipt endpoint use for a deleted account. */
export const ACCOUNT_DELETED_BODY = {
  statusCode: 403,
  code: 'ACCOUNT_DELETED',
  message: 'Account has been deleted',
} as const;
