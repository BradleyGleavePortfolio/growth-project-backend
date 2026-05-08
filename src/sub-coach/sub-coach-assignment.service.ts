import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface AssignClientDto {
  clientId: string;
  subCoachId: string;
}

export interface UnassignClientDto {
  clientId: string;
}

/**
 * SubCoachAssignmentService
 *
 * CRUD for client → sub-coach assignment overrides.
 * A "sub-coach assignment" is simply updating the student's `coach_id`
 * to point at the sub-coach (who is themselves a User with role=coach
 * and their own `coach_id` pointing at the head coach).
 *
 * All mutations verify that:
 *   1. The sub-coach is actually a coach whose `coach_id` resolves to headCoachId.
 *   2. The client's current coach is either the head coach or the sub-coach.
 */
@Injectable()
export class SubCoachAssignmentService {
  constructor(private readonly prisma: PrismaService) {}

  /** Return all clients assigned to a specific sub-coach. */
  async getAssignedClients(headCoachId: string, subCoachId: string) {
    await this.assertSubCoachBelongsTo(headCoachId, subCoachId);
    return this.prisma.user.findMany({
      where: {
        coach_id: subCoachId,
        role: 'student',
        deleted_at: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        created_at: true,
        archived_at: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Assign a client to a sub-coach.
   * The client must already belong to the head coach's roster (coach_id =
   * headCoachId) or already be assigned to a sub-coach within this team.
   */
  async assignClient(headCoachId: string, dto: AssignClientDto) {
    await this.assertSubCoachBelongsTo(headCoachId, dto.subCoachId);

    const client = await this.prisma.user.findFirst({
      where: { id: dto.clientId, deleted_at: null },
      select: { id: true, coach_id: true, role: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    if (client.role !== 'student') {
      throw new BadRequestException('Target user is not a client');
    }

    await this.assertClientInTeam(headCoachId, client.coach_id);

    return this.prisma.user.update({
      where: { id: dto.clientId },
      data: { coach_id: dto.subCoachId },
      select: { id: true, name: true, coach_id: true },
    });
  }

  /**
   * Remove a sub-coach assignment, returning the client to the head coach.
   */
  async unassignClient(headCoachId: string, dto: UnassignClientDto) {
    const client = await this.prisma.user.findFirst({
      where: { id: dto.clientId, deleted_at: null },
      select: { id: true, coach_id: true, role: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    if (client.role !== 'student') {
      throw new BadRequestException('Target user is not a client');
    }

    // Verify the current coach_id is one of the head coach's sub-coaches.
    if (client.coach_id !== headCoachId) {
      const subCoach = await this.prisma.user.findFirst({
        where: { id: client.coach_id ?? '', coach_id: headCoachId },
        select: { id: true },
      });
      if (!subCoach) {
        throw new BadRequestException(
          'Client does not belong to this team',
        );
      }
    }

    return this.prisma.user.update({
      where: { id: dto.clientId },
      data: { coach_id: headCoachId },
      select: { id: true, name: true, coach_id: true },
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async assertSubCoachBelongsTo(
    headCoachId: string,
    subCoachId: string,
  ) {
    const subCoach = await this.prisma.user.findFirst({
      where: { id: subCoachId, coach_id: headCoachId, role: 'coach' },
      select: { id: true },
    });
    if (!subCoach) {
      throw new NotFoundException(
        'Sub-coach not found or does not belong to this team',
      );
    }
  }

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
