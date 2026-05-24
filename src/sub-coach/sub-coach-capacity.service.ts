import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * Plan-tier → max clients mapping.
 * Reads `plan_tier` from the head coach's CoachProfile. Falls back to 50.
 * Add or adjust tiers here as the billing catalogue grows.
 */
const PLAN_CLIENT_CAPS: Record<string, number> = {
  flat_300: 50,
  starter: 25,
  growth: 100,
  scale: 250,
  enterprise: 1000,
};

const DEFAULT_CAP = 50;

export interface CapacityResult {
  subCoachId: string;
  assignedClients: number;
  maxClients: number;
  planTier: string;
  hasCapacity: boolean;
}

type PrismaLikeClient = Pick<PrismaService, 'subCoachAssignment' | 'coachProfile' | 'user'>;

/**
 * SubCoachCapacityService
 *
 * Enforces the maximum number of clients per sub-coach derived from the
 * head coach's billing plan tier. Counts use the SubCoachAssignment
 * overlay (Phase 11) so User.coach_id stays pinned to the head coach.
 *
 * `assertHasCapacityTx()` accepts a tx client and is called from inside
 * SubCoachReassignService's serializable transaction — that way the
 * count and the insert are part of the same atomic unit (F28).
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

  /**
   * Throws ConflictException if the sub-coach is at or above the cap.
   * Plain (non-transactional) variant — kept for read paths.
   */
  async assertHasCapacity(
    headCoachId: string,
    subCoachId: string,
  ): Promise<void> {
    const capacity = await this.getCapacity(headCoachId, subCoachId);
    if (!capacity.hasCapacity) {
      throw new ConflictException(
        `Sub-coach has reached the maximum of ${capacity.maxClients} clients for the ${capacity.planTier} plan`,
      );
    }
  }

  /**
   * Transactional capacity assertion — call from inside an interactive
   * Prisma transaction. The serializable isolation level on the outer
   * transaction means concurrent assigns cannot both observe an open
   * slot.
   */
  async assertHasCapacityTx(
    tx: Prisma.TransactionClient,
    headCoachId: string,
    subCoachId: string,
  ): Promise<void> {
    await this.assertSubCoachBelongsTo(tx, headCoachId, subCoachId);
    const capacity = await this.computeCapacity(tx, headCoachId, subCoachId);
    if (!capacity.hasCapacity) {
      throw new ConflictException(
        `Sub-coach has reached the maximum of ${capacity.maxClients} clients for the ${capacity.planTier} plan`,
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async computeCapacity(
    db: PrismaLikeClient | Prisma.TransactionClient,
    headCoachId: string,
    subCoachId: string,
  ): Promise<CapacityResult> {
    const { planTier, maxClients } = await this.resolveLimit(db, headCoachId);
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
      maxClients,
      planTier,
      hasCapacity: assignedClients < maxClients,
    };
  }

  private async assertSubCoachBelongsTo(
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

  private async resolveLimit(
    db: PrismaLikeClient | Prisma.TransactionClient,
    headCoachId: string,
  ): Promise<{ planTier: string; maxClients: number }> {
    const profile = await db.coachProfile.findUnique({
      where: { user_id: headCoachId },
      select: { plan_tier: true },
    });
    const planTier = profile?.plan_tier ?? 'flat_300';
    const maxClients = PLAN_CLIENT_CAPS[planTier] ?? DEFAULT_CAP;
    return { planTier, maxClients };
  }
}
