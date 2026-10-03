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
import * as Sentry from '@sentry/node';
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
  ROMAN_ERASE_UNCONFIRMED_MESSAGE,
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
import { randomUUID } from 'node:crypto';
import {
  ROMAN_CAPACITY_REACHED_MESSAGE,
  ROMAN_CAPACITY_UNKNOWN_MESSAGE,
  ROMAN_DAILY_COST_CAP_USD_DEFAULT,
  ROMAN_ERROR_CAPACITY_REACHED,
  ROMAN_ERROR_MODEL_UNAVAILABLE,
  ROMAN_LEDGER_CAPABILITY,
  ROMAN_MODEL_UNAVAILABLE_MESSAGE,
  ROMAN_NOT_CONFIGURED_MESSAGE,
  ROMAN_PRICE_PER_MTOK,
  romanRateLimitMessage,
} from './roman.constants';
import { PROMPT_VERSION } from './guardrails/roman-guardrail.contract';
import {
  classifySafety,
  routerHintFor,
  ROMAN_SAFETY_ROUTER_MODEL_ID,
  ROMAN_SAFETY_TEMPLATES,
} from './guardrails/safety-router';
import { postCheckRomanReply, type PostCheckContext } from './guardrails/roman-post-check';
import { RomanClientContextService } from './context/roman-client-context.service';
import { AuditService } from '../audit/audit.service';
import type {
  RomanClientContext,
  RomanClientContextBundle,
} from './context/roman-client-context.types';
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
    // Per-turn grounding (client surface). RomanModule always provides it; a
    // missing builder means degraded mode (no personal facts), never silence.
    @Optional()
    private readonly clientContext: RomanClientContextService | null = null,
    // Content-free audit row for every emergency / self-harm short-circuit
    // (ids and the route class only, never the message text).
    @Optional()
    private readonly audit: AuditService | null = null,
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
    // Sol B-635-4: every failure of the whole operation leaves here coded.
    // Coded HttpExceptions (404 not found, the verified-erase 503 that rolled
    // its transaction back) pass through unchanged; anything else (a failed
    // read, a failed or unacknowledged transaction) is reported with a
    // sanitized diagnostic and answered 503 ROMAN_ERASE_INCOMPLETE. A failure
    // before any write says the chat was not changed; a failure of the erase
    // transaction itself cannot prove a rollback, so it says the delete could
    // not be confirmed. Deleting again is always safe (idempotent).
    const progress = { stage: 'read' as 'read' | 'erase' };
    try {
      await this.deleteSessionOnce(caller, sessionId, progress);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw this.eraseFailure(err, `roman.delete_failed session=${sessionId} stage=${progress.stage}`, {
        op: 'delete_one',
        stage: progress.stage,
        message:
          progress.stage === 'read' ? ROMAN_ERASE_INCOMPLETE_MESSAGE : ROMAN_ERASE_UNCONFIRMED_MESSAGE,
      });
    }
  }

  private async deleteSessionOnce(
    caller: RomanCaller,
    sessionId: string,
    progress: { stage: 'read' | 'erase' },
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      progress.stage = 'read';
      const row = await this.prisma.romanSession.findFirst({
        where: { id: sessionId, user_id: caller.id },
        select: { id: true, day_key: true, deleted_at: true },
      });
      if (!row) throw romanSessionNotFound();
      if (isErasedShell(row)) return;
      progress.stage = 'erase';
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
    // Sol B-635-4: the batch reads and the final count are covered too, not
    // only the per-row transactions. Every chat already erased stays erased
    // (each row commits on its own), so the coded 503 always means "retry to
    // delete the rest", whatever step failed.
    const progress = { erased: 0, stage: 'read' as 'read' | 'erase' | 'count' };
    try {
      return await this.deleteAllSessionsOnce(caller, opts, progress);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw this.eraseFailure(
        err,
        `roman.delete_all_failed stage=${progress.stage} erased_before=${progress.erased}`,
        { op: 'delete_all', stage: progress.stage, message: ROMAN_ERASE_ALL_INCOMPLETE_MESSAGE },
      );
    }
  }

  /**
   * Log + report the sanitized diagnostic of an unexpected delete failure
   * (never message text, never the raw ORM error) and return the coded,
   * actionable 503. No `cause` is attached: the global filter must send the
   * coded body, not its generic ORM-boundary envelope.
   */
  private eraseFailure(
    err: unknown,
    logLine: string,
    meta: { op: 'delete_one' | 'delete_all'; stage: string; message: string },
  ): ServiceUnavailableException {
    const diagnostic = safeDiagnostic(err);
    this.logger.error(`${logLine}: ${String(diagnostic)}`);
    Sentry.captureException(diagnostic, {
      tags: { feature: 'roman', op: `roman.${meta.op}`, stage: meta.stage },
    });
    return new ServiceUnavailableException({
      code: ROMAN_ERROR_ERASE_INCOMPLETE,
      message: meta.message,
    });
  }

  private async deleteAllSessionsOnce(
    caller: RomanCaller,
    opts: { batch?: number; maxBatches?: number },
    progress: { erased: number; stage: 'read' | 'erase' | 'count' },
  ): Promise<number> {
    const batch = opts.batch ?? ROMAN_DELETE_ALL_BATCH;
    const maxBatches = opts.maxBatches ?? ROMAN_DELETE_ALL_MAX_BATCHES;
    const where: Prisma.RomanSessionWhereInput = {
      user_id: caller.id,
      OR: [{ deleted_at: null }, UNERASED_TOMBSTONE_WHERE],
    };
    let erased = 0;
    for (let b = 0; b < maxBatches; b++) {
      progress.stage = 'read';
      const rows = await this.prisma.romanSession.findMany({
        where,
        select: { id: true, day_key: true, deleted_at: true },
        orderBy: { id: 'asc' },
        take: batch,
      });
      if (rows.length === 0) return erased;
      progress.stage = 'erase';
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
          if (done) {
            erased++;
            progress.erased = erased;
          }
        } catch (err) {
          // Any per-row failure (including the verified-erase 503, whose
          // single-chat wording does not fit here) becomes the delete-all
          // copy: earlier rows stay erased, a retry finishes the rest.
          throw this.eraseFailure(
            err,
            `roman.delete_all_failed session=${row.id} erased_before=${erased}`,
            { op: 'delete_all', stage: 'erase', message: ROMAN_ERASE_ALL_INCOMPLETE_MESSAGE },
          );
        }
      }
    }
    progress.stage = 'count';
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
          message: romanRateLimitMessage(retryAfterSeconds),
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
   * One Roman reply to the freshly stored user turn (OR-113-2 launch path).
   *
   *  1. Feature flag + provider key (coded 503s, never a raw SDK error).
   *  2. Deterministic SafetyRouter on the normalised user text (A-R4-1).
   *     Emergency / self-harm answer with fixed templates: no model call, no
   *     client data loaded, nothing sent anywhere.
   *  3. Box-2 consent via the single egress gate BEFORE any client data is
   *     read (B-R8-1); the gate re-reads the grant again inside the send.
   *  4. Daily spend cap: reserve the worst-case cost first, fail closed.
   *  5. ONE immutable grounding bundle for the turn (B-R8-2): the same object
   *     feeds the prompt, the post-check and the ledger's context hash. A
   *     build failure is logged by class/code only and the turn runs in the
   *     explicit degraded mode (A-R3-1).
   *  6. The model reply is BUFFERED, post-checked, and only then persisted,
   *     once, and emitted (A-R4-4): no unvalidated text is ever stored,
   *     streamed, or readable through GET messages, on success, abort or
   *     error alike.
   */
  async *streamAssistantTurn(
    caller: RomanCaller,
    session: RomanSession,
    opts: { signal?: AbortSignal; userMessage?: string } = {},
  ): AsyncGenerator<RomanStreamChunk> {
    // Defence-in-depth flag re-check (brief §1.6): never drive the model OFF.
    if (!isRomanChatEnabled()) {
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_UNAVAILABLE,
        message: 'Roman is switched off at the moment. Your coach is in Messages any time.',
      });
    }
    if (!this.anthropic) {
      Sentry.captureMessage('roman.provider_not_configured', {
        level: 'error',
        tags: { feature: 'roman', op: 'roman.turn' },
      });
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_UNAVAILABLE,
        message: ROMAN_NOT_CONFIGURED_MESSAGE,
      });
    }

    const userMessage = opts.userMessage ?? (await this.latestUserMessage(caller, session.id));
    const route = classifySafety(userMessage);

    if (route.short_circuit && (route.class === 'emergency' || route.class === 'self_harm')) {
      const text = ROMAN_SAFETY_TEMPLATES[route.class];
      const persisted = await this.appendMessage(caller, session.id, {
        role: 'roman',
        content: text,
        modelId: ROMAN_SAFETY_ROUTER_MODEL_ID,
        interrupted: false,
      });
      this.logger.warn(
        `roman.turn session=${session.id} prompt_version=${PROMPT_VERSION} router=${route.class} model_call=false`,
      );
      await this.audit?.write({
        action: route.class === 'emergency' ? 'roman.safety_emergency' : 'roman.safety_self_harm',
        actorId: caller.id,
        actorRole: caller.role,
        targetType: 'RomanSession',
        targetId: session.id,
      });
      yield { type: 'delta', text };
      yield { type: 'done', text, messageId: persisted.id, interrupted: false };
      return;
    }

    const subject = this.dataSubjectFor(caller);
    // B-R8-1: refuse before any client data is read or any spend reserved.
    await this.egress.assertMaySend(subject, 'anthropic', 'roman.chat');

    const grounded = session.surface === 'client' && caller.role === 'student';
    const reservation = await this.reserveDailySpend(caller);

    let bundle: RomanClientContextBundle | null = null;
    let contextUnavailable = false;
    if (grounded) {
      bundle = await this.loadTurnBundle(caller);
      contextUnavailable = bundle === null;
    }

    const system = buildRomanSystemPrompt({
      surface: session.surface,
      voice: this.voiceStateOf(session),
      subjectContext:
        typeof session.subject_context_json === 'string' ? session.subject_context_json : null,
      routerHint: routerHintFor(route.class),
      clientData: bundle?.rendered ?? null,
      clientDataUnavailable: contextUnavailable,
    });
    const messages = await this.buildContextTurns(session.id);

    let acc = '';
    let interrupted = false;
    let failed = false;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;

    // Own AbortController forwarded to the SDK so a client disconnect actively
    // cancels the upstream request (no orphan generation).
    const upstream = new AbortController();
    const forwardAbort = () => upstream.abort();
    if (opts.signal) {
      if (opts.signal.aborted) upstream.abort();
      else opts.signal.addEventListener('abort', forwardAbort, { once: true });
    }

    try {
      const stream = await this.egress.anthropicMessagesStream(
        this.anthropic,
        subject,
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
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          acc += event.delta.text;
        } else if (event.type === 'message_delta') {
          completionTokens = event.usage?.output_tokens ?? completionTokens;
        } else if (event.type === 'message_start') {
          promptTokens = event.message?.usage?.input_tokens ?? promptTokens;
        }
      }
    } catch (err) {
      if (isAiEgressRefusal(err)) {
        await this.settleSpend(reservation, 0, 0, { outcome: 'refused' });
        throw err;
      }
      interrupted = true;
      failed = !opts.signal?.aborted;
      this.logger.warn(
        `roman.stream_error session=${session.id}: ${String(safeDiagnostic(err))}`,
      );
    } finally {
      opts.signal?.removeEventListener('abort', forwardAbort);
      upstream.abort();
    }

    // Model failure before any text: honest, specific, coded. The user turn
    // stays stored; nothing is invented for Roman.
    if (failed && acc.trim().length === 0) {
      await this.settleSpend(reservation, promptTokens ?? 0, completionTokens ?? 0, {
        outcome: 'model_error',
      });
      Sentry.captureMessage('roman.model_unavailable', {
        level: 'warning',
        tags: { feature: 'roman', op: 'roman.turn' },
      });
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_MODEL_UNAVAILABLE,
        message: ROMAN_MODEL_UNAVAILABLE_MESSAGE,
      });
    }

    const checked = postCheckRomanReply(acc, {
      routerClass: route.class,
      context: bundle ? postCheckContextOf(bundle.context) : null,
      contextUnavailable: grounded && contextUnavailable,
      exclamationAllowed: !session.exclamation_used,
    });

    // Persisted ONCE, already checked: what is stored is what the client sees.
    const persisted = await this.appendMessage(caller, session.id, {
      role: 'roman',
      content: checked.text,
      promptTokens,
      completionTokens,
      modelId: ROMAN_MODEL_PHASE_1,
      interrupted,
    });
    await this.settleSpend(reservation, promptTokens ?? 0, completionTokens ?? 0, {
      outcome: interrupted ? 'interrupted' : 'ok',
      router_class: route.class,
      guardrails_applied: checked.guardrails_applied,
      prompt_version: PROMPT_VERSION,
      context_version: bundle?.context.version ?? null,
      context_hash: bundle?.hash ?? null,
      context_unavailable: grounded && contextUnavailable,
    });
    this.logger.log(
      `roman.turn session=${session.id} prompt_version=${PROMPT_VERSION} router=${route.class} model_call=true rewritten=${checked.rewritten} guardrails_applied=${JSON.stringify(checked.guardrails_applied)} context=${bundle ? bundle.hash.slice(0, 12) : grounded ? 'unavailable' : 'none'}`,
    );

    if (checked.text.length > 0) yield { type: 'delta', text: checked.text };
    yield { type: 'done', text: checked.text, messageId: persisted.id, interrupted };
  }

  /** Newest user turn of the caller's session (the controller stores it first). */
  private async latestUserMessage(caller: RomanCaller, sessionId: string): Promise<string> {
    const row = await this.prisma.romanMessage.findFirst({
      where: { session_id: sessionId, user_id: caller.id, role: 'user' },
      orderBy: { created_at: 'desc' },
      select: { content: true },
    });
    return row?.content ?? '';
  }

  /**
   * B-R8-2 / A-R3-1: build the turn's grounding bundle exactly once. A failure
   * is logged with the sanitised diagnostic only (never err.message, which can
   * carry query arguments) and reported to Sentry; the caller then runs the
   * turn in degraded mode.
   */
  private async loadTurnBundle(caller: RomanCaller): Promise<RomanClientContextBundle | null> {
    if (!this.clientContext) {
      this.logger.error('roman.context_builder_missing');
      return null;
    }
    try {
      return await this.clientContext.getBundle({ id: caller.id, role: caller.role });
    } catch (err) {
      const diagnostic = safeDiagnostic(err);
      this.logger.error(`roman.context_failed: ${String(diagnostic)}`);
      Sentry.captureException(diagnostic, {
        tags: { feature: 'roman', op: 'roman.context' },
      });
      return null;
    }
  }

  // ─── Daily spend cap (OR-113-2) ──────────────────────────────────────────

  /** The configured cap; an invalid value falls back to the default (never "no cap"). */
  dailyCostCapUsd(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.ROMAN_DAILY_COST_CAP_USD;
    if (raw === undefined || raw.trim() === '') return ROMAN_DAILY_COST_CAP_USD_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : ROMAN_DAILY_COST_CAP_USD_DEFAULT;
  }

  static costUsd(inputTokens: number, outputTokens: number): number {
    return (
      (inputTokens * ROMAN_PRICE_PER_MTOK.input + outputTokens * ROMAN_PRICE_PER_MTOK.output) /
      1_000_000
    );
  }

  /**
   * Read-only capacity check the controller runs BEFORE storing the user
   * turn, so a client who hits the daily cap is told so without leaving an
   * unanswered message behind. Same fail-closed rule as the reservation.
   */
  async assertDailyCapacity(): Promise<void> {
    const now = new Date();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    let used: number;
    try {
      const agg = await this.prisma.aiRequestAudit.aggregate({
        where: { capability: ROMAN_LEDGER_CAPABILITY, created_at: { gte: dayStart } },
        _sum: { prompt_token_estimate: true, response_token_estimate: true },
      });
      used = RomanService.costUsd(
        agg._sum.prompt_token_estimate ?? 0,
        agg._sum.response_token_estimate ?? 0,
      );
    } catch (err) {
      const diagnostic = safeDiagnostic(err);
      this.logger.error(`roman.spend_ledger_failed: ${String(diagnostic)}`);
      Sentry.captureException(diagnostic, { tags: { feature: 'roman', op: 'roman.spend' } });
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_UNAVAILABLE,
        message: ROMAN_CAPACITY_UNKNOWN_MESSAGE,
      });
    }
    if (used >= this.dailyCostCapUsd()) {
      const tomorrow = dayStart.getTime() + 24 * 60 * 60 * 1000;
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_CAPACITY_REACHED,
        message: ROMAN_CAPACITY_REACHED_MESSAGE,
        retryAfterSeconds: Math.max(60, Math.ceil((tomorrow - now.getTime()) / 1000)),
      });
    }
  }

  /**
   * Reserve this turn's worst-case cost in the content-free ledger, then
   * check today's total INCLUDING the reservation. Over the cap: the
   * reservation is released and the turn is a coded 503 with a specific
   * message. Any ledger failure: coded 503, no provider call (fail closed).
   */
  async reserveDailySpend(caller: RomanCaller): Promise<string> {
    const requestId = `roman:${randomUUID()}`;
    const cap = this.dailyCostCapUsd();
    const now = new Date();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const promptReserve = ROMAN_MAX_CONTEXT_TURNS * 600 + 6000;
    let used: number;
    try {
      await this.prisma.aiRequestAudit.create({
        data: {
          request_id: requestId,
          capability: ROMAN_LEDGER_CAPABILITY,
          requester_id: caller.id,
          requester_role: caller.role,
          subject_user_id: caller.role === 'student' ? caller.id : null,
          provider: 'anthropic',
          model: ROMAN_MODEL_PHASE_1,
          enabled: true,
          prompt_token_estimate: promptReserve,
          response_token_estimate: ROMAN_MAX_OUTPUT_TOKENS,
          metadata: { state: 'reserved' },
        },
      });
      const agg = await this.prisma.aiRequestAudit.aggregate({
        where: { capability: ROMAN_LEDGER_CAPABILITY, created_at: { gte: dayStart } },
        _sum: { prompt_token_estimate: true, response_token_estimate: true },
      });
      used = RomanService.costUsd(
        agg._sum.prompt_token_estimate ?? 0,
        agg._sum.response_token_estimate ?? 0,
      );
    } catch (err) {
      const diagnostic = safeDiagnostic(err);
      this.logger.error(`roman.spend_ledger_failed: ${String(diagnostic)}`);
      Sentry.captureException(diagnostic, { tags: { feature: 'roman', op: 'roman.spend' } });
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_UNAVAILABLE,
        message: ROMAN_CAPACITY_UNKNOWN_MESSAGE,
      });
    }
    if (used > cap) {
      await this.settleSpend(requestId, 0, 0, { outcome: 'over_cap' });
      this.logger.warn(`roman.capacity_reached cap_usd=${cap}`);
      Sentry.captureMessage('roman.capacity_reached', {
        level: 'warning',
        tags: { feature: 'roman', op: 'roman.spend' },
      });
      const tomorrow = dayStart.getTime() + 24 * 60 * 60 * 1000;
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_CAPACITY_REACHED,
        message: ROMAN_CAPACITY_REACHED_MESSAGE,
        retryAfterSeconds: Math.max(60, Math.ceil((tomorrow - now.getTime()) / 1000)),
      });
    }
    return requestId;
  }

  /**
   * Replace the reservation with the actual tokens and content-free
   * provenance (router class, guardrails applied, prompt / context version,
   * context hash; never message text). A failed settle leaves the
   * worst-case reservation in place, which only over-counts.
   */
  async settleSpend(
    requestId: string,
    inputTokens: number,
    outputTokens: number,
    metadata: Record<string, string | number | boolean | string[] | null>,
  ): Promise<void> {
    try {
      await this.prisma.aiRequestAudit.update({
        where: { request_id: requestId },
        data: {
          prompt_token_estimate: inputTokens,
          response_token_estimate: outputTokens,
          metadata: { state: 'settled', ...metadata },
        },
      });
    } catch (err) {
      this.logger.warn(`roman.spend_settle_failed: ${String(safeDiagnostic(err))}`);
    }
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

/**
 * The typed facts the post-check may compare against, from the SAME bundle
 * the model saw (B-R8-2). Extra kcal facts: today's food entries, wearable
 * active energy and the meal-plan slot numbers.
 */
export function postCheckContextOf(ctx: RomanClientContext): PostCheckContext {
  const extra: number[] = [
    ...ctx.today.entries.map((e) => e.kcal),
    ...ctx.wearables.days.map((d) => d.active_kcal).filter((n): n is number => n !== null),
    ...(ctx.wearables.avg_7d.active_kcal !== null ? [ctx.wearables.avg_7d.active_kcal] : []),
    ...(ctx.meal_plan?.items ?? []).flatMap((item) =>
      [...item.matchAll(/(\d{2,5}) kcal/g)].map((m) => Number(m[1])),
    ),
    ...ctx.last_7_days.days.map((d) => d.kcal),
  ];
  return {
    targets: ctx.targets,
    today: ctx.today,
    last_7_days: ctx.last_7_days,
    macro_method: { floor_kcal: ctx.macro_method.floor_kcal },
    coach: { has_coach: ctx.coach.has_coach, coach_first_name: ctx.coach.coach_first_name },
    extra_kcal_facts: extra,
  };
}
