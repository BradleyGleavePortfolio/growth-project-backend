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
  @Get()
  async get(@Req() req: AuthedRequest) {
    return this.team.getProfile(req.user.id);
  }

  // PUT /coach/team — upsert business_name (+ optional team_code).
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
  @Get('members')
  async members(@Req() req: AuthedRequest) {
    return this.team.listMembers(req.user.id);
  }

  // GET /coach/team/members/:sub_coach_id/revenue-sharing
  @Get('members/:sub_coach_id/revenue-sharing')
  @UseGuards(JwtAuthGuard, NoActiveSubCoachGuard)
  async getRevenueSharing(
    @Req() req: AuthedRequest,
    @Param('sub_coach_id') subCoachId: string,
  ) {
    return this.team.getRevenueSharing(req.user.id, subCoachId);
  }

  // PATCH /coach/team/members/:sub_coach_id/revenue-sharing
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
