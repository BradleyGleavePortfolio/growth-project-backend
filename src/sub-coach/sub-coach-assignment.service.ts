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
 * Phase 11 model: User.coach_id ALWAYS points at the head coach. Sub-coach
 * delegation is an overlay row in SubCoachAssignment (open row =
 * unassigned_at IS NULL). This preserves the head coach's roster /
 * messaging / console queries that scope by `coach_id = headCoachId`,
 * while still letting sub-coaches see only the clients delegated to them.
 *
 * All mutations verify that:
 *   1. The sub-coach belongs to the calling head coach.
 *   2. The client is currently on the head coach's roster
 *      (User.coach_id = headCoachId).
 */
@Injectable()
export class SubCoachAssignmentService {
  constructor(private readonly prisma: PrismaService) {}

  /** Return all clients currently delegated to a specific sub-coach. */
  async getAssignedClients(headCoachId: string, subCoachId: string) {
    await this.assertSubCoachBelongsTo(headCoachId, subCoachId);

    const openAssignments = await this.prisma.subCoachAssignment.findMany({
      where: {
        head_coach_id: headCoachId,
        sub_coach_id: subCoachId,
        unassigned_at: null,
      },
      select: { client_id: true },
    });
    const clientIds = openAssignments.map((a) => a.client_id);
    if (clientIds.length === 0) return [];

    return this.prisma.user.findMany({
      where: {
        id: { in: clientIds },
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

  /** Return the open sub-coach assignment for a client, or null. */
  async getOpenAssignmentForClient(clientId: string) {
    return this.prisma.subCoachAssignment.findFirst({
      where: { client_id: clientId, unassigned_at: null },
      select: {
        id: true,
        head_coach_id: true,
        sub_coach_id: true,
        client_id: true,
        assigned_at: true,
      },
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async assertSubCoachBelongsTo(headCoachId: string, subCoachId: string) {
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

  async assertClientOnTeamRoster(headCoachId: string, clientId: string) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, deleted_at: null },
      select: { id: true, coach_id: true, role: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    if (client.role !== 'student') {
      throw new BadRequestException('Target user is not a client');
    }
    if (client.coach_id !== headCoachId) {
      throw new BadRequestException(
        'Client does not belong to this coach team',
      );
    }
    return client;
  }
}
