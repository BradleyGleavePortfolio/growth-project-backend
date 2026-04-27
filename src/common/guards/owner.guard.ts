import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

// OWNER-only routes (platform admin). Used for endpoints the spec marks as
// "OWNER only" — e.g. starting a coach subscription, role promotions, audit.
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Authentication required');
    if (user.role === 'owner') return true;
    throw new ForbiddenException('Owner access required');
  }
}
