import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

// Allows callers whose role is COACH or OWNER. OWNER is the platform admin
// (Tier 0 in the spec) and bypasses every coach-scoping check; COACH is a
// paying tenant scoped to their own roster. STUDENTs are rejected here so
// every coach console route fails closed by default.
@Injectable()
export class CoachOrOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Authentication required');
    if (user.role === 'coach' || user.role === 'owner') return true;
    throw new ForbiddenException('Coach or owner access required');
  }
}
