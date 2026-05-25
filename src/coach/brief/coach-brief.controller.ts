// src/coach/brief/coach-brief.controller.ts
//
// Routes for the R43 Coach Brief surface, all under /coach/brief/*.
// Guard stack on every route: [JwtAuthGuard, CoachGuard]. Scope is always
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
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../auth/auth-request';
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

@ApiTags('coach-brief')
@Controller('coach/brief')
@UseGuards(JwtAuthGuard, CoachGuard)
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
  // Natural idempotency key: (coach_id, brief_date) — the CoachBrief
  // row is unique on that pair and CoachBriefService.generateBrief
  // performs an atomic claim (status='generating') so concurrent
  // regenerate requests collapse to a single Claude call. The first
  // caller that flips the row owns the work; later callers receive the
  // same regenerated row by reading the same unique key. No
  // Idempotency-Key header ledger is necessary because the natural key
  // and atomic status transition guarantee at-most-once execution per
  // coach per day. R39 exception approved.
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
