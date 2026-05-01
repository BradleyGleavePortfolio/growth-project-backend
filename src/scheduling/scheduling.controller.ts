import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import {
  AttachManualVideoLinkDto,
  CancelSessionDto,
  CompleteSessionDto,
  CreateSessionTypeDto,
  RequestSessionDto,
  RescheduleSessionDto,
  SetAvailabilityDto,
  UpdateSessionTypeDto,
} from './dto/scheduling.dto';
import { SchedulingService } from './scheduling.service';

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
@ApiTags('scheduling')
@Controller('scheduling')
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  // ---------------- Session types ----------------

  @ApiOperation({ summary: "List a coach's session types" })
  @ApiResponse({ status: 200, description: 'Session types listed.' })
  @Get('coaches/:coachId/session-types')
  async listSessionTypes(@Param('coachId') coachId: string) {
    return this.scheduling.listSessionTypes(coachId);
  }

  @ApiOperation({ summary: 'Create a session type for the calling coach' })
  @ApiResponse({ status: 201, description: 'Session type created.' })
  @Post('session-types')
  async createSessionType(
    @Request() req: AuthedRequest,
    @Body() body: CreateSessionTypeDto,
  ) {
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
  @Get('coaches/:coachId/availability')
  async getAvailability(@Param('coachId') coachId: string) {
    return this.scheduling.getAvailability(coachId);
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
    summary: 'List the calling user\'s upcoming sessions',
    description:
      'Owners see all upcoming, coaches see their roster, clients see their own.',
  })
  @ApiResponse({ status: 200, description: 'Upcoming sessions.' })
  @Get('sessions')
  async listUpcoming(
    @Request() req: AuthedRequest,
    @Query('limit') limit?: string,
  ) {
    const cap = limit ? parseInt(limit, 10) : 25;
    return this.scheduling.listUpcomingForActor(toActor(req), cap);
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
  async requestSession(
    @Request() req: AuthedRequest,
    @Body() body: RequestSessionDto,
  ) {
    return this.scheduling.requestSession(toActor(req), body);
  }

  @ApiOperation({ summary: 'Approve a requested session (coach only)' })
  @ApiResponse({ status: 200, description: 'Session approved and scheduled.' })
  @Post('sessions/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.scheduling.approveSession(toActor(req), id);
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
    return this.scheduling.declineSession(toActor(req), id, body.reason);
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
    return this.scheduling.markNoShow(toActor(req), id, body.reason);
  }

  @ApiOperation({
    summary: 'Attach a manual video link to a session (coach only)',
    description:
      'Sets video_provider=manual and stores the supplied URL verbatim. Reminder jobs will not re-mint a provider link.',
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
  const userAgent = Array.isArray(ua) ? ua[0] : ua ?? null;
  return {
    id: req.user.id,
    role: req.user.role as 'student' | 'coach' | 'owner',
    email: req.user.email ?? null,
    coach_id: req.user.coach_id ?? null,
    ip,
    userAgent,
  };
}
