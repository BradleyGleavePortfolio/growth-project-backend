import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { SubCoachCapacityService } from './sub-coach-capacity.service';

export interface ReassignClientDto {
  clientId: string;
  toSubCoachId: string;
  reason?: string;
}

export interface ReassignResult {
  clientId: string;
  previousCoachId: string | null;
  newCoachId: string;
  auditLogId: string;
}

/**
 * SubCoachReassignService
 *
 * Performs atomic client reassignment between sub-coaches (or back to the
 * head coach) and writes an immutable AuditLog entry for every transfer.
 *
 * Atomicity is achieved via a Prisma interactive transaction:
 *   1. Capacity check on the destination.
 *   2. User.update (coach_id flip).
 *   3. AuditLog.create.
 * If any step fails the transaction rolls back; the audit row is never orphaned.
 */
@Injectable()
export class SubCoachReassignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly capacity: SubCoachCapacityService,
  ) {}

  async reassignClient(
    headCoachId: string,
    actorId: string,
    actorRole: string,
    dto: ReassignClientDto,
  ): Promise<ReassignResult> {
    const { clientId, toSubCoachId, reason } = dto;

    // Validate destination — must be head coach themselves or one of their subs.
    const isHeadCoach = toSubCoachId === headCoachId;
    if (!isHeadCoach) {
      const dest = await this.prisma.user.findFirst({
        where: { id: toSubCoachId, coach_id: headCoachId, role: 'coach' },
        select: { id: true },
      });
      if (!dest) {
        throw new NotFoundException(
          'Destination sub-coach not found or does not belong to this team',
        );
      }
      // Capacity guard — only needed when moving to a sub-coach (not back to head).
      await this.capacity.assertHasCapacity(headCoachId, toSubCoachId);
    }

    // Load the client and confirm they are in this team.
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, deleted_at: null },
      select: { id: true, name: true, coach_id: true, role: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    if (client.role !== 'student') {
      throw new BadRequestException('Target user is not a client');
    }

    await this.assertClientInTeam(headCoachId, client.coach_id);

    if (client.coach_id === toSubCoachId) {
      throw new BadRequestException(
        'Client is already assigned to this coach',
      );
    }

    const previousCoachId = client.coach_id;

    // Atomic transaction: update + audit.
    const auditLog = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: clientId },
        data: { coach_id: toSubCoachId },
      });

      const log = await tx.auditLog.create({
        data: {
          action: 'sub_coach.client_reassigned',
          actor_id: actorId,
          actor_role: actorRole,
          target_user_id: clientId,
          target_type: 'user',
          target_id: clientId,
          tenant_coach_id: headCoachId,
          metadata: {
            previous_coach_id: previousCoachId,
            new_coach_id: toSubCoachId,
            reason: reason ?? null,
          },
        },
        select: { id: true },
      });

      return log;
    });

    return {
      clientId,
      previousCoachId,
      newCoachId: toSubCoachId,
      auditLogId: auditLog.id,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async assertClientInTeam(
    headCoachId: string,
    currentCoachId: string | null,
  ) {
    if (!currentCoachId) {
      throw new BadRequestException('Client has no assigned coach');
    }
    if (currentCoachId === headCoachId) return;
    const sub = await this.prisma.user.findFirst({
      where: { id: currentCoachId, coach_id: headCoachId },
      select: { id: true },
    });
    if (!sub) {
      throw new BadRequestException(
        'Client does not belong to this coach team',
      );
    }
  }
}
