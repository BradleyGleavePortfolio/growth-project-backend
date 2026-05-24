import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AppRole,
  ROLES_KEY,
} from '../common/decorators/roles.decorator';

/**
 * Phase 1B RolesGuard.
 *
 * Reads required roles from the @Roles decorator, then matches them
 * against `req.user.role` (set upstream by JwtAuthGuard).
 *
 * ## Role hierarchy: owner > coach > student
 *
 * The guard enforces the documented hierarchy (docs/security/role-gating.md):
 *
 *   - `owner` passes any role-gated route — total bypass. Owners run the
 *     platform and must be able to hit every screen for support.
 *   - `coach` passes any route that permits `coach`, AND any route that
 *     permits `student` only. Coaches need access to student-level routes
 *     to manage their own profile / preferences / messaging / etc.
 *   - `student` passes only routes that explicitly permit `student`.
 *
 * Without the coach → student bypass, every student-tier route would need
 * `@Roles('student', 'coach', 'owner')` and developers would routinely
 * forget the extra entries, silently breaking the coach workflow.
 *
 * Designed to be additive — existing controllers using only
 * JwtAuthGuard + CoachGuard keep working. New controllers opt in by
 * adding `@Roles(...)` (and, since Phase 10, RolesGuard is globally
 * registered as APP_GUARD so @UseGuards(RolesGuard) is no longer required).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AppRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user || !user.role) {
      throw new ForbiddenException('Authenticated user required');
    }

    if (roleSatisfies(user.role as AppRole, required)) return true;

    throw new ForbiddenException('Insufficient role');
  }
}

/**
 * True when `actual` satisfies any of `required` under the
 * owner > coach > student hierarchy. Exported for unit-testing the
 * hierarchy itself in isolation from NestJS ExecutionContext plumbing.
 */
export function roleSatisfies(actual: AppRole, required: AppRole[]): boolean {
  // Owner is a total bypass.
  if (actual === 'owner') return true;
  // Direct match.
  if (required.includes(actual)) return true;
  // Coach inherits student permissions.
  if (actual === 'coach' && required.includes('student')) return true;
  return false;
}
