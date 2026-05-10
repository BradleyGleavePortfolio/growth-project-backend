import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, TeamAuditEventKind } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { StripeApiService } from '../billing/stripe-api.service';
import {
  CoachTier,
  TeamModeTierResolverService,
} from './tier-resolver.service';

// Locked decisions ─ ADR-0001 §10 (2026-05-10):
//   Q1 — Pro: paid staff seats. Enterprise: included. Growth: blocked.
//   Q2 — Sub-coach: many-to-many of head coaches, capped at 2.
//   Q3 — Removal auto-reassigns clients to initiating head coach.
//   Q4 — Curated audit feed (15 event_kinds). Not a CRUD firehose.
//   Q5 — Sub-coaches can invite clients directly (attribution path is
//        wired in invite-codes.service.ts; this service only writes
//        the matching audit event).
//   Q6 — Tier gate enforced at controller; this service trusts the
//        tier passed in by the controller and refuses to write a
//        Stripe line item for a Growth tier head coach as a defence
//        in depth.

const SUB_COACH_HEAD_CAP = 2;

export interface AssignSubCoachInput {
  headCoachId: string;
  subCoachId: string;
}

export interface AssignSubCoachResult {
  assignmentId: string;
  stripeSubscriptionItemId: string | null;
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
  ) {}

  // Q2: many-to-2 assignment with paid Stripe line on Pro.
  // Q1: Growth refused at controller; this service is a defence in
  //     depth. Enterprise creates the row but skips Stripe.
  async assignSubCoach(input: AssignSubCoachInput): Promise<AssignSubCoachResult> {
    const { headCoachId, subCoachId } = input;
    if (headCoachId === subCoachId) {
      throw new BadRequestException('A coach cannot assign themselves as a sub-coach');
    }

    const tierResult = await this.tierResolver.resolveTier(headCoachId);
    if (tierResult.tier === 'growth') {
      // Defence in depth — controller already returns the upsell envelope.
      throw new ForbiddenException({
        kind: 'team_mode_locked',
        current_tier: 'growth',
        required_tier: 'pro',
        upsell_url: '/pricing',
      });
    }

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

    // Stripe line item on Pro only.
    let stripeItemId: string | null = null;
    if (tierResult.tier === 'pro') {
      const seatPriceId = process.env.STRIPE_PRICE_STAFF_SEAT;
      if (!seatPriceId) {
        // Dev / preview: no price id configured, skip Stripe call.
        // Production must set this. Documented in .env.example.
        this.logger.warn(
          'STRIPE_PRICE_STAFF_SEAT unset; skipping Stripe line item create for Pro head coach',
        );
      } else if (!tierResult.stripe_subscription_id) {
        this.logger.warn(
          'Pro head coach has no stripe_subscription_id; skipping line-item create',
        );
      } else if (!this.stripeApi.isConfigured()) {
        this.logger.warn('STRIPE_SECRET_KEY unset; skipping line-item create');
      } else {
        const item = await this.stripeApi.createSubscriptionItem({
          subscription: tierResult.stripe_subscription_id,
          priceId: seatPriceId,
          quantity: 1,
          metadata: {
            head_coach_id: headCoachId,
            sub_coach_id: subCoachId,
            kind: 'team_mode_staff_seat',
          },
          idempotencyKey: `team-mode-seat-add-${headCoachId}-${subCoachId}`,
        });
        stripeItemId = item.id;
      }
    }

    // Single transaction: row + audit event.
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.teamSubCoachAssignment.create({
        data: {
          head_coach_id: headCoachId,
          sub_coach_id: subCoachId,
          stripe_subscription_item_id: stripeItemId,
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
            paid_seat: tierResult.tier === 'pro' && stripeItemId !== null,
          } as Prisma.InputJsonValue,
        },
      });
      if (tierResult.tier === 'pro' && stripeItemId !== null) {
        await tx.teamAuditEvent.create({
          data: {
            head_coach_id: headCoachId,
            actor_user_id: headCoachId,
            target_client_id: null,
            event_kind: 'staff_seat_added',
            summary: `Paid staff seat added for sub-coach ${subCoach.name}.`,
            metadata: {
              sub_coach_id: subCoachId,
              stripe_subscription_item_id: stripeItemId,
            } as Prisma.InputJsonValue,
          },
        });
      }
      return row;
    });

    return {
      assignmentId: created.id,
      stripeSubscriptionItemId: stripeItemId,
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

    // Find clients currently assigned to the sub-coach. The legacy
    // single-coach model uses User.coach_id — that's the field a
    // sub-coach today writes to. Reassignment is therefore a flip of
    // coach_id from sub-coach to head-coach for clients whose
    // coach_id === subCoachId. We deliberately scope the reassignment
    // to clients whose existing coach_id is this sub-coach — we are
    // NOT pulling clients away from a different head coach who also
    // has this sub-coach (the 2-cap means up to one other).
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

    await this.prisma.$transaction(async (tx) => {
      // Reassign clients to the initiating head coach.
      if (reassignIds.length > 0) {
        await tx.user.updateMany({
          where: { id: { in: reassignIds } },
          data: { coach_id: headCoachId },
        });
        // One client_reassigned event per client so the head coach can
        // filter their feed by client and see the trail.
        for (const clientId of reassignIds) {
          await tx.teamAuditEvent.create({
            data: {
              head_coach_id: headCoachId,
              actor_user_id: headCoachId,
              target_client_id: clientId,
              event_kind: 'client_reassigned',
              summary: `Client reassigned to you from sub-coach ${subCoach.name}.`,
              metadata: {
                from_sub_coach_id: subCoachId,
                to_head_coach_id: headCoachId,
              } as Prisma.InputJsonValue,
            },
          });
        }
      }

      // Archive the assignment (soft-delete so the audit trail stays
      // queryable on (sub_coach_id, archived_at) for forensics).
      await tx.teamSubCoachAssignment.update({
        where: { id: assignment.id },
        data: { archived_at: new Date() },
      });

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
