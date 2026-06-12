import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { COMMUNITY_DISABLED_BODY } from '../dto/disabled-response.dto';

/**
 * v2-3 event write kill-switch — FEATURE_COMMUNITY_EVENTS.
 *
 * Sibling to the v1-3 write guards (CommunityPostsEnabledGuard etc.): it rides
 * ON TOP of the master CommunityFeatureFlagGuard and gates ONLY the event WRITE
 * handlers (create, update/transition, rsvp, replay, reflect). GET /events and
 * GET /events/:id are NEVER gated by it, so when the flag is off events still
 * render as READ-ONLY cards (kill-switch contract, execution plan v2-3 rollout)
 * and only the write paths return the typed disabled envelope with HTTP 503 —
 * identical to every other community kill switch so clients have ONE disabled
 * contract to handle.
 *
 * DEFAULT OFF: absent / any value other than the exact string 'true' → OFF,
 * matching resolveWriteFlag()'s convention in community-write-flag.guard.ts.
 *
 * Kept in src/community/events/ (this slice's OWNS surface) rather than appended
 * to the shared community-write-flag.guard.ts so the v2-3 lane introduces no
 * edit to a file the parallel lanes also touch.
 */
export const FEATURE_COMMUNITY_EVENTS = 'FEATURE_COMMUNITY_EVENTS';

export function resolveEventsFlag(): boolean {
  return process.env[FEATURE_COMMUNITY_EVENTS] === 'true';
}

@Injectable()
export class CommunityEventsEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (resolveEventsFlag()) return true;
    throw new HttpException(
      COMMUNITY_DISABLED_BODY,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
