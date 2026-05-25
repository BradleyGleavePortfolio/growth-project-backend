// src/coach/command-center/command-center.controller.ts
//
// Mounts the 5 P0 endpoints (overview, at-risk, win-streaks, inbox,
// action-queue) plus the dismiss action under /coach/command-center/.
//
// All routes share the same guard stack — JwtAuthGuard authenticates the
// caller, CoachGuard restricts to coach + owner roles (sub-coaches and
// students are rejected). Scope is always `req.user.id`; nothing here
// trusts a client-supplied coach_id.

import {
  Body,
  Controller,
  Get,
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
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
import { NoActiveSubCoachGuard } from '../../common/guards/no-active-sub-coach.guard';
import type { AuthedRequest } from '../../auth/auth-request';
import {
  CommandCenterService,
  type ActionQueueResponse,
  type AtRiskResponse,
  type CommandCenterOverview,
  type InboxResponse,
  type WinStreaksResponse,
} from './command-center.service';
import {
  ChurnInterventionService,
  type ChurnAtRiskResponse,
  type ChurnInterventionDto,
  type SendInterventionResponse,
} from './churn-intervention.service';
import {
  GenerateChurnDraftDto,
  SendInterventionDto,
} from './churn-intervention.dto';

function parseInt0(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseBool(s: string | undefined): boolean {
  return s === 'true' || s === '1';
}

@ApiTags('coach')
@Controller('coach/command-center')
@UseGuards(JwtAuthGuard, CoachGuard, NoActiveSubCoachGuard)
export class CommandCenterController {
  constructor(
    private readonly commandCenter: CommandCenterService,
    private readonly churn: ChurnInterventionService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: 'KPI tiles for the Command Center home screen.',
    description:
      'Returns roster size, active-today count, 7d check-in rate, open alert ' +
      'count, at-risk count, win-streak count, and unread message count. ' +
      'Always scoped to the calling coach.',
  })
  async getOverview(
    @Request() req: AuthedRequest,
  ): Promise<CommandCenterOverview> {
    return this.commandCenter.getOverview(req.user.id);
  }

  @Get('at-risk')
  @ApiOperation({
    summary: 'List of at-risk clients (amber + red).',
    description:
      'Returns clients whose latest PTM bucket is amber or red. Raw ' +
      'risk_score is always null for coach callers — Phase 1E doctrine ' +
      '(owner-only). Optional bucket filter narrows the list.',
  })
  async getAtRisk(
    @Request() req: AuthedRequest,
    @Query('bucket') bucket?: 'red' | 'amber',
    @Query('limit') limit?: string,
  ): Promise<AtRiskResponse> {
    const safeBucket =
      bucket === 'red' || bucket === 'amber' ? bucket : undefined;
    return this.commandCenter.getAtRisk(req.user.id, {
      bucket: safeBucket,
      limit: parseInt0(limit),
    });
  }

  @Get('win-streaks')
  @ApiOperation({
    summary: 'List of clients with active check-in / workout streaks.',
    description:
      'Returns clients with a checkin_streak signal >= minStreak in the ' +
      'last 7 days, plus workout streaks as a secondary signal.',
  })
  async getWinStreaks(
    @Request() req: AuthedRequest,
    @Query('minStreak') minStreak?: string,
    @Query('limit') limit?: string,
  ): Promise<WinStreaksResponse> {
    return this.commandCenter.getWinStreaks(req.user.id, {
      minStreak: parseInt0(minStreak),
      limit: parseInt0(limit),
    });
  }

  @Get('inbox')
  @ApiOperation({
    summary: 'Coach inbox — message thread summaries.',
    description:
      'Returns the latest message thread between this coach and each of ' +
      'their clients, with unread counts and turn-taking flags.',
  })
  async getInbox(
    @Request() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ): Promise<InboxResponse> {
    return this.commandCenter.getInbox(req.user.id, {
      limit: parseInt0(limit),
      unreadOnly: parseBool(unreadOnly),
    });
  }

  @Get('action-queue')
  @ApiOperation({
    summary: 'Pending coach alerts requiring action.',
    description:
      'Returns unacknowledged CoachAlert rows shape-mapped to the mobile ' +
      'ActionQueueItem contract. Supports cursor pagination via `before` ' +
      '(ISO timestamp of the last row of the previous page).',
  })
  async getActionQueue(
    @Request() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<ActionQueueResponse> {
    return this.commandCenter.getActionQueue(req.user.id, {
      limit: parseInt0(limit),
      before,
    });
  }

  @Post('action-queue/:alertId/dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dismiss (acknowledge) an alert from the action queue.',
    description:
      'Idempotent — a repeated dismiss against the same alert returns ' +
      '{ ok: true } without re-writing the acknowledgement timestamp. ' +
      'Foreign coach calls resolve as NotFoundException (no existence ' +
      'leak).',
  })
  async dismissAlert(
    @Request() req: AuthedRequest,
    @Param('alertId', new ParseUUIDPipe()) alertId: string,
  ): Promise<{ ok: true }> {
    return this.commandCenter.dismissAlert(alertId, req.user.id);
  }

  // ── Churn intervention flow ─────────────────────────────────────────

  @Get('churn-at-risk')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Enriched at-risk list with top factors + suggested action.',
    description:
      'Reads from pre-computed PtmPrediction rows (no live scoring). ' +
      'Returns the top 3 risk signals per client and a suggested action ' +
      'so the coach can decide between drafting a re-engagement message ' +
      'and reviewing bloodwork. Raw risk_score is null (Phase 1E).',
  })
  async getChurnAtRisk(
    @Request() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('minBucket') minBucket?: 'amber' | 'red',
  ): Promise<ChurnAtRiskResponse> {
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const safeBucket =
      minBucket === 'red' || minBucket === 'amber' ? minBucket : undefined;
    return this.churn.getChurnAtRisk(req.user.id, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      minBucket: safeBucket,
    });
  }

  @Post('churn-at-risk/:clientId/draft')
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @ApiOperation({
    summary: 'Generate an Anthropic-drafted re-engagement message.',
    description:
      'Idempotent — repeating the same idempotency_key returns the same ' +
      'ChurnIntervention row without calling Anthropic again. The draft ' +
      'is stored with status="draft" and may be edited before the coach ' +
      'calls send.',
  })
  async generateChurnDraft(
    @Request() req: AuthedRequest,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
    @Body() dto: GenerateChurnDraftDto,
  ): Promise<ChurnInterventionDto> {
    return this.churn.generateChurnDraft(req.user.id, clientId, {
      idempotency_key: dto.idempotency_key,
      alert_id: dto.alert_id,
    });
  }

  @Post('churn-interventions/:interventionId/send')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 3_600_000, limit: 30 } })
  @ApiOperation({
    summary: 'Send the (optionally edited) re-engagement message.',
    description:
      'Atomic — a conditional updateMany ensures only one caller can ' +
      'transition the intervention to "sent". Creates a CoachNudge row ' +
      'and fires a fire-and-forget push notification. Idempotent: a ' +
      'second call returns the existing sent_at and nudge_id.',
  })
  async sendIntervention(
    @Request() req: AuthedRequest,
    @Param('interventionId', new ParseUUIDPipe()) interventionId: string,
    @Body() dto: SendInterventionDto,
  ): Promise<SendInterventionResponse> {
    return this.churn.sendIntervention(req.user.id, interventionId, {
      message_text: dto.message_text,
      idempotency_key: dto.idempotency_key,
    });
  }

  @Post('churn-interventions/:interventionId/dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dismiss a draft intervention without sending.',
    description:
      'Naturally idempotent — a second dismiss returns { ok: true } ' +
      'without re-writing dismissed_at. Cannot dismiss an already-sent ' +
      'intervention (returns 409).',
  })
  async dismissIntervention(
    @Request() req: AuthedRequest,
    @Param('interventionId', new ParseUUIDPipe()) interventionId: string,
  ): Promise<{ ok: true; intervention_id: string }> {
    return this.churn.dismissIntervention(req.user.id, interventionId);
  }
}
