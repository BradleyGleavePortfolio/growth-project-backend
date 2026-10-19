import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma, TeamAuditEventKind } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import {
  SchedulingSessionLifecycleService,
  type MoveCancelledSession,
} from '../scheduling/scheduling-session-lifecycle.service';
import { StripeApiService } from '../billing/stripe-api.service';
import { deleteDraftsLeftByMove } from '../coach/moved-client-drafts';
import { endSubCoachSeat } from '../sub-coach/end-sub-coach-seat';
import {
  CoachTier,
  TeamModeTierResolverService,
} from './tier-resolver.service';

// Locked decisions ─ ADR-0001 §10 (2026-05-10):
//   Q1 — Staff seats are included for every coach: no plan gate and no
//        paid seat (owner TM-P1: zero locks, only the 2% take on GMV).
//   Q2 — Sub-coach: many-to-many of head coaches, capped at 2.
//   Q3 — Removal auto-reassigns clients to initiating head coach.
//   Q4 — Curated audit feed (15 event_kinds). Not a CRUD firehose.
//   Q5 — Sub-coaches can invite clients directly (attribution path is
//        wired in invite-codes.service.ts; this service only writes
//        the matching audit event).

const SUB_COACH_HEAD_CAP = 2;

export interface AssignSubCoachInput {
  headCoachId: string;
  subCoachId: string;
}

export interface AssignSubCoachResult {
  assignmentId: string;
  tier: CoachTier;
}

export interface RemoveSubCoachInput {
  headCoachId: string;
  subCoachId: string;
}

export interface RemoveSubCoachResult {
  removed: boolean;
  reassignedClientCount: number;
  stripeSubscriptionItemId: string | null;
}

export interface AuditEventQueryInput {
  headCoachId: string;
  fromDate?: Date;
  toDate?: Date;
  eventKind?: TeamAuditEventKind;
  targetClientId?: string;
  cursor?: string;
  limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

@Injectable()
export class TeamModeService {
  private readonly logger = new Logger(TeamModeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeApi: StripeApiService,
    private readonly tierResolver: TeamModeTierResolverService,
    // Always injected in production; hand-built unit tests may leave it out.
    @Optional() private readonly sessions?: SchedulingSessionLifecycleService,
  ) {}

  // Q2: many-to-2 assignment. Q1: no Stripe seat item for any tier.
  async assignSubCoach(input: AssignSubCoachInput): Promise<AssignSubCoachResult> {
    const { headCoachId, subCoachId } = input;
    if (headCoachId === subCoachId) {
      throw new BadRequestException('A coach cannot assign themselves as a sub-coach');
    }

    const tierResult = await this.tierResolver.resolveTier(headCoachId);

    // Cap check — service-layer guard. The DB trigger is the second
    // line of defence so a concurrent double-write cannot exceed the
    // cap, but we want a clean 409 envelope on the happy contention
    // path rather than a P2025 / P2010 leak.
    const currentHeads = await this.prisma.teamSubCoachAssignment.count({
      where: { sub_coach_id: subCoachId, archived_at: null },
    });
    if (currentHeads >= SUB_COACH_HEAD_CAP) {
      throw new ConflictException({
        kind: 'sub_coach_head_cap_exceeded',
        message: `Sub-coach is already assigned under ${SUB_COACH_HEAD_CAP} head coaches`,
        cap: SUB_COACH_HEAD_CAP,
      });
    }

    // Both target users must exist and be coaches. A student should
    // not be assignable as a sub-coach.
    const subCoach = await this.prisma.user.findUnique({
      where: { id: subCoachId },
      select: { id: true, role: true, name: true },
    });
    if (!subCoach) throw new NotFoundException('Sub-coach user not found');
    if (subCoach.role !== 'coach' && subCoach.role !== 'owner') {
      throw new BadRequestException('Target user is not a coach');
    }

    // Single transaction: row + audit event.
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.teamSubCoachAssignment.create({
        data: {
          head_coach_id: headCoachId,
          sub_coach_id: subCoachId,
        },
      });
      await tx.teamAuditEvent.create({
        data: {
          head_coach_id: headCoachId,
          actor_user_id: headCoachId,
          target_client_id: null,
          event_kind: 'sub_coach_assigned',
          summary: `Sub-coach ${subCoach.name} assigned to your team.`,
          metadata: {
            sub_coach_id: subCoachId,
            tier: tierResult.tier,
          } as Prisma.InputJsonValue,
        },
      });
      return row;
    });

    return {
      assignmentId: created.id,
      tier: tierResult.tier,
    };
  }

  // Q3: Remove + auto-reassign clients to initiating head coach +
  //     write audit events + decrement Stripe quantity if Pro.
  async removeSubCoach(input: RemoveSubCoachInput): Promise<RemoveSubCoachResult> {
    const { headCoachId, subCoachId } = input;

    const assignment = await this.prisma.teamSubCoachAssignment.findUnique({
      where: {
        head_coach_id_sub_coach_id: {
          head_coach_id: headCoachId,
          sub_coach_id: subCoachId,
        },
      },
    });
    if (!assignment || assignment.archived_at !== null) {
      throw new NotFoundException('Sub-coach assignment not found');
    }

    const subCoach = await this.prisma.user.findUnique({
      where: { id: subCoachId },
      select: { id: true, name: true },
    });
    if (!subCoach) throw new NotFoundException('Sub-coach user not found');

    // Cross-tenant guard: if the sub-coach works for other head coaches,
    // we cannot safely determine which clients belong to this head coach's
    // team (no TeamClientAssignment table yet). Archive the assignment only
    // and leave User.coach_id untouched to avoid stealing another head
    // coach's clients.
    const otherHeadCount = await this.prisma.teamSubCoachAssignment.count({
      where: {
        sub_coach_id: subCoachId,
        archived_at: null,
        head_coach_id: { not: headCoachId },
      },
    });

    if (otherHeadCount > 0) {
      // Cannot safely reassign clients — sub-coach serves multiple heads.
      // Archive the assignment and Stripe seat only; do NOT touch User.coach_id.
      let stripeError: string | null = null;
      if (
        assignment.stripe_subscription_item_id &&
        this.stripeApi.isConfigured()
      ) {
        try {
          await this.stripeApi.deleteSubscriptionItem({
            subscriptionItemId: assignment.stripe_subscription_item_id,
            idempotencyKey: `team-mode-seat-remove-${headCoachId}-${subCoachId}-${assignment.id}`,
          });
        } catch (err) {
          stripeError = err instanceof Error ? err.message : 'unknown_error';
          this.logger.error(
            `Stripe seat removal failed for assignment=${assignment.id}: ${stripeError}`,
          );
        }
      }

      await this.prisma.$transaction(async (tx) => {
        // SUBREVOKE: the seat and this head coach's client assignments end together.
        const closedAssignments = await endSubCoachSeat(tx, assignment.id, headCoachId, subCoachId);
        await tx.teamAuditEvent.create({
          data: {
            head_coach_id: headCoachId,
            actor_user_id: headCoachId,
            target_client_id: null,
            event_kind: 'sub_coach_removed',
            summary: `Sub-coach ${subCoach.name} removed (clients not reassigned — sub-coach serves multiple head coaches).`,
            metadata: {
              sub_coach_id: subCoachId,
              reassigned_client_count: 0,
              closed_assignment_count: closedAssignments,
              skip_reason: 'multi_head_sub_coach',
              stripe_error: stripeError,
            } as Prisma.InputJsonValue,
          },
        });
        if (assignment.stripe_subscription_item_id !== null) {
          await tx.teamAuditEvent.create({
            data: {
              head_coach_id: headCoachId,
              actor_user_id: headCoachId,
              target_client_id: null,
              event_kind: 'staff_seat_removed',
              summary: `Paid staff seat removed for sub-coach ${subCoach.name}.`,
              metadata: {
                sub_coach_id: subCoachId,
                stripe_subscription_item_id: assignment.stripe_subscription_item_id,
                stripe_error: stripeError,
              } as Prisma.InputJsonValue,
            },
          });
        }
      });

      return {
        removed: true,
        reassignedClientCount: 0,
        stripeSubscriptionItemId: assignment.stripe_subscription_item_id,
      };
    }

    // Safe to reassign — sub-coach only serves this head coach.
    // Find clients currently assigned to the sub-coach. The legacy
    // single-coach model uses User.coach_id — that's the field a
    // sub-coach today writes to. Reassignment is therefore a flip of
    // coach_id from sub-coach to head-coach for clients whose
    // coach_id === subCoachId.
    const clientsToReassign = await this.prisma.user.findMany({
      where: { coach_id: subCoachId, role: 'student', deleted_at: null },
      select: { id: true },
    });
    const reassignIds = clientsToReassign.map((c) => c.id);

    // Stripe decrement (Pro only). Done outside the transaction so
    // a Stripe failure does not roll back the local archive — the
    // operator gets an audit row noting the Stripe failure for
    // manual reconciliation, the head coach is unblocked.
    let stripeError: string | null = null;
    if (
      assignment.stripe_subscription_item_id &&
      this.stripeApi.isConfigured()
    ) {
      try {
        await this.stripeApi.deleteSubscriptionItem({
          subscriptionItemId: assignment.stripe_subscription_item_id,
          idempotencyKey: `team-mode-seat-remove-${headCoachId}-${subCoachId}-${assignment.id}`,
        });
      } catch (err) {
        stripeError = err instanceof Error ? err.message : 'unknown_error';
        this.logger.error(
          `Stripe seat removal failed for assignment=${assignment.id}: ${stripeError}`,
        );
      }
    }

    let cancelled: MoveCancelledSession[] = [];
    await this.prisma.$transaction(async (tx) => {
      // Reassign clients to the initiating head coach.
      if (reassignIds.length > 0) {
        // Owner HIST-2b: the sub-coach's upcoming sessions with these clients end now.
        cancelled = (await this.sessions?.cancelLeftByMove(tx, reassignIds, subCoachId)) ?? [];
        await tx.user.updateMany({
          where: { id: { in: reassignIds } },
          data: { coach_id: headCoachId },
        });
        // Owner decision 17: drafts left behind for these clients go now.
        await deleteDraftsLeftByMove(tx, reassignIds, headCoachId);
        // One client_reassigned event per client so the head coach can
        // filter their feed by client and see the trail.
        await tx.teamAuditEvent.createMany({
          data: reassignIds.map((clientId) => ({
            head_coach_id: headCoachId,
            actor_user_id: headCoachId,
            target_client_id: clientId,
            event_kind: 'client_reassigned',
            summary: `Client reassigned to you from sub-coach ${subCoach.name}.`,
            metadata: {
              from_sub_coach_id: subCoachId,
              to_head_coach_id: headCoachId,
            } as Prisma.InputJsonValue,
          })),
        });
      }

      // Archive the assignment (soft-delete so the audit trail stays
      // queryable on (sub_coach_id, archived_at) for forensics) and close
      // this head coach's client assignments to the sub-coach (SUBREVOKE).
      const closedAssignments = await endSubCoachSeat(tx, assignment.id, headCoachId, subCoachId);

      await tx.teamAuditEvent.create({
        data: {
          head_coach_id: headCoachId,
          actor_user_id: headCoachId,
          target_client_id: null,
          event_kind: 'sub_coach_removed',
          summary: `Sub-coach ${subCoach.name} removed; ${reassignIds.length} client${reassignIds.length === 1 ? '' : 's'} reassigned to you.`,
          metadata: {
            sub_coach_id: subCoachId,
            reassigned_client_count: reassignIds.length,
            closed_assignment_count: closedAssignments,
            stripe_error: stripeError,
          } as Prisma.InputJsonValue,
        },
      });
      if (assignment.stripe_subscription_item_id !== null) {
        await tx.teamAuditEvent.create({
          data: {
            head_coach_id: headCoachId,
            actor_user_id: headCoachId,
            target_client_id: null,
            event_kind: 'staff_seat_removed',
            summary: `Paid staff seat removed for sub-coach ${subCoach.name}.`,
            metadata: {
              sub_coach_id: subCoachId,
              stripe_subscription_item_id: assignment.stripe_subscription_item_id,
              stripe_error: stripeError,
            } as Prisma.InputJsonValue,
          },
        });
      }
    });
    await this.sessions?.finishMoveCancels(headCoachId, cancelled);

    return {
      removed: true,
      reassignedClientCount: reassignIds.length,
      stripeSubscriptionItemId: assignment.stripe_subscription_item_id,
    };
  }

  // Q4: Curated audit feed read endpoint.
  async listAuditEvents(input: AuditEventQueryInput) {
    const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where: Prisma.TeamAuditEventWhereInput = {
      head_coach_id: input.headCoachId,
    };
    if (input.fromDate) {
      where.occurred_at = { ...((where.occurred_at as object) ?? {}), gte: input.fromDate };
    }
    if (input.toDate) {
      where.occurred_at = { ...((where.occurred_at as object) ?? {}), lte: input.toDate };
    }
    if (input.eventKind) where.event_kind = input.eventKind;
    if (input.targetClientId) where.target_client_id = input.targetClientId;

    // Cursor-paginate by descending occurred_at + id tiebreaker. Cursor
    // is the last-seen row's id (opaque to caller).
    const rows = await this.prisma.teamAuditEvent.findMany({
      where,
      orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(input.cursor
        ? { skip: 1, cursor: { id: input.cursor } }
        : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      data: page,
      next_cursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    };
  }

  // Convenience writer used by other services (e.g. invite-codes.service
  // when a sub-coach issues an invite). Public so tests can exercise
  // event-kind values directly.
  async writeAuditEvent(args: {
    headCoachId: string;
    actorUserId: string;
    targetClientId?: string | null;
    eventKind: TeamAuditEventKind;
    summary: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.teamAuditEvent.create({
      data: {
        head_coach_id: args.headCoachId,
        actor_user_id: args.actorUserId,
        target_client_id: args.targetClientId ?? null,
        event_kind: args.eventKind,
        summary: args.summary,
        metadata: (args.metadata ?? null) as Prisma.InputJsonValue,
      },
    });
  }

  // List sub-coaches under a head coach (active assignments only).
  async listSubCoaches(headCoachId: string) {
    return this.prisma.teamSubCoachAssignment.findMany({
      where: { head_coach_id: headCoachId, archived_at: null },
      orderBy: { created_at: 'desc' },
    });
  }
}
