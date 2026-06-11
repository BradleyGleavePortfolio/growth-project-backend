import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLER_ROUTE_LIMITS } from '../../throttler/throttler.config';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { AckFeatureFlagGuard } from './ack-flag.guard';
import { AckService } from './ack.service';
import { AckTransitionResponseDto } from './ack.dto';

/**
 * v2-2 coach ack-signal transitions.
 *
 * Coach-side-only signals: a coach advances a client message
 * `seen` → `acked` → `replied`. One endpoint per target keeps the action in
 * the URL (no client-supplied state to validate).
 *
 * Guard chain (mirrors the messages controller): JwtAuthGuard → RolesGuard
 * (gates to coach/owner — a client JWT gets 403) → CommunityFeatureFlagGuard
 * (community master switch) → AckFeatureFlagGuard (v2-2 kill switch: 404 when
 * FEATURE_COMMUNITY_ACKS is off). The service re-checks workspace coach
 * ownership so a coach in another workspace gets 403.
 */
@ApiTags('community')
@Controller('community/ack')
export class AckController {
  constructor(private readonly ack: AckService) {}

  @Post(':messageId/seen')
  @HttpCode(HttpStatus.OK)
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    AckFeatureFlagGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_MSG_EDIT_PER_MIN,
    },
  })
  async markSeen(
    @Request() req: AuthedRequest,
    @Param('messageId', new ParseUUIDPipe({ version: '4' }))
    messageId: string,
  ): Promise<AckTransitionResponseDto> {
    return this.ack.applyTransition(req.user, messageId, 'seen');
  }

  @Post(':messageId/acked')
  @HttpCode(HttpStatus.OK)
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    AckFeatureFlagGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_MSG_EDIT_PER_MIN,
    },
  })
  async markAcked(
    @Request() req: AuthedRequest,
    @Param('messageId', new ParseUUIDPipe({ version: '4' }))
    messageId: string,
  ): Promise<AckTransitionResponseDto> {
    return this.ack.applyTransition(req.user, messageId, 'acked');
  }

  @Post(':messageId/replied')
  @HttpCode(HttpStatus.OK)
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    AckFeatureFlagGuard,
  )
  @Roles('coach', 'owner')
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_MSG_EDIT_PER_MIN,
    },
  })
  async markReplied(
    @Request() req: AuthedRequest,
    @Param('messageId', new ParseUUIDPipe({ version: '4' }))
    messageId: string,
  ): Promise<AckTransitionResponseDto> {
    return this.ack.applyTransition(req.user, messageId, 'replied');
  }
}
