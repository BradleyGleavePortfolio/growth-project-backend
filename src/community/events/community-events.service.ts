import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CommunityEvent,
  CommunityEventRsvp,
  CommunityEventRsvpStatus,
  CommunityEventState,
  User,
} from '@prisma/client';
import { CommunityAccessService } from '../community-access.service';
import { CommunityRealtimeService } from '../realtime/community-realtime.service';
import { CommunityNotificationsService } from '../notifications/community-notifications.service';
import { COMMUNITY_BROADCAST_EVENTS } from '../community-events';
import { NotificationKind } from '../../notifications/notification-kind';
import { CommunityEventsRepository } from './community-events.repository';
import {
  canTransition,
  explainTransition,
} from './community-event-state-machine';
import { validateEventLink } from './community-event-link';
import {
  CLIENT_RSVP_STATUSES,
  CommunityEventListResponse,
  CommunityEventListResponseSchema,
  CommunityEventResponse,
  CommunityEventResponseSchema,
  CommunityEventView,
  CommunityRsvpResponse,
  CommunityRsvpResponseSchema,
} from '../dto/community-event.dto';

const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;

const EVENT_NOT_FOUND = {
  error: 'not_found',
  code: 'community.event.not_found',
} as const;

type RsvpCounts = Record<CommunityEventRsvpStatus, number>;

/**
 * Community events (v2-3) — five-state lifecycle, RSVP, coach-only CRUD.
 *
 * AUTHORIZATION MODEL (mirrors v1-3 posts):
 *  - READ: any active workspace member / owning coach / platform owner may list
 *    and read events. A cohort-scoped event is additionally gated on cohort
 *    membership so a member of cohort A never sees cohort B's event.
 *  - WRITE (create / edit / transition / replay / reflect): the OWNING COACH of
 *    the workspace only (or platform owner). A client write returns 403.
 *  - RSVP: any active member may set their OWN RSVP to a client-settable status
 *    (going/maybe/declined). attended/missed are coach/system-derived and a
 *    client attempt to self-assert them is rejected.
 *
 * NO NATIVE LIVE ROOM (Step 0): events carry an EXTERNAL validated link only.
 * The schema exposes one text URL column (`live_url`) and one media-asset UUID
 * (`replay_media_asset_id`). Because there is no video provider, BOTH the live
 * link and the replay link are external URLs and are stored in `live_url`;
 * `replay_media_asset_id` is left for a future Mux integration. This is a
 * declared deviation (see the builder report) and is never surfaced as a
 * "join native room" promise — the field is named `external_url` in the API.
 *
 * Tenant non-leak: a non-member read resolves to 404 (never 403) so existence
 * is not disclosed across tenants (v1-2 doctrine, required cross-tenant test).
 */
@Injectable()
export class CommunityEventsService {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly events: CommunityEventsRepository,
    private readonly realtime: CommunityRealtimeService,
    private readonly communityPush: CommunityNotificationsService,
  ) {}

  // ── View mapping ──────────────────────────────────────────────────────────

  private eventView(
    e: CommunityEvent,
    counts: RsvpCounts,
    viewerRsvp: CommunityEventRsvpStatus | null,
  ): CommunityEventView {
    return {
      id: e.id,
      workspace_id: e.workspace_id,
      cohort_id: e.cohort_id,
      created_by_user_id: e.created_by_id,
      title: e.title,
      description: e.description,
      state: e.state,
      starts_at: e.starts_at.toISOString(),
      ends_at: e.ends_at ? e.ends_at.toISOString() : null,
      external_url: e.live_url,
      reflected_at: e.reflected_at ? e.reflected_at.toISOString() : null,
      canceled: e.canceled_at !== null,
      rsvp_counts: {
        going: counts.going,
        maybe: counts.maybe,
        declined: counts.declined,
        attended: counts.attended,
        missed: counts.missed,
      },
      viewer_rsvp_status: viewerRsvp,
      created_at: e.created_at.toISOString(),
      updated_at: e.updated_at.toISOString(),
    };
  }

  private async buildView(
    e: CommunityEvent,
    userId: string,
  ): Promise<CommunityEventView> {
    const [counts, viewer] = await Promise.all([
      this.events.rsvpCounts(e.id),
      this.events.findRsvp(e.id, userId),
    ]);
    return this.eventView(e, counts, viewer?.status ?? null);
  }

  private parsePage(limit: string | undefined): number {
    if (!limit) return DEFAULT_PAGE;
    const n = parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
    return Math.min(n, MAX_PAGE);
  }

  private parseStartsAfter(before: string | undefined): Date | null {
    if (!before) return null;
    const d = new Date(before);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private parseState(state: string | undefined): CommunityEventState | null {
    if (!state) return null;
    if ((Object.values(CommunityEventState) as string[]).includes(state)) {
      return state as CommunityEventState;
    }
    throw new BadRequestException({
      error: 'bad_request',
      code: 'community.event.invalid_state_filter',
    });
  }

  // ── Authorization helpers ──────────────────────────────────────────────────

  /** Owning coach (or platform owner) — the only roles permitted to write. */
  private async assertCoach(
    workspaceId: string,
    user: User,
  ): Promise<void> {
    if (user.role === 'owner') return;
    if (await this.access.isWorkspaceCoach(workspaceId, user.id)) return;
    throw new ForbiddenException({
      error: 'forbidden',
      code: 'community.event.coach_only',
    });
  }

  /**
   * Resolve an event the caller may READ, or throw 404. A cohort-scoped event
   * additionally requires cohort access; a workspace-wide event requires
   * workspace access.
   */
  private async readableEvent(
    user: User,
    eventId: string,
  ): Promise<CommunityEvent> {
    const event = await this.events.findById(eventId);
    if (!event) throw new NotFoundException(EVENT_NOT_FOUND);
    const canRead = event.cohort_id
      ? await this.access.canAccessCohort(
          { id: event.cohort_id, workspace_id: event.workspace_id },
          user,
        )
      : await this.access.canAccessWorkspace(event.workspace_id, user);
    if (!canRead) throw new NotFoundException(EVENT_NOT_FOUND);
    return event;
  }

  // ── Read surfaces ──────────────────────────────────────────────────────────

  async create(
    user: User,
    workspaceId: string,
    input: {
      title: string;
      description?: string;
      starts_at: string;
      ends_at?: string;
      cohort_id?: string;
      live_url?: string;
    },
  ): Promise<CommunityEventResponse> {
    const workspace = await this.access.findWorkspace(workspaceId);
    if (
      !workspace ||
      !(await this.access.canAccessWorkspace(workspaceId, user))
    ) {
      throw new NotFoundException(EVENT_NOT_FOUND);
    }
    await this.assertCoach(workspaceId, user);

    const startsAt = new Date(input.starts_at);
    const endsAt = input.ends_at ? new Date(input.ends_at) : null;
    if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.event.ends_before_start',
      });
    }

    // A cohort-scoped event must reference a cohort that lives in THIS
    // workspace, else a coach could attach another tenant's cohort id.
    let cohortId: string | null = null;
    if (input.cohort_id) {
      const cohort = await this.access.findCohort(input.cohort_id);
      if (!cohort || cohort.workspace_id !== workspaceId) {
        throw new BadRequestException({
          error: 'bad_request',
          code: 'community.event.cohort_not_in_workspace',
        });
      }
      cohortId = cohort.id;
    }

    const liveUrl = this.normalizeLink(input.live_url);

    const created = await this.events.create({
      workspaceId,
      cohortId,
      createdById: user.id,
      title: input.title,
      description: input.description ?? null,
      startsAt,
      endsAt,
      liveUrl,
    });
    this.broadcastState(created, CommunityEventState.scheduled, created.state);
    return CommunityEventResponseSchema.parse({
      event: await this.buildView(created, user.id),
    });
  }

  async list(
    user: User,
    workspaceId: string,
    query: { state?: string; cohort_id?: string; limit?: string },
  ): Promise<CommunityEventListResponse> {
    const workspace = await this.access.findWorkspace(workspaceId);
    if (
      !workspace ||
      !(await this.access.canAccessWorkspace(workspaceId, user))
    ) {
      throw new NotFoundException(EVENT_NOT_FOUND);
    }

    // If a cohort filter is supplied, the caller must have access to it; a
    // member of another cohort gets an empty list rather than a leak.
    let cohortId: string | null = null;
    if (query.cohort_id) {
      const cohort = await this.access.findCohort(query.cohort_id);
      if (
        !cohort ||
        cohort.workspace_id !== workspaceId ||
        !(await this.access.canAccessCohort(
          { id: cohort.id, workspace_id: cohort.workspace_id },
          user,
        ))
      ) {
        return CommunityEventListResponseSchema.parse({
          events: [],
          next_before: null,
        });
      }
      cohortId = cohort.id;
    }

    const limit = this.parsePage(query.limit);
    const rows = await this.events.list({
      workspaceId,
      cohortId,
      state: this.parseState(query.state),
      before: null,
      limit,
    });

    const views = await Promise.all(
      rows.map((e) => this.buildView(e, user.id)),
    );
    const next =
      rows.length === limit
        ? rows[rows.length - 1].starts_at.toISOString()
        : null;
    return CommunityEventListResponseSchema.parse({
      events: views,
      next_before: next,
    });
  }

  async getOne(user: User, eventId: string): Promise<CommunityEventResponse> {
    const event = await this.readableEvent(user, eventId);
    return CommunityEventResponseSchema.parse({
      event: await this.buildView(event, user.id),
    });
  }

  // ── Coach writes ───────────────────────────────────────────────────────────

  /** Validate + normalize an external link, or throw a typed BadRequest. */
  private normalizeLink(raw: string | undefined): string | null {
    if (raw === undefined || raw.length === 0) return null;
    const result = validateEventLink(raw);
    if (!result.ok || !result.normalized) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.event.invalid_link',
        reason: result.reason,
      });
    }
    return result.normalized;
  }

  /** Mutable, coach-only event editor (fields + forward state advance). */
  async update(
    user: User,
    eventId: string,
    input: {
      title?: string;
      description?: string;
      starts_at?: string;
      ends_at?: string;
      live_url?: string;
      state?: string;
    },
  ): Promise<CommunityEventResponse> {
    const event = await this.readableEvent(user, eventId);
    await this.assertCoach(event.workspace_id, user);
    if (event.canceled_at) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.event.canceled',
      });
    }

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) {
      data.description = input.description.length ? input.description : null;
    }
    if (input.live_url !== undefined) {
      data.live_url =
        input.live_url.length === 0 ? null : this.normalizeLink(input.live_url);
    }

    let startsAt = event.starts_at;
    if (input.starts_at !== undefined) {
      startsAt = new Date(input.starts_at);
      data.starts_at = startsAt;
    }
    if (input.ends_at !== undefined) {
      const endsAt = input.ends_at.length ? new Date(input.ends_at) : null;
      if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
        throw new BadRequestException({
          error: 'bad_request',
          code: 'community.event.ends_before_start',
        });
      }
      data.ends_at = endsAt;
    }

    let nextState = event.state;
    if (input.state !== undefined && input.state !== event.state) {
      nextState = this.resolveTargetState(input.state);
      this.assertTransitionAllowed(event, nextState);
      // Moving into `replay` requires a replay artifact to exist or arrive in
      // the same call; the dedicated /replay endpoint is the supported path.
      if (
        nextState === CommunityEventState.replay &&
        !(data.live_url ?? event.live_url)
      ) {
        throw new BadRequestException({
          error: 'bad_request',
          code: 'community.event.replay_requires_link',
        });
      }
      data.state = nextState;
      if (nextState === CommunityEventState.reflected) {
        data.reflected_at = new Date();
      }
    }

    const updated = await this.events.update(eventId, data);
    if (nextState !== event.state) {
      this.broadcastState(updated, event.state, updated.state);
    }
    return CommunityEventResponseSchema.parse({
      event: await this.buildView(updated, user.id),
    });
  }

  private resolveTargetState(raw: string): CommunityEventState {
    if ((Object.values(CommunityEventState) as string[]).includes(raw)) {
      return raw as CommunityEventState;
    }
    throw new BadRequestException({
      error: 'bad_request',
      code: 'community.event.invalid_state',
    });
  }

  private assertTransitionAllowed(
    event: CommunityEvent,
    to: CommunityEventState,
  ): void {
    const rejection = explainTransition(event.state, to);
    if (rejection) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.event.illegal_transition',
        reason: rejection,
      });
    }
  }

  /** POST /replay — attach an external replay link and move to `replay`. */
  async attachReplay(
    user: User,
    eventId: string,
    replayUrl: string,
  ): Promise<CommunityEventResponse> {
    const event = await this.readableEvent(user, eventId);
    await this.assertCoach(event.workspace_id, user);
    if (event.canceled_at) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.event.canceled',
      });
    }
    // replay is reachable from scheduled/tomorrow/live (forward-only).
    if (
      event.state !== CommunityEventState.replay &&
      !canTransition(event.state, CommunityEventState.replay)
    ) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.event.illegal_transition',
        reason: 'illegal_edge',
      });
    }
    const normalized = this.normalizeLink(replayUrl);
    const updated = await this.events.update(eventId, {
      live_url: normalized,
      state: CommunityEventState.replay,
    });
    if (event.state !== CommunityEventState.replay) {
      this.broadcastState(updated, event.state, updated.state);
    }
    return CommunityEventResponseSchema.parse({
      event: await this.buildView(updated, user.id),
    });
  }

  /** POST /reflect — mark the event reflected (recap posted). */
  async reflect(
    user: User,
    eventId: string,
  ): Promise<CommunityEventResponse> {
    const event = await this.readableEvent(user, eventId);
    await this.assertCoach(event.workspace_id, user);
    if (event.canceled_at) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.event.canceled',
      });
    }
    this.assertTransitionAllowed(event, CommunityEventState.reflected);
    const updated = await this.events.update(eventId, {
      state: CommunityEventState.reflected,
      reflected_at: new Date(),
    });
    this.broadcastState(updated, event.state, updated.state);
    return CommunityEventResponseSchema.parse({
      event: await this.buildView(updated, user.id),
    });
  }

  // ── RSVP ───────────────────────────────────────────────────────────────────

  async rsvp(
    user: User,
    eventId: string,
    status: string,
  ): Promise<CommunityRsvpResponse> {
    const event = await this.readableEvent(user, eventId);
    if (event.canceled_at) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.event.canceled',
      });
    }
    // Reflected events are historical — RSVP is closed.
    if (event.state === CommunityEventState.reflected) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.event.rsvp_closed',
      });
    }
    if (!(CLIENT_RSVP_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException({
        error: 'bad_request',
        code: 'community.event.invalid_rsvp_status',
      });
    }
    const saved = await this.events.upsertRsvp({
      workspaceId: event.workspace_id,
      eventId: event.id,
      userId: user.id,
      status: status as CommunityEventRsvpStatus,
    });
    // Best-effort realtime ping so the coach console's RSVP ticker refetches.
    this.broadcastState(event, event.state, event.state);
    return CommunityRsvpResponseSchema.parse({
      rsvp: this.rsvpView(saved),
    });
  }

  private rsvpView(r: CommunityEventRsvp) {
    return {
      event_id: r.event_id,
      user_id: r.user_id,
      status: r.status,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    };
  }

  // ── Realtime ─────────────────────────────────────────────────────────────

  /**
   * Best-effort, IDs-only state-change ping on the per-event channel. Mobile
   * receives the ping and refetches over the authenticated REST API (the
   * channel is treated as untrusted; never carries titles/notes — #36).
   */
  private broadcastState(
    event: CommunityEvent,
    fromState: CommunityEventState,
    toState: CommunityEventState,
  ): void {
    void this.realtime.broadcastCommunityEvent(
      this.realtime.channels.event(event.id),
      COMMUNITY_BROADCAST_EVENTS.eventStateChanged,
      {
        eventId: event.id,
        fromState,
        toState,
        at: new Date().toISOString(),
      },
      { distinctId: event.created_by_id, channelKind: 'event' },
    );
  }

  // ── Transition jobs (invoked by the cron scheduler) ────────────────────────

  /**
   * Promote `scheduled` events starting within `windowMs` to `tomorrow`, and
   * push a "starting soon" reminder to each member who RSVP'd going/maybe.
   * Pure of the cron wiring so it is directly unit-testable. Returns the count
   * promoted.
   */
  async runTomorrowPromotion(
    now: Date,
    windowMs: number,
    batchSize: number,
  ): Promise<number> {
    const windowEnd = new Date(now.getTime() + windowMs);
    const candidates = await this.events.findScheduledStartingBefore(
      windowEnd,
      batchSize,
    );
    let promoted = 0;
    for (const event of candidates) {
      // Skip anything already past start (the live sweep owns those) so we
      // never label an in-progress event "tomorrow".
      if (event.starts_at.getTime() <= now.getTime()) continue;
      if (!canTransition(event.state, CommunityEventState.tomorrow)) continue;
      const updated = await this.events.update(event.id, {
        state: CommunityEventState.tomorrow,
      });
      this.broadcastState(updated, event.state, updated.state);
      await this.pushStartingSoon(updated);
      promoted += 1;
    }
    return promoted;
  }

  /**
   * Promote events whose start time has passed (from scheduled OR tomorrow) to
   * `live`. Returns the count promoted.
   */
  async runLivePromotion(now: Date, batchSize: number): Promise<number> {
    const candidates = await this.events.findDueForLive(now, batchSize);
    let promoted = 0;
    for (const event of candidates) {
      if (!canTransition(event.state, CommunityEventState.live)) continue;
      const updated = await this.events.update(event.id, {
        state: CommunityEventState.live,
      });
      this.broadcastState(updated, event.state, updated.state);
      promoted += 1;
    }
    return promoted;
  }

  /**
   * Fire-and-forget "event starting soon" push to every member who RSVP'd
   * going/maybe and has not yet been reminded. reminded_at is stamped after the
   * fan-out so a re-run of the promotion (or a retry tick) does not double-push.
   * The push itself is gated behind FEATURE_COMMUNITY_PUSH inside the service
   * and carries IDs + a deep link only (never the event title/notes).
   */
  private async pushStartingSoon(event: CommunityEvent): Promise<void> {
    const recipients = await this.events.findRsvpRecipients({
      eventId: event.id,
      statuses: [
        CommunityEventRsvpStatus.going,
        CommunityEventRsvpStatus.maybe,
      ],
      onlyUnreminded: true,
    });
    if (recipients.length === 0) return;
    for (const r of recipients) {
      void this.communityPush.sendCommunityPush({
        recipientId: r.user_id,
        kind: NotificationKind.COMMUNITY_EVENT_STARTING_SOON,
        targetType: 'event',
        targetId: event.id,
        deepLink: `tgp://community/events/${event.id}`,
      });
    }
    await this.events.markReminded(
      recipients.map((r) => r.id),
      new Date(),
    );
  }
}
