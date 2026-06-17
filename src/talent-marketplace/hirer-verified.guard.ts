import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

// HirerVerifiedGuard — gates the JobListing write surface to a *verified
// hirer*: a gym owner (role=owner) or a head coach / solo coach who runs a
// real, paying coach business.
//
// "Verified" reuses the two signals already used across the coach surface
// rather than inventing a new flag:
//   - role=owner               → platform admin / gym owner; always verified
//                                (mirrors the OWNER bypass in CoachGuard /
//                                SubscriptionGuard / HeadCoachOnlyGuard).
//   - role=coach + head coach  → must NOT be a sub-coach (the non-archived
//                                TeamSubCoachAssignment predicate from
//                                HeadCoachOnlyGuard) AND must have an active
//                                CoachSubscription (active / trialing /
//                                grandfathered — the same statuses
//                                SubscriptionGuard treats as entitled).
//
// A solo coach is just a head coach with no sub-coaches, so the same branch
// covers both. Students and sub-coaches are rejected.
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

    // Verified = active paying coach business.
    const sub = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: user.id },
    });
    const status = sub?.status;
    if (
      status === 'active' ||
      status === 'trialing' ||
      status === 'grandfathered'
    ) {
      return true;
    }

    throw new ForbiddenException({
      kind: 'hirer_not_verified',
      message: 'A verified, active coach subscription is required to hire.',
    });
  }
}
