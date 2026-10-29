/**
 * LEAVE-MUTE-BE (agent 176; owner D2): leave or join again a space, mute or leave a thread, and who left a
 * space. Gated by the community API switch (CommunityFeatureFlagGuard). A space the caller cannot read now
 * answers 404 like an unknown one (the b#1137 rule).
 */
import { Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import type { LeftMembers, SpaceLeave, ThreadState, ThreadStates } from './community-leave-mute.dto';
import { CommunityLeaveMuteService } from './community-leave-mute.service';

@ApiTags('community')
@Controller('community/cohorts/:cohortId')
@UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
@Roles('student', 'coach', 'owner')
export class CommunityLeaveMuteController {
  constructor(private readonly leaveMute: CommunityLeaveMuteService) {}

  /** 409 community.space.cannot_leave for Announcements, a section heading, and the coach's own space. */
  @Post('leave')
  @HttpCode(HttpStatus.OK)
  async leave(@Request() req: AuthedRequest, @Param('cohortId', ParseUUIDPipe) cohortId: string): Promise<SpaceLeave> {
    return this.leaveMute.leave(req.user, cohortId);
  }

  @Post('join')
  @HttpCode(HttpStatus.OK)
  async join(@Request() req: AuthedRequest, @Param('cohortId', ParseUUIDPipe) cohortId: string): Promise<SpaceLeave> {
    return this.leaveMute.join(req.user, cohortId);
  }

  /** The people who left this space (the "{name} left" line in its chat). */
  @Get('left')
  async left(@Request() req: AuthedRequest, @Param('cohortId', ParseUUIDPipe) cohortId: string): Promise<LeftMembers> {
    return this.leaveMute.leftMembers(req.user, cohortId);
  }

  /** The caller's muted and left threads in this space. */
  @Get('threads')
  async threads(@Request() req: AuthedRequest, @Param('cohortId', ParseUUIDPipe) cohortId: string): Promise<ThreadStates> {
    return this.leaveMute.threadStates(req.user, cohortId);
  }

  @Put('threads/:messageId/mute')
  async mute(
    @Request() req: AuthedRequest,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<ThreadState> {
    return this.leaveMute.setThread(req.user, cohortId, messageId, 'muted');
  }

  @Delete('threads/:messageId/mute')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unmute(
    @Request() req: AuthedRequest,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<void> {
    return this.leaveMute.clearThread(req.user, cohortId, messageId, 'muted');
  }

  @Put('threads/:messageId/leave')
  async leaveThread(
    @Request() req: AuthedRequest,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<ThreadState> {
    return this.leaveMute.setThread(req.user, cohortId, messageId, 'left');
  }

  /** Follow the thread again. */
  @Delete('threads/:messageId/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  async follow(
    @Request() req: AuthedRequest,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<void> {
    return this.leaveMute.clearThread(req.user, cohortId, messageId, 'left');
  }
}
