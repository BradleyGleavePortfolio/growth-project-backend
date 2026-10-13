import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { TeamAuditEventKind } from '@prisma/client';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { AssignSubCoachDto } from './team-mode.dto';
import { TeamModeService } from './team-mode.service';
import { HeadCoachOnlyGuard } from '../sub-coaches/head-coach-only.guard';

const TEAM_AUDIT_EVENT_KINDS: ReadonlyArray<TeamAuditEventKind> = [
  'session_held',
  'message_sent',
  'plan_assigned',
  'checkin_logged',
  'macro_target_set',
  'meal_plan_assigned',
  'workout_assigned',
  'client_progress_logged',
  'sub_coach_assigned',
  'sub_coach_removed',
  'client_reassigned',
  'invite_sent_by_sub_coach',
  'tier_changed',
  'staff_seat_added',
  'staff_seat_removed',
];

// No coach plan gate on Team Mode (owner TM-P1: zero locks).
@ApiTags('team-mode')
@Controller('team')
export class TeamModeController {
  constructor(private readonly teamMode: TeamModeService) {}

  // POST /team/sub-coaches  body: { sub_coach_id }
  // Q1, Q2: assign a sub-coach. Pro: paid Stripe seat. Everyone else: free.
  @Post('sub-coaches')
  @UseGuards(JwtAuthGuard, CoachGuard, HeadCoachOnlyGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async assignSubCoach(
    @Req() req: AuthedRequest,
    @Body() dto: AssignSubCoachDto,
  ) {
    return this.teamMode.assignSubCoach({
      headCoachId: req.user.id,
      subCoachId: dto.sub_coach_id,
    });
  }

  // GET /team/sub-coaches  — current head coach's active sub-coaches.
  @Get('sub-coaches')
  @UseGuards(JwtAuthGuard, CoachGuard)
  async listSubCoaches(@Req() req: AuthedRequest) {
    return this.teamMode.listSubCoaches(req.user.id);
  }

  // DELETE /team/sub-coaches/:subCoachId
  // Q3: removal auto-reassigns clients to the initiating head coach.
  @Delete('sub-coaches/:subCoachId')
  @UseGuards(JwtAuthGuard, CoachGuard)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async removeSubCoach(
    @Req() req: AuthedRequest,
    @Param('subCoachId') subCoachId: string,
  ) {
    return this.teamMode.removeSubCoach({
      headCoachId: req.user.id,
      subCoachId,
    });
  }

  // GET /team/audit-events?event_kind=&from=&to=&target_client_id=&limit=&cursor=
  // Q4: curated feed (15 event_kinds, not a CRUD firehose).
  @Get('audit-events')
  @UseGuards(JwtAuthGuard, CoachGuard)
  async listAuditEvents(
    @Req() req: AuthedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('event_kind') eventKindRaw?: string,
    @Query('target_client_id') targetClientId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    let eventKind: TeamAuditEventKind | undefined;
    if (eventKindRaw) {
      if (!TEAM_AUDIT_EVENT_KINDS.includes(eventKindRaw as TeamAuditEventKind)) {
        // 400, not 403. A malformed query string is a validation
        // problem, not a permission gate. The response shape mirrors
        // class-validator output so mobile clients can consume it
        // through the same error renderer they already use for DTO
        // validation failures.
        throw new BadRequestException({
          kind: 'invalid_event_kind',
          allowed: TEAM_AUDIT_EVENT_KINDS,
        });
      }
      eventKind = eventKindRaw as TeamAuditEventKind;
    }

    const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 50)) : 50;
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    return this.teamMode.listAuditEvents({
      headCoachId: req.user.id,
      fromDate: fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : undefined,
      toDate: toDate && !Number.isNaN(toDate.getTime()) ? toDate : undefined,
      eventKind,
      targetClientId,
      cursor,
      limit,
    });
  }
}
