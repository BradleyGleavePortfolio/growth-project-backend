import { Body, Controller, Get, Post, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachExerciseEnabledGuard } from './coach-exercise-flag.guard';
import { CoachExerciseService } from './coach-exercise.service';
import {
  CreateCoachExerciseDto,
  IssueMediaUploadDto,
} from './coach-exercise.dto';

/**
 * Coach custom-exercise library (FEATURE_CUSTOM_EXERCISE, default OFF).
 *
 * The backend half of the mobile custom-exercise authoring stack. Three
 * endpoints matching the merged mobile data layer's contract:
 *   - POST /coach-exercises/media/upload-url — presign a media upload URL.
 *   - POST /coach-exercises — durably create a library exercise after the
 *     upload (if any) is confirmed.
 *   - GET  /coach-exercises — list the caller-coach's own library.
 *
 * Guard layering mirrors the community voice-notes controller: every handler
 * carries the master auth guards (JwtAuthGuard + RolesGuard, @Roles coach/owner
 * — this is a coach-only surface) PLUS the slice CoachExerciseEnabledGuard so
 * the whole feature can be killed independently. The GET read carries the slice
 * guard too (coaches only — there is no public/student read surface to keep
 * readable mid-rollout, unlike the voice feed). Ownership is enforced in the
 * SERVICE (coach_id taken from req.user, never the body).
 */
@ApiTags('coach-exercises')
@Controller('coach-exercises')
@UseGuards(JwtAuthGuard, RolesGuard, CoachExerciseEnabledGuard)
@Roles('coach', 'owner')
export class CoachExerciseController {
  constructor(private readonly exercises: CoachExerciseService) {}

  @Post('media/upload-url')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async issueUploadUrl(
    @Request() req: AuthedRequest,
    @Body() body: IssueMediaUploadDto,
  ) {
    return this.exercises.issueUploadUrl(req.user, body);
  }

  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async create(
    @Request() req: AuthedRequest,
    @Body() body: CreateCoachExerciseDto,
  ) {
    return this.exercises.create(req.user, body);
  }

  @Get()
  async list(@Request() req: AuthedRequest) {
    return this.exercises.list(req.user);
  }
}
