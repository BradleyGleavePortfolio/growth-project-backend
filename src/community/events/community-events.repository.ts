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
   */
  async list(params: {
    workspaceId: string;
    cohortId: string | null;
    state: CommunityEventState | null;
    before: Date | null;
    limit: number;
  }): Promise<CommunityEvent[]> {
    return this.prisma.communityEvent.findMany({
      where: {
        workspace_id: params.workspaceId,
        canceled_at: null,
        ...(params.cohortId ? { cohort_id: params.cohortId } : {}),
        ...(params.state ? { state: params.state } : {}),
        ...(params.before ? { starts_at: { gt: params.before } } : {}),
      },
      orderBy: [{ starts_at: 'asc' }, { id: 'asc' }],
      take: params.limit,
    });
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
