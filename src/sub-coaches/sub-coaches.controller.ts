import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import {
  AcceptSubCoachInviteDto,
  InviteSubCoachDto,
  ReassignClientDto,
  RevokeSubCoachDto,
} from './sub-coaches.dto';
import { SubCoachesService } from './sub-coaches.service';

// Phase 8 — Top-level /sub-coaches surface for the mobile coach app.
//
// Differs from TeamModeController (which is mounted at /team/sub-coaches
// and includes the tier gate / Stripe staff seat path used by the
// existing v0 web admin). The mobile-facing version is plan-tier-agnostic
// at read time: any head coach can see their sub-coaches; invite + revoke
// fall through the same audit + reassignment guarantees the legacy path
// uses.
//
// All write routes are head-coach-only. Sub-coaches can read their own
// detail/analytics row (and owners can read everything) but cannot
// invite or revoke.
@ApiTags('sub-coaches')
@Controller('sub-coaches')
@UseGuards(JwtAuthGuard, CoachGuard)
export class SubCoachesController {
  constructor(private readonly subCoaches: SubCoachesService) {}

  // GET /sub-coaches — head-coach view of every active sub-coach.
  @Get()
  async list(@Req() req: AuthedRequest) {
    // Sub-coaches see an empty list (they have no team of their own
    // here). Owners see their own roster if they happen to have one.
    return this.subCoaches.list(req.user.id);
  }

  // GET /sub-coaches/:id — drill-in. Allowed for the head coach, for
  // the sub-coach themselves, and for owners.
  @Get(':id')
  async detail(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.subCoaches.detail(req.user.id, req.user.role ?? 'coach', id);
  }

  // GET /sub-coaches/:id/analytics — engagement score block.
  @Get(':id/analytics')
  async analytics(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.subCoaches.analytics(req.user.id, req.user.role ?? 'coach', id);
  }

  // POST /sub-coaches/:id/reassign-client — head-coach-only.
  @Post(':id/reassign-client')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @HttpCode(HttpStatus.OK)
  async reassign(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) toCoachId: string,
    @Body() dto: ReassignClientDto,
  ) {
    this.assertHeadCoach(req);
    return this.subCoaches.reassignClient(req.user.id, toCoachId, {
      clientId: dto.clientId,
      reason: dto.reason,
    });
  }

  // POST /sub-coaches/invites — head-coach-only outbound invite.
  @Post('invites')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  async invite(
    @Req() req: AuthedRequest,
    @Body() dto: InviteSubCoachDto,
  ) {
    this.assertHeadCoach(req);
    return this.subCoaches.invite(req.user.id, {
      email: dto.email,
      name: dto.name ?? null,
      max_clients: dto.max_clients ?? null,
    });
  }

  // POST /sub-coaches/invites/accept — authenticated coach accepts an
  // invite token. Idempotent on (caller, invite) pairs.
  @Post('invites/accept')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @HttpCode(HttpStatus.OK)
  async acceptInvite(
    @Req() req: AuthedRequest,
    @Body() dto: AcceptSubCoachInviteDto,
  ) {
    return this.subCoaches.accept(
      req.user.id,
      req.user.role ?? 'coach',
      req.user.email,
      dto.token,
    );
  }

  // POST /sub-coaches/:id/revoke — head-coach-only revoke + client
  // reassignment.
  @Post(':id/revoke')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RevokeSubCoachDto,
  ) {
    this.assertHeadCoach(req);
    return this.subCoaches.revoke(req.user.id, id, { reason: dto.reason });
  }

  // A "head coach" here means coach OR owner. Sub-coach users carry
  // role=coach so we cannot distinguish them by role alone — at the
  // service layer the (head_coach_id = req.user.id) filter enforces
  // that only the head coach whose team this is can hit the endpoint;
  // a sub-coach calling this would find no team to revoke from and
  // get a 404. The role check here is just a defence-in-depth gate
  // against students or unauthenticated calls slipping past the
  // CoachGuard.
  private assertHeadCoach(req: AuthedRequest): void {
    if (
      !req.user ||
      (req.user.role !== 'coach' && req.user.role !== 'owner')
    ) {
      throw new ForbiddenException({
        kind: 'head_coach_only',
        message: 'Only head coaches can invoke this endpoint.',
      });
    }
  }
}
