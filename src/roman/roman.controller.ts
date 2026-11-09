/**
 * RomanController — REST surface for the Roman chat MVP (brief §1.2).
 *
 * Routes (all under `/roman`, all behind JwtAuthGuard + RomanFeatureGuard):
 *   POST   /roman/sessions                  open or resume (idempotent on day-key)
 *   GET    /roman/sessions/:id/messages      paginated, newest first
 *   POST   /roman/sessions/:id/messages      submit a user turn → SSE assistant stream
 *
 * Listing and deleting chats (GET /roman/sessions, DELETE /roman/sessions,
 * DELETE /roman/sessions/:id) live in RomanChatsController, which is NOT
 * behind the feature flag: a client's right to find and erase their chats
 * must not depend on Roman chat being on (B-635-2).
 *
 * Auth: JwtAuthGuard authenticates every route. Roman is available to ALL
 * signed-in users on ANY tier (free + pro) — so there is no tier gate, only the
 * client's daily Roman limits (ROMANCOUNT, roman-usage.ts). RomanFeatureGuard
 * returns 404 on every route while the feature flag is OFF. A client with no
 * coach gets 403 ROMAN_REQUIRES_COACH on open and send (owner 10-09 00:0x,
 * roman-requires-coach.ts); reading a transcript stays open.
 *
 * Streaming: `POST …/messages` returns Server-Sent Events. The user turn is
 * persisted first; the assistant turn is streamed and persisted on completion
 * (or partial-with-interrupted on client disconnect — brief §1.3).
 *
 * CRISIS-2B: Roman's fixed emergency or self-harm reply carries
 * `safety_actions` on the SSE `done` frame and in the message list, for an app
 * that sends ROMAN_SAFETY_ACTIONS_HEADER.
 */

import {
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RomanMessage } from '@prisma/client';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../prisma.service';
import { RomanFeatureGuard } from './roman-feature.guard';
import { romanSafetyActions, type RomanSafetyAction } from './guardrails/safety-router';
import { ROMAN_SSE_FALLBACK_ERROR, ROMAN_SSE_REPLY_PENDING_ERROR, toRomanSseErrorFrame } from './roman-sse-error';
import { IDEMPOTENCY_KEY_REUSED, messageKey } from '../community/messages/message-idempotency';
import type { RomanUsageDebit } from './roman-usage';
import {
  assertRomanHasCoach,
  romanRequiresCoach,
  romanRequiresCoachException,
} from './roman-requires-coach';
import {
  RomanCaller,
  RomanService,
  romanTurnIds,
} from './roman.service';
import {
  ListMessagesQueryDto,
  OpenSessionDto,
  SendMessageDto,
} from './roman.dto';
import { KeepRomanContext } from './context/roman-context-invalidation';
import { CopilotTurnService, ROMAN_COPILOT_HEADER, withoutCites } from '../copilot/copilot-turn';
import { isCopilotEnabled } from '../copilot/copilot.controller';

/**
 * CRISIS-2B: an app that reads `safety_actions` sends this header with the
 * value 1. Builds without it parse Roman's views strictly and refuse an
 * unknown key, so they get today's exact shape and the crisis reply still
 * reaches them.
 */
export const ROMAN_SAFETY_ACTIONS_HEADER = 'x-roman-safety-actions';

@Controller('roman')
@UseGuards(JwtAuthGuard, RolesGuard, RomanFeatureGuard)
export class RomanController {
  constructor(
    private readonly roman: RomanService,
    private readonly prisma: PrismaService,
    @Optional() @Inject(CopilotTurnService) private readonly copilot: CopilotTurnService | null = null,
  ) {}

  // ─── POST /roman/sessions — open or resume ─────────────────────────────────
  @Post('sessions')
  @HttpCode(HttpStatus.OK)
  @Roles('student', 'coach', 'owner')
  async openSession(@Req() req: AuthedRequest, @Body() dto: OpenSessionDto) {
    // Owner 10-09 00:0x: a client with no coach gets 403 ROMAN_REQUIRES_COACH
    // (roman-requires-coach.ts) and no session is opened.
    assertRomanHasCoach(req.user);
    const caller = await this.callerOf(req);
    const session = await this.roman.openOrResumeSession(caller, dto.surface);
    return this.toSessionView(session);
  }

  // ─── GET /roman/sessions/:id/messages — paginated, newest first ────────────
  // no-store: a transcript must never outlive its deletion in a device HTTP
  // cache (the global interceptor would otherwise mark it private, max-age=60).
  @Get('sessions/:id/messages')
  @Header('Cache-Control', 'no-store')
  @Roles('student', 'coach', 'owner')
  async listMessages(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    const caller = await this.callerOf(req);
    const page = await this.roman.listMessages(caller, id, {
      cursor: query.cursor,
      limit: query.limit,
    });
    const marker = this.safetyMarker(req);
    // COPILOT-BE2: each Copilot reply's facts and suggestion, only for an app that sent ROMAN_COPILOT_HEADER;
    // any other app reads that reply without its [n] markers, as plain text.
    const copilot = this.copilotAsked(req, caller) && this.copilot ? await this.copilot.views(caller.id, page.messages) : null;
    return {
      messages: page.messages.map((m) => ({
        ...this.toMessageView(m),
        ...marker(m),
        ...(copilot?.has(m.id) ? { copilot: copilot.get(m.id) } : m.copilot ? { content: withoutCites(m.content) } : {}),
      })),
      nextCursor: page.nextCursor,
    };
  }

  // ─── POST /roman/sessions/:id/messages — submit a turn, stream the reply ───
  @Post('sessions/:id/messages')
  @Roles('student', 'coach', 'owner')
  // The turn reads the context; it writes nothing the context reads.
  @KeepRomanContext()
  async sendMessage(
    @Req() req: Request & AuthedRequest,
    @Res() res: Response,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ): Promise<void> {
    // SEND-ONCE-SERVER: an optional Idempotency-Key (a UUID; blank keeps today's send; anything else 400) names
    // this turn and its reply (romanTurnIds), so a resend of a turn that reached the server lands once.
    const key = messageKey(req.headers?.['idempotency-key']);
    const caller = await this.callerOf(req);
    // An emergency / self-harm / urgent-symptoms message is answered by a
    // deterministic SafetyRouter template: no model call, no spend, and none of
    // the client's data leaves the app. Neither the per-user turn limit, the
    // daily spend cap, nor the box-2 AI gate (which governs sending data to
    // the AI processor, CONSENT_D2_CONTRACT) may stand between the client and
    // that answer. Every other turn keeps all three checks.
    const crisis = await this.roman.isSafetyShortCircuit(caller, id, dto.content);
    // CF-ROMAN-COPY-B-128 (owner default 10-07): an eating-disorder message
    // that one of the checks below refuses gets the fixed fallback (a pointer
    // to people, no model call) instead of the refusal.
    const edRisk = !crisis && this.roman.isEatingDisorderRisk(dto.content);
    let edFallback = false;
    let usageDebit: RomanUsageDebit | null = null;

    // Owner 10-09 00:0x: a client with no coach gets 403 ROMAN_REQUIRES_COACH
    // first, before the rate limit, the turn is stored or any AI or pool
    // check. Like every refusal here, a crisis turn still gets the template
    // and an eating-disorder message the fixed fallback (no model call).
    if (!crisis && romanRequiresCoach(req.user)) {
      if (!edRisk) throw romanRequiresCoachException();
      edFallback = true;
    }

    const session = await this.roman.getOwnedSession(caller, id);
    // SEND-ONCE-SERVER: a resend of a stored turn is answered from what is stored, before every check below:
    // no model call, no counted message, no spend, no second alert.
    const keyed = key ? romanTurnIds(caller.id, session.id, key) : null;
    const sentBefore = keyed ? await this.roman.findKeyedTurn(caller, session.id, keyed) : null;
    if (sentBefore) return this.replayTurn(req, res, caller, dto.content, sentBefore);
    // R2b — a client without a live box-2 grant gets a plain 403
    // ai_consent_required (Settings > Privacy) before the turn is stored or
    // the stream opens.
    // A crisis turn skips it: the template involves no AI processing, and
    // streamAssistantTurn answers it before its own egress check.
    try {
      if (!crisis && !edFallback) await this.roman.assertMayUseAi(caller);
      // OR-113-2 — daily spend cap, checked before the turn is stored (coded
      // 503 ROMAN_CAPACITY_REACHED with a specific message; fail closed).
      if (!crisis && !edFallback) await this.roman.assertDailyCapacity(caller);
      // B-668-1 — the coach's monthly AI credit pool, before the turn is stored
      // (402 COACH_AI_BUDGET_EXHAUSTED, copy for the caller's audience).
      if (!crisis && !edFallback) await this.roman.assertCoachPoolOpen(caller);
      // ROMANCOUNT — counted last, so a turn refused above never counts (the spend
      // admission gives it back). An eating-disorder-risk turn is checked, never counted.
      if (!crisis && !edFallback) usageDebit = await this.roman.assertWithinRateLimit(caller, edRisk);
    } catch (err) {
      if (!edRisk) {
        // 429: the wait as a real Retry-After header (RFC 6585 §4).
        const retry = (err as { getResponse?: () => { retryAfterSeconds?: unknown } }).getResponse?.();
        if (typeof retry?.retryAfterSeconds === 'number') res.setHeader('Retry-After', String(retry.retryAfterSeconds));
        throw err;
      }
      edFallback = true;
    }
    // The stored turn's id: a safety alert points at this one message.
    const keyedTurn = keyed ? await this.roman.appendKeyedTurn(caller, session.id, keyed.turn, dto.content) : null;
    if (keyed && keyedTurn?.replayed) {
      // Two first sends raced and the other one stored the turn: this one gives back what it counted.
      await this.roman.giveBackTurn(usageDebit);
      const first = await this.roman.findKeyedTurn(caller, session.id, keyed);
      return this.replayTurn(req, res, caller, dto.content, first ?? { turn: keyedTurn.row, reply: null });
    }
    const stored = keyedTurn
      ? keyedTurn.row
      : await this.roman.appendMessage(caller, session.id, {
          role: 'user',
          content: dto.content,
        });

    // Manual SSE: we own the response stream so we can persist the partial on
    // client-disconnect. (NestJS @Sse maps an Observable but does not give us a
    // clean disconnect hook for partial persistence — brief §1.3.)
    // B-626-2 — the support reference for this stream travels in the
    // X-Request-ID header (RequestIdMiddleware already set it; repeating it
    // here keeps it on the SSE response whatever writeHead merges). It is
    // never added to the strict `{ code, message }` error frame.
    this.openStream(req, res);

    const marker = this.safetyMarker(req);
    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.on('close', onClose);

    const turn = edFallback
      ? this.roman.streamEatingDisorderFallback(caller, session, stored?.id, keyed?.reply)
      : this.roman.streamAssistantTurn(caller, session, {
          signal: abort.signal,
          userMessage: dto.content,
          userMessageId: stored?.id,
          usageDebit,
          copilot: this.copilotAsked(req, caller) && session.surface === 'client',
          replyId: keyed?.reply,
        });
    try {
      try {
        for await (const chunk of turn) {
          const frame =
            chunk.type === 'done'
              ? { ...chunk, ...marker({ role: 'roman', content: chunk.text ?? '' }) }
              : chunk;
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
          if (chunk.type === 'done') break;
        }
      } finally {
        // SEND-ONCE-PENDING-BE: every way this stream ends passes here: after any reply row is stored, and before
        // the error frame below, so the resend that frame invites reads the final answer. It never throws.
        if (keyed) await this.roman.clearReplyPending(caller, session.id, keyed.turn);
      }
    } catch (err) {
      // Surface a structured error event, never a raw stack (AGENT_RULES #9).
      // B-626-2 — exactly `{ code, message }`: the mobile parser is strict,
      // and the reference is already in the X-Request-ID header above.
      res.write(`event: error\ndata: ${JSON.stringify(toRomanSseErrorFrame(err))}\n\n`);
    } finally {
      req.off('close', onClose);
      res.end();
    }
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  /** The SSE head every turn answer opens with (a new turn and a SEND-ONCE-SERVER replay alike). */
  private openStream(req: AuthedRequest, res: Response): void {
    const requestId = (req as { requestId?: string }).requestId;
    res.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(requestId ? { 'X-Request-ID': requestId } : {}),
    });
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
      (res as { flushHeaders: () => void }).flushHeaders();
    }
  }

  /**
   * SEND-ONCE-SERVER: the answer to a resend of a keyed turn, from what is stored; nothing is counted, spent,
   * alerted or written. Other words under the key: 409 (before the stream opens). Reply stored: its delta and
   * `done` frame, as the first send gave them (the Copilot facts as the history read builds them). No reply yet:
   * SEND-ONCE-PENDING-BE, the coded ROMAN_REPLY_PENDING frame while the first send may still store one (`pending`,
   * RomanService.findKeyedTurn), else the coded ROMAN_UNAVAILABLE frame, which the phone already reads as "turn
   * stored, no reply" (it keeps the turn and reloads the chat). The two carry the same words.
   */
  private async replayTurn(
    req: Request & AuthedRequest,
    res: Response,
    caller: RomanCaller,
    content: string,
    first: { turn: { content: string }; reply: RomanMessage | null; pending?: boolean },
  ): Promise<void> {
    if (first.turn.content !== content) throw new ConflictException(IDEMPOTENCY_KEY_REUSED);
    this.openStream(req, res);
    const { reply } = first;
    if (!reply) {
      const frame = first.pending ? ROMAN_SSE_REPLY_PENDING_ERROR : ROMAN_SSE_FALLBACK_ERROR;
      res.write(`event: error\ndata: ${JSON.stringify({ ...frame })}\n\n`);
      res.end();
      return;
    }
    const views = reply.copilot && this.copilotAsked(req, caller) && this.copilot
      ? await this.copilot.views(caller.id, [reply])
      : null;
    const facts = views?.get(reply.id);
    const text = !facts && reply.copilot ? withoutCites(reply.content) : reply.content;
    const done = {
      type: 'done',
      text,
      messageId: reply.id,
      interrupted: reply.interrupted,
      ...(facts ? { copilot: facts } : {}),
      ...this.safetyMarker(req)({ role: 'roman', content: text }),
    };
    if (text.length > 0) res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
    res.write(`data: ${JSON.stringify(done)}\n\n`);
    res.end();
  }

  /** COPILOT-BE2: a client with a coach (as on every Copilot route) asked for Copilot (header '1') while FEATURE_CLIENT_PATH_COPILOT is on. */
  private copilotAsked(req: AuthedRequest, caller: RomanCaller): boolean {
    return caller.role === 'student' && !!req.user.coach_id && isCopilotEnabled() && req.headers?.[ROMAN_COPILOT_HEADER] === '1';
  }

  /**
   * Build the RomanCaller from the authenticated user. Resolves the coach
   * subscription tier (best-effort) so the service can apply the right
   * rate-limit cap; absent a row, the caller is treated as free.
   */
  private async callerOf(req: AuthedRequest): Promise<RomanCaller> {
    const user = req.user;
    let tier: RomanCaller['tier'] = 'free';
    try {
      const sub = (await this.prisma.coachSubscription.findUnique({
        where: { coach_id: user.id },
      })) as { tier?: RomanCaller['tier'] } | null;
      if (sub?.tier) tier = sub.tier;
    } catch {
      // No subscription model row / not a coach — free tier is the safe default.
    }
    return { id: user.id, role: user.role, tier };
  }

  /**
   * CRISIS-2B: `{ safety_actions }` for a fixed crisis reply when the app sent
   * ROMAN_SAFETY_ACTIONS_HEADER, otherwise nothing (the key is left out).
   * message_coach needs a coach now: `req.user` is the fresh User row
   * (JwtAuthGuard), and only a client's coach_id is their coach.
   */
  private safetyMarker(req: AuthedRequest) {
    const asked = req.headers?.[ROMAN_SAFETY_ACTIONS_HEADER] === '1';
    const hasCoach = req.user.role === 'student' && !!req.user.coach_id;
    return (turn: { role: string; content: string }): { safety_actions?: RomanSafetyAction[] } => {
      const actions = asked ? romanSafetyActions(turn, hasCoach) : null;
      return actions ? { safety_actions: actions } : {};
    };
  }

  private toSessionView(session: {
    id: string;
    surface: string;
    message_count: number;
    started_at: Date;
    last_activity_at: Date;
  }) {
    return {
      id: session.id,
      surface: session.surface,
      messageCount: session.message_count,
      startedAt: session.started_at,
      lastActivityAt: session.last_activity_at,
    };
  }

  private toMessageView(m: {
    id: string;
    role: string;
    content: string;
    interrupted: boolean;
    created_at: Date;
  }) {
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      interrupted: m.interrupted,
      createdAt: m.created_at,
    };
  }
}
