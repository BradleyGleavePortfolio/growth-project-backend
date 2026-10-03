// src/coach/brief/roman/roman-drafts.controller.ts
//
// A5-COACH-BRIEF — the coach's Roman reply-draft review surface.
//
//   GET  /coach/brief/drafts             queue: ready drafts + threads to answer personally
//   POST /coach/brief/drafts/:id/send    send (optionally edited) — the coach's tap
//   POST /coach/brief/drafts/:id/dismiss dismiss; the coach answers personally
//
// Guard stack: CoachBriefEnabledGuard (404 when the brief is off),
// RomanBriefFlagGuard (404 until FEATURE_COACH_BRIEF_ROMAN=true), CoachGuard
// (coach role). JwtAuthGuard + RolesGuard are global. The coach id is always
// req.user.id; every draft read and write is scoped to it.

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CoachGuard } from '../../../auth/coach.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../../auth/auth-request';
import { PrismaService } from '../../../prisma.service';
import { CoachBriefEnabledGuard } from '../coach-brief-enabled.guard';
import { CoachBriefService } from '../coach-brief.service';
import { RomanBriefFlagGuard } from './roman-brief-flag.guard';
import {
  RomanDraftQueue,
  RomanDraftSendResult,
  RomanReplyDraftsService,
} from './roman-reply-drafts.service';

export class SendRomanDraftDto {
  // Present when the coach edited the draft. Length is re-checked in the
  // service so the error carries the reply_draft_body_invalid code.
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  body?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@ApiTags('coach-brief')
@Controller('coach/brief/drafts')
@UseGuards(CoachBriefEnabledGuard, RomanBriefFlagGuard, CoachGuard)
@Roles('coach')
export class RomanDraftsController {
  constructor(
    private readonly drafts: RomanReplyDraftsService,
    private readonly brief: CoachBriefService,
    private readonly prisma: PrismaService,
  ) {}

  /** The coach's client scope, minus clients delegated to a sub-coach. */
  private async scope(coachId: string): Promise<{ clientIds: string[]; coachName: string | null }> {
    const mode = await this.brief.detectBriefMode(coachId);
    let clientIds = await this.brief.resolveClientScope(coachId, mode);
    if (mode === 'head_coach' && clientIds.length > 0) {
      const delegated = await this.prisma.subCoachAssignment.findMany({
        where: { client_id: { in: clientIds }, unassigned_at: null },
        select: { client_id: true },
      });
      const out = new Set(delegated.map((d) => d.client_id));
      clientIds = clientIds.filter((id) => !out.has(id));
    }
    const coach = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { name: true },
    });
    return { clientIds, coachName: coach?.name ?? null };
  }

  @Get()
  // Opening the queue may start up to ROMAN_DRAFT_MAX_NEW_PER_CALL model
  // calls (only for consenting clients without a draft yet).
  @Throttle({ default: { limit: 20, ttl: 60 * 60 * 1000 } })
  @ApiOperation({ summary: 'Roman reply drafts and threads awaiting a reply' })
  async queue(
    @Request() req: AuthedRequest,
    @Query('prepare') prepare?: string,
  ): Promise<RomanDraftQueue> {
    const { clientIds, coachName } = await this.scope(req.user.id);
    return this.drafts.listQueue(req.user.id, coachName, clientIds, {
      prepare: prepare !== 'false',
    });
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 120, ttl: 60 * 60 * 1000 } })
  @ApiOperation({ summary: 'Send a Roman reply draft (optionally edited)' })
  async send(
    @Request() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendRomanDraftDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RomanDraftSendResult> {
    return this.drafts.send(req.user.id, id, {
      body: body?.body,
      idempotencyKey: idempotencyKey && UUID_RE.test(idempotencyKey) ? idempotencyKey : null,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
    });
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss a Roman reply draft' })
  async dismiss(
    @Request() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ status: 'dismissed'; id: string }> {
    return this.drafts.dismiss(req.user.id, id, { ip: clientIp(req), userAgent: userAgentOf(req) });
  }
}

function clientIp(req: AuthedRequest): string | null {
  const xff = req.headers?.['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  if (typeof first === 'string' && first.length > 0) return first.split(',')[0].trim();
  return req.ip ?? null;
}

function userAgentOf(req: AuthedRequest): string | null {
  const ua = req.headers?.['user-agent'];
  if (!ua) return null;
  return Array.isArray(ua) ? (ua[0] ?? null) : ua;
}
