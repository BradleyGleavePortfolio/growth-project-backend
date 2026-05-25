import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { NoActiveSubCoachGuard } from '../common/guards/no-active-sub-coach.guard';
import { UpsertTeamProfileDto } from './team.dto';
import { UpdateRevenueSharingDto } from './dto/update-revenue-sharing.dto';
import { TeamService } from './team.service';

// Phase 8 — Coach team profile + member roster.
//
// All routes are mounted under /coach/team (not /v1/coach/team) so the
// mobile axios baseURL (`<host>/api`) resolves them at
// `<host>/api/coach/team/...`. Mirrors the rest of the mobile-facing
// /coach/* surface (CoachBilling, CoachAlerts, etc.).
//
// CoachGuard widens to OWNER per the Phase 1B contract, so platform
// admins can read any head coach's team via the same route (used by
// the admin web console).
@ApiTags('coach-team')
@Controller('coach/team')
@UseGuards(JwtAuthGuard, CoachGuard, NoActiveSubCoachGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  // GET /coach/team — head coach's profile, or 404 (mobile collapses to
  // "not_configured").
  //
  // A "team" is the head coach + their sub-coach roster construct.
  // Reads the requesting coach's own profile (scoped by req.user.id, no
  // coach_id query). NoActiveSubCoachGuard already blocks sub-coaches from
  // hitting this billing-adjacent surface; OWNER is included so on-call
  // support can read any head coach's team via the admin web console.
  // Students have no team and must not enumerate this endpoint.
  @Roles('coach', 'owner')
  @Get()
  async get(@Req() req: AuthedRequest) {
    return this.team.getProfile(req.user.id);
  }

  // PUT /coach/team — upsert business_name (+ optional team_code).
  //
  // Mutates the head coach's team config. The service scopes by
  // `headCoachId = req.user.id`; combined with NoActiveSubCoachGuard at
  // the class level (which throws 403 'sub_coach_billing_blocked' for any
  // active sub-coach), a sub-coach cannot reach this handler. OWNER is
  // included for platform admin support flows.
  @Roles('coach', 'owner')
  @Put()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async upsert(
    @Req() req: AuthedRequest,
    @Body() dto: UpsertTeamProfileDto,
  ) {
    return this.team.upsertProfile(req.user.id, {
      business_name: dto.business_name,
      team_code: dto.team_code,
    });
  }

  // GET /coach/team/members — head coach + every active sub-coach with
  // assigned/cap counts.
  //
  // Roster view scoped to the requesting head coach. Sub-coaches do not
  // have a roster of their own here (NoActiveSubCoachGuard would also
  // 403 them). Students have no semantic interpretation for this.
  @Roles('coach', 'owner')
  @Get('members')
  async members(@Req() req: AuthedRequest) {
    return this.team.listMembers(req.user.id);
  }

  // GET /coach/team/members/:sub_coach_id/revenue-sharing
  //
  // Reads the revenue-sharing flag for a single sub-coach. Service-side
  // `assertSubCoachRelationship(headCoachId, subCoachId)` ensures the
  // caller owns the target sub-coach; NoActiveSubCoachGuard blocks any
  // active sub-coach from inspecting their own (or anyone's) split.
  @Roles('coach', 'owner')
  @Get('members/:sub_coach_id/revenue-sharing')
  @UseGuards(JwtAuthGuard, NoActiveSubCoachGuard)
  async getRevenueSharing(
    @Req() req: AuthedRequest,
    @Param('sub_coach_id') subCoachId: string,
  ) {
    return this.team.getRevenueSharing(req.user.id, subCoachId);
  }

  // PATCH /coach/team/members/:sub_coach_id/revenue-sharing
  //
  // CRITICAL: alters the head_coach_split_bps override for a sub-coach.
  // A sub-coach must NEVER be able to set their own (or anyone's) split.
  // Two defences enforce this:
  //   1. NoActiveSubCoachGuard throws 403 'sub_coach_billing_blocked'
  //      before the handler runs for any user with an active
  //      teamSubCoachAssignment row.
  //   2. Service calls `assertSubCoachRelationship(req.user.id, subCoachId)`
  //      which verifies the caller is the head coach of the target.
  // OWNER is included for platform support; the global RolesGuard owner
  // bypass is also active.
  @Roles('coach', 'owner')
  @Patch('members/:sub_coach_id/revenue-sharing')
  @UseGuards(JwtAuthGuard, NoActiveSubCoachGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async setRevenueSharing(
    @Req() req: AuthedRequest,
    @Param('sub_coach_id') subCoachId: string,
    @Body() body: UpdateRevenueSharingDto,
  ) {
    return this.team.setRevenueSharing(req.user.id, subCoachId, body.enabled);
  }
}
