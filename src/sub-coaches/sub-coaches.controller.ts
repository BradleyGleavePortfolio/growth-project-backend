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
import { Roles } from '../common/decorators/roles.decorator';
import {
  AcceptSubCoachInviteDto,
  InviteSubCoachDto,
  ReassignClientDto,
  ReissueSubCoachInviteDto,
  RevokeSubCoachDto,
} from './sub-coaches.dto';
import { SubCoachesService } from './sub-coaches.service';
import { HeadCoachOnlyGuard } from './head-coach-only.guard';

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
  //
  // Service filters by (head_coach_id = req.user.id), so a sub-coach
  // calling this gets an empty list. Students must not enumerate the
  // roster (no semantic interpretation; reveals coach platform usage).
  // OWNER is included for platform admin reads.
  @Roles('coach', 'owner')
  @Get()
  async list(@Req() req: AuthedRequest) {
    // Sub-coaches see an empty list (they have no team of their own
    // here). Owners see their own roster if they happen to have one.
    return this.subCoaches.list(req.user.id);
  }

  // GET /sub-coaches/:id — drill-in. Allowed for the head coach, for
  // the sub-coach themselves, and for owners.
  //
  // Sub-coaches in TGP carry role='coach' (they are coach users with a
  // teamSubCoachAssignment row pointing at a head coach). The service-side
  // assertCanReadSubCoach() validates the caller is either the head coach,
  // the sub-coach themselves, or an owner. Students have no business
  // resolving a sub-coach UUID; gating by 'coach','owner' shuts that off.
  @Roles('coach', 'owner')
  @Get(':id')
  async detail(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.subCoaches.detail(req.user.id, req.user.role ?? 'coach', id);
  }

  // GET /sub-coaches/:id/analytics — engagement score block.
  //
  // Same authz model as detail(): service-side assertCanReadSubCoach()
  // restricts to (head coach of target | the target sub-coach | owner).
  // Students are not in that set and must not poll engagement scores.
  @Roles('coach', 'owner')
  @Get(':id/analytics')
  async analytics(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.subCoaches.analytics(req.user.id, req.user.role ?? 'coach', id);
  }

  // POST /sub-coaches/:id/reassign-client — head-coach-only.
  //
  // Moves a client from one sub-coach to another inside the caller's
  // team. Service scopes by (head_coach_id = req.user.id), so a peer
  // sub-coach calling this would find no matching team and 404 — plus
  // HeadCoachOnlyGuard + the in-handler assertHeadCoach() defence-in-depth
  // block non-coach roles before any DB work. Sub-coaches CANNOT reassign
  // their peers. Students are obviously not in scope.
  @Roles('coach', 'owner')
  @Post(':id/reassign-client')
  @UseGuards(JwtAuthGuard, HeadCoachOnlyGuard)
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
  //
  // Issues a sub-coach invite under the caller's team. Service stores
  // head_coach_id = req.user.id on the invite row. HeadCoachOnlyGuard +
  // assertHeadCoach() reject non-coach roles. A user holding role=coach
  // but who is themselves a sub-coach would still be allowed to invite
  // — that's a pre-existing product surface (a sub-coach who graduates
  // can build their own roster); not in scope for this PR.
  @Roles('coach', 'owner')
  @Post('invites')
  @UseGuards(JwtAuthGuard, HeadCoachOnlyGuard)
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
  //
  // Semantic note (verified against SubCoachInviteService.accept at
  // src/sub-coaches/sub-coach-invite.service.ts:225-230): the service
  // explicitly throws ForbiddenException('accept_role_not_coach') if the
  // caller's role is not 'coach' or 'owner'. The handler does NOT flip a
  // student into a coach — the user must already be a coach to accept.
  // Therefore the right gate is @Roles('coach','owner'), not 'student'.
  // Class-level CoachGuard would also block students; this metadata makes
  // the contract test and global RolesGuard agree.
  @Roles('coach', 'owner')
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

  // POST /sub-coaches/invites/:id/reissue — head-coach-only recovery
  // path when a sub-coach can't accept the original invite (typo'd
  // email, alias swap). Generates a fresh token + 14-day expiry on the
  // existing row, optionally rebinding the email.
  //
  // Service scopes by (head_coach_id = req.user.id) on the invite row,
  // so a peer sub-coach cannot reissue an invite that does not belong
  // to their (non-existent) team. HeadCoachOnlyGuard + assertHeadCoach()
  // are layered defences. Sub-coaches CANNOT reissue invites against
  // peers.
  @Roles('coach', 'owner')
  @Post('invites/:id/reissue')
  @UseGuards(JwtAuthGuard, HeadCoachOnlyGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @HttpCode(HttpStatus.OK)
  async reissueInvite(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReissueSubCoachInviteDto,
  ) {
    this.assertHeadCoach(req);
    return this.subCoaches.reissueInvite(req.user.id, id, {
      email: dto.email ?? null,
      name: dto.name ?? null,
    });
  }

  // POST /sub-coaches/:id/revoke — head-coach-only revoke + client
  // reassignment.
  //
  // Removes a sub-coach from the caller's team and bulk-reassigns their
  // clients. Service requires (head_coach_id = req.user.id, sub_coach_id
  // = :id) on teamSubCoachAssignment, so a peer sub-coach finds no
  // assignment and 404s. HeadCoachOnlyGuard + assertHeadCoach() block
  // non-coach roles. Sub-coaches CANNOT revoke their peers.
  @Roles('coach', 'owner')
  @Post(':id/revoke')
  @UseGuards(JwtAuthGuard, HeadCoachOnlyGuard)
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
