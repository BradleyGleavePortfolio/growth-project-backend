import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class HeadCoachOnlyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) return false;
    if (user.role === 'owner') return true;
    if (user.role !== 'coach') throw new ForbiddenException({ kind: 'head_coach_only' });

    const activeSubRows = await this.prisma.teamSubCoachAssignment.count({
      where: { sub_coach_id: user.id, archived_at: null },
    });
    if (activeSubRows > 0) throw new ForbiddenException({ kind: 'head_coach_only', message: 'Sub-coaches cannot perform this action.' });
    return true;
  }
}
