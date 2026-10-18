import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  SchedulingSessionLifecycleService,
  type MoveCancelledSession,
} from '../scheduling/scheduling-session-lifecycle.service';
import { AuditAction } from '../audit/audit.service';
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

const MAX_SERIALIZATION_RETRIES = 3;

/**
 * SubCoachReassignService
 *
 * Single entry point for every client → sub-coach assignment change.
 * POST /sub-coaches/:id/assign-client AND
 * POST /sub-coaches/:id/reassign-client both route through here so they
 * share:
 *   - DTO validation (controller layer)
 *   - Atomic idempotency claim + payload/action validation (R19, F29)
 *   - Team check inside the same transaction (F28, F44); no plan cap
 *   - Serialization-failure (P2034) retries with exponential backoff
 *   - AuditLog persistence with correct action label (R1, R18, R22)
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
    private readonly capacity: SubCoachCapacityService,
    private readonly idempotency: SubCoachIdempotencyService,
    // Always injected in production; hand-built unit tests may leave it out.
    @Optional() private readonly sessions?: SchedulingSessionLifecycleService,
  ) {}

  /**
   * Reassign a client. `targetSubCoachId === headCoachId` means
   * "unassign back to head coach (no active sub-coach delegation)".
   *
   * `intent` distinguishes first-time assign vs explicit unassign vs
   * generic reassign so the audit action label is accurate (P2-3).
   */
  async reassignClient(
    headCoachId: string,
    actorId: string,
    actorRole: string,
    dto: ReassignClientDto,
    intent: 'assign' | 'reassign' | 'unassign' = 'reassign',
  ): Promise<ReassignResult> {
    const { clientId, targetSubCoachId, reason } = dto;
    const unassigning = targetSubCoachId === headCoachId;

    // Idempotency canonical payload — the operation-defining fields only.
    // Everything else (headers, ip, etc.) is excluded so the same logical
    // request hashes identically across retries.
    const canonicalPayload = {
      headCoachId,
      clientId,
      targetSubCoachId,
      reason: reason ?? null,
      intent,
    };
    const idempotencyAction = `sub_coach.${intent}`;

    const { response, replay } = await this.idempotency.runWithIdempotency<
      ReassignResult
    >({
      actorId,
      idempotencyKey: dto.idempotency_key,
      action: idempotencyAction,
      payload: canonicalPayload,
      runMutation: async () => {
        // Validate destination sub-coach (skip when unassigning to head).
        if (!unassigning) {
          const dest = await this.prisma.user.findFirst({
            where: {
              id: targetSubCoachId,
              coach_id: headCoachId,
              role: 'coach',
            },
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

        return this.runReassignTransactionWithRetry({
          headCoachId,
          actorId,
          actorRole,
          intent,
          clientId,
          targetSubCoachId,
          unassigning,
          reason: reason ?? null,
        });
      },
    });

    return replay ? { ...response, idempotent_replay: true } : response;
  }

  /**
   * First-time assignment of a client to a sub-coach. Routes through the
   * shared reassign path with `intent='assign'` so the audit log uses
   * SUB_COACH_CLIENT_ASSIGNED when no prior open delegation existed.
   */
  async assignClient(
    headCoachId: string,
    actorId: string,
    actorRole: string,
    dto: AssignClientInternalDto,
  ): Promise<ReassignResult> {
    return this.reassignClient(
      headCoachId,
      actorId,
      actorRole,
      {
        clientId: dto.clientId,
        targetSubCoachId: dto.subCoachId,
        idempotency_key: dto.idempotency_key,
        reason: dto.reason,
      },
      'assign',
    );
  }

  /** Explicit unassign — remove any open sub-coach delegation. */
  async unassignClient(
    headCoachId: string,
    actorId: string,
    actorRole: string,
    dto: UnassignClientInternalDto,
  ): Promise<ReassignResult> {
    return this.reassignClient(
      headCoachId,
      actorId,
      actorRole,
      {
        clientId: dto.clientId,
        targetSubCoachId: headCoachId,
        idempotency_key: dto.idempotency_key,
        reason: dto.reason,
      },
      'unassign',
    );
  }

  // ─── Transactional core ───────────────────────────────────────────────────

  /**
   * Run the reassignment transaction under SERIALIZABLE isolation, with
   * bounded retries on P2034 (serialization failure / write conflict),
   * then rethrow.
   */
  private async runReassignTransactionWithRetry(args: {
    headCoachId: string;
    actorId: string;
    actorRole: string;
    intent: 'assign' | 'reassign' | 'unassign';
    clientId: string;
    targetSubCoachId: string;
    unassigning: boolean;
    reason: string | null;
  }): Promise<ReassignResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await this.runReassignTransaction(args);
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2034'
        ) {
          lastError = err;
          // Exponential backoff: 50ms, 100ms, 200ms.
          await sleep(50 * Math.pow(2, attempt));
          continue;
        }
        // P2002 (partial unique index violation on race) becomes a
        // controlled 409 — another actor committed an assignment for
        // this client at the same instant.
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

    // Out of retries: rethrow so the framework returns 500.
    throw lastError instanceof Error
      ? lastError
      : new Error('Sub-coach reassignment failed after retries');
  }

  private async runReassignTransaction(args: {
    headCoachId: string;
    actorId: string;
    actorRole: string;
    intent: 'assign' | 'reassign' | 'unassign';
    clientId: string;
    targetSubCoachId: string;
    unassigning: boolean;
    reason: string | null;
  }): Promise<ReassignResult> {
    const {
      headCoachId,
      actorId,
      actorRole,
      intent,
      clientId,
      targetSubCoachId,
      unassigning,
      reason,
    } = args;

    let cancelled: MoveCancelledSession[] = [];
    const result = await this.prisma.$transaction(
      async (tx) => {
        // SUBREVOKE: a pair that has ever had a seat may only get a new
        // delegation while that seat is active, so a removed sub-coach gets
        // no clients until re-invited. A pair that never had a seat (legacy
        // delegation) is unaffected. FOR SHARE orders this against a
        // concurrent removal (see endSubCoachSeat).
        if (!unassigning) {
          const [seat] = await tx.$queryRaw<Array<{ archived_at: Date | null }>>`
            SELECT "archived_at" FROM "TeamSubCoachAssignment"
            WHERE "head_coach_id" = ${headCoachId} AND "sub_coach_id" = ${targetSubCoachId}
            FOR SHARE`;
          if (seat && seat.archived_at !== null) {
            throw new NotFoundException(
              'Destination sub-coach not found or does not belong to this team',
            );
          }
        }

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
        const action = this.resolveAuditAction(intent, previousSubCoachId, unassigning);

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
          // Owner HIST-2b: the sub-coach handing the client on loses their upcoming sessions.
          cancelled =
            (await this.sessions?.cancelLeftByMove(tx, [clientId], open.sub_coach_id)) ?? [];
          await tx.subCoachAssignment.update({
            where: { id: open.id },
            data: { unassigned_at: new Date() },
          });
        }

        // Open a new assignment if we're delegating to a sub-coach.
        if (!unassigning) {
          // Team check INSIDE the transaction. No plan cap (owner TM-P1).
          await this.capacity.assertSubCoachBelongsTo(
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
    const role = actorRole === 'owner' ? 'owner' : 'coach';
    await this.sessions?.finishMoveCancels(actorId, cancelled, role);
    return result;
  }

  /**
   * Pick the audit action label based on the caller's intent + the
   * observed prior state. This is what makes the action log accurate
   * for first-time assigns vs reassigns vs unassigns (P2-3).
   *
   * Rules:
   *   - unassigning (target === head) → CLIENT_UNASSIGNED
   *   - no prior open assignment → CLIENT_ASSIGNED (first-time)
   *   - prior open assignment, different sub-coach → CLIENT_REASSIGNED
   *   - prior open to same sub-coach → CLIENT_REASSIGNED (noop)
   */
  private resolveAuditAction(
    intent: 'assign' | 'reassign' | 'unassign',
    previousSubCoachId: string | null,
    unassigning: boolean,
  ): string {
    if (unassigning || intent === 'unassign') {
      return AuditAction.SUB_COACH_CLIENT_UNASSIGNED;
    }
    if (!previousSubCoachId) {
      return AuditAction.SUB_COACH_CLIENT_ASSIGNED;
    }
    return AuditAction.SUB_COACH_CLIENT_REASSIGNED;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
