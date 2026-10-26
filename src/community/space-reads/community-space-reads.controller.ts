/**
 * SC-BE2: the space chat's read line and the person's notification setting for a space. Gated by the
 * community API switch (CommunityFeatureFlagGuard). Access is the messages routes' check; a space the caller
 * cannot read now (another coach's, a members-only space they are not in, a ban) answers 404 like an unknown one.
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import {
  CommunitySpaceReadsService,
  NOTIFY_MODES,
  SILENCE_HOURS,
  type NotifyMode,
  type SpaceNotifySetting,
  type SpaceRead,
} from './community-space-reads.service';

export class MarkSpaceReadDto {
  @IsUUID()
  message_id!: string;
}

export class SetSpaceNotifyDto {
  @IsIn(NOTIFY_MODES)
  mode!: NotifyMode;
}

export class SilenceSpaceDto {
  @IsIn(SILENCE_HOURS)
  hours!: (typeof SILENCE_HOURS)[number];
}

@ApiTags('community')
@Controller('community/cohorts/:cohortId')
@UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
@Roles('student', 'coach', 'owner')
export class CommunitySpaceReadsController {
  constructor(private readonly reads: CommunitySpaceReadsService) {}

  @Get('read')
  getRead(@Request() req: AuthedRequest, @Param('cohortId', ParseUUIDPipe) cohortId: string): Promise<SpaceRead> {
    return this.reads.getRead(req.user, cohortId);
  }

  /** Moves the read line forward; an older message is a no-op (200, the line as it stands). */
  @Post('read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @Request() req: AuthedRequest,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @Body() body: MarkSpaceReadDto,
  ): Promise<SpaceRead> {
    return this.reads.markRead(req.user, cohortId, body.message_id);
  }

  @Get('notifications')
  getNotify(@Request() req: AuthedRequest, @Param('cohortId', ParseUUIDPipe) cohortId: string): Promise<SpaceNotifySetting> {
    return this.reads.getNotify(req.user, cohortId);
  }

  @Put('notifications')
  setMode(
    @Request() req: AuthedRequest,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @Body() body: SetSpaceNotifyDto,
  ): Promise<SpaceNotifySetting> {
    return this.reads.setNotify(req.user, cohortId, { notify_mode: body.mode });
  }

  /** Mute all for 1, 8 or 24 hours, then back to the chosen mode. */
  @Post('notifications/silence')
  @HttpCode(HttpStatus.OK)
  silence(
    @Request() req: AuthedRequest,
    @Param('cohortId', ParseUUIDPipe) cohortId: string,
    @Body() body: SilenceSpaceDto,
  ): Promise<SpaceNotifySetting> {
    return this.reads.setNotify(req.user, cohortId, { silenced_until: new Date(Date.now() + body.hours * 3_600_000) });
  }

  @Delete('notifications/silence')
  unsilence(@Request() req: AuthedRequest, @Param('cohortId', ParseUUIDPipe) cohortId: string): Promise<SpaceNotifySetting> {
    return this.reads.setNotify(req.user, cohortId, { silenced_until: null });
  }
}
