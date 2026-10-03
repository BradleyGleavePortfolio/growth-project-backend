import * as crypto from 'crypto';
import type { PrismaService } from '../prisma.service';

/**
 * Deletion completion receipt (B-608-10, mobile #313 B-313-5; keyed r2 since
 * C-608-7).
 *
 * When a finalized account's Supabase identity is removed, the tombstone's
 * `supabase_id` becomes a receipt key derived from the removed auth id
 * instead of a value that forgets it. The original sub is not stored; only a
 * token whose verified `sub` derives the same key can match it. That lets the
 * person's own token (still valid, or expired within the window) learn
 * "this account was deleted" (403 ACCOUNT_DELETED, or the receipt endpoint)
 * instead of a bare 401. After DELETION_RECEIPT_DAYS the nightly cron
 * replaces the key with `deleted-<user id>`, so the link is not kept for ever.
 *
 * Formats:
 *  - r2 (written since C-608-7): `deleted-r2:<HMAC-SHA256(secret,
 *    "tgp-deletion-receipt:v2:" + sub)>`. Without the server secret a database
 *    snapshot plus a list of known auth ids cannot be joined to a receipt.
 *  - r1 (legacy, read only): `deleted-r1:<SHA-256("tgp-deletion-receipt:v1:" +
 *    sub)>`. Never written again; still matched so receipts minted before the
 *    switch keep working until the 30-day cron drains them.
 *
 * Secret: DELETION_RECEIPT_SECRET (32+ characters) when set, otherwise a key
 * derived from RECENT_AUTH_SECRET (HMAC with a fixed label; it is required for
 * deletion anyway, so no new production secret is needed). Rotation:
 * set DELETION_RECEIPT_SECRET_PREVIOUS to the old value for 30 days; lookups
 * try the current key, then the previous one. With no usable secret no receipt
 * is written (the tombstone forgets the auth id: `deleted-<user id>`), never
 * an unkeyed digest.
 */
export const TOMBSTONE_AUTH_PREFIX = 'deleted-';
/** Prefix of every receipt written now (keyed). */
export const RECEIPT_KEY_PREFIX = `${TOMBSTONE_AUTH_PREFIX}r2:`;
/** Legacy unkeyed receipts: matched until they drain, never written. */
export const LEGACY_RECEIPT_KEY_PREFIX = `${TOMBSTONE_AUTH_PREFIX}r1:`;
/** Every receipt prefix the expiry cron drains. */
export const RECEIPT_KEY_PREFIXES = [RECEIPT_KEY_PREFIX, LEGACY_RECEIPT_KEY_PREFIX] as const;
export const DELETION_RECEIPT_DAYS = 30;
export const DELETION_RECEIPT_SECRET_MIN_LENGTH = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

function usable(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t.length >= DELETION_RECEIPT_SECRET_MIN_LENGTH ? t : null;
}

/**
 * Receipt HMAC keys, current first. Empty when neither DELETION_RECEIPT_SECRET
 * nor RECENT_AUTH_SECRET is usable.
 */
export function receiptSecrets(env: NodeJS.ProcessEnv = process.env): Buffer[] {
  const keys: Buffer[] = [];
  const explicit = usable(env.DELETION_RECEIPT_SECRET);
  if (explicit) {
    keys.push(Buffer.from(explicit, 'utf8'));
  } else {
    const base = usable(env.RECENT_AUTH_SECRET);
    if (base) {
      keys.push(crypto.createHmac('sha256', 'tgp.deletion-receipt.key.v2').update(base).digest());
    }
  }
  const previous = usable(env.DELETION_RECEIPT_SECRET_PREVIOUS);
  if (previous) keys.push(Buffer.from(previous, 'utf8'));
  return keys;
}

function r2(secret: Buffer, supabaseId: string): string {
  const mac = crypto
    .createHmac('sha256', secret)
    .update(`tgp-deletion-receipt:v2:${supabaseId}`)
    .digest('hex');
  return `${RECEIPT_KEY_PREFIX}${mac}`;
}

/** Legacy r1 key, for lookups of receipts written before C-608-7. */
export function legacyReceiptKey(supabaseId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`tgp-deletion-receipt:v1:${supabaseId}`)
    .digest('hex');
  return `${LEGACY_RECEIPT_KEY_PREFIX}${digest}`;
}

/**
 * The receipt key to WRITE for a removed auth id: keyed r2 with the current
 * secret, or null when no secret is usable (the caller then forgets the id).
 */
export function deletionReceiptKey(
  supabaseId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const [current] = receiptSecrets(env);
  return current ? r2(current, supabaseId) : null;
}

/**
 * Every key a receipt for `supabaseId` may be stored under, in lookup order:
 * r2 with the current secret, r2 with the previous secret, legacy r1.
 */
export function receiptLookupKeys(
  supabaseId: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [...receiptSecrets(env).map((k) => r2(k, supabaseId)), legacyReceiptKey(supabaseId)];
}

/** The tombstone holding a receipt for `supabaseId`, if any (any live format). */
export async function findDeletionReceipt(
  prisma: Pick<PrismaService, 'user'>,
  supabaseId: string,
): Promise<{ deleted_at: Date | null } | null> {
  for (const key of receiptLookupKeys(supabaseId)) {
    const row = await prisma.user.findUnique({
      where: { supabase_id: key },
      select: { deleted_at: true },
    });
    if (row) return row;
  }
  return null;
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
