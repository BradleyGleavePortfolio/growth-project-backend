import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  GoneException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { CommunityService } from './community.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PostWinDto } from './community.dto';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import {
  CommunityFeatureFlagGuard,
  CommunityAlwaysReachable,
} from './community-feature-flag.guard';
import { CommunityWorkspaceParamsSchema } from './dto/community-workspace.dto';
import { CommunityCohortParamsSchema } from './dto/community-cohort.dto';

@ApiTags('community')
@Controller('community')
export class CommunityController {
  constructor(private communityService: CommunityService) {}

  // ── v1-2 foundation endpoints ──────────────────────────────────────────────
  // Guard order matches the brief: JwtAuthGuard → RolesGuard →
  // CommunityFeatureFlagGuard. JwtAuthGuard + RolesGuard are also registered
  // globally (APP_GUARD); listing them here is explicit and harmless (idempotent
  // canActivate), and keeps the route's contract readable at the handler.

  /** GET /community/me — caller's community state envelope (always reachable). */
  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @CommunityAlwaysReachable()
  async getMe(@Request() req: AuthedRequest) {
    return this.communityService.getMe(req.user);
  }

  /** GET /community/today — bounded Today envelope (always reachable). */
  @Get('today')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @CommunityAlwaysReachable()
  async getToday(@Request() req: AuthedRequest) {
    return this.communityService.getToday(req.user);
  }

  /** GET /community/workspaces/:workspaceId — gated (503 when flag off). */
  @Get('workspaces/:workspaceId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async getWorkspace(
    @Request() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
  ) {
    const { workspaceId: id } = CommunityWorkspaceParamsSchema.parse({
      workspaceId,
    });
    return this.communityService.getWorkspace(req.user, id);
  }

  /** GET /community/cohorts — gated. Scope is server-derived (gap G14). */
  @Get('cohorts')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async getCohorts(@Request() req: AuthedRequest) {
    return this.communityService.getCohorts(req.user);
  }

  /** GET /community/cohorts/:cohortId — gated. */
  @Get('cohorts/:cohortId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async getCohort(
    @Request() req: AuthedRequest,
    @Param('cohortId') cohortId: string,
  ) {
    const { cohortId: id } = CommunityCohortParamsSchema.parse({ cohortId });
    return this.communityService.getCohort(req.user, id);
  }

  // ── Legacy v0 endpoints (preserved) ─────────────────────────────────────────
  // These keep their original {JwtAuthGuard, ClientEntitlementGuard, RolesGuard}
  // + @Roles('student') stack, moved from the class level so the new endpoints
  // above can use the community feature-flag guard without inheriting the
  // client-entitlement gate.

  /**
   * GET /community/leaderboard
   * Returns workout-volume leaderboard for the caller's coach roster.
   */
  @Get('leaderboard')
  @UseGuards(JwtAuthGuard, ClientEntitlementGuard, RolesGuard)
  @Roles('student')
  async getLeaderboard(
    @Request() req: AuthedRequest,
    @Query('period') period?: 'week' | 'month',
  ) {
    return this.communityService.getLeaderboard(req.user.id, period || 'week');
  }

  /**
   * GET /community/feed
   * Returns the last 30 anonymised community wins.
   * Response: [{ id, displayName, action, createdAt }]
   */
  @Get('feed')
  @UseGuards(JwtAuthGuard, ClientEntitlementGuard, RolesGuard)
  @Roles('student')
  async getFeed(@Request() req: AuthedRequest) {
    return this.communityService.getFeed(req.user.id);
  }

  /**
   * POST /community/wins
   * Creates a new community win entry for the current user.
   * Body: { title, description, visibility?: "circle" | "public" }
   */
  @Post('wins')
  @UseGuards(JwtAuthGuard, ClientEntitlementGuard, RolesGuard)
  @Roles('student')
  async postWin(@Request() req: AuthedRequest, @Body() body: PostWinDto) {
    return this.communityService.postWin(req.user.id, body);
  }

  /**
   * POST /community/wins/:id/react — REMOVED (doctrine cleanup).
   * Per-Win reactions are no longer part of the product surface; the route
   * returns 410 Gone for one mobile release window before being deleted.
   */
  // TODO: remove route entirely after one mobile release window.
  @Post('wins/:id/react')
  @UseGuards(JwtAuthGuard, ClientEntitlementGuard, RolesGuard)
  @Roles('student')
  @HttpCode(410)
  async reactToWin() {
    throw new GoneException(
      'This endpoint has been removed. Reactions on community wins are no longer part of the product surface.',
    );
  }
}
