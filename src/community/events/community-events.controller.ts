import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { CommunityEventsEnabledGuard } from './community-events-flag.guard';
import { CommunityEventsService } from './community-events.service';
import {
  AttachReplayDto,
  CreateEventDto,
  ListEventsQueryDto,
  RsvpEventDto,
  UpdateEventDto,
} from '../dto/community-event.dto';

/**
 * Community events (v2-3).
 *
 * Reads (GET) carry only the master CommunityFeatureFlagGuard so events survive
 * a write kill switch as read-only cards. Writes additionally carry
 * CommunityEventsEnabledGuard (FEATURE_COMMUNITY_EVENTS, default OFF) — when off
 * they return the typed 503 disabled envelope. Coach-only writes are enforced in
 * the service (assertCoach) on top of the @Roles gate, because workspace
 * ownership — not the global role — is the real authority for a given event.
 */
@ApiTags('community')
@Controller('community')
export class CommunityEventsController {
  constructor(private readonly events: CommunityEventsService) {}

  @Post('workspaces/:workspaceId/events')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityEventsEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_EVENTS_PER_MIN,
    },
  })
  async create(
    @Request() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateEventDto,
  ) {
    return this.events.create(req.user, workspaceId, body);
  }

  @Get('workspaces/:workspaceId/events')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async list(
    @Request() req: AuthedRequest,
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListEventsQueryDto,
  ) {
    return this.events.list(req.user, workspaceId, query);
  }

  @Get('events/:eventId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async getOne(
    @Request() req: AuthedRequest,
    @Param('eventId') eventId: string,
  ) {
    return this.events.getOne(req.user, eventId);
  }

  @Patch('events/:eventId')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityEventsEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_EVENTS_PER_MIN,
    },
  })
  async update(
    @Request() req: AuthedRequest,
    @Param('eventId') eventId: string,
    @Body() body: UpdateEventDto,
  ) {
    return this.events.update(req.user, eventId, body);
  }

  @Post('events/:eventId/rsvp')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityEventsEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_EVENT_RSVP_PER_MIN,
    },
  })
  async rsvp(
    @Request() req: AuthedRequest,
    @Param('eventId') eventId: string,
    @Body() body: RsvpEventDto,
  ) {
    return this.events.rsvp(req.user, eventId, body.status);
  }

  @Post('events/:eventId/replay')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityEventsEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_EVENTS_PER_MIN,
    },
  })
  async attachReplay(
    @Request() req: AuthedRequest,
    @Param('eventId') eventId: string,
    @Body() body: AttachReplayDto,
  ) {
    return this.events.attachReplay(req.user, eventId, body.replay_url);
  }

  @Post('events/:eventId/reflect')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityEventsEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_EVENTS_PER_MIN,
    },
  })
  async reflect(
    @Request() req: AuthedRequest,
    @Param('eventId') eventId: string,
  ) {
    return this.events.reflect(req.user, eventId);
  }
}
