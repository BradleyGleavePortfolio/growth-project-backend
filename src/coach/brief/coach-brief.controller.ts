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

  @Put('preferences')
  @ApiOperation({ summary: 'Update brief notification preferences' })
  async updatePreferences(
    @Request() req: AuthedRequest,
    @Body() body: UpdateBriefPreferencesDto,
  ): Promise<CoachBriefPreferencesResponse> {
    return this.prefsService.upsert(req.user.id, body);
  }
}
