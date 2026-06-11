import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { COMMUNITY_DISABLED_BODY } from '../dto/disabled-response.dto';

/**
 * v3-1 challenge write kill-switch.
 *
 * Rides ON TOP of the master CommunityFeatureFlagGuard (FEATURE_COMMUNITY_API),
 * mirroring the v1-3 sibling guards in community-write-flag.guard.ts. Gates
 * challenge WRITE handlers only — joins, progress, opt-in, comments, coach CRUD.
 * GET handlers carry only the master guard so a participant's active progress
 * stays READABLE when the challenge surface is killed (brief kill-switch
 * requirement: "challenge tab hidden; active challenge progress remains
 * readable").
 *
 * FEATURE_COMMUNITY_CHALLENGES defaults OFF (execution plan v3-1 rollout): any
 * value other than the literal 'true' resolves to OFF, matching the
 * resolveWriteFlag convention v1-3 established.
 *
 * Defined locally (in src/community/challenges/**) rather than appended to the
 * shared write-flag file so the v3-1 slice owns its own kill switch outright and
 * never collides with the parallel events / ack lanes (R71).
 */
export const FEATURE_COMMUNITY_CHALLENGES = 'FEATURE_COMMUNITY_CHALLENGES';

export function resolveChallengesFlag(): boolean {
  return process.env[FEATURE_COMMUNITY_CHALLENGES] === 'true';
}

@Injectable()
export class CommunityChallengesEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (resolveChallengesFlag()) return true;
    throw new HttpException(
      COMMUNITY_DISABLED_BODY,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
