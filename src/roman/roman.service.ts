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
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import type { Prisma, RomanMessage, RomanSession, RomanSurface } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { ROMAN_ANTHROPIC_CLIENT } from './anthropic-client.provider';
import {
  ROMAN_CHARS_PER_TOKEN,
  ROMAN_DAILY_CAP_REPLY,
  ROMAN_ERROR_EMPTY_REPLY,
  ROMAN_ERROR_RATE_LIMIT,
  ROMAN_ERROR_UNAVAILABLE,
  ROMAN_HISTORY_MAX_TOKENS,
  ROMAN_HISTORY_TURN_MAX_CHARS,
  ROMAN_MAX_CONTEXT_TURNS,
  ROMAN_MAX_OUTPUT_TOKENS,
  ROMAN_MESSAGES_DEFAULT_LIMIT,
  ROMAN_MESSAGES_MAX_LIMIT,
  ROMAN_RATE_LIMIT_FREE_PER_DAY,
  ROMAN_RATE_LIMIT_PRO_PER_DAY,
  ROMAN_RATE_LIMIT_WINDOW_MS,
  ROMAN_UNAVAILABLE_MESSAGE,
  ROMAN_UPSTREAM_TIMEOUT_MS,
} from './roman.constants';
import {
  ROMAN_AI_CAPABILITY,
  RomanModelConfig,
  RomanModelProfile,
  costCentsFor,
  requestProfileFor,
  resolveRomanModelConfig,
} from './model/roman-model.config';
import {
  UpstreamErrorDescription,
  describeUpstreamError,
  formatUpstreamError,
  isFallbackEligible,
  isNotFound,
} from './model/roman-upstream-error';
import { RomanModelHealthService } from './model/roman-model-health.service';
import { isRomanChatEnabled } from './roman.feature';
import { buildRomanSystemPrompt, RomanSessionVoiceState } from './roman.prompts';

/** Minimal caller identity the service needs (from the authenticated User). */
export interface RomanCaller {
  id: string;
  role: string;
  /** Coach tier when known; drives the rate-limit cap. Defaults to free. */
  tier?: 'free' | 'pro' | 'enterprise' | null;
}

/**
 * One emitted chunk of an assistant stream.
 *
 * `error` is the HONEST FAILURE frame (plan §2.7): emitted instead of `done`
 * whenever the upstream call failed after fallback, or the model produced no
 * text. The controller writes it as an SSE `event: error` frame with a
 * structured `{code, message}` body the mobile can show. A `done` frame is
 * never emitted with empty text unless the CLIENT aborted the stream.
 */
export interface RomanStreamChunk {
  type: 'delta' | 'done' | 'error';
  /** Text delta for `delta`; full assistant text for `done`. */
  text?: string;
  /** Persisted message id, present on `done` and `error`. */
  messageId?: string;
  /** True on `done` when the turn was persisted from a partial stream. */
  interrupted?: boolean;
  /** Structured error code on `error` (ROMAN_UNAVAILABLE | ROMAN_EMPTY_REPLY). */
  code?: string;
  /** User-facing message on `error`. */
  message?: string;
  /** The model that actually answered (from the response), on `done`. */
  modelId?: string | null;
}

/** Cursor-paginated message page (newest first). */
export interface RomanMessagePage {
  messages: RomanMessage[];
  /** Cursor to pass for the next (older) page, or null when exhausted. */
  nextCursor: string | null;
}

/** UTC calendar day-key (YYYY-MM-DD) used for the open-or-resume idempotency. */
export function dayKeyUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

@Injectable()
export class RomanService {
  private readonly logger = new Logger(RomanService.name);

  private readonly modelConfig: RomanModelConfig;
  /** UTC day-key of the last daily-cap alert, so the operator page fires once per day. */
  private lastCapAlertDay: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(ROMAN_ANTHROPIC_CLIENT)
    private readonly anthropic: Anthropic | null = null,
    @Optional()
    private readonly health: RomanModelHealthService | null = null,
  ) {
    // Same validated config the health service holds; resolving it here too
    // keeps the service usable in unit tests that construct it directly.
    this.modelConfig = health?.config ?? resolveRomanModelConfig();
  }

  /** The validated model config in force (test seam + health reporting). */
  get models(): RomanModelConfig {
    return this.modelConfig;
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  /**
   * Open or resume the caller's session for a surface. Idempotent on
   * (userId, surface, dayKey): a live session for today is resumed; otherwise a
   * new one is created. A soft-deleted session for the same day does NOT get
   * resurrected — the unique key still holds it, so we resume only non-deleted
   * rows and rely on the day rolling over for a fresh start.
   */
  async openOrResumeSession(
    caller: RomanCaller,
    surface: RomanSurface,
    subjectContext?: Prisma.InputJsonValue,
  ): Promise<RomanSession> {
    const day_key = dayKeyUtc();

    const existing = await this.prisma.romanSession.findFirst({
      where: {
        user_id: caller.id,
        surface,
        day_key,
        deleted_at: null,
      },
    });
    if (existing) return existing;

    try {
      return await this.prisma.romanSession.create({
        data: {
          user_id: caller.id,
          surface,
          day_key,
          ...(subjectContext !== undefined ? { subject_context_json: subjectContext } : {}),
        },
      });
    } catch (err) {
      // Unique-violation race: another request created the row first. Resume it.
      if (this.isUniqueViolation(err)) {
        const row = await this.prisma.romanSession.findFirst({
          where: { user_id: caller.id, surface, day_key, deleted_at: null },
        });
        if (row) return row;
      }
      throw err;
    }
  }

  /** Load a session the caller owns, or throw 404 (never 403 — avoid ID probing). */
  async getOwnedSession(caller: RomanCaller, sessionId: string): Promise<RomanSession> {
    const session = await this.prisma.romanSession.findFirst({
      where: { id: sessionId, user_id: caller.id, deleted_at: null },
    });
    if (!session) {
      throw new NotFoundException('Roman session not found');
    }
    return session;
  }

  /** Soft-delete a session the caller owns (sets deleted_at). Idempotent. */
  async softDeleteSession(caller: RomanCaller, sessionId: string): Promise<void> {
    const session = await this.getOwnedSession(caller, sessionId);
    await this.prisma.romanSession.update({
      where: { id: session.id },
      data: { deleted_at: new Date() },
    });
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
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? page[page.length - 1].id : null;
    return { messages: page, nextCursor };
  }

  /**
   * Append a turn to a session and bump the denormalised bookkeeping
   * (message_count, last_activity_at) in a single transaction so the count
   * never drifts from reality.
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
      const message = await tx.romanMessage.create({
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
      await tx.romanSession.update({
        where: { id: sessionId },
        data: {
          message_count: { increment: 1 },
          last_activity_at: new Date(),
        },
      });
      return message;
    });
  }

  // ─── Rate limiting ─────────────────────────────────────────────────────────

  /** The user-turn cap for a caller's tier (brief §3). */
  rateLimitCapFor(caller: RomanCaller): number {
    const tier = caller.tier ?? 'free';
    return tier === 'free' ? ROMAN_RATE_LIMIT_FREE_PER_DAY : ROMAN_RATE_LIMIT_PRO_PER_DAY;
  }

  /**
   * Throw a structured 429 when the caller has exhausted their 24h user-turn
   * budget. Counts only `user` turns in the rolling window. OWNER is exempt.
   */
  async assertWithinRateLimit(caller: RomanCaller): Promise<void> {
    if (caller.role === 'owner') return;
    const cap = this.rateLimitCapFor(caller);
    const since = new Date(Date.now() - ROMAN_RATE_LIMIT_WINDOW_MS);
    const used = await this.prisma.romanMessage.count({
      where: {
        user_id: caller.id,
        role: 'user',
        created_at: { gte: since },
      },
    });
    if (used >= cap) {
      // Retry-after = time until the oldest counted turn falls out of window.
      const oldest = await this.prisma.romanMessage.findFirst({
        where: {
          user_id: caller.id,
          role: 'user',
          created_at: { gte: since },
        },
        orderBy: { created_at: 'asc' },
      });
      const retryAfterSeconds = oldest
        ? Math.max(
            1,
            Math.ceil(
              (oldest.created_at.getTime() + ROMAN_RATE_LIMIT_WINDOW_MS - Date.now()) / 1000,
            ),
          )
        : Math.ceil(ROMAN_RATE_LIMIT_WINDOW_MS / 1000);
      throw new HttpException(
        {
          code: ROMAN_ERROR_RATE_LIMIT,
          retryAfterSeconds,
          message: 'You have reached the Roman conversation limit for now. It will reset shortly.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
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
   * Assemble the prior turns for the API call, token-capped (plan §2.4): the
   * most recent ROMAN_MAX_CONTEXT_TURNS messages, oldest-first, each clamped
   * to ROMAN_HISTORY_TURN_MAX_CHARS, then trimmed oldest-first until the
   * estimated total fits ROMAN_HISTORY_MAX_TOKENS. The newest turn (the user
   * message just persisted) is always kept. Leading assistant turns left over
   * after trimming are dropped so the transcript starts on a user turn.
   */
  async buildContextTurns(
    sessionId: string,
  ): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const recent = await this.prisma.romanMessage.findMany({
      where: { session_id: sessionId },
      orderBy: { created_at: 'desc' },
      take: ROMAN_MAX_CONTEXT_TURNS,
    });
    const ordered = recent.reverse().map((m, idx, all) => {
      const isNewest = idx === all.length - 1;
      const content =
        !isNewest && m.content.length > ROMAN_HISTORY_TURN_MAX_CHARS
          ? m.content.slice(0, ROMAN_HISTORY_TURN_MAX_CHARS)
          : m.content;
      return {
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content,
      };
    });
    const budgetChars = ROMAN_HISTORY_MAX_TOKENS * ROMAN_CHARS_PER_TOKEN;
    let total = ordered.reduce((n, t) => n + t.content.length, 0);
    while (ordered.length > 1 && total > budgetChars) {
      total -= ordered.shift()!.content.length;
    }
    while (ordered.length > 1 && ordered[0].role === 'assistant') {
      ordered.shift();
    }
    return ordered;
  }

  /**
   * Stream an assistant turn for a freshly-appended user turn. Yields text
   * deltas, then persists the assistant turn and yields `done`.
   *
   * Model routing (plan §3 / R1): the PRIMARY model from config is tried
   * first; on a fallback-eligible upstream failure (not_found / 404 / 529 /
   * 5xx / connection error) BEFORE any text arrived, the FALLBACK model is
   * tried once. The model that actually answered is recorded on the turn.
   *
   * Honest failure (plan §2.7): if the call still fails, or the model returns
   * no text, the turn is persisted as `interrupted` and an `error` chunk is
   * yielded — never a blank `done`.
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
        message: ROMAN_UNAVAILABLE_MESSAGE,
      });
    }
    if (!this.anthropic || this.health?.isDown()) {
      throw new ServiceUnavailableException({
        code: ROMAN_ERROR_UNAVAILABLE,
        message: ROMAN_UNAVAILABLE_MESSAGE,
      });
    }

    // Global daily spend cap (plan §2.8): a deterministic reply, no model call.
    if (await this.isOverDailyCap()) {
      const persisted = await this.appendMessage(caller, session.id, {
        role: 'roman',
        content: ROMAN_DAILY_CAP_REPLY,
        modelId: null,
      });
      yield { type: 'delta', text: ROMAN_DAILY_CAP_REPLY };
      yield {
        type: 'done',
        text: ROMAN_DAILY_CAP_REPLY,
        messageId: persisted.id,
        interrupted: false,
        modelId: null,
      };
      return;
    }

    const system = buildRomanSystemPrompt({
      surface: session.surface,
      voice: this.voiceStateOf(session),
      subjectContext:
        typeof session.subject_context_json === 'string' ? session.subject_context_json : null,
    });
    const messages = await this.buildContextTurns(session.id);

    let acc = '';
    let interrupted = false;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let answeringModel: string | null = null;
    let upstreamError: UpstreamErrorDescription | null = null;

    // Own AbortController forwarded to the SDK so a client disconnect actively
    // cancels the upstream Anthropic request — otherwise the provider keeps
    // generating tokens after we stop reading (brief §7: no orphan upstream).
    const upstream = new AbortController();
    const forwardAbort = () => upstream.abort();
    if (opts.signal) {
      if (opts.signal.aborted) upstream.abort();
      else opts.signal.addEventListener('abort', forwardAbort, { once: true });
    }
    const timeout = setTimeout(() => upstream.abort(), ROMAN_UPSTREAM_TIMEOUT_MS);

    const order = this.health?.preferredOrder() ?? this.defaultModelOrder();

    try {
      for (let attempt = 0; attempt < order.length; attempt++) {
        const profile = order[attempt];
        const startedAt = Date.now();
        try {
          const stream = this.anthropic.messages.stream(
            {
              model: profile.id,
              max_tokens: ROMAN_MAX_OUTPUT_TOKENS,
              system,
              messages,
              ...requestProfileFor(profile, this.modelConfig.effort),
            } as Anthropic.MessageStreamParams,
            { signal: upstream.signal },
          );

          for await (const event of stream) {
            if (opts.signal?.aborted) {
              interrupted = true;
              break;
            }
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              acc += event.delta.text;
              yield { type: 'delta', text: event.delta.text };
            } else if (event.type === 'message_delta') {
              completionTokens = event.usage?.output_tokens ?? completionTokens;
            } else if (event.type === 'message_start') {
              promptTokens = event.message?.usage?.input_tokens ?? promptTokens;
              answeringModel = event.message?.model ?? profile.id;
            }
          }
          answeringModel ??= profile.id;
          upstreamError = null;
          this.health?.noteUpstreamSuccess();
          await this.logCall(caller, profile, {
            tokensIn: promptTokens ?? 0,
            tokensOut: completionTokens ?? 0,
            latencyMs: Date.now() - startedAt,
            success: true,
          });
          break;
        } catch (err) {
          const d = describeUpstreamError(err);
          if (d.aborted || opts.signal?.aborted) {
            // Client disconnect (or our upstream timeout): keep the partial.
            interrupted = true;
            if (!opts.signal?.aborted) upstreamError = d; // timeout, not client
            break;
          }
          // Log the CLASS, status and type only — never upstream text (§6.5).
          this.logger.warn(
            `Roman upstream error session=${session.id} model=${profile.id} ${formatUpstreamError(d)}`,
          );
          if (isNotFound(d)) this.health?.noteUpstreamNotFound();
          await this.logCall(caller, profile, {
            tokensIn: promptTokens ?? 0,
            tokensOut: completionTokens ?? 0,
            latencyMs: Date.now() - startedAt,
            success: false,
            errorCode: `${d.name}:${d.type ?? d.status ?? 'unknown'}`,
          });
          upstreamError = d;
          const canFallback =
            acc.length === 0 && attempt < order.length - 1 && isFallbackEligible(d);
          if (!canFallback) break;
          promptTokens = null;
          completionTokens = null;
          answeringModel = null;
        }
      }
    } finally {
      // Cancel the upstream HTTP request and drop the listener regardless of
      // how the loop exited (clean finish, client abort, or SDK error).
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', forwardAbort);
      upstream.abort();
    }

    const clientAborted = opts.signal?.aborted === true;

    if (upstreamError || (!clientAborted && acc.trim().length === 0)) {
      // Honest failure: persist the attempt (partial text, if any) as
      // interrupted and surface a structured error — never a blank `done`.
      const persisted = await this.appendMessage(caller, session.id, {
        role: 'roman',
        content: acc,
        promptTokens,
        completionTokens,
        modelId: answeringModel,
        interrupted: true,
      });
      yield {
        type: 'error',
        code: upstreamError ? ROMAN_ERROR_UNAVAILABLE : ROMAN_ERROR_EMPTY_REPLY,
        message: ROMAN_UNAVAILABLE_MESSAGE,
        messageId: persisted.id,
      };
      return;
    }

    // Persist the assistant turn (full or partial). An empty partial (client
    // aborted before any token) still records the interrupted attempt so the
    // transcript is honest.
    const persisted = await this.appendMessage(caller, session.id, {
      role: 'roman',
      content: acc,
      promptTokens,
      completionTokens,
      modelId: answeringModel,
      interrupted,
    });

    yield {
      type: 'done',
      text: acc,
      messageId: persisted.id,
      interrupted,
      modelId: answeringModel,
    };
  }

  // ─── cost + health plumbing ──────────────────────────────────────────────

  private defaultModelOrder(): RomanModelProfile[] {
    const { primary, fallback } = this.modelConfig;
    return primary.id === fallback.id ? [primary] : [primary, fallback];
  }

  /**
   * One AICallLog row per upstream call (plan §2.8). Best-effort: a logging
   * failure must never fail the user's turn. `errorMessage` carries only an
   * error class + type/status, never upstream text.
   */
  private async logCall(
    caller: RomanCaller,
    profile: RomanModelProfile,
    call: {
      tokensIn: number;
      tokensOut: number;
      latencyMs: number;
      success: boolean;
      errorCode?: string;
    },
  ): Promise<void> {
    const table = (this.prisma as { aICallLog?: { create?: (args: unknown) => Promise<unknown> } })
      .aICallLog;
    if (!table?.create) return;
    try {
      await table.create({
        data: {
          model: profile.id,
          tokensIn: call.tokensIn,
          tokensOut: call.tokensOut,
          costCents: costCentsFor(profile, call.tokensIn, call.tokensOut),
          latencyMs: call.latencyMs,
          success: call.success,
          errorMessage: call.errorCode ?? null,
          coachId: caller.role === 'coach' || caller.role === 'owner' ? caller.id : null,
          clientId: caller.role === 'student' ? caller.id : null,
          capability: ROMAN_AI_CAPABILITY,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Roman AICallLog write failed: ${err instanceof Error ? err.name : 'Error'}`,
      );
    }
  }

  /**
   * Global daily USD cap (plan §2.8): sum of today's (UTC) Roman AICallLog
   * cost. A cap of 0 disables the check. Best-effort: if the ledger cannot be
   * read, Roman keeps answering (the feature flag is the hard kill switch).
   */
  async isOverDailyCap(): Promise<boolean> {
    const capUsd = this.modelConfig.globalDailyUsdCap;
    if (!capUsd || capUsd <= 0) return false;
    const table = (
      this.prisma as {
        aICallLog?: {
          aggregate?: (args: unknown) => Promise<{ _sum?: { costCents?: number | null } }>;
        };
      }
    ).aICallLog;
    if (!table?.aggregate) return false;
    try {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const agg = await table.aggregate({
        _sum: { costCents: true },
        where: { capability: ROMAN_AI_CAPABILITY, createdAt: { gte: startOfDay } },
      });
      const spentCents = agg?._sum?.costCents ?? 0;
      const over = spentCents >= Math.round(capUsd * 100);
      if (over) {
        const day = dayKeyUtc();
        if (this.lastCapAlertDay !== day) {
          this.lastCapAlertDay = day;
          this.logger.error(
            `[roman] global daily spend cap reached (spent_cents=${spentCents} cap_usd=${capUsd}); serving the resting reply until UTC midnight`,
          );
        }
      }
      return over;
    } catch (err) {
      this.logger.warn(`Roman daily-cap read failed: ${err instanceof Error ? err.name : 'Error'}`);
      return false;
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
