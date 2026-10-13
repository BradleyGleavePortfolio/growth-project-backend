import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// HirerVerifiedGuard — gates the JobListing write surface to a verified hirer.
// "Verified" reuses existing coach-surface signals rather than a new flag:
//   - role=owner    → always verified (mirrors the OWNER bypass elsewhere).
//   - role=coach    → must NOT be a sub-coach (non-archived
//                     TeamSubCoachAssignment). Covers solo + head coaches.
//                     No coach subscription check (owner TM-P1: no plans).
// Students and sub-coaches are rejected.
@Injectable()
export class HirerVerifiedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException({ kind: 'hirer_not_verified' });

    // Gym owner — always verified.
    if (user.role === 'owner') return true;

    if (user.role !== 'coach') {
      throw new ForbiddenException({ kind: 'hirer_not_verified' });
    }

    // Sub-coaches cannot hire — reuse the non-archived assignment predicate.
    const subCoachRows = await this.prisma.teamSubCoachAssignment.count({
      where: { sub_coach_id: user.id, archived_at: null },
    });
    if (subCoachRows > 0) {
      throw new ForbiddenException({
        kind: 'hirer_not_verified',
        message: 'Sub-coaches cannot post job listings.',
      });
    }
    return true;
  }
}
