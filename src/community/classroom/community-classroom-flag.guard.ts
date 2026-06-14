import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { COMMUNITY_DISABLED_BODY } from '../dto/disabled-response.dto';

/**
 * v3-2 classroom-posts kill-switch.
 *
 * Rides ON TOP of the master CommunityFeatureFlagGuard (FEATURE_COMMUNITY_API),
 * mirroring the v3-1 sibling in community-challenges-flag.guard.ts. Gates the
 * classroom WRITE handlers (coach create / edit / publish / pin / archive /
 * media attach). The feed + detail GET handlers carry ONLY the master guard so
 * a student's already-released lessons stay READABLE if the authoring surface
 * is killed mid-rollout.
 *
 * FEATURE_COMMUNITY_CLASSROOM_POSTS defaults OFF (execution plan v3-2 rollout):
 * any value other than the literal 'true' resolves to OFF, matching the
 * resolveChallengesFlag convention v3-1 established. The flag is read at the
 * call site every request (never boot-cached) so a runtime kill takes effect
 * without a redeploy.
 *
 * Defined locally (in src/community/classroom/**) rather than appended to the
 * shared write-flag file so the v3-2 slice owns its own kill switch outright and
 * never collides with the parallel v3-3 voice lane (R71 / R77 scope).
 */
export const FEATURE_COMMUNITY_CLASSROOM_POSTS =
  'FEATURE_COMMUNITY_CLASSROOM_POSTS';

export function resolveClassroomFlag(): boolean {
  return process.env[FEATURE_COMMUNITY_CLASSROOM_POSTS] === 'true';
}

@Injectable()
export class CommunityClassroomEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (resolveClassroomFlag()) return true;
    throw new HttpException(
      COMMUNITY_DISABLED_BODY,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
