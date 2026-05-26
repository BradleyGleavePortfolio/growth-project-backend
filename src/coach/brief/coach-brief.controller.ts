// src/coach/brief/coach-brief.controller.ts
//
// Routes for the R43 Coach Brief surface, all under /coach/brief/*.
// Guard stack on every route: [CoachBriefEnabledGuard, CoachGuard].
// JwtAuthGuard + RolesGuard are global APP_GUARDs. Scope is always
// req.user.id — never trust a client-supplied coach_id.

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CoachGuard } from '../../auth/coach.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../auth/auth-request';
import { CoachBriefEnabledGuard } from './coach-brief-enabled.guard';
import { CoachBriefService } from './coach-brief.service';
import { CoachDailyLogService } from './coach-daily-log.service';
import { CoachBriefPreferencesService } from './coach-brief-preferences.service';
import {
  BriefHistoryQueryDto,
  LogHistoryQueryDto,
  UpdateBriefPreferencesDto,
  UpsertDailyLogDto,
} from './coach-brief.dto';
import {
  BriefHistoryResponse,
  CoachBriefPreferencesResponse,
  CoachBriefResponse,
  CoachDailyLogResponse,
  EmptyDailyLogResponse,
  LogHistoryResponse,
} from './coach-brief.types';

// P1-2 — CoachBriefEnabledGuard sits at the front of the guard stack so
// when COACH_BRIEF_ENABLED=off every route returns 404 BEFORE JWT or role
// checks run. This prevents the disabled feature from advertising its
// existence and lets operators kill the surface without a client deploy.
// A5-P2-1 — JwtAuthGuard is already registered globally as APP_GUARD in
// AppModule. Listing it again in the controller-level @UseGuards stack
// runs JWT verification twice per request (once globally, once per the
// decorator). We keep CoachBriefEnabledGuard first so a disabled-feature
// 404 short-circuits BEFORE the global auth chain runs, and CoachGuard
// is the bespoke role-narrowing guard. The RolesGuard that interprets
// @Roles('coach') is also globally registered.
@ApiTags('coach-brief')
@Controller('coach/brief')
@UseGuards(CoachBriefEnabledGuard, CoachGuard)
@Roles('coach')
export class CoachBriefController {
  constructor(
    private readonly briefService: CoachBriefService,
    private readonly logService: CoachDailyLogService,
    private readonly prefsService: CoachBriefPreferencesService,
  ) {}

  @Get('today')
  @ApiOperation({ summary: "Get or generate today's brief for this coach" })
  async getTodaysBrief(
    @Request() req: AuthedRequest,
  ): Promise<CoachBriefResponse> {
    return this.briefService.getOrGenerateTodaysBrief(req.user.id);
  }

  @Get('history')
  @ApiOperation({ summary: 'List the coach\'s briefs over the last 30 days' })
  async getHistory(
    @Request() req: AuthedRequest,
    @Query() query: BriefHistoryQueryDto,
  ): Promise<BriefHistoryResponse> {
    return this.briefService.getBriefHistory(
      req.user.id,
      query.page ?? 1,
      query.limit ?? 10,
    );
  }

  // @ApproveIdempotencyException(R39)
  //
  // R39 exception scope (read this before changing the comment):
  //
  //   regenerate's PURPOSE is to produce fresh output — the coach is
  //   explicitly asking for the brief to be re-derived. That is the
  //   opposite of strict idempotency ("same input → same row"), so we
  //   document an explicit exception under R39 rather than pretending
  //   the route is naturally idempotent on (coach_id, brief_date).
  //
  // Concurrency guarantees we DO provide:
  //
  //   1) Concurrent in-flight collapse — CoachBriefService.generateBrief
  //      runs an atomic claim (status='generating' with a fresh
  //      generation_started_at lease). Only the caller that flips the
  //      row owns the Claude call; other concurrent callers see the
  //      in-progress row and read it back. So two simultaneous taps do
  //      NOT trigger two Claude calls.
  //
  //   2) Abuse bounded — @Throttle({ limit: 3, ttl: 3_600_000 }) caps
  //      each coach to 3 regenerations per hour. A network retry storm
  //      cannot drive unbounded Claude spend.
  //
  //   3) Stale-lease recovery — if a previous regenerate crashed mid-
  //      flight, the next caller reclaims the row after
  //      BRIEF_GENERATION_LEASE_MS, so a coach is never permanently
  //      stuck on a half-written brief.
  //
  // Guarantees we do NOT provide (and why that is OK):
  //
  //   * Sequential retry idempotency. If the client's response is lost
  //     after the brief was successfully regenerated, a subsequent
  //     regenerate call WILL produce a second Claude call and overwrite
  //     the row. That is the documented R39 exception: a fresh-output
  //     route is permitted to do work on retry. Mobile mitigates the
  //     surprise by surfacing the throttle response on the 4th call in
  //     an hour. Adding an Idempotency-Key ledger here would defeat the
  //     route's purpose ("give me a different brief than the one I just
  //     read").
  //
  // R39 exception approved on these terms.
  @Post('regenerate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 3600_000 } })
  @ApiOperation({ summary: "Force-regenerate today's brief (max 3/hr)" })
  async regenerate(
    @Request() req: AuthedRequest,
  ): Promise<CoachBriefResponse> {
    return this.briefService.regenerateTodaysBrief(req.user.id);
  }

  @Get('log/today')
  @ApiOperation({ summary: "Get today's written log (or empty stub)" })
  async getTodaysLog(
    @Request() req: AuthedRequest,
  ): Promise<CoachDailyLogResponse | EmptyDailyLogResponse> {
    return this.logService.getTodaysLog(req.user.id);
  }

  // @ApproveIdempotencyException(R39)
  // Natural idempotency key: (coach_id, log_date). CoachDailyLog is
  // unique on that pair; upsertTodaysLog calls prisma.coachDailyLog.upsert
  // which is idempotent by construction — repeats land on the same row
  // and overwrite content rather than inserting duplicates. Mobile
  // retries are safe; no Idempotency-Key ledger required. R39 exception
  // approved.
  @Put('log/today')
  @ApiOperation({ summary: "Create or update today's written log" })
  async upsertTodaysLog(
    @Request() req: AuthedRequest,
    @Body() body: UpsertDailyLogDto,
  ): Promise<CoachDailyLogResponse> {
    return this.logService.upsertTodaysLog(req.user.id, body.content);
  }

  @Get('log/history')
  @ApiOperation({ summary: 'List the coach\'s written logs (30 days)' })
  async getLogHistory(
    @Request() req: AuthedRequest,
    @Query() query: LogHistoryQueryDto,
  ): Promise<LogHistoryResponse> {
    return this.logService.getLogHistory(
      req.user.id,
      query.page ?? 1,
      query.limit ?? 10,
    );
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Read brief notification preferences' })
  async getPreferences(
    @Request() req: AuthedRequest,
  ): Promise<CoachBriefPreferencesResponse> {
    return this.prefsService.getOrDefault(req.user.id);
  }

  // @ApproveIdempotencyException(R39)
  // Natural idempotency key: coach_id. CoachBriefPreferences is unique
  // per coach (one row), and prefsService.upsert lands on that row
  // regardless of how many times the request is retried. Mobile retries
  // converge on the same final preference state. R39 exception approved.
  @Put('preferences')
  @ApiOperation({ summary: 'Update brief notification preferences' })
  async updatePreferences(
    @Request() req: AuthedRequest,
    @Body() body: UpdateBriefPreferencesDto,
  ): Promise<CoachBriefPreferencesResponse> {
    return this.prefsService.upsert(req.user.id, body);
  }
}
