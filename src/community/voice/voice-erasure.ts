import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { isSignableVoiceKey, voiceOwnerFolder } from './voice-storage-key';
import { VoiceUploadProvider } from './voice-upload.provider';

/**
 * Durable voice-recording erasure (B-610-5, fix round 5).
 *
 * Author delete, a moderation Hide/Ban and account deletion must erase the
 * recording itself, not only hide the row. Storage is an external service
 * that can be down, and the process can crash between steps, so erasure is
 * recorded as work in "community_voice_erasures" BEFORE the note rows or
 * storage are touched:
 *
 *  1. recordVoiceErasures(): upsert one row per exact key (kind 'object') or
 *     owner folder (kind 'owner_folder'). A completed row is re-opened as a
 *     new intent: its failure count, last error and reason start fresh
 *     (C-610-12), so its first failure backs off 1 minute, not from the old
 *     count. A row that is still open keeps its count (the same work is
 *     still failing; the >= 10 attempts error log must not be reset by a
 *     retried request) and is only made due now.
 *  2. attemptVoiceErasures(): try now. A row is completed ONLY after a
 *     verified removal: the exact object reads back missing, or the owner
 *     folder lists empty. Anything else (storage error, object still there,
 *     storage unreachable for the check, folder still has files after one
 *     bounded pass) leaves the row open with attempts + 1, last_error and a
 *     backoff next_attempt_at.
 *  3. VoiceErasureService.retryDue() (cron, every 10 minutes): claims due
 *     open rows with a lease and retries them until verified. The table has
 *     no FK to "User", so the work survives account finalization and
 *     restarts; a folder larger than one pass simply continues next run.
 *
 * A key that does not have the canonical shape was never signable (A-610-1)
 * and is never sent to storage; its row is completed with that reason.
 */

export type VoiceErasureKind = 'object' | 'owner_folder';
export type VoiceErasureReason = 'author_delete' | 'moderation' | 'account_deletion';

export interface VoiceErasureTarget {
  kind: VoiceErasureKind;
  target: string;
}

export interface VoiceErasureRow extends VoiceErasureTarget {
  id: string;
  attempts: number;
}

/** The storage operations erasure needs (VoiceUploadProvider implements them). */
export interface VoiceErasureStorage {
  bucket(): string;
  removeObjects(keys: string[]): Promise<{ removed: number; failed: boolean }>;
  /** true = verified missing, false = still present, null = could not check. */
  objectGone(key: string): Promise<boolean | null>;
  removeOwnerFolder(ownerId: string): Promise<{ removed: number; failed: boolean }>;
  /** true = verified empty, false = files remain, null = could not check. */
  ownerFolderEmpty(ownerId: string): Promise<boolean | null>;
}

type ErasureDb = Pick<Prisma.TransactionClient, 'communityVoiceErasure'>;

export interface VoiceErasureOutcome {
  completed: number;
  pending: number;
}

/** Backoff after `attempts` failed tries: 1, 2, 4 ... minutes, capped at 6 hours. */
export function voiceErasureBackoffMs(attempts: number): number {
  const minutes = Math.min(2 ** Math.max(0, attempts - 1), 360);
  return minutes * 60 * 1000;
}

/** The exact-key targets for a set of storage keys (deduplicated). */
export function objectTargets(keys: string[]): VoiceErasureTarget[] {
  return [...new Set(keys.filter((k) => typeof k === 'string' && k.length > 0))].map((k) => ({
    kind: 'object',
    target: k,
  }));
}

/**
 * Record erasure work durably (step 1). Must run BEFORE the caller soft-deletes
 * the rows or calls storage, and before it acknowledges the erasure. Throws
 * when the work cannot be recorded, so the caller never claims an erasure it
 * cannot guarantee.
 */
export async function recordVoiceErasures(
  db: ErasureDb,
  targets: VoiceErasureTarget[],
  reason: VoiceErasureReason,
  now: Date = new Date(),
): Promise<VoiceErasureRow[]> {
  const seen = new Set<string>();
  const rows: VoiceErasureRow[] = [];
  for (const t of targets) {
    const k = `${t.kind}|${t.target}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // C-610-12: re-opening COMPLETED work is a genuinely new intent, so it
    // starts with a clean failure count. Conditional on completed_at, so it
    // never resets work that is still open (and still failing).
    await db.communityVoiceErasure.updateMany({
      where: { kind: t.kind, target: t.target, completed_at: { not: null } },
      data: { completed_at: null, attempts: 0, last_error: null, reason, next_attempt_at: now },
    });
    const row = await db.communityVoiceErasure.upsert({
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
  storage: VoiceErasureStorage,
  row: VoiceErasureRow,
): Promise<{ done: true; note: string | null } | { done: false; error: string }> {
  if (row.kind === 'object') {
    if (!isSignableVoiceKey(storage.bucket(), row.target)) {
      return { done: true, note: 'non_canonical_key: never signable, not sent to storage' };
    }
    const removal = await storage.removeObjects([row.target]);
    const gone = await storage.objectGone(row.target);
    if (gone === true) return { done: true, note: null };
    if (removal.failed) return { done: false, error: 'storage_remove_failed' };
    return { done: false, error: gone === null ? 'storage_check_unavailable' : 'object_still_present' };
  }
  if (!voiceOwnerFolder(row.target)) {
    return { done: true, note: 'non_canonical_owner: never a storage folder' };
  }
  const removal = await storage.removeOwnerFolder(row.target);
  const empty = await storage.ownerFolderEmpty(row.target);
  if (empty === true) return { done: true, note: null };
  if (removal.failed) return { done: false, error: 'storage_remove_failed' };
  return { done: false, error: empty === null ? 'storage_check_unavailable' : 'folder_not_empty' };
}

/**
 * Try the recorded work now (step 2). Never throws for a storage fault: the
 * row stays open and the cron retries it. Returns how many rows were
 * verified complete and how many remain open.
 */
export async function attemptVoiceErasures(
  db: ErasureDb,
  storage: VoiceErasureStorage,
  rows: VoiceErasureRow[],
  logger?: Pick<Logger, 'warn' | 'error'>,
  now: () => Date = () => new Date(),
): Promise<VoiceErasureOutcome> {
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
      await db.communityVoiceErasure.updateMany({
        where: { id: row.id, completed_at: null },
        data: { completed_at: at, last_error: result.note },
      });
      completed += 1;
      continue;
    }
    const attempts = row.attempts + 1;
    await db.communityVoiceErasure.updateMany({
      where: { id: row.id, completed_at: null },
      data: {
        attempts,
        last_error: result.error,
        next_attempt_at: new Date(at.getTime() + voiceErasureBackoffMs(attempts)),
      },
    });
    pending += 1;
    const msg = `voice erasure ${row.id} (${row.kind}) not yet verified after ${attempts} attempt(s): ${result.error}; retry scheduled`;
    if (attempts >= 10) logger?.error(msg);
    else logger?.warn(msg);
  }
  return { completed, pending };
}

/** How long a cron run holds a claimed row before another run may take it. */
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const RETRY_BATCH = 50;

/**
 * Retries open erasure work until each row is verified (step 3). Runs on
 * every instance; a lease (conditional next_attempt_at update) keeps two runs
 * off the same row, and every storage call is idempotent anyway.
 */
@Injectable()
export class VoiceErasureService {
  private readonly logger = new Logger(VoiceErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: VoiceUploadProvider,
  ) {}

  @Cron('*/10 * * * *')
  async retryDue(now: Date = new Date()): Promise<VoiceErasureOutcome> {
    const due = await this.prisma.communityVoiceErasure.findMany({
      where: { completed_at: null, next_attempt_at: { lte: now } },
      orderBy: { next_attempt_at: 'asc' },
      take: RETRY_BATCH,
      select: { id: true, kind: true, target: true, attempts: true, next_attempt_at: true },
    });
    const claimed: VoiceErasureRow[] = [];
    for (const row of due) {
      const lease = await this.prisma.communityVoiceErasure.updateMany({
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
    const outcome = await attemptVoiceErasures(this.prisma, this.storage, claimed, this.logger);
    this.logger.log(
      `voice erasure retry: completed=${outcome.completed} pending=${outcome.pending}`,
    );
    return outcome;
  }
}
