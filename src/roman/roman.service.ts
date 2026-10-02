/**
 * RomanService — session/message CRUD + the Anthropic streaming wrapper.
 *
 * Tenant isolation: every method scopes by the caller's `userId` in an explicit
 * WHERE clause (ENGINEERING_RULES §1) in ADDITION to the RLS policies on the
 * tables. Defence in depth: a route guard alone is never trusted.
 *
 * Feature gate: every model-touching path re-checks `isRomanChatEnabled()` so
 * the surface cannot drive Anthropic while the flag is OFF, even if a caller
 * reached the service some other way.
 */

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RomanMessage, RomanSession, RomanSurface } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { safeDiagnostic } from '../observability/orm-diagnostics';
import { AiEgressService, AnthropicHandle } from '../ai-egress/ai-egress.service';
import { isAiEgressRefusal } from '../ai-egress/ai-consent-required.exception';
import {
  AiDataSubject,
  clientDataSubject,
  noClientDataSubject,
} from '../ai-egress/ai-egress.types';
import {
  ROMAN_ANTHROPIC_CLIENT,
  ROMAN_MODEL_PHASE_1,
} from './anthropic-client.provider';
import {
  ROMAN_CURSOR_INVALID_MESSAGE,
  ROMAN_DELETE_ALL_BATCH,
  ROMAN_DELETE_ALL_MAX_BATCHES,
  ROMAN_ERASE_ALL_INCOMPLETE_MESSAGE,
  ROMAN_ERASE_INCOMPLETE_MESSAGE,
  ROMAN_ERROR_CURSOR_INVALID,
  ROMAN_ERROR_ERASE_INCOMPLETE,
  ROMAN_ERROR_RATE_LIMIT,
  ROMAN_ERROR_SESSION_NOT_FOUND,
  ROMAN_ERROR_UNAVAILABLE,
  ROMAN_MAX_CONTEXT_TURNS,
  ROMAN_MAX_OUTPUT_TOKENS,
  ROMAN_MESSAGES_DEFAULT_LIMIT,
  ROMAN_MESSAGES_MAX_LIMIT,
  ROMAN_RATE_LIMIT_FREE_PER_DAY,
  ROMAN_RATE_LIMIT_PRO_PER_DAY,
  ROMAN_RATE_LIMIT_WINDOW_MS,
  ROMAN_ERASED_DAY_KEY_PREFIX,
  ROMAN_SESSION_NOT_FOUND_MESSAGE,
  ROMAN_SESSIONS_DEFAULT_LIMIT,
  ROMAN_SESSIONS_MAX_LIMIT,
  ROMAN_ERASE_SWEEP_BATCH,
  ROMAN_ERASE_SWEEP_MAX_BATCHES,
} from './roman.constants';
import { isRomanChatEnabled } from './roman.feature';
import {
  buildRomanSystemPrompt,
  RomanSessionVoiceState,
} from './roman.prompts';

/** Minimal caller identity the service needs (from the authenticated User). */
export interface RomanCaller {
  id: string;
  role: string;
  /** Coach tier when known; drives the rate-limit cap. Defaults to free. */
  tier?: 'free' | 'pro' | 'enterprise' | null;
}

/** One emitted chunk of an assistant stream. */
export interface RomanStreamChunk {
  type: 'delta' | 'done' | 'error';
  /** Text delta for `delta`; full assistant text for `done`. */
  text?: string;
  /** Persisted message id, present on `done`. */
  messageId?: string;
  /** True on `done` when the turn was persisted from a partial stream. */
  interrupted?: boolean;
}

/** Cursor-paginated message page (newest first). */
export interface RomanMessagePage {
  messages: RomanMessage[];
  /** Cursor to pass for the next (older) page, or null when exhausted. */
  nextCursor: string | null;
}

/** One page of the caller's own Roman sessions (newest first). */
export interface RomanSessionPage {
  sessions: RomanSession[];
  /** Pass as `cursor` for the next (older) page; null when exhausted. */
  nextCursor: string | null;
}

/** Outcome of one bounded erasure run over pre-#635 tombstones. */
export interface RomanErasureRunResult {
  /** Sessions erased by this run. */
  erased: number;
  /** Sessions whose erase failed (rolled back; retried by the next run). */
  failed: number;
  /** Sanitized diagnostic of the first failure (no ORM message), or null. */
  firstFailure: string | null;
  /** True when the per-run batch bound ended the run with rows still waiting. */
  boundHit: boolean;
}

/** A deleted session that still holds a calendar day_key (and its content). */
const UNERASED_TOMBSTONE_WHERE: Prisma.RomanSessionWhereInput = {
  deleted_at: { not: null },
  NOT: { day_key: { startsWith: ROMAN_ERASED_DAY_KEY_PREFIX } },
};

/** The coded 404 for a session that is not the caller's (C-635-2). */
export function romanSessionNotFound(): NotFoundException {
  return new NotFoundException({
    code: ROMAN_ERROR_SESSION_NOT_FOUND,
    message: ROMAN_SESSION_NOT_FOUND_MESSAGE,
  });
}

/** An erased shell: deleted and already moved off its calendar day key. */
function isErasedShell(row: { deleted_at: Date | null; day_key: string }): boolean {
  return row.deleted_at !== null && row.day_key.startsWith(ROMAN_ERASED_DAY_KEY_PREFIX);
}

/** Compare-and-set guard for erasing a row in the state it was read in. */
function eraseGuardFor(row: {
  deleted_at: Date | null;
  day_key: string;
}): Prisma.RomanSessionWhereInput {
  return row.deleted_at === null
    ? { deleted_at: null }
    : { deleted_at: { not: null }, day_key: row.day_key };
}

/** UTC calendar day-key (YYYY-MM-DD) used for the open-or-resume idempotency. */
export function dayKeyUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * day_key of an erased session shell: unique per session, never a calendar
 * day, so the shell no longer holds the (user, surface, day) open key.
 */
export function erasedDayKey(sessionId: string): string {
  return `${ROMAN_ERASED_DAY_KEY_PREFIX}${sessionId}`;
}

@Injectable()
export class RomanService {
  private readonly logger = new Logger(RomanService.name);

  constructor(
    private readonly prisma: PrismaService,
    // R2b — box-2 consent gate before every Anthropic request.
    private readonly egress: AiEgressService,
    @Optional()
    @Inject(ROMAN_ANTHROPIC_CLIENT)
    private readonly anthropic: AnthropicHandle | null = null,
  ) {}

  // ─── Sessions ──────────────────────────────────────────────────────────────

  /**
   * Open or resume the caller's session for a surface. Idempotent on
   * (userId, surface, dayKey): a live session for today is resumed; otherwise a
   * new one is created. A deleted session is never resurrected: erasing a chat
   * moves its row off the day key (`erasedDayKey`), so a fresh session can open
   * the same day (Sol B-635-1). A pre-upgrade soft-deleted row that still holds
   * today's key (and its transcript) is erased here first, then the open is
   * retried once (Sol C-635-1).
   */
  async openOrResumeSession(
    caller: RomanCaller,
    surface: RomanSurface,
    subjectContext?: Prisma.InputJsonValue,
  ): Promise<RomanSession> {
    const day_key = dayKeyUtc();
    const liveWhere = { user_id: caller.id, surface, day_key, deleted_at: null };

    const existing = await this.prisma.romanSession.findFirst({ where: liveWhere });
    if (existing) return existing;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.prisma.romanSession.create({
          data: {
            user_id: caller.id,
            surface,
            day_key,
            ...(subjectContext !== undefined
              ? { subject_context_json: subjectContext }
              : {}),
          },
        });
      } catch (err) {
        if (!this.isUniqueViolation(err)) throw err;
        // Another request created today's session first: resume it.
        const row = await this.prisma.romanSession.findFirst({ where: liveWhere });
        if (row) return row;
        // Otherwise a deleted session that was never erased holds the key.
        // Erase it (transcript gone, cap count kept), then open fresh. If
        // that erase fails, the caller gets the open's own coded 503 below,
        // never a delete message for a chat they did not ask to delete.
        if (attempt === 0) {
          try {
            await this.eraseUnerasedHolderOfDayKey(caller.id, surface, day_key);
          } catch (eraseErr) {
            this.logger.error(
              `roman.open_erase_holder_failed surface=${surface}: ${String(safeDiagnostic(eraseErr))}`,
            );
            break;
          }
        }
      }
    }
    throw new ServiceUnavailableException({
      code: ROMAN_ERROR_UNAVAILABLE,
      message: 'Roman could not open a new conversation just now. Wait a moment and open Roman again.',
    });
  }

  /** Load a session the caller owns, or throw 404 (never 403 — avoid ID probing). */
  async getOwnedSession(
    caller: RomanCaller,
    sessionId: string,
  ): Promise<RomanSession> {
    const session = await this.prisma.romanSession.findFirst({
      where: { id: sessionId, user_id: caller.id, deleted_at: null },
    });
    if (!session) {
      throw romanSessionNotFound();
    }
    return session;
  }

  /**
   * The caller's own live Roman chats, newest first (B-635-2), so the app can
   * show past conversations and delete any of them, not only today's. Keyset
   * pagination on (started_at, id): the cursor is the id of the last session
   * already shown and must be one of the caller's own sessions (a live or an
   * erased one, so a chat deleted between two pages does not break the
   * list); anything else is a 400 ROMAN_CURSOR_INVALID, never a lookup of
   * another user's row. Content-free metadata only (no message text).
   */
  async listSessions(
    caller: RomanCaller,
    opts: { cursor?: string; limit?: number; surface?: RomanSurface },
  ): Promise<RomanSessionPage> {
    const take = Math.min(
      Math.max(opts.limit ?? ROMAN_SESSIONS_DEFAULT_LIMIT, 1),
      ROMAN_SESSIONS_MAX_LIMIT,
    );
    const where: Prisma.RomanSessionWhereInput = {
      user_id: caller.id,
      deleted_at: null,
      ...(opts.surface ? { surface: opts.surface } : {}),
    };
    if (opts.cursor) {
      const anchor = await this.prisma.romanSession.findFirst({
        where: { id: opts.cursor, user_id: caller.id },
        select: { id: true, started_at: true },
      });
      if (!anchor) {
        throw new BadRequestException({
          code: ROMAN_ERROR_CURSOR_INVALID,
          message: ROMAN_CURSOR_INVALID_MESSAGE,
        });
      }
      where.OR = [
        { started_at: { lt: anchor.started_at } },
        { started_at: anchor.started_at, id: { lt: anchor.id } },
      ];
    }
    const rows = await this.prisma.romanSession.findMany({
      where,
      orderBy: [{ started_at: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return { sessions: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  /**
   * Delete one chat the caller owns: any day's, not only today's (B-635-2).
   * The conversation is ERASED, not hidden: Roman chats are kept until the
   * client deletes them or their account (owner decision 2026-10-01 20:32,
   * operator ruling OR-110-1; box-2 copy client-ai-v4 and the privacy policy
   * say exactly this). There is no time-based purge.
   *
   * In one transaction, scoped to the caller's own session AND user_id
   * (`eraseSessionInTx`):
   *   1. tombstone the session row (deleted_at, subject context cleared) and
   *      move it off the (user, surface, day) key to `erasedDayKey(id)`, so a
   *      fresh session can open the same day (Sol B-635-1); the row lock makes
   *      a concurrent `appendMessage` either commit first (and be erased by
   *      step 2) or see the tombstone and write nothing;
   *   2. hard-delete every message of the session, then prove none is left
   *      (C-635-3: a silent zero-row delete is a coded 503 and rolls back);
   *   3. keep only a content-free count of the user turns that were inside the
   *      rolling rate-limit window, so deleting a chat never resets the daily
   *      Roman cap (`assertWithinRateLimit` adds it back while the shell is
   *      recent). The shell holds no text; account deletion removes it.
   *
   * Idempotent (C-635-2): deleting a chat that is already erased is a no-op
   * (204), so a retry after a lost response never shows an error. A chat the
   * caller deleted on a pre-#635 build (tombstone still holding content) is
   * erased now. A session that is not the caller's is a coded 404.
   */
  async deleteSession(caller: RomanCaller, sessionId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await this.prisma.romanSession.findFirst({
        where: { id: sessionId, user_id: caller.id },
        select: { id: true, day_key: true, deleted_at: true },
      });
      if (!row) throw romanSessionNotFound();
      if (isErasedShell(row)) return;
      const erased = await this.prisma.$transaction((tx) =>
        this.eraseSessionInTx(
          tx,
          row.id,
          caller.id,
          eraseGuardFor(row),
          row.deleted_at === null ? new Date() : null,
        ),
      );
      if (erased) return;
      // The row changed between the read and the erase (a concurrent delete,
      // or an old machine soft-deleting it during a rolling deploy): read it
      // again once and finish from its new state.
    }
    throw new ServiceUnavailableException({
      code: ROMAN_ERROR_ERASE_INCOMPLETE,
      message: ROMAN_ERASE_INCOMPLETE_MESSAGE,
    });
  }

  /**
   * Delete EVERY Roman chat of the caller, on both surfaces and every day
   * (B-635-2: DELETE /roman/sessions). Each session is erased exactly like a
   * single delete, in its own transaction, so a failure part-way keeps every
   * chat already erased erased and leaves the rest untouched; the request is
   * then a coded 503 ROMAN_ERASE_INCOMPLETE and a retry finishes the job.
   * Also erases the caller's own pre-#635 tombstones that still hold content.
   * Scoped by user_id on every read and write; never touches another user.
   * The daily cap is not reset (the shells keep the content-free count).
   * Returns the number of sessions erased (0 when nothing was left).
   * `opts` overrides the per-request bound (tests only).
   */
  async deleteAllSessions(
    caller: RomanCaller,
    opts: { batch?: number; maxBatches?: number } = {},
  ): Promise<number> {
    const batch = opts.batch ?? ROMAN_DELETE_ALL_BATCH;
    const maxBatches = opts.maxBatches ?? ROMAN_DELETE_ALL_MAX_BATCHES;
    const where: Prisma.RomanSessionWhereInput = {
      user_id: caller.id,
      OR: [{ deleted_at: null }, UNERASED_TOMBSTONE_WHERE],
    };
    let erased = 0;
    for (let b = 0; b < maxBatches; b++) {
      const rows = await this.prisma.romanSession.findMany({
        where,
        select: { id: true, day_key: true, deleted_at: true },
        orderBy: { id: 'asc' },
        take: batch,
      });
      if (rows.length === 0) return erased;
      for (const row of rows) {
        try {
          const done = await this.prisma.$transaction((tx) =>
            this.eraseSessionInTx(
              tx,
              row.id,
              caller.id,
              eraseGuardFor(row),
              row.deleted_at === null ? new Date() : null,
            ),
          );
          if (done) erased++;
        } catch (err) {
          this.logger.error(
            `roman.delete_all_failed session=${row.id} erased_before=${erased}: ${String(safeDiagnostic(err))}`,
          );
          throw new ServiceUnavailableException({
            code: ROMAN_ERROR_ERASE_INCOMPLETE,
            message: ROMAN_ERASE_ALL_INCOMPLETE_MESSAGE,
          });
        }
      }
    }
    const left = await this.prisma.romanSession.count({ where });
    if (left === 0) return erased;
    this.logger.error(`roman.delete_all_bound_hit erased=${erased} left=${left}`);
    throw new ServiceUnavailableException({
      code: ROMAN_ERROR_ERASE_INCOMPLETE,
      message: ROMAN_ERASE_ALL_INCOMPLETE_MESSAGE,
    });
  }

  /**
   * Erase one session inside `tx`. `guard` is the compare-and-set predicate
   * the row must still match (live for a client delete; still unerased for a
   * pre-upgrade tombstone), so concurrent erasers and a racing append are
   * ordered by the row lock and each row is erased exactly once. `deletedAt`
   * stamps a live row; an existing tombstone keeps its deletion time.
   * Returns false when the guard no longer matches (nothing written).
   *
   * C-635-3: the erase is verified, not assumed. After the delete no message
   * of the session may be left; if any is (for example the connection runs
   * under a role that row-level security stops from deleting, which deletes
   * zero rows without an error), it throws a coded 503 so the transaction
   * rolls back and nobody is told the chat is gone while it is not.
   */
  private async eraseSessionInTx(
    tx: Prisma.TransactionClient,
    sessionId: string,
    userId: string,
    guard: Prisma.RomanSessionWhereInput,
    deletedAt: Date | null,
  ): Promise<boolean> {
    const since = new Date(Date.now() - ROMAN_RATE_LIMIT_WINDOW_MS);
    const marked = await tx.romanSession.updateMany({
      where: { ...guard, id: sessionId, user_id: userId },
      data: {
        ...(deletedAt ? { deleted_at: deletedAt } : {}),
        day_key: erasedDayKey(sessionId),
        subject_context_json: Prisma.DbNull,
      },
    });
    if (marked.count === 0) return false;
    const erasedUserTurnsInWindow = await tx.romanMessage.count({
      where: {
        session_id: sessionId,
        user_id: userId,
        role: 'user',
        created_at: { gte: since },
      },
    });
    await tx.romanMessage.deleteMany({
      where: { session_id: sessionId, user_id: userId },
    });
    const left = await tx.romanMessage.count({
      where: { session_id: sessionId, user_id: userId },
    });
    if (left !== 0) {
      this.logger.error(`roman.erase_incomplete session=${sessionId} messages_left=${left}`);
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_ERASE_INCOMPLETE,
        message: ROMAN_ERASE_INCOMPLETE_MESSAGE,
      });
    }
    await tx.romanSession.updateMany({
      where: { id: sessionId, user_id: userId },
      data: { message_count: erasedUserTurnsInWindow },
    });
    return true;
  }

  /**
   * A deleted session that still holds a calendar day_key was soft-deleted
   * before this version (messages and subject context kept). Erase the one
   * holding (user, surface, day) so `openOrResumeSession` can open fresh.
   */
  private async eraseUnerasedHolderOfDayKey(
    userId: string,
    surface: RomanSurface,
    dayKey: string,
  ): Promise<void> {
    const holder = await this.prisma.romanSession.findFirst({
      where: { user_id: userId, surface, day_key: dayKey, deleted_at: { not: null } },
      select: { id: true },
    });
    if (!holder) return;
    await this.prisma.$transaction((tx) =>
      this.eraseSessionInTx(
        tx,
        holder.id,
        userId,
        { deleted_at: { not: null }, day_key: dayKey },
        null,
      ),
    );
  }

  /**
   * Erase every deleted session that still holds content because it was
   * soft-deleted before deletes erased (Sol C-635-1): pre-upgrade rows, and
   * rows an old machine soft-deletes during a rolling deploy. Same erasure as
   * a client delete (transcript and subject context gone, content-free cap
   * count kept). Never touches a live session: this is not a retention purge.
   * Idempotent and safe on several machines at once (per-row compare-and-set);
   * bounded per run. Returns the number of sessions erased.
   * `runUnerasedErasure` is the same run with the failure detail the sweep
   * reports.
   */
  async eraseUnerasedDeletedSessions(
    opts: { batch?: number; maxBatches?: number } = {},
  ): Promise<number> {
    return (await this.runUnerasedErasure(opts)).erased;
  }

  /**
   * One bounded erasure run (see `eraseUnerasedDeletedSessions`). A row whose
   * erase fails is skipped for the rest of the run (its transaction rolled
   * back, so it stays unerased and the next run retries it) and logged with
   * a sanitized diagnostic only (Sol B-635-3: an ORM message can carry query
   * arguments; `safeDiagnostic` keeps just the Prisma code). The result
   * carries the failure count and the first sanitized diagnostic, so
   * RomanErasureSweep can alert Sentry, and whether the per-run bound was hit
   * with rows still waiting.
   */
  async runUnerasedErasure(
    opts: { batch?: number; maxBatches?: number } = {},
  ): Promise<RomanErasureRunResult> {
    const batch = opts.batch ?? ROMAN_ERASE_SWEEP_BATCH;
    const maxBatches = opts.maxBatches ?? ROMAN_ERASE_SWEEP_MAX_BATCHES;
    const failed: string[] = [];
    let firstFailure: string | null = null;
    let erased = 0;
    let boundHit = false;
    for (let b = 0; b < maxBatches; b++) {
      const rows = await this.prisma.romanSession.findMany({
        where: {
          ...UNERASED_TOMBSTONE_WHERE,
          ...(failed.length > 0 ? { id: { notIn: failed } } : {}),
        },
        select: { id: true, user_id: true, day_key: true },
        orderBy: { id: 'asc' },
        take: batch,
      });
      for (const row of rows) {
        try {
          const done = await this.prisma.$transaction((tx) =>
            this.eraseSessionInTx(
              tx,
              row.id,
              row.user_id,
              { deleted_at: { not: null }, day_key: row.day_key },
              null,
            ),
          );
          if (done) erased++;
        } catch (err) {
          failed.push(row.id);
          const diagnostic = String(safeDiagnostic(err));
          firstFailure ??= diagnostic;
          this.logger.error(`roman.erase_deleted_session_failed session=${row.id}: ${diagnostic}`);
        }
      }
      if (rows.length < batch) break;
      if (b === maxBatches - 1) boundHit = true;
    }
    return { erased, failed: failed.length, firstFailure, boundHit };
  }

  /** How many deleted sessions still hold content (0 once the rollout is done). */
  async countUnerasedDeletedSessions(): Promise<number> {
    return this.prisma.romanSession.count({ where: UNERASED_TOMBSTONE_WHERE });
  }

  // ─── Messages ────────────────────────────────────────────────────────────

  /**
   * List a session's messages newest-first with an opaque cursor. The cursor is
   * the created_at+id of the oldest message already seen; we page backwards in
   * time over the (session_id, created_at) index.
   */
  async listMessages(
    caller: RomanCaller,
    sessionId: string,
    opts: { cursor?: string; limit?: number },
  ): Promise<RomanMessagePage> {
    const session = await this.getOwnedSession(caller, sessionId);
    const take = Math.min(
      Math.max(opts.limit ?? ROMAN_MESSAGES_DEFAULT_LIMIT, 1),
      ROMAN_MESSAGES_MAX_LIMIT,
    );

    const where: Prisma.RomanMessageWhereInput = { session_id: session.id };
    // Cursor pagination: fetch one extra to know whether more remain.
    const rows = await this.prisma.romanMessage.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: take + 1,
      ...(opts.cursor
        ? { cursor: { id: opts.cursor }, skip: 1 }
        : {}),
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? page[page.length - 1].id : null;
    return { messages: page, nextCursor };
  }

  /**
   * Append a turn to a session and bump the denormalised bookkeeping
   * (message_count, last_activity_at) in a single transaction so the count
   * never drifts from reality. The bookkeeping update runs first and only
   * matches a live session the caller owns, so a turn (for example a streamed
   * reply finishing after the client deleted the chat) is never written into
   * an erased conversation: it is a 404 and nothing is stored.
   */
  async appendMessage(
    caller: RomanCaller,
    sessionId: string,
    data: {
      role: 'user' | 'roman';
      content: string;
      promptTokens?: number | null;
      completionTokens?: number | null;
      modelId?: string | null;
      interrupted?: boolean;
      parentMessageId?: string | null;
    },
  ): Promise<RomanMessage> {
    return this.prisma.$transaction(async (tx) => {
      const live = await tx.romanSession.updateMany({
        where: { id: sessionId, user_id: caller.id, deleted_at: null },
        data: {
          message_count: { increment: 1 },
          last_activity_at: new Date(),
        },
      });
      if (live.count === 0) {
        throw romanSessionNotFound();
      }
      return tx.romanMessage.create({
        data: {
          session_id: sessionId,
          user_id: caller.id,
          role: data.role,
          content: data.content,
          prompt_tokens: data.promptTokens ?? null,
          completion_tokens: data.completionTokens ?? null,
          model_id: data.modelId ?? null,
          interrupted: data.interrupted ?? false,
          parent_message_id: data.parentMessageId ?? null,
        },
      });
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────────

  /** The user-turn cap for a caller's tier (brief §3). */
  rateLimitCapFor(caller: RomanCaller): number {
    const tier = caller.tier ?? 'free';
    return tier === 'free'
      ? ROMAN_RATE_LIMIT_FREE_PER_DAY
      : ROMAN_RATE_LIMIT_PRO_PER_DAY;
  }

  /**
   * Throw a structured 429 when the caller has exhausted their 24h user-turn
   * budget. Counts `user` turns in the rolling window, plus the content-free
   * count of user turns erased by `deleteSession` from a recently active
   * session (so deleting a chat never resets the cap; conservative: those
   * turns count until the erased session's last activity leaves the window).
   * OWNER is exempt.
   */
  async assertWithinRateLimit(caller: RomanCaller): Promise<void> {
    if (caller.role === 'owner') return;
    const cap = this.rateLimitCapFor(caller);
    const since = new Date(Date.now() - ROMAN_RATE_LIMIT_WINDOW_MS);
    const live = await this.prisma.romanMessage.count({
      where: {
        user_id: caller.id,
        role: 'user',
        created_at: { gte: since },
      },
    });
    // Content-free counts kept by erased shells (deleteSession / the sweep).
    // Summed in the database, so any number of deleted chats counts in full.
    // Unerased pre-upgrade tombstones are excluded: their messages still
    // exist and are already in `live`.
    const erased = await this.prisma.romanSession.aggregate({
      where: {
        user_id: caller.id,
        deleted_at: { not: null },
        day_key: { startsWith: ROMAN_ERASED_DAY_KEY_PREFIX },
        last_activity_at: { gte: since },
        message_count: { gt: 0 },
      },
      _sum: { message_count: true },
      _min: { last_activity_at: true },
    });
    const used = live + (erased._sum.message_count ?? 0);
    if (used >= cap) {
      // Retry-after = time until the oldest counted turn (or erased session's
      // last activity) falls out of the window.
      const oldest = await this.prisma.romanMessage.findFirst({
        where: {
          user_id: caller.id,
          role: 'user',
          created_at: { gte: since },
        },
        orderBy: { created_at: 'asc' },
      });
      const candidates = [
        ...(oldest ? [oldest.created_at.getTime()] : []),
        ...(erased._min.last_activity_at ? [erased._min.last_activity_at.getTime()] : []),
      ];
      const earliest = candidates.length > 0 ? Math.min(...candidates) : null;
      const retryAfterSeconds =
        earliest !== null
          ? Math.max(
              1,
              Math.ceil((earliest + ROMAN_RATE_LIMIT_WINDOW_MS - Date.now()) / 1000),
            )
          : Math.ceil(ROMAN_RATE_LIMIT_WINDOW_MS / 1000);
      throw new HttpException(
        {
          code: ROMAN_ERROR_RATE_LIMIT,
          retryAfterSeconds,
          message:
            'You have reached the Roman conversation limit for now. It will reset shortly.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  // ─── AI consent (R2b) ────────────────────────────────────────────────────

  /**
   * Whose data a Roman turn sends. A client (role `student`) sends their own
   * conversation: their live box-2 grant is required. Coaches and owners
   * chat about their own work; the server loads no client record into the
   * prompt (coach_own_scope).
   */
  dataSubjectFor(caller: RomanCaller): AiDataSubject {
    return caller.role === 'coach' || caller.role === 'owner'
      ? noClientDataSubject('coach_own_scope')
      : clientDataSubject(caller.id, 'client');
  }

  /**
   * Refuse early (403 ai_consent_required) so the controller can answer
   * before it stores the user turn or opens the stream. The stream re-checks
   * immediately before the provider request regardless.
   */
  async assertMayUseAi(caller: RomanCaller): Promise<void> {
    await this.egress.assertMaySend(this.dataSubjectFor(caller), 'anthropic', 'roman.chat');
  }

  // ─── Anthropic streaming ─────────────────────────────────────────────────

  /** Current per-session voice budget surfaced to the model. */
  private voiceStateOf(session: RomanSession): RomanSessionVoiceState {
    return {
      quipsInSession: session.quips_in_session,
      exclamationUsed: session.exclamation_used,
    };
  }

  /**
   * Assemble the tail-slice of prior turns for the API call (brief §3): the
   * most recent ROMAN_MAX_CONTEXT_TURNS messages, oldest-first, mapped to the
   * Anthropic message shape. Phase 1 does NOT summarise older turns.
   */
  async buildContextTurns(
    sessionId: string,
  ): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const recent = await this.prisma.romanMessage.findMany({
      where: { session_id: sessionId },
      orderBy: { created_at: 'desc' },
      take: ROMAN_MAX_CONTEXT_TURNS,
    });
    return recent
      .reverse()
      .map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.content,
      }));
  }

  /**
   * Stream an assistant turn for a freshly-appended user turn. Yields text
   * deltas, then persists the assistant turn (full on clean completion, partial
   * with `interrupted=true` if the caller aborts mid-stream).
   *
   * `signal` lets the controller signal client-disconnect: when aborted, we
   * stop reading, persist what we have with interrupted=true, and emit `done`.
   */
  async *streamAssistantTurn(
    caller: RomanCaller,
    session: RomanSession,
    opts: { signal?: AbortSignal } = {},
  ): AsyncGenerator<RomanStreamChunk> {
    // Defence-in-depth flag re-check (brief §1.6): never drive the model OFF.
    if (!isRomanChatEnabled()) {
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_UNAVAILABLE,
        message: 'Roman is not available right now.',
      });
    }
    if (!this.anthropic) {
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_UNAVAILABLE,
        message: 'Roman is not available right now.',
      });
    }

    const system = buildRomanSystemPrompt({
      surface: session.surface,
      voice: this.voiceStateOf(session),
      subjectContext:
        typeof session.subject_context_json === 'string'
          ? session.subject_context_json
          : null,
    });
    const messages = await this.buildContextTurns(session.id);

    let acc = '';
    let interrupted = false;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;

    // Own AbortController forwarded to the SDK so a client disconnect actively
    // cancels the upstream Anthropic request — otherwise the provider keeps
    // generating tokens after we stop reading (brief §7: no orphan upstream).
    const upstream = new AbortController();
    const forwardAbort = () => upstream.abort();
    if (opts.signal) {
      if (opts.signal.aborted) upstream.abort();
      else opts.signal.addEventListener('abort', forwardAbort, { once: true });
    }

    try {
      // R2b — the grant is read live inside the egress call.
      const stream = await this.egress.anthropicMessagesStream(
        this.anthropic,
        this.dataSubjectFor(caller),
        'roman.chat',
        {
          model: ROMAN_MODEL_PHASE_1,
          max_tokens: ROMAN_MAX_OUTPUT_TOKENS,
          system,
          messages,
        },
        { signal: upstream.signal },
      );

      for await (const event of stream) {
        if (opts.signal?.aborted) {
          interrupted = true;
          break;
        }
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta'
        ) {
          acc += event.delta.text;
          yield { type: 'delta', text: event.delta.text };
        } else if (event.type === 'message_delta') {
          completionTokens =
            event.usage?.output_tokens ?? completionTokens;
        } else if (event.type === 'message_start') {
          promptTokens =
            event.message?.usage?.input_tokens ?? promptTokens;
        }
      }
    } catch (err) {
      // R2b — refused before anything was sent: no Roman turn is stored;
      // the controller turns this into a structured error event.
      if (isAiEgressRefusal(err)) throw err;
      // Mark interrupted, persist whatever we accumulated, and surface a
      // structured error chunk (never a raw SDK string — AGENT_RULES #9).
      interrupted = true;
      this.logger.warn(
        `Roman stream error for session ${session.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      // Cancel the upstream HTTP request and drop the listener regardless of
      // how the loop exited (clean finish, client abort, or SDK error).
      opts.signal?.removeEventListener('abort', forwardAbort);
      upstream.abort();
    }

    // Persist the assistant turn (full or partial). An empty partial (client
    // aborted before any token) still records the interrupted attempt so the
    // transcript is honest.
    const persisted = await this.appendMessage(caller, session.id, {
      role: 'roman',
      content: acc,
      promptTokens,
      completionTokens,
      modelId: ROMAN_MODEL_PHASE_1,
      interrupted,
    });

    yield {
      type: 'done',
      text: acc,
      messageId: persisted.id,
      interrupted,
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    );
  }
}
