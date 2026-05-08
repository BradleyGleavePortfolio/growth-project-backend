import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
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

/**
 * SubCoachCapacityService
 *
 * Enforces the maximum number of clients per sub-coach derived from the
 * head coach's billing plan tier. Exposes a check method used by the
 * reassignment service before any transfer is committed.
 */
@Injectable()
export class SubCoachCapacityService {
  constructor(private readonly prisma: PrismaService) {}

  async getCapacity(
    headCoachId: string,
    subCoachId: string,
  ): Promise<CapacityResult> {
    const subCoach = await this.prisma.user.findFirst({
      where: { id: subCoachId, coach_id: headCoachId, role: 'coach' },
      select: { id: true },
    });
    if (!subCoach) {
      throw new NotFoundException(
        'Sub-coach not found or does not belong to this team',
      );
    }

    const { planTier, maxClients } = await this.resolveLimit(headCoachId);

    const assignedClients = await this.prisma.user.count({
      where: { coach_id: subCoachId, role: 'student', deleted_at: null },
    });

    return {
      subCoachId,
      assignedClients,
      maxClients,
      planTier,
      hasCapacity: assignedClients < maxClients,
    };
  }

  /**
   * Throws ConflictException if the sub-coach is at or above the cap.
   * Called by SubCoachReassignService before committing a transfer.
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

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async resolveLimit(
    headCoachId: string,
  ): Promise<{ planTier: string; maxClients: number }> {
    const profile = await this.prisma.coachProfile.findUnique({
      where: { user_id: headCoachId },
      select: { plan_tier: true },
    });
    const planTier = profile?.plan_tier ?? 'flat_300';
    const maxClients = PLAN_CLIENT_CAPS[planTier] ?? DEFAULT_CAP;
    return { planTier, maxClients };
  }
}
