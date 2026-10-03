import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { SupabaseService } from '../supabase/supabase.service';
import { MessagesSafetyService } from '../messages-safety/messages-safety.service';
import { ImageSanitizeError, sanitizeImage, sniffImageType } from './image-metadata';
import {
  MESSAGE_PHOTO_SCANNER,
  NoopMessagePhotoScanner,
  type MessagePhotoScanner,
} from './message-photo-scanner';
import {
  MessagePhotoStorage,
  PHOTO_READ_URL_TTL_SEC,
  PHOTO_REVIEW_URL_TTL_SEC,
  mintFinalKey,
  mintStagingKey,
  type MessagePhotoStorageApi,
} from './message-photo-storage';
import {
  attemptPhotoErasures,
  photoObjectTargets,
  recordPhotoErasures,
  retryDuePhotoErasures,
  type PhotoErasureReason,
  type PhotoErasureTarget,
} from './message-photo-erasure';
import { photoError, type PhotoErrorCode } from './message-photos.errors';
import { assertMessagePhotosEnabled } from './message-photos.flag';

/** Types a phone may declare. The stored type is always the SNIFFED one. */
export const PHOTO_DECLARED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'] as const;
/** Upload size limit (the bucket enforces the same 15 MB). */
export const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
/** Photos per message (an album). */
export const PHOTO_MAX_PER_MESSAGE = 10;
/** Unsent uploads one person may hold at once. */
export const PHOTO_MAX_PENDING = 30;
/** Window in which an issued upload must be finalized. */
export const PHOTO_UPLOAD_WINDOW_MS = 10 * 60 * 1000;
/** A finalize that has not finished after this long may be taken over. */
export const PHOTO_PROCESSING_STALE_MS = 2 * 60 * 1000;
/** A finalized photo that is never sent is erased after this long. */
export const PHOTO_UNSENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Moderation respond-by commitment (same as the community queue). */
export const PHOTO_REPORT_RESPOND_MS = 24 * 60 * 60 * 1000;

/** One coach <-> client thread, already authorized by MessagingService. */
export interface PhotoThread {
  /** The thread's (head) coach id. */
  coachId: string;
  clientId: string;
  /** The caller (client, head coach or assigned sub-coach). */
  actorId: string;
  actorRole: 'coach' | 'student';
}

export type PhotoViewState = 'ready' | 'hidden' | 'removed' | 'unavailable';

export interface MessagePhotoView {
  id: string;
  state: PhotoViewState;
  /** 5-minute signed URL; null unless state is 'ready'. Never a public URL. */
  url: string | null;
  url_expires_at: string | null;
  width: number | null;
  height: number | null;
  content_type: string | null;
  position: number;
}

export interface PhotoUploadIntent {
  photo_id: string;
  upload_url: string;
  upload_token: string | null;
  expires_at: string;
  max_bytes: number;
}

type PhotoRow = {
  id: string;
  uploader_id: string;
  coach_id: string;
  client_id: string;
  message_id: string | null;
  status: string;
  staging_key: string;
  storage_key: string | null;
  content_type: string | null;
  width: number | null;
  height: number | null;
  position: number | null;
  upload_expires_at: Date;
  processing_at: Date | null;
  attached_at: Date | null;
  removed_at: Date | null;
};

const ROW_SELECT = {
  id: true,
  uploader_id: true,
  coach_id: true,
  client_id: true,
  message_id: true,
  status: true,
  staging_key: true,
  storage_key: true,
  content_type: true,
  width: true,
  height: true,
  position: true,
  upload_expires_at: true,
  processing_at: true,
  attached_at: true,
  removed_at: true,
} as const;

type PhotoDb = Pick<Prisma.TransactionClient, 'messagePhoto' | 'messagePhotoErasure'>;

const SANITIZE_CODES: Record<ImageSanitizeError['reason'], PhotoErrorCode> = {
  not_an_image: 'message_photo.not_an_image',
  unsupported_format: 'message_photo.type_unsupported',
  dimensions_out_of_range: 'message_photo.dimensions_out_of_range',
};

/**
 * Photos in coach <-> client messages (A6-PHOTOS). See src/message-photos/README.md.
 *
 * Upload: intent (thread-checked, size/type-limited, signed upload URL for a
 * server-minted staging key) -> the phone PUTs the bytes -> finalize (the
 * server downloads the raw bytes, verifies the real format, strips
 * EXIF/GPS and all other metadata, runs the moderation hook, writes the
 * sanitized copy to a new key and erases the raw upload) -> send (the message
 * and its photos are linked in one transaction). Reads sign 5-minute URLs per
 * request for a thread party; a reported photo is hidden for its reporter;
 * blocked senders' photos never reach the blocker. Delete by the sender,
 * moderation removal, a deleted message and account deletion all go through
 * durable, verified erasure.
 */
@Injectable()
export class MessagePhotosService {
  private readonly logger = new Logger(MessagePhotosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MessagePhotoStorage,
    private readonly audit: AuditService,
    private readonly supabase: SupabaseService,
    // Explicit tokens: a `T | null` param type is emitted as Object when the
    // file is compiled without strictNullChecks (ts-jest here), which would
    // silently drop the injection.
    @Optional()
    @Inject(MessagesSafetyService)
    private readonly safety: MessagesSafetyService | null = null,
    @Optional()
    @Inject(MESSAGE_PHOTO_SCANNER)
    private readonly scanner: MessagePhotoScanner | null = null,
  ) {}

  private store(): MessagePhotoStorageApi {
    return this.storage;
  }

  private otherParty(thread: PhotoThread): string {
    return thread.actorRole === 'student' ? thread.coachId : thread.clientId;
  }

  private async assertNotBlocked(thread: PhotoThread): Promise<void> {
    if (!this.safety) return;
    if (await this.safety.isEitherSideBlocked(thread.actorId, this.otherParty(thread))) {
      throw photoError('message_photo.blocked');
    }
  }

  // ─── 1. Upload intent ──────────────────────────────────────────────────────

  async createUpload(
    thread: PhotoThread,
    request: { content_type: string; size_bytes: number },
    now: Date = new Date(),
  ): Promise<PhotoUploadIntent> {
    assertMessagePhotosEnabled();
    const declared = String(request.content_type ?? '').toLowerCase();
    if (!(PHOTO_DECLARED_TYPES as readonly string[]).includes(declared)) {
      throw photoError('message_photo.type_unsupported');
    }
    const size = Number(request.size_bytes);
    if (!Number.isInteger(size) || size < 1 || size > PHOTO_MAX_BYTES) {
      throw photoError('message_photo.too_large', { max_bytes: PHOTO_MAX_BYTES });
    }
    await this.assertNotBlocked(thread);

    const open = await this.prisma.messagePhoto.count({
      where: {
        uploader_id: thread.actorId,
        message_id: null,
        removed_at: null,
        status: { in: ['pending', 'processing', 'ready'] },
        created_at: { gt: new Date(now.getTime() - PHOTO_UNSENT_TTL_MS) },
      },
    });
    if (open >= PHOTO_MAX_PENDING) throw photoError('message_photo.pending_limit');

    const id = randomUUID();
    const stagingKey = mintStagingKey(thread.actorId, id);
    const expiresAt = new Date(now.getTime() + PHOTO_UPLOAD_WINDOW_MS);
    await this.prisma.messagePhoto.create({
      data: {
        id,
        uploader_id: thread.actorId,
        coach_id: thread.coachId,
        client_id: thread.clientId,
        staging_key: stagingKey,
        declared_content_type: declared === 'image/jpg' ? 'image/jpeg' : declared,
        declared_size_bytes: size,
        upload_expires_at: expiresAt,
      },
    });
    const signed = await this.store().createSignedUpload(stagingKey);
    if (!signed) {
      // Nothing was uploaded; the row would only ever expire. Remove it now.
      await this.prisma.messagePhoto.deleteMany({ where: { id, status: 'pending' } });
      throw photoError('message_photo.storage_unavailable');
    }
    return {
      photo_id: id,
      upload_url: signed.uploadUrl,
      upload_token: signed.token,
      expires_at: expiresAt.toISOString(),
      max_bytes: PHOTO_MAX_BYTES,
    };
  }

  // ─── 2. Finalize (sanitize) ────────────────────────────────────────────────

  private async loadOwn(thread: PhotoThread, photoId: string): Promise<PhotoRow> {
    const row = await this.prisma.messagePhoto.findFirst({
      where: {
        id: photoId,
        uploader_id: thread.actorId,
        coach_id: thread.coachId,
        client_id: thread.clientId,
      },
      select: ROW_SELECT,
    });
    if (!row) throw photoError('message_photo.not_found');
    return row;
  }

  /** Put a claimed photo back to 'pending' so the phone can retry. */
  private async release(id: string, claimedAt: Date): Promise<void> {
    await this.prisma.messagePhoto.updateMany({
      where: { id, status: 'processing', processing_at: claimedAt },
      data: { status: 'pending', processing_at: null },
    });
  }

  /** Reject a claimed photo for good and erase its raw upload. */
  private async reject(
    row: PhotoRow,
    claimedAt: Date,
    code: PhotoErrorCode,
    scanner?: string,
  ): Promise<never> {
    const work = await recordPhotoErasures(
      this.prisma,
      photoObjectTargets([row.staging_key]),
      'superseded',
    );
    await this.prisma.messagePhoto.updateMany({
      where: { id: row.id, status: 'processing', processing_at: claimedAt },
      data: {
        status: 'rejected',
        reject_code: code,
        processing_at: null,
        scanner: scanner ?? null,
      },
    });
    await attemptPhotoErasures(this.prisma, this.store(), work, this.logger);
    throw photoError(
      code,
      code === 'message_photo.too_large' ? { max_bytes: PHOTO_MAX_BYTES } : {},
    );
  }

  async finalize(
    thread: PhotoThread,
    photoId: string,
    now: Date = new Date(),
  ): Promise<MessagePhotoView> {
    assertMessagePhotosEnabled();
    let row = await this.loadOwn(thread, photoId);
    const settled = this.settledAnswer(row, now);
    if (settled === 'ready') return (await this.views(thread.actorId, [row], now))[0];
    if (settled) throw photoError(settled);

    if (now.getTime() > row.upload_expires_at.getTime()) {
      await this.expire([row], now);
      throw photoError('message_photo.upload_expired');
    }

    // Claim (lease): only one finalize works on a photo at a time.
    const claimedAt = now;
    const claim = await this.prisma.messagePhoto.updateMany({
      where: {
        id: row.id,
        removed_at: null,
        OR: [
          { status: 'pending' },
          {
            status: 'processing',
            processing_at: { lt: new Date(now.getTime() - PHOTO_PROCESSING_STALE_MS) },
          },
        ],
      },
      data: { status: 'processing', processing_at: claimedAt },
    });
    if (claim.count !== 1) {
      row = await this.loadOwn(thread, photoId);
      const again = this.settledAnswer(row, now);
      if (again === 'ready') return (await this.views(thread.actorId, [row], now))[0];
      throw photoError(again ?? 'message_photo.processing');
    }

    const stat = await this.store().stat(row.staging_key);
    if (stat.state === 'missing') {
      await this.release(row.id, claimedAt);
      throw photoError('message_photo.upload_missing');
    }
    if (stat.state === 'unavailable') {
      await this.release(row.id, claimedAt);
      throw photoError('message_photo.storage_unavailable');
    }
    if (stat.size !== null && stat.size > PHOTO_MAX_BYTES) {
      return this.reject(row, claimedAt, 'message_photo.too_large');
    }
    const download = await this.store().download(row.staging_key, PHOTO_MAX_BYTES);
    if (download.state === 'too_large')
      return this.reject(row, claimedAt, 'message_photo.too_large');
    if (download.state !== 'ok') {
      await this.release(row.id, claimedAt);
      throw photoError(
        download.state === 'missing'
          ? 'message_photo.upload_missing'
          : 'message_photo.storage_unavailable',
      );
    }

    const sniffed = sniffImageType(download.bytes);
    if (sniffed === 'image/heic')
      return this.reject(row, claimedAt, 'message_photo.type_unsupported');
    let clean: ReturnType<typeof sanitizeImage>;
    try {
      clean = sanitizeImage(download.bytes);
    } catch (err) {
      if (err instanceof ImageSanitizeError)
        return this.reject(row, claimedAt, SANITIZE_CODES[err.reason]);
      throw err;
    }

    let verdict: Awaited<ReturnType<MessagePhotoScanner['scan']>>;
    try {
      verdict = await (this.scanner ?? new NoopMessagePhotoScanner()).scan({
        bytes: clean.bytes,
        contentType: clean.contentType,
        width: clean.width,
        height: clean.height,
        uploaderId: thread.actorId,
      });
    } catch (err) {
      this.logger.warn(`photo scanner failed: ${(err as Error).message}`);
      await this.release(row.id, claimedAt);
      throw photoError('message_photo.storage_unavailable');
    }
    if (verdict.verdict === 'block') {
      return this.reject(row, claimedAt, 'message_photo.rejected', verdict.scanner);
    }

    const finalKey = mintFinalKey(thread.actorId, row.id, clean.ext);
    const put = await this.store().put(finalKey, clean.bytes, clean.contentType);
    if (put !== 'ok') {
      // A failed write may still have left bytes: erase that key durably.
      const orphan = await recordPhotoErasures(
        this.prisma,
        photoObjectTargets([finalKey]),
        'superseded',
      );
      await attemptPhotoErasures(this.prisma, this.store(), orphan, this.logger);
      await this.release(row.id, claimedAt);
      throw photoError('message_photo.storage_unavailable');
    }

    const done = await this.prisma.messagePhoto.updateMany({
      where: { id: row.id, status: 'processing', processing_at: claimedAt, removed_at: null },
      data: {
        status: 'ready',
        storage_key: finalKey,
        content_type: clean.contentType,
        size_bytes: clean.bytes.length,
        width: clean.width,
        height: clean.height,
        sha256: clean.sha256,
        scanner: verdict.scanner,
        finalized_at: now,
        processing_at: null,
      },
    });
    // The raw upload (with its metadata) is erased in every case.
    const raw: PhotoErasureTarget[] = photoObjectTargets([row.staging_key]);
    if (done.count !== 1) raw.push(...photoObjectTargets([finalKey]));
    const work = await recordPhotoErasures(this.prisma, raw, 'superseded');
    await attemptPhotoErasures(this.prisma, this.store(), work, this.logger);
    row = await this.loadOwn(thread, photoId);
    if (done.count !== 1) {
      const lost = this.settledAnswer(row, now);
      if (lost === 'ready') return (await this.views(thread.actorId, [row], now))[0];
      throw photoError(lost ?? 'message_photo.processing');
    }
    return (await this.views(thread.actorId, [row], now))[0];
  }

  /** The final answer for a photo that is no longer pending, or null to keep going. */
  private settledAnswer(row: PhotoRow, now: Date): 'ready' | PhotoErrorCode | null {
    if (row.removed_at || row.status === 'removed') return 'message_photo.not_found';
    if (row.status === 'ready') return 'ready';
    if (row.status === 'rejected') return 'message_photo.rejected';
    if (
      row.status === 'processing' &&
      row.processing_at &&
      row.processing_at.getTime() >= now.getTime() - PHOTO_PROCESSING_STALE_MS
    ) {
      return 'message_photo.processing';
    }
    return null;
  }

  // ─── 3. Attach on send ─────────────────────────────────────────────────────

  /** Normalize and pre-check photo ids before the message is written (specific errors, no write). */
  async assertAttachable(thread: PhotoThread, photoIds: string[] | undefined): Promise<string[]> {
    const ids = [...new Set(photoIds ?? [])];
    if (ids.length === 0) return [];
    assertMessagePhotosEnabled();
    if (ids.length > PHOTO_MAX_PER_MESSAGE) throw photoError('message_photo.limit_exceeded');
    const rows = await this.prisma.messagePhoto.findMany({
      where: {
        id: { in: ids },
        uploader_id: thread.actorId,
        coach_id: thread.coachId,
        client_id: thread.clientId,
      },
      select: ROW_SELECT,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const r = byId.get(id);
      if (!r || r.removed_at || r.status === 'removed' || r.status === 'rejected') {
        throw photoError('message_photo.not_found');
      }
      if (r.message_id || r.attached_at) throw photoError('message_photo.already_attached');
      if (r.status !== 'ready' || !r.storage_key) throw photoError('message_photo.not_ready');
    }
    return ids;
  }

  /**
   * Link photos to a message inside the caller's transaction. Each update is
   * conditional (still ready, unattached, same uploader and thread), so a
   * concurrent second send of the same photo fails and rolls back its message.
   */
  async attachInTx(
    tx: Pick<Prisma.TransactionClient, 'messagePhoto'>,
    thread: PhotoThread,
    photoIds: string[],
    messageId: string,
    now: Date = new Date(),
  ): Promise<void> {
    for (let i = 0; i < photoIds.length; i += 1) {
      const res = await tx.messagePhoto.updateMany({
        where: {
          id: photoIds[i],
          uploader_id: thread.actorId,
          coach_id: thread.coachId,
          client_id: thread.clientId,
          status: 'ready',
          removed_at: null,
          message_id: null,
          attached_at: null,
        },
        data: { message_id: messageId, attached_at: now, position: i },
      });
      if (res.count !== 1) throw photoError('message_photo.already_attached');
    }
  }

  // ─── 4. Reads ──────────────────────────────────────────────────────────────

  /** Build views for photo rows as seen by `viewerId` (signs one batch of URLs). */
  private async views(
    viewerId: string,
    rows: PhotoRow[],
    now: Date = new Date(),
  ): Promise<MessagePhotoView[]> {
    const messageIds = [...new Set(rows.map((r) => r.message_id).filter((m): m is string => !!m))];
    const reported = new Set<string>();
    if (messageIds.length > 0) {
      const reports = await this.prisma.messageReport.findMany({
        where: { reporter_id: viewerId, message_id: { in: messageIds } },
        select: { message_id: true },
      });
      for (const r of reports) reported.add(r.message_id);
    }
    const state = (r: PhotoRow): PhotoViewState => {
      if (r.removed_at || r.status === 'removed') return 'removed';
      if (r.message_id && reported.has(r.message_id)) return 'hidden';
      return r.status === 'ready' && r.storage_key ? 'ready' : 'unavailable';
    };
    const signable = rows.filter((r) => state(r) === 'ready').map((r) => r.storage_key as string);
    const urls =
      signable.length > 0
        ? await this.store().signRead(signable, PHOTO_READ_URL_TTL_SEC)
        : new Map();
    const expires = new Date(now.getTime() + PHOTO_READ_URL_TTL_SEC * 1000).toISOString();
    return rows.map((r) => {
      let s = state(r);
      const url = s === 'ready' ? (urls.get(r.storage_key as string) ?? null) : null;
      if (s === 'ready' && !url) s = 'unavailable';
      const visible = s === 'ready' || s === 'unavailable';
      return {
        id: r.id,
        state: s,
        url,
        url_expires_at: url ? expires : null,
        width: visible ? r.width : null,
        height: visible ? r.height : null,
        content_type: visible ? r.content_type : null,
        position: r.position ?? 0,
      };
    });
  }

  /**
   * Add `photos` to each thread message (in place order). The rows were
   * already filtered for blocks by MessagingService, so only visible
   * messages are decorated. Reads stay on when the flag is off (see flag).
   */
  async decorate<T extends { id: string }>(
    viewerId: string,
    messages: T[],
  ): Promise<Array<T & { photos: MessagePhotoView[] }>> {
    if (messages.length === 0) return [];
    const rows = await this.prisma.messagePhoto.findMany({
      where: {
        message_id: { in: messages.map((m) => m.id) },
        status: { in: ['ready', 'removed'] },
      },
      orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
      select: ROW_SELECT,
    });
    if (rows.length === 0) return messages.map((m) => ({ ...m, photos: [] }));
    const views = await this.views(viewerId, rows);
    const byMessage = new Map<string, MessagePhotoView[]>();
    rows.forEach((r, i) => {
      const list = byMessage.get(r.message_id as string) ?? [];
      list.push(views[i]);
      byMessage.set(r.message_id as string, list);
    });
    return messages.map((m) => ({ ...m, photos: byMessage.get(m.id) ?? [] }));
  }

  /** Fresh signed URL for the full-screen viewer (the list URL expires after 5 minutes). */
  async viewUrl(
    thread: PhotoThread,
    photoId: string,
    now: Date = new Date(),
  ): Promise<MessagePhotoView> {
    const row = await this.prisma.messagePhoto.findFirst({
      where: { id: photoId, coach_id: thread.coachId, client_id: thread.clientId },
      select: ROW_SELECT,
    });
    // Unsent photos are visible only to their uploader (composer preview).
    if (!row || (!row.message_id && row.uploader_id !== thread.actorId)) {
      throw photoError('message_photo.not_found');
    }
    // Block parity with the thread list: the blocker never sees the blocked
    // person's photos (same 404 as "does not exist").
    if (row.uploader_id !== thread.actorId && this.safety) {
      const blocked = await this.safety.getBlockedIdsFor(thread.actorId);
      if (blocked.includes(row.uploader_id)) throw photoError('message_photo.not_found');
    }
    const [view] = await this.views(thread.actorId, [row], now);
    if (view.state === 'removed') throw photoError('message_photo.removed');
    if (view.state === 'hidden') throw photoError('message_photo.hidden');
    if (view.state === 'unavailable') {
      throw photoError(
        row.status === 'ready' ? 'message_photo.storage_unavailable' : 'message_photo.not_ready',
      );
    }
    return view;
  }

  // ─── 5. Removal and erasure ────────────────────────────────────────────────

  /**
   * Record erasure work for the rows' keys FIRST, then mark them removed, then
   * try storage. A failure to record throws before anything is changed.
   */
  private async removeRows(
    db: PhotoDb,
    rows: Array<Pick<PhotoRow, 'id' | 'staging_key' | 'storage_key'>>,
    reason: PhotoErasureReason,
    now: Date,
    extraTargets: PhotoErasureTarget[] = [],
  ): Promise<{ removed: number; pending: number }> {
    if (rows.length === 0 && extraTargets.length === 0) return { removed: 0, pending: 0 };
    const work = await recordPhotoErasures(
      db,
      [...photoObjectTargets(rows.flatMap((r) => [r.staging_key, r.storage_key])), ...extraTargets],
      reason,
      now,
    );
    let removed = 0;
    if (rows.length > 0) {
      const res = await db.messagePhoto.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, removed_at: null },
        data: { status: 'removed', removed_at: now, removed_reason: reason, processing_at: null },
      });
      removed = res.count;
    }
    const outcome = await attemptPhotoErasures(db, this.store(), work, this.logger);
    return { removed, pending: outcome.pending };
  }

  private async expire(rows: PhotoRow[], now: Date): Promise<void> {
    await this.removeRows(this.prisma, rows, 'expired', now);
  }

  /** The sender deletes one of their photos (sent or not). Idempotent. */
  async deleteBySender(
    thread: PhotoThread,
    photoId: string,
    now: Date = new Date(),
  ): Promise<{ id: string; deleted: true }> {
    const row = await this.prisma.messagePhoto.findFirst({
      where: { id: photoId, coach_id: thread.coachId, client_id: thread.clientId },
      select: ROW_SELECT,
    });
    if (!row || (!row.message_id && row.uploader_id !== thread.actorId))
      throw photoError('message_photo.not_found');
    if (row.uploader_id !== thread.actorId) throw photoError('message_photo.not_sender');
    if (!row.removed_at) {
      await this.removeRows(this.prisma, [row], 'sender_delete', now);
      void this.audit.write({
        action: 'message_photo.deleted',
        actorId: thread.actorId,
        actorRole: thread.actorRole,
        targetUserId: this.otherParty(thread),
        targetType: 'message_photo',
        targetId: row.id,
        tenantCoachId: thread.coachId,
        metadata: { sent: !!row.message_id },
      });
      if (row.message_id) void this.supabase.broadcastNewMessage(this.otherParty(thread));
    }
    return { id: row.id, deleted: true };
  }

  /**
   * Erase every photo on the given messages (message delete, moderation).
   * Exported hook for lane A3's message delete: call it in the same request
   * as the tombstone write (inside its transaction when it has one).
   */
  async eraseForMessages(
    messageIds: string[],
    reason: PhotoErasureReason,
    db: PhotoDb = this.prisma,
    now: Date = new Date(),
  ): Promise<{ removed: number; pending: number }> {
    if (messageIds.length === 0) return { removed: 0, pending: 0 };
    const rows = await db.messagePhoto.findMany({
      where: { message_id: { in: messageIds }, removed_at: null },
      select: { id: true, staging_key: true, storage_key: true },
    });
    return this.removeRows(db, rows, reason, now);
  }

  /** Periodic sweep: retry open erasures, expire stale uploads, erase unsent and orphaned photos. */
  @Cron('*/10 * * * *')
  async sweep(
    now: Date = new Date(),
  ): Promise<{ erasures: { completed: number; pending: number }; removed: number }> {
    let removed = 0;
    try {
      const stale = await this.prisma.messagePhoto.findMany({
        where: {
          removed_at: null,
          status: { in: ['pending', 'processing', 'rejected'] },
          upload_expires_at: { lt: new Date(now.getTime() - PHOTO_PROCESSING_STALE_MS) },
        },
        take: 100,
        select: ROW_SELECT,
      });
      removed += (await this.removeRows(this.prisma, stale, 'expired', now)).removed;
      const unsent = await this.prisma.messagePhoto.findMany({
        where: {
          removed_at: null,
          status: 'ready',
          message_id: null,
          attached_at: null,
          finalized_at: { lt: new Date(now.getTime() - PHOTO_UNSENT_TTL_MS) },
        },
        take: 100,
        select: ROW_SELECT,
      });
      removed += (await this.removeRows(this.prisma, unsent, 'unsent', now)).removed;
      // Sent photos whose message row was hard-deleted (FK SET NULL).
      const orphaned = await this.prisma.messagePhoto.findMany({
        where: { removed_at: null, message_id: null, attached_at: { not: null } },
        take: 100,
        select: ROW_SELECT,
      });
      removed += (await this.removeRows(this.prisma, orphaned, 'message_deleted', now)).removed;
    } catch (err) {
      this.logger.error(`photo sweep failed: ${(err as Error).message}`);
    }
    const erasures = await retryDuePhotoErasures(this.prisma, this.store(), now, this.logger);
    return { erasures, removed };
  }

  // ─── 6. Moderation (report -> review -> action, TGP team) ─────────────────

  /** Open reports on messages that carry photos, oldest first, with 15-minute review links. */
  async reportQueue(now: Date = new Date()) {
    const reports = await this.prisma.messageReport.findMany({
      where: { status: 'pending', message: { photos: { some: {} } } },
      orderBy: { created_at: 'asc' },
      take: 100,
      select: {
        id: true,
        reason: true,
        details: true,
        created_at: true,
        coach_id: true,
        client_id: true,
        message: {
          select: {
            id: true,
            body: true,
            sender_id: true,
            created_at: true,
            photos: { orderBy: { position: 'asc' }, select: ROW_SELECT },
          },
        },
      },
    });
    const keys = reports.flatMap((r) =>
      r.message.photos
        .filter((p) => !p.removed_at && p.status === 'ready' && p.storage_key)
        .map((p) => p.storage_key as string),
    );
    const urls =
      keys.length > 0
        ? await this.store().signRead(keys, PHOTO_REVIEW_URL_TTL_SEC)
        : new Map<string, string>();
    return reports.map((r) => {
      const respondBy = new Date(r.created_at.getTime() + PHOTO_REPORT_RESPOND_MS);
      return {
        report_id: r.id,
        reason: r.reason,
        details: r.details,
        created_at: r.created_at.toISOString(),
        respond_by: respondBy.toISOString(),
        overdue: now.getTime() > respondBy.getTime(),
        coach_id: r.coach_id,
        client_id: r.client_id,
        message: {
          id: r.message.id,
          body: r.message.body,
          sender_id: r.message.sender_id,
          created_at: r.message.created_at.toISOString(),
        },
        photos: r.message.photos.map((p) => {
          const removed = !!p.removed_at || p.status === 'removed';
          const url = !removed && p.storage_key ? (urls.get(p.storage_key) ?? null) : null;
          return {
            id: p.id,
            removed,
            review_url: url,
            review_url_expires_at: url
              ? new Date(now.getTime() + PHOTO_REVIEW_URL_TTL_SEC * 1000).toISOString()
              : null,
            width: p.width,
            height: p.height,
          };
        }),
      };
    });
  }

  /**
   * Act on a report. `remove` erases every photo on the message and closes all
   * open reports on it; `dismiss` closes this report only. Audited.
   */
  async actOnReport(
    reviewerId: string,
    reportId: string,
    action: 'remove' | 'dismiss',
    notes: string | undefined,
    now: Date = new Date(),
  ): Promise<{ report_id: string; action: 'remove' | 'dismiss'; photos_removed: number }> {
    const report = await this.prisma.messageReport.findFirst({
      where: { id: reportId, status: 'pending', message: { photos: { some: {} } } },
      select: {
        id: true,
        message_id: true,
        coach_id: true,
        client_id: true,
        message: { select: { sender_id: true } },
      },
    });
    if (!report) throw photoError('message_photo.report_not_found');
    let photosRemoved = 0;
    if (action === 'remove') {
      const res = await this.eraseForMessages([report.message_id], 'moderation', this.prisma, now);
      photosRemoved = res.removed;
      await this.prisma.messageReport.updateMany({
        where: { message_id: report.message_id, status: 'pending' },
        data: {
          status: 'reviewed',
          action: 'removed',
          reviewed_at: now,
          reviewed_by_admin_id: reviewerId,
        },
      });
      const other =
        report.message.sender_id === report.client_id ? report.coach_id : report.client_id;
      if (other) void this.supabase.broadcastNewMessage(other);
      if (report.message.sender_id)
        void this.supabase.broadcastNewMessage(report.message.sender_id);
    } else {
      const res = await this.prisma.messageReport.updateMany({
        where: { id: report.id, status: 'pending' },
        data: {
          status: 'dismissed',
          action: 'none',
          reviewed_at: now,
          reviewed_by_admin_id: reviewerId,
        },
      });
      if (res.count !== 1) throw photoError('message_photo.report_not_found');
    }
    void this.audit.write({
      action:
        action === 'remove' ? 'message_photo.moderation_removed' : 'message_photo.report_dismissed',
      actorId: reviewerId,
      actorRole: 'owner',
      targetUserId: report.message.sender_id ?? undefined,
      targetType: 'message_report',
      targetId: report.id,
      tenantCoachId: report.coach_id ?? undefined,
      metadata: { photos_removed: photosRemoved, has_notes: !!notes },
    });
    return { report_id: report.id, action, photos_removed: photosRemoved };
  }
}

/**
 * Account deletion (Apple 5.1.1(v)): erase every photo the user sent, every
 * photo in a thread where the user is the client (#608 removes those threads),
 * and everything under their owner folder (unfinished uploads included).
 * Work is recorded durably first: if that fails this throws and the account
 * is not finalized (retried by the next run). Storage faults after that leave
 * open rows that the sweep retries until verified.
 */
export async function eraseMessagePhotosForAccount(
  db: PhotoDb,
  storage: MessagePhotoStorageApi,
  userId: string,
  now: Date,
  logger?: Pick<Logger, 'warn' | 'error'>,
): Promise<{ removed: number; pending: number }> {
  const rows = await db.messagePhoto.findMany({
    where: { OR: [{ uploader_id: userId }, { client_id: userId }] },
    select: { id: true, staging_key: true, storage_key: true, removed_at: true },
  });
  const work = await recordPhotoErasures(
    db,
    [
      ...photoObjectTargets(rows.flatMap((r) => [r.staging_key, r.storage_key])),
      { kind: 'owner_folder', target: userId },
    ],
    'account_deletion',
    now,
  );
  const live = rows.filter((r) => !r.removed_at).map((r) => r.id);
  let removed = 0;
  if (live.length > 0) {
    const res = await db.messagePhoto.updateMany({
      where: { id: { in: live }, removed_at: null },
      data: {
        status: 'removed',
        removed_at: now,
        removed_reason: 'account_deletion',
        processing_at: null,
      },
    });
    removed = res.count;
  }
  const outcome = await attemptPhotoErasures(db, storage, work, logger);
  if (outcome.pending > 0) {
    logger?.warn(
      `account deletion: ${outcome.pending} photo erasure(s) for ${userId} not yet verified; recorded in message_photo_erasures and retried by the photo sweep.`,
    );
  }
  return { removed, pending: outcome.pending };
}
