/**
 * GET /roman/context/me — disclosure endpoint (PLAN_roman_intelligence §2.3,
 * slice R3): the signed-in client can see exactly what Roman is grounded in.
 *
 * Own data only: the subject is `req.user.id`, there is no parameter. Behind
 * the same guards as every /roman route (404 while the feature flag is off).
 * Students only — the coach surface gets no client data at launch.
 */

import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../auth/auth.guard';
import type { AuthedRequest } from '../../auth/auth-request';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RomanFeatureGuard } from '../roman-feature.guard';
import { RomanClientContextService } from './roman-client-context.service';

@Controller('roman/context')
@UseGuards(JwtAuthGuard, RolesGuard, RomanFeatureGuard)
export class RomanContextController {
  constructor(private readonly context: RomanClientContextService) {}

  @Get('me')
  @Roles('student')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async me(@Req() req: AuthedRequest) {
    const bundle = await this.context.buildFresh({ id: req.user.id, role: req.user.role });
    return {
      version: bundle.context.version,
      as_of: bundle.generated_at.toISOString(),
      estimated_tokens: bundle.estimated_tokens,
      context: bundle.context,
    };
  }
}
