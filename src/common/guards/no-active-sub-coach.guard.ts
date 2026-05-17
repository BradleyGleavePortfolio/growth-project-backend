import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

@Injectable()
export class NoActiveSubCoachGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) return false;
    if (user.role === 'owner') return true;
    if (user.role !== 'coach') return true; // non-coaches handled elsewhere

    const isActiveSub = await this.prisma.teamSubCoachAssignment.count({
      where: { sub_coach_id: user.id, archived_at: null },
    });
    if (isActiveSub > 0) throw new ForbiddenException({ kind: 'sub_coach_billing_blocked', message: 'Sub-coaches cannot access billing or financial surfaces.' });
    return true;
  }
}
