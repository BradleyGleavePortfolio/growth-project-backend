import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import { CommunityVoiceEnabledGuard } from './community-voice-flag.guard';
import { CommunityVoiceService } from './community-voice.service';
import {
  CreateVoiceNoteDto,
  IssueVoiceUploadDto,
  ListVoiceNotesQueryDto,
} from './community-voice.dto';

/**
 * Community voice notes (v3-3) — audio attachments into cohort / workspace-hall
 * channels and DM threads.
 *
 * Guard layering mirrors the v3-2 classroom controller. The two WRITE-path
 * handlers (issue an upload URL, durably create a note) carry the master
 * CommunityFeatureFlagGuard PLUS the slice CommunityVoiceEnabledGuard
 * (FEATURE_COMMUNITY_VOICE_NOTES, default off) so the authoring surface can be
 * killed independently of the read surface. The feed + detail GET handlers and
 * DELETE carry ONLY the master guard, so already-published notes stay readable
 * (and removable by their author) if the authoring flag is flipped off
 * mid-rollout. Membership / coach authority is enforced in the SERVICE, not by
 * @Roles alone, because students must reach the read + create routes. Write
 * limits reuse the existing community throttle buckets (no new config).
 */
@ApiTags('community')
@Controller('community')
export class CommunityVoiceController {
  constructor(private readonly voice: CommunityVoiceService) {}

  // ── Write (master + slice flag guard) ────────────────────────────────────────

  @Post('workspaces/:workspaceId/voice-notes/upload-url')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityVoiceEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN,
    },
  })
  async issueUploadUrl(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Body() body: IssueVoiceUploadDto,
  ) {
    return this.voice.issueUploadUrl(req.user, workspaceId, body);
  }

  @Post('workspaces/:workspaceId/voice-notes')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    CommunityFeatureFlagGuard,
    CommunityVoiceEnabledGuard,
  )
  @Roles('student', 'coach', 'owner')
  @Throttle({
    default: {
      ttl: 60_000,
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN,
    },
  })
  async create(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Body() body: CreateVoiceNoteDto,
  ) {
    return this.voice.create(req.user, workspaceId, body);
  }

  // ── Reads (master guard only) ────────────────────────────────────────────────

  @Get('workspaces/:workspaceId/voice-notes')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async list(
    @Request() req: AuthedRequest,
    @Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
    workspaceId: string,
    @Query() query: ListVoiceNotesQueryDto,
  ) {
    return this.voice.list(req.user, workspaceId, query);
  }

  @Get('voice-notes/:voiceNoteId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  async getOne(
    @Request() req: AuthedRequest,
    @Param('voiceNoteId', new ParseUUIDPipe({ version: '4' }))
    voiceNoteId: string,
  ) {
    return this.voice.getOne(req.user, voiceNoteId);
  }

  // ── Delete (master guard only — author/coach can always retract) ──────────────

  @Delete('voice-notes/:voiceNoteId')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @HttpCode(200)
  async remove(
    @Request() req: AuthedRequest,
    @Param('voiceNoteId', new ParseUUIDPipe({ version: '4' }))
    voiceNoteId: string,
  ) {
    return this.voice.delete(req.user, voiceNoteId);
  }
}
