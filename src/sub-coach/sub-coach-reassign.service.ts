import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService, AuditAction } from '../audit/audit.service';
import { SubCoachCapacityService } from './sub-coach-capacity.service';
import { SubCoachIdempotencyService } from './sub-coach-idempotency.service';

export interface ReassignClientDto {
  clientId: string;
  /** Destination sub-coach id, or the head coach's own id to unassign. */
  targetSubCoachId: string;
  idempotency_key: string;
  reason?: string;
}

export interface AssignClientInternalDto {
  clientId: string;
  subCoachId: string;
  idempotency_key: string;
  reason?: string;
}

export interface UnassignClientInternalDto {
  clientId: string;
  idempotency_key: string;
  reason?: string;
}

export interface ReassignResult {
  clientId: string;
  previousSubCoachId: string | null;
  newSubCoachId: string | null;
  auditLogId: string;
  idempotent_replay?: boolean;
}

/**
 * SubCoachReassignService
 *
 * Single entry point for every client → sub-coach assignment change.
 * POST /sub-coaches/:id/assign-client AND
 * POST /sub-coaches/:id/reassign-client both route through here so they
 * share:
 *   - DTO validation (controller layer)
 *   - Idempotency dedupe (R19, F29)
 *   - Capacity enforcement inside the same transaction (F28, F44)
 *   - AuditLog persistence (R1, R18, R22)
 *
 * The transaction uses Serializable isolation so two concurrent assigns
 * cannot both observe an open slot and both commit. The DB partial
 * unique index on SubCoachAssignment(client_id) WHERE unassigned_at IS
 * NULL is a defense-in-depth backstop.
 */
@Injectable()
export class SubCoachReassignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly capacity: SubCoachCapacityService,
    private readonly idempotency: SubCoachIdempotencyService,
  ) {}

  /**
   * Reassign a client. `targetSubCoachId === headCoachId` means
   * "unassign back to head coach (no active sub-coach delegation)".
   */
  async reassignClient(
    headCoachId: string,
    actorId: string,
    actorRole: string,
    dto: ReassignClientDto,
  ): Promise<ReassignResult> {
    const action = AuditAction.SUB_COACH_CLIENT_REASSIGNED;
    const existing = await this.idempotency.findExisting<ReassignResult>(
      actorId,
      dto.idempotency_key,
    );
    if (existing) return { ...existing, idempotent_replay: true };

    const { clientId, targetSubCoachId, reason } = dto;
    const unassigning = targetSubCoachId === headCoachId;

    // Validate destination sub-coach (skip when unassigning to head).
    if (!unassigning) {
      const dest = await this.prisma.user.findFirst({
        where: { id: targetSubCoachId, coach_id: headCoachId, role: 'coach' },
        select: { id: true },
      });
      if (!dest) {
        throw new NotFoundException(
          'Destination sub-coach not found or does not belong to this team',
        );
      }
    }

    // Verify client is on this head coach's roster (User.coach_id stays
    // pinned to the head coach in the Phase 11 model).
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, deleted_at: null },
      select: { id: true, name: true, coach_id: true, role: true },
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

    const result = await this.runReassignTransaction({
      headCoachId,
      actorId,
      actorRole,
      action,
      clientId,
      targetSubCoachId,
      unassigning,
      reason: reason ?? null,
    });

    return this.idempotency.store(actorId, dto.idempotency_key, action, result);
  }

  /**
   * First-time assignment of a client to a sub-coach. Internally routes
   * through the same reassign path so capacity + audit + idempotency
   * are enforced identically.
   */
  async assignClient(
    headCoachId: string,
    actorId: string,
    actorRole: string,
    dto: AssignClientInternalDto,
  ): Promise<ReassignResult> {
    return this.reassignClient(headCoachId, actorId, actorRole, {
      clientId: dto.clientId,
      targetSubCoachId: dto.subCoachId,
      idempotency_key: dto.idempotency_key,
      reason: dto.reason,
    });
  }

  /** Explicit unassign — remove any open sub-coach delegation. */
  async unassignClient(
    headCoachId: string,
    actorId: string,
    actorRole: string,
    dto: UnassignClientInternalDto,
  ): Promise<ReassignResult> {
    return this.reassignClient(headCoachId, actorId, actorRole, {
      clientId: dto.clientId,
      targetSubCoachId: headCoachId,
      idempotency_key: dto.idempotency_key,
      reason: dto.reason,
    });
  }

  // ─── Transactional core ───────────────────────────────────────────────────

  private async runReassignTransaction(args: {
    headCoachId: string;
    actorId: string;
    actorRole: string;
    action: string;
    clientId: string;
    targetSubCoachId: string;
    unassigning: boolean;
    reason: string | null;
  }): Promise<ReassignResult> {
    const {
      headCoachId,
      actorId,
      actorRole,
      action,
      clientId,
      targetSubCoachId,
      unassigning,
      reason,
    } = args;

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Current open assignment (if any) for this client.
          const open = await tx.subCoachAssignment.findFirst({
            where: { client_id: clientId, unassigned_at: null },
            select: {
              id: true,
              sub_coach_id: true,
              head_coach_id: true,
            },
          });

          const previousSubCoachId = open?.sub_coach_id ?? null;

          // Same-destination retry — return idempotent success rather
          // than 400. Covers two cases:
          //   (a) reassigning to the same sub-coach the client is on
          //   (b) unassigning a client already on head coach roster
          //       with no open assignment
          const sameDestination =
            (unassigning && !open) ||
            (!unassigning && open?.sub_coach_id === targetSubCoachId);

          if (sameDestination) {
            const log = await tx.auditLog.create({
              data: {
                action,
                actor_id: actorId,
                actor_role: actorRole,
                target_user_id: clientId,
                target_type: 'user',
                target_id: clientId,
                tenant_coach_id: headCoachId,
                metadata: {
                  previous_sub_coach_id: previousSubCoachId,
                  new_sub_coach_id: unassigning ? null : targetSubCoachId,
                  reason,
                  noop: true,
                },
              },
              select: { id: true },
            });
            return {
              clientId,
              previousSubCoachId,
              newSubCoachId: unassigning ? null : targetSubCoachId,
              auditLogId: log.id,
            };
          }

          // Defense-in-depth: the SubCoachAssignment must belong to
          // this head coach team. If a stale row points at a different
          // tenant, refuse.
          if (open && open.head_coach_id !== headCoachId) {
            throw new BadRequestException(
              'Client has an active assignment under a different team',
            );
          }

          // Close any open assignment first (history preserved).
          if (open) {
            await tx.subCoachAssignment.update({
              where: { id: open.id },
              data: { unassigned_at: new Date() },
            });
          }

          // Open a new assignment if we're delegating to a sub-coach.
          if (!unassigning) {
            // Capacity check INSIDE the transaction. Counts use the
            // SubCoachAssignment table so they reflect the new model.
            await this.capacity.assertHasCapacityTx(
              tx,
              headCoachId,
              targetSubCoachId,
            );

            await tx.subCoachAssignment.create({
              data: {
                head_coach_id: headCoachId,
                sub_coach_id: targetSubCoachId,
                client_id: clientId,
                assigned_by_id: actorId,
                reason,
              },
            });
          }

          const log = await tx.auditLog.create({
            data: {
              action,
              actor_id: actorId,
              actor_role: actorRole,
              target_user_id: clientId,
              target_type: 'user',
              target_id: clientId,
              tenant_coach_id: headCoachId,
              metadata: {
                previous_sub_coach_id: previousSubCoachId,
                new_sub_coach_id: unassigning ? null : targetSubCoachId,
                reason,
              },
            },
            select: { id: true },
          });

          return {
            clientId,
            previousSubCoachId,
            newSubCoachId: unassigning ? null : targetSubCoachId,
            auditLogId: log.id,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      // The partial unique index on SubCoachAssignment(client_id)
      // WHERE unassigned_at IS NULL is the last-line race guard. If
      // two parallel assigns both pass capacity at the same instant,
      // exactly one wins and the other lands here.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'Another assignment for this client was committed concurrently — please retry',
        );
      }
      throw err;
    }
  }
}
