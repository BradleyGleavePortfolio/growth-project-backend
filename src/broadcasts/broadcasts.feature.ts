import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

/**
 * A4-MSG-BROADCAST kill switch.
 *
 * FEATURE_COACH_BROADCASTS defaults OFF: any value other than the literal
 * 'true' is off. It gates every A4 coach route (broadcasts, segment preview,
 * cards, saved replies, client tags) and the dispatcher tick. The flag is
 * read on every request / tick (never boot-cached) so a runtime kill takes
 * effect without a redeploy. Registered in ENV_RULES and the launch-flag
 * manifest (.github/fly-env-desired-state.json) as "unset".
 *
 * Kill semantics: turning the flag off stops new occurrences AND parks
 * in-flight deliveries (the dispatcher does nothing). Turning it back on
 * resumes them; rows already delivered are never re-sent (unique keys).
 */
export const FEATURE_COACH_BROADCASTS = 'FEATURE_COACH_BROADCASTS';

export function coachBroadcastsEnabled(): boolean {
  return process.env[FEATURE_COACH_BROADCASTS] === 'true';
}

export const BROADCASTS_DISABLED_BODY = {
  code: 'broadcasts.disabled',
  message:
    'Broadcasts are not available on your account yet. Your messages to clients still work as usual.',
} as const;

@Injectable()
export class CoachBroadcastsEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (coachBroadcastsEnabled()) return true;
    throw new HttpException(BROADCASTS_DISABLED_BODY, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
