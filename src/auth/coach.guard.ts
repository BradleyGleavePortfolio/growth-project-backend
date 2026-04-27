import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';

@Injectable()
export class CoachGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Phase 1B: OWNER bypass. Owners are platform admins and can hit
    // every coach-only route (manage any roster, view any dashboard).
    // The narrow rule before this change rejected owners with a 403.
    if (!user || (user.role !== 'coach' && user.role !== 'owner')) {
      throw new ForbiddenException('Coach access required');
    }

    return true;
  }
}
