import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { SupabaseService } from '../supabase/supabase.service';
import { exportArchivePath } from '../data-export/data-export.paths';
import { MuxService } from '../video/mux.service';
import { VOICE_DEFAULT_BUCKET } from '../community/voice/voice-upload.provider';
import {
  SUPABASE_BACKEND,
  bloodworkBucket,
  ownedBloodworkKey,
} from '../bloodwork/bloodwork-storage-ref';

/**
 * Account-deletion storage cleanup (B-608-3).
 *
 * Deleting or nulling a row does not delete the bytes it pointed at. Before
 * the finalization transaction touches any row, this service collects every
 * object the user owns (voice notes, coach-message voice, coach media,
 * bloodwork attachments, data-export archives) from the rows themselves and
 * removes the bytes. It runs inside the finalization transaction while the
 * User row is locked, so:
 *   - if any removal fails it throws, the transaction rolls back, the rows
 *     (and therefore the object keys) survive and the next cron run retries;
 *   - every removal is idempotent (a missing object counts as removed), so a
 *     retry after a later DB failure is safe.
 * Nothing is announced as erased until the transaction commits.
 */

export type StorageObject =
  | { kind: 'supabase'; bucket: string; key: string }
  | { kind: 'mux'; assetId: string }
  | { kind: 'local'; path: string };

export interface StoragePurgeResult {
  removed: number;
  byKind: Record<StorageObject['kind'], number>;
}

const DEFAULT_MEDIA_BUCKET = 'coach-media';
const LIST_PAGE = 1000;

/** Supabase object key from a public/signed storage URL for `bucket`. */
export function objectKeyFromUrl(url: string | null, bucket: string): string | null {
  if (!url) return null;
  const marker = `/${bucket}/`;
  const at = url.indexOf(marker);
  if (at < 0 || !url.includes('/storage/v1/object/')) return null;
  const key = url.slice(at + marker.length).split('?')[0];
  return key ? decodeURIComponent(key) : null;
}

@Injectable()
export class AccountDeletionStorageService {
  private readonly logger = new Logger(AccountDeletionStorageService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly mux: MuxService,
  ) {}

  private voiceBucket(): string {
    return (process.env.SUPABASE_VOICE_BUCKET ?? '').trim() || VOICE_DEFAULT_BUCKET;
  }

  private mediaBucket(): string {
    return this.config.get<string>('SUPABASE_MEDIA_BUCKET') ?? DEFAULT_MEDIA_BUCKET;
  }

  /** Every stored object the user owns, read from the rows that point at them. */
  async collect(tx: Prisma.TransactionClient, userId: string): Promise<StorageObject[]> {
    const voiceBucket = this.voiceBucket();
    const out: StorageObject[] = [];
    const seen = new Set<string>();
    const push = (obj: StorageObject) => {
      const id = JSON.stringify(obj);
      if (!seen.has(id)) {
        seen.add(id);
        out.push(obj);
      }
    };

    const voiceNotes = await tx.communityVoiceNote.findMany({
      where: { author_id: userId },
      select: { storage_key: true },
    });
    // Voice keys are written under `${ownerId}/` (VoiceUploadProvider, and
    // confirm rejects any other key). Keys taken from rows or URLs are only
    // removed inside that prefix, so a URL pointing at someone else's clip
    // can never delete it (B-608-8, same rule as bloodwork).
    const ownVoiceKey = (key: string | null) =>
      key && key.startsWith(`${userId}/`) && !key.split('/').includes('..') ? key : null;
    for (const v of voiceNotes) {
      const key = ownVoiceKey(v.storage_key);
      if (key) push({ kind: 'supabase', bucket: voiceBucket, key });
    }

    const coachVoice = await tx.coachMessage.findMany({
      where: { sender_id: userId, voice_url: { not: null } },
      select: { voice_url: true },
    });
    const communityVoice = await tx.communityMessage.findMany({
      where: { sender_id: userId, voice_url: { not: null } },
      select: { voice_url: true },
    });
    for (const m of [...coachVoice, ...communityVoice]) {
      const key = ownVoiceKey(objectKeyFromUrl(m.voice_url, voiceBucket));
      if (key) push({ kind: 'supabase', bucket: voiceBucket, key });
    }

    // Voice uploads are written under `${ownerId}/` (VoiceUploadProvider), so
    // the prefix also catches uploads whose row was never committed.
    for (const key of await this.listPrefix(voiceBucket, userId)) {
      push({ kind: 'supabase', bucket: voiceBucket, key });
    }

    const media = await tx.coachMediaAsset.findMany({
      where: { coach_id: userId },
      select: { storage_key: true, provider: true },
    });
    for (const m of media) {
      if (m.provider === 'mux') push({ kind: 'mux', assetId: m.storage_key });
      else push({ kind: 'supabase', bucket: this.mediaBucket(), key: m.storage_key });
    }

    // Classroom media a coach posted (C-608-1). Keys are server-minted
    // (`community-classroom/<workspace>/<post>/...`) in the media bucket.
    const classroom = await tx.communityClassroomMediaAsset.findMany({
      where: { post: { coach_id: userId } },
      select: { storage_key: true },
    });
    for (const c of classroom) {
      if (c.storage_key.startsWith('community-classroom/')) {
        push({ kind: 'supabase', bucket: this.mediaBucket(), key: c.storage_key });
      }
    }

    // B-608-8: storage_ref is client-supplied. Only keys inside the bloodwork
    // bucket under this user's own prefix are removed; anything else is
    // counted and logged (no key in the log), never deleted.
    const bwBucket = bloodworkBucket();
    const attachments = await tx.bloodworkAttachment.findMany({
      where: { panel: { client_id: userId }, storage_ref: { not: null } },
      select: { storage_ref: true, storage_backend: true },
    });
    let foreignRefs = 0;
    for (const a of attachments) {
      if (a.storage_backend !== SUPABASE_BACKEND) continue;
      const key = ownedBloodworkKey(a.storage_ref, userId, bwBucket);
      if (key) push({ kind: 'supabase', bucket: bwBucket, key });
      else foreignRefs += 1;
      // Other backends are client-supplied external references; the backend
      // holds no bytes for them, and the row itself is deleted.
    }
    if (foreignRefs > 0) {
      this.logger.warn(
        `account deletion: skipped ${foreignRefs} bloodwork storage_ref(s) outside ${bwBucket}/<user>/`,
      );
    }

    // Every export of the user, not only finished ones (B-608-3): an export
    // still building writes `<DATA_EXPORT_FS_DIR>/<id>.json`, so that path is
    // removed too. An archive written after this transaction commits is
    // removed by the export worker itself (its READY update finds no row) or
    // by the nightly orphan sweep in DataExportService.expireOldExports.
    const exports = await tx.dataExportRequest.findMany({
      where: { user_id: userId },
      select: { id: true, file_url: true },
    });
    for (const e of exports) {
      const url = e.file_url ?? '';
      if (url) {
        if (url.startsWith('local://')) push({ kind: 'local', path: url.slice('local://'.length) });
        else
          throw new Error('account deletion: data export archive has an unsupported storage URL');
      }
      const planned = exportArchivePath(e.id);
      if (planned !== url.slice('local://'.length)) push({ kind: 'local', path: planned });
    }
    return out;
  }

  private async listPrefix(bucket: string, prefix: string): Promise<string[]> {
    const storage = this.supabase.getClient().storage.from(bucket);
    const keys: string[] = [];
    for (let offset = 0; ; offset += LIST_PAGE) {
      const { data, error } = await storage.list(prefix, { limit: LIST_PAGE, offset });
      if (error) {
        // A missing bucket means nothing was ever stored there.
        if (/not found/i.test(error.message)) return keys;
        throw new Error(`account deletion: listing ${bucket}/${prefix} failed: ${error.message}`);
      }
      const page = data ?? [];
      for (const item of page) if (item.name) keys.push(`${prefix}/${item.name}`);
      if (page.length < LIST_PAGE) return keys;
    }
  }

  /** Remove every collected object; throws on the first unrecoverable error. */
  async purge(objects: StorageObject[]): Promise<StoragePurgeResult> {
    const byKind: StoragePurgeResult['byKind'] = { supabase: 0, mux: 0, local: 0 };
    const byBucket = new Map<string, string[]>();
    for (const o of objects) {
      if (o.kind === 'supabase') byBucket.set(o.bucket, [...(byBucket.get(o.bucket) ?? []), o.key]);
    }
    for (const [bucket, keys] of byBucket) {
      for (let i = 0; i < keys.length; i += LIST_PAGE) {
        const batch = keys.slice(i, i + LIST_PAGE);
        const { error } = await this.supabase.getClient().storage.from(bucket).remove(batch);
        if (error) {
          throw new Error(
            `account deletion: removing ${batch.length} object(s) from ${bucket} failed: ${error.message}`,
          );
        }
        byKind.supabase += batch.length;
      }
    }
    for (const o of objects) {
      if (o.kind === 'mux') {
        await this.mux.deleteAsset(o.assetId);
        byKind.mux += 1;
      } else if (o.kind === 'local') {
        const { unlink } = await import('fs/promises');
        try {
          await unlink(o.path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        byKind.local += 1;
      }
    }
    const removed = byKind.supabase + byKind.mux + byKind.local;
    this.logger.log(
      `account deletion storage purge: supabase=${byKind.supabase} mux=${byKind.mux} local=${byKind.local}`,
    );
    return { removed, byKind };
  }
}
