/**
 * RomanController — REST surface for the Roman chat MVP (brief §1.2).
 *
 * Routes (all under `/roman`, all behind JwtAuthGuard + RomanFeatureGuard):
 *   POST   /roman/sessions                  open or resume (idempotent on day-key)
 *   GET    /roman/sessions/:id/messages      paginated, newest first
 *   POST   /roman/sessions/:id/messages      submit a user turn → SSE assistant stream
 *   DELETE /roman/sessions/:id               soft-delete
 *
 * Auth: JwtAuthGuard authenticates every route. Roman is available to ALL
 * signed-in users on ANY tier (free + pro) — so there is no tier gate, only the
 * per-tier RATE limit applied in the service (brief §4). RomanFeatureGuard
 * returns 404 on every route while the feature flag is OFF.
 *
 * Streaming: `POST …/messages` returns Server-Sent Events. The user turn is
 * persisted first; the assistant turn is streamed and persisted on completion
 * (or partial-with-interrupted on client disconnect — brief §1.3).
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { PrismaService } from '../prisma.service';
import { RomanFeatureGuard } from './roman-feature.guard';
import {
  RomanCaller,
  RomanService,
} from './roman.service';
import {
  ListMessagesQueryDto,
  OpenSessionDto,
  SendMessageDto,
} from './roman.dto';

@Controller('roman')
@UseGuards(JwtAuthGuard, RomanFeatureGuard)
export class RomanController {
  constructor(
    private readonly roman: RomanService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── POST /roman/sessions — open or resume ─────────────────────────────────
  @Post('sessions')
  @HttpCode(HttpStatus.OK)
  async openSession(@Req() req: AuthedRequest, @Body() dto: OpenSessionDto) {
    const caller = await this.callerOf(req);
    const session = await this.roman.openOrResumeSession(caller, dto.surface);
    return this.toSessionView(session);
  }

  // ─── GET /roman/sessions/:id/messages — paginated, newest first ────────────
  @Get('sessions/:id/messages')
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
    return {
      messages: page.messages.map((m) => this.toMessageView(m)),
      nextCursor: page.nextCursor,
    };
  }

  // ─── POST /roman/sessions/:id/messages — submit a turn, stream the reply ───
  @Post('sessions/:id/messages')
  async sendMessage(
    @Req() req: Request & AuthedRequest,
    @Res() res: Response,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ): Promise<void> {
    const caller = await this.callerOf(req);

    // Rate-limit BEFORE persisting the user turn (so a rejected turn does not
    // count against the cap). Throws a structured 429 Too Many Requests; we
    // surface the retry budget as a real Retry-After header (RFC 6585 §4)
    // before re-throwing so the NestJS filter serialises the body.
    try {
      await this.roman.assertWithinRateLimit(caller);
    } catch (err) {
      const payload = (
        err as { getResponse?: () => unknown }
      ).getResponse?.() as { retryAfterSeconds?: number } | undefined;
      if (typeof payload?.retryAfterSeconds === 'number') {
        res.setHeader('Retry-After', String(payload.retryAfterSeconds));
      }
      throw err;
    }

    const session = await this.roman.getOwnedSession(caller, id);
    await this.roman.appendMessage(caller, session.id, {
      role: 'user',
      content: dto.content,
    });

    // Manual SSE: we own the response stream so we can persist the partial on
    // client-disconnect. (NestJS @Sse maps an Observable but does not give us a
    // clean disconnect hook for partial persistence — brief §1.3.)
    res.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
      (res as { flushHeaders: () => void }).flushHeaders();
    }

    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.on('close', onClose);

    try {
      for await (const chunk of this.roman.streamAssistantTurn(caller, session, {
        signal: abort.signal,
      })) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (chunk.type === 'done') break;
      }
    } catch (err) {
      // Surface a structured error event, never a raw stack (AGENT_RULES #9).
      const body =
        err && typeof err === 'object' && 'response' in err
          ? (err as { response?: unknown }).response
          : { code: 'ROMAN_UNAVAILABLE', message: 'Roman is not available right now.' };
      res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
    } finally {
      req.off('close', onClose);
      res.end();
    }
  }

  // ─── DELETE /roman/sessions/:id — soft-delete ──────────────────────────────
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSession(@Req() req: AuthedRequest, @Param('id') id: string) {
    const caller = await this.callerOf(req);
    await this.roman.softDeleteSession(caller, id);
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

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
