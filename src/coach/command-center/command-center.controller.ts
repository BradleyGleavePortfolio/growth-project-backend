// src/coach/command-center/command-center.controller.ts
//
// Mounts the 5 P0 endpoints (overview, at-risk, win-streaks, inbox,
// action-queue) plus the dismiss action under /coach/command-center/.
//
// Guard stack — JwtAuthGuard authenticates the caller and CoachGuard
// restricts to coach + owner roles (students are rejected).
//
// SC-1: NoActiveSubCoachGuard was previously applied at CLASS level, which
// blocked active sub-coaches from the ENTIRE Command Center — overview,
// at-risk, win-streaks, inbox, and action-queue — even though every route
// on THIS controller is an operational (non-financial) surface. The guard
// is meant to fence off financial/owner-only surfaces (earnings, payouts,
// revenue) only. None of those live here: the revenue dashboard is the
// separate LtvMetricsController (GET /coach/command-center/ltv-metrics),
// which is owned by the LTV unit and is where the financial guard belongs.
//
// Therefore the class-level NoActiveSubCoachGuard is removed here so a sub-
// coach regains the operational surfaces. There are no financial route
// handlers on this controller to re-apply it to; if one is ever added,
// decorate that single handler with @UseGuards(NoActiveSubCoachGuard).
//
// Roster scoping for sub-coaches (head sees full roster, sub sees only
// assigned clients) is enforced in CommandCenterService via
// SubCoachScopeService (SC-2), not by this guard.

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
import { Roles } from '../../common/decorators/roles.decorator';
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
@UseGuards(JwtAuthGuard, CoachGuard)
export class CommandCenterController {
  constructor(
    private readonly commandCenter: CommandCenterService,
    private readonly churn: ChurnInterventionService,
  ) {}

  // Coach reads their own Command Center KPI tiles (roster size, active
  // today, 7d check-in rate, open alerts, at-risk, win-streaks, unread
  // messages). CommandCenterService.getOverview scopes every count by
  // `coach_id = req.user.id` (verified at command-center.service.ts:159 —
  // `where: { coach_id: coachId, role: 'student', deleted_at: null }`).
  // Students must never reach this — cross-roster aggregates would leak
  // headcount and churn signals.
  @Roles('coach', 'owner')
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

  // Coach reads the amber/red slice of their own roster. Service
  // `getAtRisk` filters by `coach_id = req.user.id`; raw risk_score is
  // nulled before leaving the server per Phase-1E doctrine (coaches see
  // bucket only). No coach_id is accepted as input; a coach cannot peek
  // at another coach's at-risk list.
  @Roles('coach', 'owner')
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

  // Coach reads their own roster's positive-signal list. Service
  // `getWinStreaks` filters by `coach_id = req.user.id` (verified at
  // command-center.service.ts:324). Students must never reach — exposes
  // other students' streak data.
  @Roles('coach', 'owner')
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

  // Coach reads their own inbox — thread summaries between this coach
  // and each of their clients. Service `getInbox` scopes by
  // `coach_id = req.user.id` on both the roster lookup and the message
  // thread query (verified at command-center.service.ts:414/427/453).
  // Cross-coach data leak would be P0; the absence of any coach_id
  // query parameter forces the user.id path.
  @Roles('coach', 'owner')
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

  // Coach reads their own pending CoachAlert rows. Service
  // `getActionQueue` scopes by `coach_id = req.user.id` (verified at
  // command-center.service.ts:504/517) and supports cursor pagination on
  // (acknowledged_at IS NULL, created_at < before). No coach_id input.
  @Roles('coach', 'owner')
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

  // Coach mutates one of their own alerts (acknowledge / dismiss).
  // CoachAlertsService.acknowledge (called via
  // CommandCenterService.dismissAlert) runs a `findFirst({ where: { id,
  // coach_id } })` ownership check that raises NotFoundException for
  // foreign alerts — no existence leak, no IDOR. Idempotent on repeat.
  @Roles('coach', 'owner')
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

  // Coach reads enriched at-risk rows for their own roster (top factors
  // + suggested action, derived from PtmPrediction snapshots). Service
  // `getChurnAtRisk` filters roster by `coach_id = req.user.id` and only
  // looks up predictions whose `user_id IN rosterIds`, so a coach cannot
  // pull predictions for users outside their roster. Raw risk_score is
  // nulled (Phase-1E).
  @Roles('coach', 'owner')
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

  // Coach creates a draft intervention for one of their own clients.
  // Service `generateChurnDraft` runs a pre-write IDOR check
  // (`findFirst({ where: { id: clientId, coach_id: coachId, role:
  // 'student' } })`) and raises NotFoundException for clients outside
  // the coach's roster (verified at churn-intervention.service.ts:302).
  // Idempotency key is unique-scoped to coach to defuse cross-coach
  // replay. Anthropic call is rate-limited (20/hour).
  @Roles('coach', 'owner')
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

  // Coach sends a draft intervention they own. Service `sendIntervention`
  // first looks up the row with `findFirst({ where: { id: interventionId,
  // coach_id: coachId } })` and raises NotFoundException for foreign
  // rows (verified at churn-intervention.service.ts:460). The conditional
  // updateMany transition to 'sent' also includes coach_id in WHERE, so
  // a concurrent foreign-coach race cannot succeed. send_idempotency_key
  // replay is coach-scoped.
  @Roles('coach', 'owner')
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

  // Coach dismisses one of their own draft interventions. Service
  // `dismissIntervention` runs a single atomic conditional
  // updateMany({ where: { id, coach_id, status NOT IN ('sent',
  // 'dismissed') } }) (verified at churn-intervention.service.ts:661);
  // foreign rows fall through to NotFoundException, already-sent rows
  // return 409. Naturally idempotent.
  @Roles('coach', 'owner')
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
