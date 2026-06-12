import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth-request';
import { aiTriageEnabled } from './ai-triage.feature';

/**
 * v2-4 kill switch for the community AI inbox-triage generation endpoint.
 *
 * When `FEATURE_COMMUNITY_AI_TRIAGE` is OFF the route stays REGISTERED (stable,
 * observable surface area) but this guard short-circuits with a byte-identical
 * 404 — indistinguishable from "no such route" to a caller, the desired
 * dark-launch posture and identical body shape to the ack kill-switch. A
 * single INFO log records the short-circuit without leaking caller identity
 * beyond the opaque user id.
 *
 * Mounted AFTER JwtAuthGuard + RolesGuard so req.user is populated for the log
 * line; ordering matches the ack + messages controller guard chains. Critically
 * the human inbox path does NOT use this guard, so flipping the flag off leaves
 * GET /community/me/coach-inbox fully functional.
 */
@Injectable()
export class AiTriageFeatureFlagGuard implements CanActivate {
  private readonly logger = new Logger(AiTriageFeatureFlagGuard.name);

  canActivate(context: ExecutionContext): boolean {
    if (aiTriageEnabled()) return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    this.logger.log(
      `ai-triage endpoint short-circuited reason=flag_off_disabled caller=${
        req.user?.id ?? 'anon'
      }`,
    );
    // 404 (not 503): the route is invisible while the flag is off. Body shape
    // mirrors the ack kill-switch so the two read identically off the wire.
    throw new NotFoundException({
      error: 'not_found',
      code: 'community.ai_triage.disabled',
    });
  }
}
