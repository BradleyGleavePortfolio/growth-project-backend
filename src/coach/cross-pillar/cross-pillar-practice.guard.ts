import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth-request';

/**
 * CrossPillarPracticeGuard
 *
 * Stage-3 gate for the coach-facing cross-pillar federation surface
 * (`/api/coach/cross-pillar/*`). The federation orchestration itself is
 * unchanged from the OWNER-gated admin path — `FederationService` does
 * the same fitness-Postgres + finance-backend join for both audiences.
 * What differs is *who* may call it:
 *
 *   - OWNER routes (`/api/admin/federation/*`) accept any authenticated
 *     OWNER session. RolesGuard handles that.
 *   - Coach routes here accept any coach OR owner whose stored
 *     `coach_practice_type === 'both'`. A coach with `fitness_only` /
 *     `finance_only` / `null` is rejected with `403 PRACTICE_NOT_BOTH`
 *     so the mobile app routes them through the practice-selection
 *     flow rather than rendering a broken cross-pillar screen.
 *
 * The guard runs *after* JwtAuthGuard + CoachGuard, so:
 *   - The user is authenticated.
 *   - `req.user.role` is `'coach'` or `'owner'`.
 *   - Cross-pillar access is the only thing this guard enforces.
 *
 * Owners are NOT auto-allowed regardless of practice type: a platform
 * owner who runs a fitness-only practice should not see cross-pillar
 * data unless they explicitly opt in. The cross-pillar UI is a coach
 * tool, not an admin tool — admins use `/api/admin/federation/*`.
 */
@Injectable()
export class CrossPillarPracticeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const user = req.user;

    if (!user) {
      // Defensive: JwtAuthGuard should have populated this. If not,
      // surface a 403 rather than a NPE.
      throw new ForbiddenException({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
    }

    const practice = (user as { coach_practice_type?: string | null })
      .coach_practice_type;

    if (practice === 'both') {
      return true;
    }

    if (!practice) {
      throw new ForbiddenException({
        error:
          'Cross-pillar access requires a "both" practice type. Choose your practice in Settings to enable.',
        code: 'PRACTICE_NOT_SELECTED',
      });
    }

    throw new ForbiddenException({
      error:
        'Cross-pillar access is reserved for coaches whose practice spans both Body and Wealth. Update your practice type in Settings.',
      code: 'PRACTICE_NOT_BOTH',
      current: practice,
    });
  }
}
