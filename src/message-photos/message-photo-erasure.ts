import type { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  isCanonicalOwner,
  isCanonicalPhotoKey,
  type MessagePhotoStorageApi,
} from './message-photo-storage';

/**
 * Durable photo erasure (A6-PHOTOS), the same contract as community voice
 * (B-610-5 / B-610-8):
 *
 *  1. recordPhotoErasures(): BEFORE a photo row is marked removed or storage
 *     is touched, one row per exact key (kind 'object') or owner folder (kind
 *     'owner_folder') is upserted into message_photo_erasures. A completed row
 *     is re-opened. If this write fails the caller fails, so nothing is ever
 *     acknowledged as erased without recorded work.
 *  2. attemptPhotoErasures(): try now. A row completes ONLY after storage
 *     proves the object is gone (exact "Object not found" answer AND the
 *     bucket confirmed to exist) or the owner folder lists empty. Anything
 *     else leaves it open with attempts + 1, last_error and a backoff.
 *  3. The sweep cron (MessagePhotosService.sweep) retries due rows under a
 *     lease until verified. The table has no FK to "User", so the work
 *     survives account finalization and restarts.
 */

export type PhotoErasureKind = 'object' | 'owner_folder';
export type PhotoErasureReason =
  | 'sender_delete'
  | 'message_deleted'
  | 'moderation'
  | 'account_deletion'
  | 'expired'
  | 'unsent'
  | 'superseded';

export interface PhotoErasureTarget {
  kind: PhotoErasureKind;
  target: string;
}

export interface PhotoErasureRow extends PhotoErasureTarget {
  id: string;
  attempts: number;
}

type ErasureDb = Pick<Prisma.TransactionClient, 'messagePhotoErasure'>;

export interface PhotoErasureOutcome {
  completed: number;
  pending: number;
}

export function photoErasureBackoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1), 360) * 60 * 1000;
}

/** Exact-key targets for every non-empty key (staging and final), deduplicated. */
export function photoObjectTargets(keys: Array<string | null | undefined>): PhotoErasureTarget[] {
  return [...new Set(keys.filter((k): k is string => typeof k === 'string' && k.length > 0))].map(
    (k) => ({ kind: 'object', target: k }),
  );
}

export async function recordPhotoErasures(
  db: ErasureDb,
  targets: PhotoErasureTarget[],
  reason: PhotoErasureReason,
  now: Date = new Date(),
): Promise<PhotoErasureRow[]> {
  const seen = new Set<string>();
  const rows: PhotoErasureRow[] = [];
  for (const t of targets) {
    const k = `${t.kind}|${t.target}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const row = await db.messagePhotoErasure.upsert({
      where: { kind_target: { kind: t.kind, target: t.target } },
      create: { kind: t.kind, target: t.target, reason, next_attempt_at: now },
      update: { completed_at: null, next_attempt_at: now },
      select: { id: true, kind: true, target: true, attempts: true },
    });
    rows.push({
      id: row.id,
      kind: row.kind === 'owner_folder' ? 'owner_folder' : 'object',
      target: row.target,
      attempts: row.attempts,
    });
  }
  return rows;
}

async function verifyOne(
  storage: MessagePhotoStorageApi,
  row: PhotoErasureRow,
): Promise<{ done: true; note: string | null } | { done: false; error: string }> {
  if (row.kind === 'object') {
    if (!isCanonicalPhotoKey(row.target)) {
      return { done: true, note: 'non_canonical_key: never minted, not sent to storage' };
    }
    const removal = await storage.removeObjects([row.target]);
    const gone = await storage.objectGone(row.target);
    if (gone === true) return { done: true, note: null };
    if (removal.failed) return { done: false, error: 'storage_remove_failed' };
    return {
      done: false,
      error: gone === null ? 'storage_check_unavailable' : 'object_still_present',
    };
  }
  if (!isCanonicalOwner(row.target)) {
    return { done: true, note: 'non_canonical_owner: never a storage folder' };
  }
  const removal = await storage.removeOwnerFolder(row.target);
  const empty = await storage.ownerFolderEmpty(row.target);
  if (empty === true) return { done: true, note: null };
  if (removal.failed) return { done: false, error: 'storage_remove_failed' };
  return { done: false, error: empty === null ? 'storage_check_unavailable' : 'folder_not_empty' };
}

/** Try recorded work now. Never throws for a storage fault; open rows are retried by the sweep. */
export async function attemptPhotoErasures(
  db: ErasureDb,
  storage: MessagePhotoStorageApi,
  rows: PhotoErasureRow[],
  logger?: Pick<Logger, 'warn' | 'error'>,
  now: () => Date = () => new Date(),
): Promise<PhotoErasureOutcome> {
  let completed = 0;
  let pending = 0;
  for (const row of rows) {
    let result: Awaited<ReturnType<typeof verifyOne>>;
    try {
      result = await verifyOne(storage, row);
    } catch (err) {
      result = { done: false, error: `storage_error: ${(err as Error).message}`.slice(0, 500) };
    }
    const at = now();
    if (result.done) {
      await db.messagePhotoErasure.updateMany({
        where: { id: row.id, completed_at: null },
        data: { completed_at: at, last_error: result.note },
      });
      completed += 1;
      continue;
    }
    const attempts = row.attempts + 1;
    await db.messagePhotoErasure.updateMany({
      where: { id: row.id, completed_at: null },
      data: {
        attempts,
        last_error: result.error,
        next_attempt_at: new Date(at.getTime() + photoErasureBackoffMs(attempts)),
      },
    });
    pending += 1;
    const msg = `photo erasure ${row.id} (${row.kind}) not yet verified after ${attempts} attempt(s): ${result.error}; retry scheduled`;
    if (attempts >= 10) logger?.error(msg);
    else logger?.warn(msg);
  }
  return { completed, pending };
}

const CLAIM_LEASE_MS = 5 * 60 * 1000;

/** Claim due open rows with a lease (conditional next_attempt_at update), then retry them. */
export async function retryDuePhotoErasures(
  db: ErasureDb,
  storage: MessagePhotoStorageApi,
  now: Date,
  logger?: Pick<Logger, 'warn' | 'error'>,
  batch = 50,
): Promise<PhotoErasureOutcome> {
  const due = await db.messagePhotoErasure.findMany({
    where: { completed_at: null, next_attempt_at: { lte: now } },
    orderBy: { next_attempt_at: 'asc' },
    take: batch,
    select: { id: true, kind: true, target: true, attempts: true, next_attempt_at: true },
  });
  const claimed: PhotoErasureRow[] = [];
  for (const row of due) {
    const lease = await db.messagePhotoErasure.updateMany({
      where: { id: row.id, completed_at: null, next_attempt_at: row.next_attempt_at },
      data: { next_attempt_at: new Date(now.getTime() + CLAIM_LEASE_MS) },
    });
    if (lease.count !== 1) continue;
    claimed.push({
      id: row.id,
      kind: row.kind === 'owner_folder' ? 'owner_folder' : 'object',
      target: row.target,
      attempts: row.attempts,
    });
  }
  if (claimed.length === 0) return { completed: 0, pending: 0 };
  return attemptPhotoErasures(db, storage, claimed, logger);
}
