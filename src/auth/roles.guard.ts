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
 * against `req.user.role` (set upstream by JwtAuthGuard). OWNER role is
 * an automatic pass-through: an OWNER can hit any route a coach or
 * student can hit. This is the single point we enforce the
 * OWNER > COACH > STUDENT hierarchy so feature controllers do not
 * each re-implement the bypass.
 *
 * Designed to be additive — existing controllers using only
 * JwtAuthGuard + CoachGuard keep working. New controllers opt in by
 * adding `@Roles(...)` + `@UseGuards(JwtAuthGuard, RolesGuard)`.
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

    if (user.role === 'owner') return true;
    if (required.includes(user.role as AppRole)) return true;

    throw new ForbiddenException('Insufficient role');
  }
}
