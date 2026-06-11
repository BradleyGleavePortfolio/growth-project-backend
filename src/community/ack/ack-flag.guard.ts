import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth-request';
import { acksEnabled } from './ack.feature';

/**
 * v2-2 kill switch for the coach ack transition endpoints.
 *
 * When `FEATURE_COMMUNITY_ACKS` is OFF the routes stay REGISTERED (so the
 * surface area is stable and observable) but this guard short-circuits with a
 * 404 — the endpoints are indistinguishable from "no such route" to a caller,
 * which is the desired dark-launch posture. A single INFO log
 * (`flag_off_disabled`) records the short-circuit for observability without
 * leaking the caller's identity beyond the opaque user id.
 *
 * Mounted AFTER JwtAuthGuard + RolesGuard so req.user is populated for the log
 * line; ordering matches the messages controller guard chain.
 */
@Injectable()
export class AckFeatureFlagGuard implements CanActivate {
  private readonly logger = new Logger(AckFeatureFlagGuard.name);

  canActivate(context: ExecutionContext): boolean {
    if (acksEnabled()) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    this.logger.log(
      `ack endpoint short-circuited reason=flag_off_disabled caller=${
        req.user?.id ?? 'anon'
      }`,
    );
    // 404 (not 503): the route is invisible while the flag is off.
    throw new NotFoundException({
      error: 'not_found',
      code: 'community.ack.disabled',
    });
  }
}
