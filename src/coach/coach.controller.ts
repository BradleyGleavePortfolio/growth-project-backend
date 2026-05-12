import { Controller, Get, Post, Body, Param, Query, UseGuards, Request, NotFoundException, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuditableRequest, AuthedRequest } from '../auth/auth-request';
import { CoachService } from './coach.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { AdminPtmService } from '../admin/ptm/admin-ptm.service';
import { RiskBoardQueryDto } from '../admin/ptm/admin-ptm.dto';

@ApiTags('coach')
@Controller('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachController {
  constructor(
    private coachService: CoachService,
    private analytics: AnalyticsService,
    private adminPtm: AdminPtmService,
  ) {}

  @Get('dashboard')
  async getDashboard(@Request() req: AuthedRequest) {
    return this.coachService.getDashboard(req.user.id, req.user.role);
  }

  @Get('clients')
  async getClients(
    @Request() req: AuthedRequest,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('take') takeRaw?: string,
  ) {
    const normalized: 'active' | 'archived' | 'all' =
      status === 'archived' || status === 'all' ? status : 'active';
    const take = takeRaw ? Math.min(parseInt(takeRaw, 10) || 20, 50) : undefined;
    return this.coachService.getClients(req.user.id, normalized, req.user.role, cursor, take);
  }

  // ------------------------------------------------------------------ //
  // Phase 1E — Coach-scoped PTM risk board.                              //
  //                                                                      //
  // Privacy doctrine:                                                    //
  //   * JwtAuthGuard + CoachGuard at the class level ensures only coach  //
  //     or owner tokens reach any route on this controller.              //
  //   * req.user.id is the ONLY source for the coachId scope: the caller //
  //     cannot influence which roster is read.                           //
  //   * risk_score and success_score are nulled by the service before    //
  //     this handler sees the payload — the raw model output never       //
  //     leaves the server for non-owner tokens.                          //
  //   * An owner calling this endpoint sees only their OWN coach roster  //
  //     (coach_id = owner_id). Owners who want the platform-wide view    //
  //     use GET /admin/ptm/risk-board.                                   //
  // ------------------------------------------------------------------ //
  @Get('clients/risk-board')
  @ApiOperation({
    summary:
      'Coach-scoped PTM risk board. Returns this coach\'s own clients sorted by churn-risk bucket. ' +
      'risk_score and success_score are always null — use the bucket field to drive UI colour.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Cursor-paginated list of risk-board rows scoped to the calling coach\'s roster.',
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not hold the coach or owner role.',
  })
  async getCoachRiskBoard(
    @Request() req: AuthedRequest,
    @Query() query: RiskBoardQueryDto,
  ) {
    return this.adminPtm.getRiskBoardForCoach(req.user.id, {
      bucket: query.bucket,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post('clients/:id/archive')
  @HttpCode(HttpStatus.OK)
  async archiveClient(@Request() req: AuthedRequest, @Param('id') id: string) {
    try {
      const result = await this.coachService.archiveClient(
        req.user.id,
        id,
        req.user.role,
        auditContext(req),
      );
      this.analytics.capture(req.user.id, Events.COACH_ACTION, { action_type: 'archive_client' });
      return result;
    } catch {
      throw new NotFoundException('Client not found');
    }
  }

  @Post('clients/:id/unarchive')
  @HttpCode(HttpStatus.OK)
  async unarchiveClient(@Request() req: AuthedRequest, @Param('id') id: string) {
    try {
      const result = await this.coachService.unarchiveClient(
        req.user.id,
        id,
        req.user.role,
        auditContext(req),
      );
      this.analytics.capture(req.user.id, Events.COACH_ACTION, { action_type: 'unarchive_client' });
      return result;
    } catch {
      throw new NotFoundException('Client not found');
    }
  }

  // Audit-1 Fix #7: accept optional per-slice cursor query params so the
  // mobile timeline screen can scroll-load each data type independently.
  // All params are optional — omitting them returns the first page of 100
  // rows per slice (backwards-compatible with the current mobile client).
  @Get('clients/:id/timeline')
  async getClientTimeline(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Query('days') days?: string,
    @Query('mealsCursor') mealsCursor?: string,
    @Query('workoutsCursor') workoutsCursor?: string,
    @Query('weightsCursor') weightsCursor?: string,
    @Query('checkInsCursor') checkInsCursor?: string,
  ) {
    const daysNum = days ? parseInt(days, 10) : 90;
    return this.coachService.getClientTimeline(req.user.id, id, daysNum, req.user.role, {
      mealsCursor,
      workoutsCursor,
      weightsCursor,
      checkInsCursor,
    });
  }

  @Get('clients/:id/summary')
  async getClientSummary(@Request() req: AuthedRequest, @Param('id') clientId: string, @Query('date') date?: string) {
    return this.coachService.getClientSummary(req.user.id, clientId, date, req.user.role);
  }

  @Get('my-guidelines')
  async getMyGuidelines(@Request() req: AuthedRequest) {
    return this.coachService.getGuidelines(req.user.id);
  }

  @Get('guidelines/:client_id')
  async getGuidelines(@Request() req: AuthedRequest, @Param('client_id') clientId: string) {
    return this.coachService.getGuidelines(req.user.id, clientId);
  }

  @Post('guidelines/:client_id')
  async postGuidelines(@Request() req: AuthedRequest, @Param('client_id') clientId: string, @Body() body: { guidelines: string }) {
    const result = await this.coachService.postGuidelines(req.user.id, clientId, body.guidelines);
    this.analytics.capture(req.user.id, Events.COACH_ACTION, { action_type: 'post_guidelines' });
    return result;
  }

  @Get('alerts')
  async getAlerts(@Request() req: AuthedRequest) {
    return this.coachService.getAlerts(req.user.id, req.user.role);
  }
}

// Best-effort extraction of remote IP + User-Agent for audit-log context.
// Mirrors the helper in admin.controller.ts and users.controller.ts.
function auditContext(req: AuditableRequest): { ip: string | null; userAgent: string | null } {
  const xffRaw = req?.headers?.['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw || '';
  const fwdIp = xff.split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const uaRaw = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw) ? uaRaw[0] ?? null : uaRaw ?? null;
  return { ip: ip || null, userAgent: userAgent || null };
}
