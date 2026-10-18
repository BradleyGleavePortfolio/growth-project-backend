import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

export interface CapacityResult {
  subCoachId: string;
  assignedClients: number;
}

type PrismaLikeClient = Pick<PrismaService, 'subCoachAssignment' | 'user'>;

/**
 * SubCoachCapacityService
 *
 * Counts a sub-coach's clients; there is no plan cap (owner TM-P1: zero
 * locks). Counts use the SubCoachAssignment overlay (Phase 11) so
 * User.coach_id stays pinned to the head coach.
 *
 * `assertSubCoachBelongsTo()` accepts a tx client and is called from inside
 * SubCoachReassignService's serializable transaction — that way the
 * team check and the insert are part of the same atomic unit (F28).
 */
@Injectable()
export class SubCoachCapacityService {
  constructor(private readonly prisma: PrismaService) {}

  async getCapacity(
    headCoachId: string,
    subCoachId: string,
  ): Promise<CapacityResult> {
    await this.assertSubCoachBelongsTo(this.prisma, headCoachId, subCoachId);
    return this.computeCapacity(this.prisma, headCoachId, subCoachId);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async computeCapacity(
    db: PrismaLikeClient | Prisma.TransactionClient,
    headCoachId: string,
    subCoachId: string,
  ): Promise<CapacityResult> {
    const assignedClients = await db.subCoachAssignment.count({
      where: {
        head_coach_id: headCoachId,
        sub_coach_id: subCoachId,
        unassigned_at: null,
      },
    });
    return {
      subCoachId,
      assignedClients,
    };
  }

  async assertSubCoachBelongsTo(
    db: PrismaLikeClient | Prisma.TransactionClient,
    headCoachId: string,
    subCoachId: string,
  ): Promise<void> {
    const subCoach = await db.user.findFirst({
      where: { id: subCoachId, coach_id: headCoachId, role: 'coach' },
      select: { id: true },
    });
    if (!subCoach) {
      throw new NotFoundException(
        'Sub-coach not found or does not belong to this team',
      );
    }
  }
}
