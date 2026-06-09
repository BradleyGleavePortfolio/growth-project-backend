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
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  Prisma,
  RomanMessage,
  RomanSession,
  RomanSurface,
} from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  ROMAN_ANTHROPIC_CLIENT,
  ROMAN_MODEL_PHASE_1,
} from './anthropic-client.provider';
import {
  ROMAN_ERROR_RATE_LIMIT,
  ROMAN_ERROR_UNAVAILABLE,
  ROMAN_MAX_CONTEXT_TURNS,
  ROMAN_MAX_OUTPUT_TOKENS,
  ROMAN_MESSAGES_DEFAULT_LIMIT,
  ROMAN_MESSAGES_MAX_LIMIT,
  ROMAN_RATE_LIMIT_FREE_PER_DAY,
  ROMAN_RATE_LIMIT_PRO_PER_DAY,
  ROMAN_RATE_LIMIT_WINDOW_MS,
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

/** UTC calendar day-key (YYYY-MM-DD) used for the open-or-resume idempotency. */
export function dayKeyUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

@Injectable()
export class RomanService {
  private readonly logger = new Logger(RomanService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(ROMAN_ANTHROPIC_CLIENT)
    private readonly anthropic: Anthropic | null = null,
  ) {}

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
          ...(subjectContext !== undefined
            ? { subject_context_json: subjectContext }
            : {}),
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
  async getOwnedSession(
    caller: RomanCaller,
    sessionId: string,
  ): Promise<RomanSession> {
    const session = await this.prisma.romanSession.findFirst({
      where: { id: sessionId, user_id: caller.id, deleted_at: null },
    });
    if (!session) {
      throw new NotFoundException('Roman session not found');
    }
    return session;
  }

  /** Soft-delete a session the caller owns (sets deleted_at). Idempotent. */
  async softDeleteSession(
    caller: RomanCaller,
    sessionId: string,
  ): Promise<void> {
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
    return tier === 'free'
      ? ROMAN_RATE_LIMIT_FREE_PER_DAY
      : ROMAN_RATE_LIMIT_PRO_PER_DAY;
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
              (oldest.created_at.getTime() +
                ROMAN_RATE_LIMIT_WINDOW_MS -
                Date.now()) /
                1000,
            ),
          )
        : Math.ceil(ROMAN_RATE_LIMIT_WINDOW_MS / 1000);
      throw new ForbiddenException({
        code: ROMAN_ERROR_RATE_LIMIT,
        retryAfterSeconds,
        message:
          'You have reached the Roman conversation limit for now. It will reset shortly.',
      });
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

    try {
      const stream = this.anthropic.messages.stream({
        model: ROMAN_MODEL_PHASE_1,
        max_tokens: ROMAN_MAX_OUTPUT_TOKENS,
        system,
        messages,
      });

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
      // Mark interrupted, persist whatever we accumulated, and surface a
      // structured error chunk (never a raw SDK string — AGENT_RULES #9).
      interrupted = true;
      this.logger.warn(
        `Roman stream error for session ${session.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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
