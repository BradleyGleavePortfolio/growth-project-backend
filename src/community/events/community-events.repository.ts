import { Injectable } from '@nestjs/common';
import {
  CommunityEvent,
  CommunityEventRsvp,
  CommunityEventRsvpStatus,
  CommunityEventState,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';

/**
 * Data access for Community events + RSVPs (v2-3).
 *
 * Tenant scoping is application-layer (v1-2 doctrine, mirrored from
 * community-posts.repository.ts): every read is bounded by the workspace id the
 * service already authorised. The app connects as service_role/BYPASSRLS, so
 * Postgres RLS does not constrain these queries — the service is the gate.
 * Canceled events are excluded from list reads but remain fetchable by id so a
 * deep link resolves to a deterministic "canceled" card rather than a 404.
 */
@Injectable()
export class CommunityEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: {
    workspaceId: string;
    cohortId: string | null;
    createdById: string;
    title: string;
    description: string | null;
    startsAt: Date;
    endsAt: Date | null;
    liveUrl: string | null;
  }): Promise<CommunityEvent> {
    return this.prisma.communityEvent.create({
      data: {
        workspace_id: params.workspaceId,
        cohort_id: params.cohortId,
        created_by_id: params.createdById,
        title: params.title,
        description: params.description,
        state: CommunityEventState.scheduled,
        starts_at: params.startsAt,
        ends_at: params.endsAt,
        live_url: params.liveUrl,
      },
    });
  }

  async findById(eventId: string): Promise<CommunityEvent | null> {
    return this.prisma.communityEvent.findUnique({ where: { id: eventId } });
  }

  /**
   * List events visible in a workspace (optionally one cohort + one state),
   * soonest-first, cursor-paginated by starts_at. Excludes canceled rows.
   *
   * `cohortScope` controls cross-cohort visibility (the IDOR boundary — #5):
   *  - `null`            → no cohort restriction (coach/owner of the workspace,
   *                        who may see every cohort's events).
   *  - `{ cohortId }`    → exactly one cohort (an explicit, access-checked
   *                        cohort filter from the caller).
   *  - `{ accessibleCohortIds }` → a MEMBER view: workspace-wide events
   *                        (cohort_id IS NULL) PLUS events in the cohorts the
   *                        caller actively belongs to. A member of cohort A
   *                        therefore never sees cohort B's events.
   */
  async list(params: {
    workspaceId: string;
    cohortScope:
      | null
      | { cohortId: string }
      | { accessibleCohortIds: string[] };
    state: CommunityEventState | null;
    before: Date | null;
    limit: number;
  }): Promise<CommunityEvent[]> {
    const scope = params.cohortScope;
    let cohortWhere: Prisma.CommunityEventWhereInput = {};
    if (scope && 'cohortId' in scope) {
      cohortWhere = { cohort_id: scope.cohortId };
    } else if (scope && 'accessibleCohortIds' in scope) {
      cohortWhere =
        scope.accessibleCohortIds.length > 0
          ? {
              OR: [
                { cohort_id: null },
                { cohort_id: { in: scope.accessibleCohortIds } },
              ],
            }
          : { cohort_id: null };
    }
    return this.prisma.communityEvent.findMany({
      where: {
        workspace_id: params.workspaceId,
        canceled_at: null,
        ...cohortWhere,
        ...(params.state ? { state: params.state } : {}),
        ...(params.before ? { starts_at: { gt: params.before } } : {}),
      },
      orderBy: [{ starts_at: 'asc' }, { id: 'asc' }],
      take: params.limit,
    });
  }

  /**
   * The ids of every cohort in the workspace the user is an ACTIVE member of.
   * Used to bound a member's event list to their own cohorts (the F1 fix).
   */
  async activeCohortIds(
    workspaceId: string,
    userId: string,
  ): Promise<string[]> {
    const rows = await this.prisma.communityMembership.findMany({
      where: {
        workspace_id: workspaceId,
        user_id: userId,
        status: 'active',
      },
      select: { cohort_id: true },
    });
    return rows.map((r) => r.cohort_id);
  }

  async update(
    eventId: string,
    data: Prisma.CommunityEventUpdateInput,
  ): Promise<CommunityEvent> {
    return this.prisma.communityEvent.update({
      where: { id: eventId },
      data,
    });
  }

  /**
   * Compare-and-swap state promotion (F3 — race safety, doctrine #28). Moves an
   * event to `toState` ONLY IF it is still in `fromState` and not canceled, in a
   * single atomic UPDATE. Returns the count actually changed (0 or 1): when two
   * replicas race, exactly one observes count===1 and is responsible for the
   * side effects (broadcast + reminder fan-out); the loser sees 0 and does
   * nothing, so no duplicate ping/push is emitted.
   */
  async casPromoteState(params: {
    eventId: string;
    fromState: CommunityEventState;
    toState: CommunityEventState;
  }): Promise<number> {
    const { count } = await this.prisma.communityEvent.updateMany({
      where: {
        id: params.eventId,
        state: params.fromState,
        canceled_at: null,
      },
      data: { state: params.toState },
    });
    return count;
  }

  // ── RSVP ──────────────────────────────────────────────────────────────────

  async findRsvp(
    eventId: string,
    userId: string,
  ): Promise<CommunityEventRsvp | null> {
    return this.prisma.communityEventRsvp.findUnique({
      where: { event_id_user_id: { event_id: eventId, user_id: userId } },
    });
  }

  /** Upsert the caller's RSVP (one row per user per event). */
  async upsertRsvp(params: {
    workspaceId: string;
    eventId: string;
    userId: string;
    status: CommunityEventRsvpStatus;
  }): Promise<CommunityEventRsvp> {
    return this.prisma.communityEventRsvp.upsert({
      where: {
        event_id_user_id: { event_id: params.eventId, user_id: params.userId },
      },
      create: {
        workspace_id: params.workspaceId,
        event_id: params.eventId,
        user_id: params.userId,
        status: params.status,
      },
      update: { status: params.status },
    });
  }

  /**
   * ATOMICALLY claim the “starting soon” reminder rows for one event (F3 —
   * reminder idempotency, doctrine #28/#29). A single SQL `UPDATE ... WHERE
   * reminded_at IS NULL ... RETURNING` stamps and returns the rows in one
   * statement: each unreminded going/maybe RSVP is claimed by exactly one
   * caller, so two promotion workers firing in parallel cannot both send to the
   * same recipient. The caller then sends a push ONLY to the rows it claimed
   * (the returned set), guaranteeing zero duplicate pushes.
   *
   * Parameterised query (no string interpolation — doctrine #3). `statuses` is
   * an enum-typed array bound through Prisma.join, never user input.
   */
  async claimReminderRecipients(params: {
    eventId: string;
    statuses: CommunityEventRsvpStatus[];
    at: Date;
  }): Promise<Array<{ id: string; user_id: string }>> {
    if (params.statuses.length === 0) return [];
    const statusList = Prisma.join(params.statuses.map((s) => Prisma.sql`${s}`));
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; user_id: string }>
    >`
      UPDATE "community_event_rsvps"
         SET "reminded_at" = ${params.at}
       WHERE "event_id" = ${params.eventId}::uuid
         AND "reminded_at" IS NULL
         AND "status"::text IN (${statusList})
      RETURNING "id", "user_id"
    `;
    return rows;
  }

  /** Per-status RSVP counts for one event. */
  async rsvpCounts(
    eventId: string,
  ): Promise<Record<CommunityEventRsvpStatus, number>> {
    const grouped = await this.prisma.communityEventRsvp.groupBy({
      by: ['status'],
      where: { event_id: eventId },
      _count: { _all: true },
    });
    const counts: Record<CommunityEventRsvpStatus, number> = {
      going: 0,
      maybe: 0,
      declined: 0,
      attended: 0,
      missed: 0,
    };
    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }
    return counts;
  }

  // ── Transition-job queries ──────────────────────────────────────────────

  /**
   * Scheduled events whose start falls within the next-day window
   * [now, windowEnd] — candidates for the `tomorrow` auto-promotion. Excludes
   * canceled rows. Ordered soonest-first and batch-capped by the caller.
   */
  async findScheduledStartingBefore(
    windowEnd: Date,
    limit: number,
  ): Promise<CommunityEvent[]> {
    return this.prisma.communityEvent.findMany({
      where: {
        state: CommunityEventState.scheduled,
        canceled_at: null,
        starts_at: { lte: windowEnd },
      },
      orderBy: { starts_at: 'asc' },
      take: limit,
    });
  }

  /**
   * Events in `scheduled` or `tomorrow` whose start time has passed — the
   * candidates for the automatic `live` promotion. Excludes canceled rows.
   */
  async findDueForLive(now: Date, limit: number): Promise<CommunityEvent[]> {
    return this.prisma.communityEvent.findMany({
      where: {
        state: {
          in: [CommunityEventState.scheduled, CommunityEventState.tomorrow],
        },
        canceled_at: null,
        starts_at: { lte: now },
      },
      orderBy: { starts_at: 'asc' },
      take: limit,
    });
  }
}
