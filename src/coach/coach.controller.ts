import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuditableRequest, AuthedRequest } from '../auth/auth-request';
import { CoachService } from './coach.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { AdminPtmService } from '../admin/ptm/admin-ptm.service';
import { RiskBoardQueryDto } from '../admin/ptm/admin-ptm.dto';
import { ImportedPeopleService } from './imported-people.service';
import { ImportedPeopleQueryDto, ImportedPeopleResult } from './imported-people.dto';

@ApiTags('coach')
@Controller('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachController {
  constructor(
    private coachService: CoachService,
    private analytics: AnalyticsService,
    private adminPtm: AdminPtmService,
    private importedPeople: ImportedPeopleService,
  ) {}

  @Get('dashboard')
  async getDashboard(@Request() req: AuthedRequest) {
    return this.coachService.getDashboard(req.user.id, req.user.role);
  }

  /**
   * GET /coach/dashboard/summary
   *
   * Pre-aggregated dashboard summary designed to stay performant at 100+ clients.
   * Returns:
   *   - stats: total_clients, active_today, unread_messages, pending_checkins
   *   - attention_needed: up to 20 clients with a reason tag (missed_workout |
   *     off_macros | no_checkin | weight_flag)
   *
   * All data is computed via parallel Prisma aggregations (no N+1 queries).
   */
  //
  // Coach reads their own pre-aggregated dashboard summary (stats + the
  // first 20 attention-needed clients). The service scopes every Prisma
  // aggregation by `req.user.id`; nothing accepts a coach_id query arg, so
  // a coach cannot peek at another coach's roster stats. CoachGuard at
  // class level already restricts to coach|owner; the explicit @Roles
  // closes a Phase-10 contract-test gap (sibling handlers are on the
  // legacy allowlist with "CoachGuard at class level", but this handler
  // post-dates that allowlist and must declare its role directly).
  // OWNER is listed explicitly per C1 pattern for on-call/audit clarity
  // even though RolesGuard's owner-bypass would admit it implicitly.
  @Roles('coach', 'owner')
  @Get('dashboard/summary')
  @ApiOperation({
    summary: 'Pre-aggregated coach dashboard summary',
    description:
      'Returns aggregated stats and a capped list of clients needing attention. ' +
      'Designed for coach rosters with 100+ clients — all data is derived from ' +
      'parallel Prisma groupBy/count queries with no N+1 patterns.',
  })
  async getDashboardSummary(@Request() req: AuthedRequest) {
    return this.coachService.getDashboardSummary(req.user.id, req.user.role);
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
  // S8-D2 — "imported, not yet joined" (owner D-S8-2 (a);                //
  // docs/decisions/2026-09-26-s8d-person-link.md §5.2).                  //
  //                                                                      //
  // The coach roster shows the coach's imported `Person` rows as a       //
  // SIBLING collection of GET /coach/clients, never interleaved into     //
  // that `User` array (no existing consumer sees a non-User row; the     //
  // array response of /coach/clients is unchanged in shape).            //
  //                                                                      //
  // Privacy doctrine (as the risk board above):                          //
  //   * req.user.id is the ONLY tenant key — an owner or sub-coach sees  //
  //     Persons of their OWN coach id, never another coach's import.     //
  //   * A Person carries no email/phone/contact column; the row emits   //
  //     person_id, display_name, state, source_platform and markers.    //
  //   * invite / proposal markers are null until their tables exist     //
  //     (S8-D3+); suggestions are same-coach name matches, read-time     //
  //     only, never persisted or applied.                               //
  //   * Declared before the `clients/:id/*` routes so the static segment //
  //     wins; OWNER listed explicitly per the C1 pattern.               //
  // ------------------------------------------------------------------ //
  @Roles('coach', 'owner')
  @Get('clients/imported')
  @ApiOperation({
    summary: "Imported, not yet joined: the coach's imported Persons without an account",
    description:
      "Lists the calling coach's imported Person rows whose state is not Claimed and not " +
      'Deleted (Suspended is shown with its state), newest first, with bounded cursor ' +
      'pagination. A sibling of GET /coach/clients: never interleaved into the User array. ' +
      'Each row carries `joined: false`, the fixed label "imported, not yet joined", and the ' +
      'link-flow markers `invite` and `proposal`, which are null until the PersonInvite ' +
      '(S8-D4a) and PersonLinkProposal (S8-D6) tables exist — never fabricated. ' +
      '`suggestions` lists same-coach students whose account name equals the display name ' +
      '(normalised), computed at read time, never persisted or applied. No email, phone or ' +
      'contact field is emitted; coach_id is taken from the bearer token only.',
  })
  @ApiResponse({ status: 200, description: 'Imported-people page.', type: ImportedPeopleResult })
  @ApiResponse({
    status: 400,
    description: 'Invalid query (oversized cursor or out-of-range take).',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
  @ApiResponse({ status: 403, description: 'Caller does not hold the coach or owner role.' })
  async getImportedPeople(
    @Request() req: AuthedRequest,
    @Query() query: ImportedPeopleQueryDto,
  ): Promise<ImportedPeopleResult> {
    return this.importedPeople.list(req.user.id, query.cursor, query.take);
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
      "Coach-scoped PTM risk board. Returns this coach's own clients sorted by churn-risk bucket. " +
      'risk_score and success_score are always null — use the bucket field to drive UI colour.',
  })
  @ApiResponse({
    status: 200,
    description: "Cursor-paginated list of risk-board rows scoped to the calling coach's roster.",
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not hold the coach or owner role.',
  })
  async getCoachRiskBoard(@Request() req: AuthedRequest, @Query() query: RiskBoardQueryDto) {
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
    return this.coachService.getClientTimeline(
      req.user.id,
      id,
      daysNum,
      req.user.role,
      {
        mealsCursor,
        workoutsCursor,
        weightsCursor,
        checkInsCursor,
      },
      auditContext(req),
    );
  }

  @Get('clients/:id/summary')
  async getClientSummary(
    @Request() req: AuthedRequest,
    @Param('id') clientId: string,
    @Query('date') date?: string,
  ) {
    return this.coachService.getClientSummary(
      req.user.id,
      clientId,
      date,
      req.user.role,
      auditContext(req),
    );
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
  async postGuidelines(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Body() body: { guidelines: string },
  ) {
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
  const userAgent = Array.isArray(uaRaw) ? (uaRaw[0] ?? null) : (uaRaw ?? null);
  return { ip: ip || null, userAgent: userAgent || null };
}
