import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { CoachMessage } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { objectTargets, recordVoiceErasures } from '../community/voice/voice-erasure';
import { isSignableVoiceKey } from '../community/voice/voice-storage-key';
import { MessagingService, type ResolvedThread } from './messaging.service';
import { messagingError, MESSAGING_ERRORS } from './messaging-errors';

/** Authors may edit a message for 48 hours after sending (Telegram parity). */
export const MESSAGE_EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Authors may delete a message for everyone for 48 hours after sending. */
export const MESSAGE_DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Pinned messages per thread (shared by both participants). */
export const MAX_PINS_PER_THREAD = 10;
/** Pinned conversations per user inbox. */
export const MAX_INBOX_PINS = 5;
/** `muted_until` stored for "mute until I turn it back on". */
export const MUTE_FOREVER_UNTIL = new Date('9999-12-31T23:59:59.000Z');

export const MUTE_DURATIONS = ['1h', '8h', '1d', '7d', 'forever', 'off'] as const;
export type MuteDuration = (typeof MUTE_DURATIONS)[number];

const MUTE_MS: Record<Exclude<MuteDuration, 'forever' | 'off'>, number> = {
  '1h': 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

const VOICE_BUCKET_DEFAULT = 'voice-notes';

/**
 * A3-MSG-CORE — author edit/delete, thread pins, per-thread mute and inbox
 * pins on the canonical 1:1 thread (CoachMessage).
 *
 * Every method takes an already-resolved thread (MessagingService
 * resolveThreadForCoach / resolveThreadForClient), so tenancy is decided once,
 * by the same code that guards reads and sends: a foreign coach gets 404, a
 * coachless client gets 409 NO_COACH_ASSIGNED. Every message lookup is
 * additionally scoped by (coach_id, client_id), so a message id from another
 * thread is indistinguishable from a missing one (404, no existence leak).
 *
 * Blocking parity: edit and pin are refused (403 `messaging.blocked`) when
 * either side blocked the other, exactly like send. Delete is always allowed
 * inside the window — removing your own words is never blocked.
 *
 * Audit: edit, delete, pin and unpin write one AuditLog row each, carrying
 * lengths and ids only (never message text).
 */
@Injectable()
export class MessageActionsService {
  private readonly logger = new Logger(MessageActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly audit: AuditService,
  ) {}

  private async loadInThread(thread: ResolvedThread, messageId: string): Promise<CoachMessage> {
    const row = await this.prisma.coachMessage.findFirst({
      where: { id: messageId, coach_id: thread.coachId, client_id: thread.clientId },
    });
    if (!row) {
      throw messagingError(HttpStatus.NOT_FOUND, MESSAGING_ERRORS.MESSAGE_NOT_FOUND);
    }
    // A message authored by someone the caller blocked is not addressable by
    // the caller (it is filtered out of their thread read).
    if (row.sender_id && row.sender_id !== thread.actorId) {
      const blocked = await this.messaging.blockedIdsFor(thread.actorId);
      if (blocked.includes(row.sender_id)) {
        throw messagingError(HttpStatus.NOT_FOUND, MESSAGING_ERRORS.MESSAGE_NOT_FOUND);
      }
    }
    return row;
  }

  private async assertNotBlocked(thread: ResolvedThread): Promise<void> {
    if (await this.messaging.isEitherSideBlocked(thread.coachId, thread.clientId)) {
      throw messagingError(HttpStatus.FORBIDDEN, MESSAGING_ERRORS.BLOCKED);
    }
  }

  private auditBase(thread: ResolvedThread, messageId: string) {
    return {
      actorId: thread.actorId,
      actorRole: thread.actorSide === 'coach' ? 'coach' : 'student',
      targetUserId: thread.otherPartyId,
      targetType: 'coach_message',
      targetId: messageId,
      tenantCoachId: thread.coachId,
    };
  }

  private serialize(row: CoachMessage) {
    return this.messaging.serializeMessage(row, new Set<string>());
  }

  // ---- edit ----

  async edit(thread: ResolvedThread, messageId: string, rawBody: string) {
    const row = await this.loadInThread(thread, messageId);
    if (row.sender_id !== thread.actorId) {
      throw messagingError(HttpStatus.FORBIDDEN, MESSAGING_ERRORS.NOT_AUTHOR);
    }
    if (row.deleted_at) {
      throw messagingError(HttpStatus.CONFLICT, MESSAGING_ERRORS.MESSAGE_DELETED);
    }
    if (Date.now() - row.created_at.getTime() > MESSAGE_EDIT_WINDOW_MS) {
      throw messagingError(HttpStatus.CONFLICT, MESSAGING_ERRORS.EDIT_WINDOW_CLOSED);
    }
    const body = (rawBody ?? '').trim();
    if (!body) {
      throw messagingError(
        HttpStatus.BAD_REQUEST,
        row.body === null && row.voice_url
          ? MESSAGING_ERRORS.NOT_EDITABLE
          : MESSAGING_ERRORS.EDIT_EMPTY,
      );
    }
    await this.assertNotBlocked(thread);
    if (body === row.body) return this.serialize(row);

    const editedAt = new Date();
    // Conditional write: a concurrent delete wins (0 rows → 409 deleted).
    const res = await this.prisma.coachMessage.updateMany({
      where: { id: row.id, deleted_at: null },
      data: { body, edited_at: editedAt },
    });
    if (res.count === 0) {
      throw messagingError(HttpStatus.CONFLICT, MESSAGING_ERRORS.MESSAGE_DELETED);
    }
    void this.audit.write({
      action: 'messaging.edited',
      ...this.auditBase(thread, row.id),
      metadata: {
        body_length_before: row.body?.length ?? 0,
        body_length_after: body.length,
        age_ms: editedAt.getTime() - row.created_at.getTime(),
      },
    });
    this.messaging.notifyThreadUpdated(thread, 'edited', row.id, {
      coachContentChanged: thread.actorSide === 'coach',
    });
    return this.serialize({ ...row, body, edited_at: editedAt });
  }

  // ---- delete (tombstone) ----

  /**
   * Delete for everyone. Idempotent: deleting a tombstone returns it again.
   * Content columns (body, voice) are erased in the SAME transaction that
   * records durable erasure work for the voice object (community voice
   * erasure ledger, retried by its cron until storage confirms removal), and
   * the message is unpinned. The row stays so thread order, read state and
   * reply links remain stable; replies show "deleted" for the quote.
   */
  async delete(thread: ResolvedThread, messageId: string) {
    const row = await this.loadInThread(thread, messageId);
    if (row.sender_id !== thread.actorId) {
      throw messagingError(HttpStatus.FORBIDDEN, MESSAGING_ERRORS.NOT_AUTHOR);
    }
    if (row.deleted_at) return this.serialize(row);
    if (Date.now() - row.created_at.getTime() > MESSAGE_DELETE_WINDOW_MS) {
      throw messagingError(HttpStatus.CONFLICT, MESSAGING_ERRORS.DELETE_WINDOW_CLOSED);
    }

    const deletedAt = new Date();
    const voiceKey = row.voice_url ? this.voiceKeyFrom(row.voice_url, thread.actorId) : null;
    const count = await this.prisma.$transaction(async (tx) => {
      const res = await tx.coachMessage.updateMany({
        where: { id: row.id, deleted_at: null },
        data: {
          body: null,
          voice_url: null,
          voice_duration_sec: null,
          voice_size_bytes: null,
          voice_content_type: null,
          deleted_at: deletedAt,
          deleted_by_id: thread.actorId,
          pinned_at: null,
          pinned_by_id: null,
        },
      });
      if (res.count > 0 && voiceKey) {
        await recordVoiceErasures(tx, objectTargets([voiceKey]), 'author_delete', deletedAt);
      }
      return res.count;
    });
    if (count === 0) {
      // Lost a race with a concurrent delete of the same message: idempotent.
      const now = await this.loadInThread(thread, messageId);
      return this.serialize(now);
    }
    if (row.voice_url && !voiceKey) {
      this.logger.warn(
        `coach_message ${row.id}: voice URL is not a signable key; columns erased, object left for the storage sweep`,
      );
    }
    void this.audit.write({
      action: 'messaging.deleted',
      ...this.auditBase(thread, row.id),
      metadata: {
        message_kind: row.voice_url ? 'voice' : 'text',
        body_length: row.body?.length ?? 0,
        was_pinned: row.pinned_at !== null,
        voice_erasure_recorded: voiceKey !== null,
        age_ms: deletedAt.getTime() - row.created_at.getTime(),
      },
    });
    this.messaging.notifyThreadUpdated(thread, 'deleted', row.id, {
      coachContentChanged: thread.actorSide === 'coach',
    });
    return this.serialize({
      ...row,
      body: null,
      voice_url: null,
      voice_duration_sec: null,
      voice_size_bytes: null,
      voice_content_type: null,
      deleted_at: deletedAt,
      deleted_by_id: thread.actorId,
      pinned_at: null,
      pinned_by_id: null,
    });
  }

  /**
   * Bucket-relative object key from a stored voice URL
   * (`.../<bucket>/<senderId>/<file>`), only when it is a canonical signable
   * key inside the author's own folder. Anything else returns null and is
   * never sent to storage.
   */
  private voiceKeyFrom(url: string, senderId: string): string | null {
    const bucket = (process.env.SUPABASE_VOICE_BUCKET ?? '').trim() || VOICE_BUCKET_DEFAULT;
    let path: string;
    try {
      path = decodeURIComponent(new URL(url).pathname);
    } catch {
      return null;
    }
    const marker = `/${bucket}/`;
    const at = path.indexOf(marker);
    if (at < 0) return null;
    const key = path.slice(at + marker.length);
    return isSignableVoiceKey(bucket, key, senderId) ? key : null;
  }

  // ---- message pins (thread-shared) ----

  async pin(thread: ResolvedThread, messageId: string) {
    const row = await this.loadInThread(thread, messageId);
    if (row.deleted_at) {
      throw messagingError(HttpStatus.CONFLICT, MESSAGING_ERRORS.MESSAGE_DELETED);
    }
    if (row.pinned_at) return this.serialize(row);
    await this.assertNotBlocked(thread);
    const pinnedAt = new Date();
    const pinned = await this.prisma.$transaction(async (tx) => {
      // Serialize pins per thread so two concurrent pins cannot both pass
      // the cap check (transaction-scoped advisory lock on the thread key).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`coach_message_pins:${thread.coachId}:${thread.clientId}`}))`;
      const current = await tx.coachMessage.count({
        where: {
          coach_id: thread.coachId,
          client_id: thread.clientId,
          pinned_at: { not: null },
          deleted_at: null,
        },
      });
      if (current >= MAX_PINS_PER_THREAD) {
        throw messagingError(HttpStatus.CONFLICT, MESSAGING_ERRORS.PIN_LIMIT_REACHED, {
          max_pins: MAX_PINS_PER_THREAD,
        });
      }
      const res = await tx.coachMessage.updateMany({
        where: { id: row.id, deleted_at: null, pinned_at: null },
        data: { pinned_at: pinnedAt, pinned_by_id: thread.actorId },
      });
      return res.count > 0;
    });
    if (!pinned) {
      return this.serialize(await this.loadInThread(thread, messageId));
    }
    void this.audit.write({
      action: 'messaging.pinned',
      ...this.auditBase(thread, row.id),
      metadata: { pinned_by_side: thread.actorSide },
    });
    this.messaging.notifyThreadUpdated(thread, 'pinned', row.id);
    return this.serialize({ ...row, pinned_at: pinnedAt, pinned_by_id: thread.actorId });
  }

  async unpin(thread: ResolvedThread, messageId: string) {
    const row = await this.loadInThread(thread, messageId);
    if (!row.pinned_at) return this.serialize(row);
    const res = await this.prisma.coachMessage.updateMany({
      where: { id: row.id, pinned_at: { not: null } },
      data: { pinned_at: null, pinned_by_id: null },
    });
    if (res.count > 0) {
      void this.audit.write({
        action: 'messaging.unpinned',
        ...this.auditBase(thread, row.id),
        metadata: { unpinned_by_side: thread.actorSide },
      });
      this.messaging.notifyThreadUpdated(thread, 'unpinned', row.id);
    }
    return this.serialize({ ...row, pinned_at: null, pinned_by_id: null });
  }

  /** Pins bar: live pinned messages, newest pin first, blocked authors hidden. */
  async listPins(thread: ResolvedThread) {
    const rows = await this.prisma.coachMessage.findMany({
      where: {
        coach_id: thread.coachId,
        client_id: thread.clientId,
        pinned_at: { not: null },
        deleted_at: null,
      },
      orderBy: [{ pinned_at: 'desc' }, { id: 'desc' }],
      take: MAX_PINS_PER_THREAD,
    });
    const blocked = new Set(await this.messaging.blockedIdsFor(thread.actorId));
    const visible = rows.filter(
      (r) => !(r.sender_id && r.sender_id !== thread.actorId && blocked.has(r.sender_id)),
    );
    return { items: visible.map((r) => this.messaging.serializeMessage(r, blocked)) };
  }

  // ---- per-user thread preferences ----

  private stateKey(thread: ResolvedThread) {
    return {
      CoachThreadState_user_thread_key: {
        user_id: thread.actorId,
        coach_id: thread.coachId,
        client_id: thread.clientId,
      },
    };
  }

  /** Mute push for this thread (or unmute with 'off'). Private to the caller. */
  async setMute(thread: ResolvedThread, duration: MuteDuration) {
    const mutedUntil =
      duration === 'off'
        ? null
        : duration === 'forever'
          ? MUTE_FOREVER_UNTIL
          : new Date(Date.now() + MUTE_MS[duration]);
    const state = await this.prisma.coachThreadState.upsert({
      where: this.stateKey(thread),
      create: {
        user_id: thread.actorId,
        coach_id: thread.coachId,
        client_id: thread.clientId,
        muted_until: mutedUntil,
      },
      update: { muted_until: mutedUntil },
      select: { muted_until: true, pinned_at: true },
    });
    return this.stateView(state);
  }

  /** Pin or unpin this conversation at the top of the caller's own inbox. */
  async setInboxPin(thread: ResolvedThread, pinned: boolean) {
    if (!pinned) {
      const state = await this.prisma.coachThreadState.upsert({
        where: this.stateKey(thread),
        create: {
          user_id: thread.actorId,
          coach_id: thread.coachId,
          client_id: thread.clientId,
        },
        update: { pinned_at: null },
        select: { muted_until: true, pinned_at: true },
      });
      return this.stateView(state);
    }
    const state = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`coach_inbox_pins:${thread.actorId}`}))`;
      const existing = await tx.coachThreadState.findUnique({
        where: this.stateKey(thread),
        select: { muted_until: true, pinned_at: true },
      });
      if (existing?.pinned_at) return existing;
      const count = await tx.coachThreadState.count({
        where: { user_id: thread.actorId, pinned_at: { not: null } },
      });
      if (count >= MAX_INBOX_PINS) {
        throw messagingError(HttpStatus.CONFLICT, MESSAGING_ERRORS.INBOX_PIN_LIMIT_REACHED, {
          max_pins: MAX_INBOX_PINS,
        });
      }
      return tx.coachThreadState.upsert({
        where: this.stateKey(thread),
        create: {
          user_id: thread.actorId,
          coach_id: thread.coachId,
          client_id: thread.clientId,
          pinned_at: new Date(),
        },
        update: { pinned_at: new Date() },
        select: { muted_until: true, pinned_at: true },
      });
    });
    return this.stateView(state);
  }

  private stateView(state: { muted_until: Date | null; pinned_at: Date | null }) {
    const muted = !!state.muted_until && state.muted_until.getTime() > Date.now();
    return {
      muted,
      muted_until: muted && state.muted_until ? state.muted_until.toISOString() : null,
      pinned: state.pinned_at !== null,
    };
  }
}
