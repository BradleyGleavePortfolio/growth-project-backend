import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { COMMUNITY_DISABLED_BODY } from '../dto/disabled-response.dto';

/**
 * v3-4 community-search kill-switch.
 *
 * Rides ON TOP of the master CommunityFeatureFlagGuard (FEATURE_COMMUNITY_API),
 * mirroring the v3-2 classroom + v3-3 voice siblings. Gates the search query
 * endpoint AND the indexer's admin reindex endpoint. The flag is read at the
 * call site every request (never boot-cached) so a runtime kill takes effect
 * without a redeploy.
 *
 * FEATURE_COMMUNITY_SEARCH defaults OFF (execution plan v3-4 rollout): any value
 * other than the literal 'true' resolves to OFF, matching the
 * resolveVoiceNotesFlag / resolveClassroomFlag convention.
 *
 * Defined locally (in src/community/search/**) so the v3-4 slice owns its own
 * kill switch outright and never collides with the parallel lanes (R77 scope).
 */
export const FEATURE_COMMUNITY_SEARCH = 'FEATURE_COMMUNITY_SEARCH';

export function resolveCommunitySearchFlag(): boolean {
  return process.env[FEATURE_COMMUNITY_SEARCH] === 'true';
}

@Injectable()
export class CommunitySearchEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (resolveCommunitySearchFlag()) return true;
    throw new HttpException(
      COMMUNITY_DISABLED_BODY,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
