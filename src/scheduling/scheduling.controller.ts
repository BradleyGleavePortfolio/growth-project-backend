import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import type { SessionStatus } from '@prisma/client';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import {
  ApproveSessionDto,
  AttachManualVideoLinkDto,
  CancelSessionDto,
  CompleteSessionDto,
  CreateAvailabilityOverrideDto,
  CreateSessionTypeDto,
  RequestSessionDto,
  RescheduleSessionDto,
  SetAvailabilityDto,
  UpdateAvailabilityOverrideDto,
  UpdateSessionTypeDto,
} from './dto/scheduling.dto';
import { SchedulingService } from './scheduling.service';
import { SchedulingErrorCode, schedulingError } from './scheduling.types';

// Mounted at /scheduling under the global JwtAuthGuard. Every endpoint
// here requires an authenticated user; the service layer enforces the
// fine-grained client/coach/owner rules.
//
// Path layout — public-facing surface for clients + coaches + admins:
//
//   GET    /scheduling/coaches/:coachId/session-types
//   POST   /scheduling/session-types                   (coach)
//   PATCH  /scheduling/session-types/:id               (coach)
//   GET    /scheduling/coaches/:coachId/availability
//   PUT    /scheduling/coaches/:coachId/availability   (coach)
//   GET    /scheduling/sessions                        (upcoming for me)
//   GET    /scheduling/sessions/:id
//   POST   /scheduling/sessions                        (request)
//   POST   /scheduling/sessions/:id/approve            (coach)
//   POST   /scheduling/sessions/:id/decline            (coach)
//   POST   /scheduling/sessions/:id/reschedule
//   POST   /scheduling/sessions/:id/cancel
//   POST   /scheduling/sessions/:id/complete           (coach)
//   POST   /scheduling/sessions/:id/no-show            (coach)
//   POST   /scheduling/sessions/:id/manual-video-link  (coach)
// ClientEntitlementGuard is applied class-level. It is a no-op for coaches
// and owners (the guard short-circuits on `user.role !== 'student'`), so
// coach-facing endpoints (approve, decline, complete, no-show, manual-video-link,
// session-types, availability, availability-overrides) are unaffected.
// Students hit 402 on any scheduling endpoint unless they have an active
// ClientPurchase — including booking, reschedule, and cancel (the core
// paid surface the audit flagged at P0).
@ApiTags('scheduling')
@Controller('scheduling')
@UseGuards(JwtAuthGuard, ClientEntitlementGuard)
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  // ---------------- Provider capabilities ----------------

  @ApiOperation({
    summary: 'List available scheduling provider integrations',
    description:
      'Returns the video and calendar providers currently supported for selection. Until real adapters ship, only manual link entry is available.',
  })
  @ApiResponse({ status: 200, description: 'Supported providers.' })
  @Get('providers')
  getProviders() {
    // C9: Hard-coded to manual-only. When Google Calendar / Zoom adapters
    // ship, this should delegate to SchedulingProviderRegistry so the
    // list stays in sync automatically.
    return {
      video: ['manual'],
      calendar: ['manual'],
      note: 'Provider integrations are coming soon. Use manual link entry for all sessions.',
    };
  }

  // ---------------- Session types ----------------

  @ApiOperation({
    summary: 'List the coaches the calling client can book with',
    description:
      "Head coach first, then the current sub-coach. Each row carries the coach timezone, the number of active appointment types, and the welcome type with the client's upcoming welcome booking (if any). Coaches and owners get an empty list.",
  })
  @ApiResponse({ status: 200, description: 'Bookable coaches.' })
  @Get('my-coaches')
  async listMyCoaches(@Request() req: AuthedRequest) {
    return this.scheduling.listMyCoaches(toActor(req));
  }

  @ApiOperation({
    summary: "List a coach's session types",
    description:
      'Readable by the coach, an owner, and clients assigned to that coach (head coach or current sub-coach). Clients see active types only and never the default meeting link. include_archived=true is honoured for the coach and owners.',
  })
  @ApiResponse({ status: 200, description: 'Session types listed.' })
  @ApiResponse({ status: 403, description: 'COACH_NOT_BOOKABLE' })
  @Get('coaches/:coachId/session-types')
  async listSessionTypes(
    @Request() req: AuthedRequest,
    @Param('coachId') coachId: string,
    @Query('include_archived') includeArchived?: string,
  ) {
    return this.scheduling.listSessionTypes(toActor(req), coachId, {
      includeArchived: includeArchived === 'true' || includeArchived === '1',
    });
  }

  @ApiOperation({ summary: 'Create a session type for the calling coach' })
  @ApiResponse({ status: 201, description: 'Session type created.' })
  @Post('session-types')
  async createSessionType(@Request() req: AuthedRequest, @Body() body: CreateSessionTypeDto) {
    return this.scheduling.createSessionType(toActor(req), body);
  }

  @ApiOperation({ summary: 'Update or archive a session type' })
  @ApiResponse({ status: 200, description: 'Session type updated.' })
  @Patch('session-types/:id')
  async updateSessionType(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateSessionTypeDto,
  ) {
    return this.scheduling.updateSessionType(toActor(req), id, body);
  }

  // ---------------- Availability ----------------

  @ApiOperation({ summary: "Read a coach's recurring availability" })
  @ApiResponse({ status: 200, description: 'Availability windows.' })
  @ApiResponse({ status: 403, description: 'COACH_NOT_BOOKABLE' })
  @Get('coaches/:coachId/availability')
  async getAvailability(@Request() req: AuthedRequest, @Param('coachId') coachId: string) {
    return this.scheduling.getAvailability(toActor(req), coachId);
  }

  @ApiOperation({
    summary: "Replace a coach's recurring availability",
    description:
      'Atomic — all existing windows are deleted and replaced with the supplied set in one transaction.',
  })
  @ApiResponse({ status: 200, description: 'Availability replaced.' })
  @Post('coaches/:coachId/availability')
  @HttpCode(HttpStatus.OK)
  async setAvailability(
    @Request() req: AuthedRequest,
    @Param('coachId') coachId: string,
    @Body() body: SetAvailabilityDto,
  ) {
    return this.scheduling.setAvailability(toActor(req), coachId, body.windows);
  }

  // ---------------- Sessions ----------------

  @ApiOperation({
    summary: "List the calling user's sessions",
    description:
      'scope=upcoming (default): sessions that have not ended, soonest first; next page with after=<start_at of the last row>&after_id=<id of the last row>. scope=past: ended sessions, most recent first; next page with before=<start_at of the last row>&before_id=<id of the last row>. status=<comma-separated statuses> narrows either scope (e.g. status=requested for the coach inbox). Owners see all, coaches their own calendar, clients their own sessions.',
  })
  @ApiResponse({ status: 200, description: 'Sessions.' })
  @Get('sessions')
  async listUpcoming(
    @Request() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('scope') scope?: string,
    @Query('before') before?: string,
    @Query('before_id') beforeId?: string,
    @Query('after') after?: string,
    @Query('after_id') afterId?: string,
    @Query('status') status?: string,
  ) {
    if (scope !== undefined && scope !== 'upcoming' && scope !== 'past') {
      throw new BadRequestException(
        schedulingError(
          SchedulingErrorCode.INVALID_LIST_QUERY,
          'The session list scope must be upcoming or past. Reload Calendar.',
        ),
      );
    }
    const cap = limit ? parseInt(limit, 10) : 25;
    return this.scheduling.listSessionsForActor(toActor(req), {
      scope: scope === 'past' ? 'past' : 'upcoming',
      limit: Number.isFinite(cap) ? cap : 25,
      before: before ?? null,
      before_id: beforeId ?? null,
      after: after ?? null,
      after_id: afterId ?? null,
      statuses: parseStatusFilter(status),
    });
  }

  @ApiOperation({ summary: 'Get a single session by id' })
  @ApiResponse({ status: 200, description: 'Session.' })
  @Get('sessions/:id')
  async getSession(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.scheduling.getSession(toActor(req), id);
  }

  @ApiOperation({ summary: 'Request (or auto-book) a session with a coach' })
  @ApiResponse({ status: 201, description: 'Session requested or scheduled.' })
  @Post('sessions')
  async requestSession(@Request() req: AuthedRequest, @Body() body: RequestSessionDto) {
    return this.scheduling.requestSession(toActor(req), body);
  }

  @ApiOperation({ summary: 'Approve a requested session (coach only)' })
  @ApiResponse({ status: 200, description: 'Session approved and scheduled.' })
  @Post('sessions/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ApproveSessionDto,
  ) {
    return this.scheduling.approveSession(toActor(req), id, {
      expectedStartAt: body?.expected_start_at ?? null,
    });
  }

  @ApiOperation({ summary: 'Decline a requested session (coach only)' })
  @ApiResponse({ status: 200, description: 'Session declined.' })
  @Post('sessions/:id/decline')
  @HttpCode(HttpStatus.OK)
  async decline(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CancelSessionDto,
  ) {
    return this.scheduling.declineSession(toActor(req), id, body.reason, {
      expectedStartAt: body.expected_start_at ?? null,
    });
  }

  @ApiOperation({ summary: 'Reschedule a requested or scheduled session' })
  @ApiResponse({ status: 200, description: 'Session rescheduled.' })
  @Post('sessions/:id/reschedule')
  @HttpCode(HttpStatus.OK)
  async reschedule(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: RescheduleSessionDto,
  ) {
    return this.scheduling.rescheduleSession(toActor(req), id, body);
  }

  @ApiOperation({ summary: 'Cancel a session' })
  @ApiResponse({ status: 200, description: 'Session canceled.' })
  @Post('sessions/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CancelSessionDto,
  ) {
    return this.scheduling.cancelSession(toActor(req), id, body);
  }

  @ApiOperation({ summary: 'Mark a session complete (coach only)' })
  @ApiResponse({ status: 200, description: 'Session marked complete.' })
  @Post('sessions/:id/complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CompleteSessionDto,
  ) {
    return this.scheduling.completeSession(toActor(req), id, body);
  }

  @ApiOperation({ summary: 'Mark a session no-show (coach only)' })
  @ApiResponse({ status: 200, description: 'Session marked no-show.' })
  @Post('sessions/:id/no-show')
  @HttpCode(HttpStatus.OK)
  async noShow(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CancelSessionDto,
  ) {
    return this.scheduling.markNoShow(toActor(req), id, body.reason, {
      expectedStartAt: body.expected_start_at ?? null,
    });
  }

  @ApiOperation({
    summary: 'Attach a manual video link to a session (coach only)',
    description:
      'Sets video_provider=manual and stores the supplied https:// (or tel:) link. Allowed while the session is requested, confirmed, or waiting on a provider link; a session waiting on a provider link becomes confirmed. The client is notified when a confirmed session gets its link.',
  })
  @ApiResponse({ status: 200, description: 'Video link attached.' })
  @Post('sessions/:id/manual-video-link')
  @HttpCode(HttpStatus.OK)
  async attachManualLink(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: AttachManualVideoLinkDto,
  ) {
    return this.scheduling.attachManualVideoLink(toActor(req), id, body);
  }

  // ---------------- Open slots (Phase 1 — TGP-exclusive) ----------------

  @ApiOperation({
    summary: 'List concrete open slots for a coach in a date range',
    description:
      'Phase 1: materializes slots from TGP recurring availability, coach overrides, and active sessions. Phase 2 will optionally fold in Google Calendar free-busy when FEATURE_GOOGLE_CALENDAR_SYNC is on.',
  })
  @ApiResponse({ status: 200, description: 'Open slot list.' })
  @Get('coaches/:coachId/open-slots')
  async getOpenSlots(
    @Request() req: AuthedRequest,
    @Param('coachId') coachId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('duration_minutes') durationMinutes?: string,
    @Query('session_type_id') sessionTypeId?: string,
  ) {
    if (sessionTypeId !== undefined && !isUUID(sessionTypeId)) {
      throw new BadRequestException(
        schedulingError(
          SchedulingErrorCode.SESSION_TYPE_UNAVAILABLE,
          "That appointment type could not be found. Pick a type from your coach's list.",
        ),
      );
    }
    const parsed = durationMinutes !== undefined ? Number(durationMinutes) : null;
    return this.scheduling.getOpenSlots(toActor(req), coachId, {
      from,
      to,
      duration_minutes: parsed,
      session_type_id: sessionTypeId ?? null,
    });
  }

  // ---------------- Coach availability overrides ----------------

  @ApiOperation({ summary: "List the calling coach's availability overrides" })
  @ApiResponse({ status: 200, description: 'Overrides listed.' })
  @Get('coach/availability-overrides')
  async listMyAvailabilityOverrides(
    @Request() req: AuthedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.scheduling.listMyAvailabilityOverrides(toActor(req), {
      from,
      to,
    });
  }

  @ApiOperation({ summary: 'Create an availability override' })
  @ApiResponse({ status: 201, description: 'Override created.' })
  @Post('coach/availability-overrides')
  async createAvailabilityOverride(
    @Request() req: AuthedRequest,
    @Body() body: CreateAvailabilityOverrideDto,
  ) {
    return this.scheduling.createAvailabilityOverride(toActor(req), body);
  }

  @ApiOperation({ summary: 'Update an availability override (owner only)' })
  @ApiResponse({ status: 200, description: 'Override updated.' })
  @Patch('coach/availability-overrides/:id')
  async updateAvailabilityOverride(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateAvailabilityOverrideDto,
  ) {
    return this.scheduling.updateAvailabilityOverride(toActor(req), id, body);
  }

  @ApiOperation({ summary: 'Delete an availability override (owner only)' })
  @ApiResponse({ status: 200, description: 'Override deleted.' })
  @Delete('coach/availability-overrides/:id')
  @HttpCode(HttpStatus.OK)
  async deleteAvailabilityOverride(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.scheduling.deleteAvailabilityOverride(toActor(req), id);
  }
}

// Builds the audit-context shape the service expects from a Nest
// AuthedRequest. Mirrors the auditContext() helper in coach.controller
// but inlined here so this controller has no cross-module helper imports.
function toActor(req: AuthedRequest) {
  const xff = req.headers?.['x-forwarded-for'];
  const ip =
    (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ??
    req.ip ??
    req.socket?.remoteAddress ??
    null;
  const ua = req.headers?.['user-agent'];
  const userAgent = Array.isArray(ua) ? ua[0] : (ua ?? null);
  return {
    id: req.user.id,
    role: req.user.role as 'student' | 'coach' | 'owner',
    email: req.user.email ?? null,
    coach_id: req.user.coach_id ?? null,
    ip,
    userAgent,
  };
}

// S-SCHED-3 (C-634-3): ?status=requested or ?status=scheduled,pending_provider.
const LISTABLE_STATUSES: readonly SessionStatus[] = [
  'requested',
  'scheduled',
  'pending_provider',
  'declined',
  'canceled',
  'completed',
  'no_show',
];

function parseStatusFilter(raw: string | undefined): SessionStatus[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const parts = raw.split(',').map((p) => p.trim());
  const out: SessionStatus[] = [];
  for (const part of parts) {
    const match = LISTABLE_STATUSES.find((s) => s === part);
    if (!match || parts.length > LISTABLE_STATUSES.length) {
      throw new BadRequestException(
        schedulingError(
          SchedulingErrorCode.INVALID_LIST_QUERY,
          'The session status filter could not be read. Reload Calendar.',
        ),
      );
    }
    if (!out.includes(match)) out.push(match);
  }
  return out;
}
