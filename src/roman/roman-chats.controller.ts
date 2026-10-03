/**
 * RomanChatsController — the client's own Roman chat history: list and
 * delete (B-635-2). Owner 2026-10-01 20:32 + operator ruling OR-110-1: past
 * AI chats are kept until the client deletes them or their account, and the
 * box-2 copy client-ai-v4 says exactly that, so a client must be able to find
 * and erase ANY of their chats, not only today's.
 *
 * Routes (all under `/roman`, JwtAuthGuard + RolesGuard, every response
 * `Cache-Control: no-store`):
 *   GET    /roman/sessions        the caller's live chats, newest first
 *                                  (content-free metadata, keyset cursor)
 *   DELETE /roman/sessions        erase EVERY chat of the caller -> 204
 *   DELETE /roman/sessions/:id    erase one chat -> 204 (idempotent)
 *
 * Deliberately NOT behind RomanFeatureGuard (same rule as the AI consent
 * ledger, Sol B1 on #601): finding and deleting your own chats must not
 * depend on Roman chat being switched on, so the kill switch never takes a
 * deletion right away. None of these routes calls Anthropic. The chat
 * routes (open, read, send) stay in RomanController behind the flag.
 *
 * Tenancy: the subject is always req.user.id; the service scopes every read
 * and write by user_id, and a session that is not the caller's is a coded
 * 404 ROMAN_SESSION_NOT_FOUND (never 403, so ids cannot be probed).
 */
import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { parseListSessionsQuery } from './roman-chats.query';
import { RomanCaller, RomanService } from './roman.service';

/** Wire view of one chat in the list (no message text). */
export interface RomanSessionListItemView {
  id: string;
  surface: string;
  /** UTC calendar day the chat was opened (YYYY-MM-DD). */
  dayKey: string;
  messageCount: number;
  startedAt: Date;
  lastActivityAt: Date;
}

@Controller('roman')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RomanChatsController {
  constructor(private readonly roman: RomanService) {}

  // ─── GET /roman/sessions — the caller's chats, newest first ────────────────
  @Get('sessions')
  @Header('Cache-Control', 'no-store')
  @Roles('student', 'coach', 'owner')
  async listSessions(
    @Req() req: AuthedRequest,
    // Raw query (plain-object metatype: the global ValidationPipe leaves it
    // alone) validated by the route-owned parser, so every bad value is a
    // coded 400 with a next step, never an uncoded DTO error (Sol B-635-5).
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<{ sessions: RomanSessionListItemView[]; nextCursor: string | null }> {
    const query = parseListSessionsQuery(rawQuery);
    const page = await this.roman.listSessions(this.callerOf(req), {
      cursor: query.cursor,
      limit: query.limit,
      surface: query.surface,
    });
    return {
      sessions: page.sessions.map((s) => ({
        id: s.id,
        surface: s.surface,
        dayKey: s.day_key,
        messageCount: s.message_count,
        startedAt: s.started_at,
        lastActivityAt: s.last_activity_at,
      })),
      nextCursor: page.nextCursor,
    };
  }

  // ─── DELETE /roman/sessions — erase every chat of the caller ───────────────
  @Delete('sessions')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('student', 'coach', 'owner')
  async deleteAllSessions(@Req() req: AuthedRequest): Promise<void> {
    await this.roman.deleteAllSessions(this.callerOf(req));
  }

  // ─── DELETE /roman/sessions/:id — erase one chat ───────────────────────────
  // Any day's chat, not only today's. A repeat delete is a 204 (the erased
  // state the client asked for already holds). See RomanService.deleteSession.
  @Delete('sessions/:id')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('student', 'coach', 'owner')
  async deleteSession(@Req() req: AuthedRequest, @Param('id') id: string): Promise<void> {
    await this.roman.deleteSession(this.callerOf(req), id);
  }

  /** List and delete need no tier (no rate limit applies to them). */
  private callerOf(req: AuthedRequest): RomanCaller {
    return { id: req.user.id, role: req.user.role };
  }
}
