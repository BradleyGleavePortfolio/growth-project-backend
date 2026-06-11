import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { PlanContextService, planTagsEnabled } from './plan-context.service';
import {
  ResolvePlanContextQuerySchema,
  ResolvePlanContextResponseSchema,
} from './plan-context.dto';

/**
 * v2-1 plan-context read surface.
 *
 * GET /community/plan-context/resolve?type=...&id=...[&week_index&day_index
 * &exercise_id&meal_id] returns the render snapshot a client previews before
 * (or while) attaching a plan-context tag to a message.
 *
 * Guard order mirrors the messages controller: JwtAuthGuard → RolesGuard →
 * CommunityFeatureFlagGuard (community master switch). Plans/packages/check-ins
 * are coach-owned, so the route is coach/owner only (RolesGuard + @Roles).
 *
 * Feature flag (FEATURE_COMMUNITY_PLAN_TAGS, default OFF): when OFF the route
 * 404s across the board — the per-tag-type kill switch the brief requires —
 * without leaking whether a referenced entity exists. When ON, the service
 * applies the ownership gate (foreign/missing → 404).
 */
@ApiTags('community')
@Controller('community/plan-context')
export class PlanContextController {
  constructor(private readonly planContext: PlanContextService) {}

  @Get('resolve')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('coach', 'owner')
  async resolve(@Request() req: AuthedRequest, @Query() query: unknown) {
    // Flag off → the resolve surface is dark. 404 (not 503) so the route is
    // indistinguishable from an unknown id when the feature is not live.
    if (!planTagsEnabled()) {
      throw new NotFoundException({
        error: 'not_found',
        code: 'community.plan_context.not_found',
      });
    }
    const parsed = ResolvePlanContextQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_PLAN_CONTEXT_QUERY',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    const snapshot = await this.planContext.resolve(req.user, parsed.data);
    return ResolvePlanContextResponseSchema.parse({ snapshot });
  }
}
