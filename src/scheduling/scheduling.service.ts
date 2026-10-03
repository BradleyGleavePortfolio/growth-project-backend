import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  SessionStatus,
  SessionType,
  VideoProvider as VideoProviderEnum,
} from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { BookingEmitter } from '../notifications/emitters/booking.emitter';
import { PrismaService } from '../prisma.service';
import {
  AttachManualVideoLinkDto,
  AvailabilityWindowDto,
  CancelSessionDto,
  CompleteSessionDto,
  CreateAvailabilityOverrideDto,
  CreateSessionTypeDto,
  RequestSessionDto,
  RescheduleSessionDto,
  UpdateAvailabilityOverrideDto,
  UpdateSessionTypeDto,
} from './dto/scheduling.dto';
import { SchedulingProviderRegistry } from './providers/scheduling-provider.registry';
import { SchedulingAccessService } from './scheduling-access.service';
import type { BookableCoach } from './scheduling-access.service';
import { SchedulingAvailabilityService } from './scheduling-availability.service';
import { SchedulingOpenSlotsService } from './scheduling-open-slots.service';
import { SchedulingSessionLifecycleService } from './scheduling-session-lifecycle.service';
import type { TransitionOptions } from './scheduling-session-lifecycle.service';
import { SESSION_VIEW_INCLUDE, toSessionView } from './scheduling-session.view';
import type { SessionView } from './scheduling-session.view';
import { assertCanManageAvailability } from './scheduling.permissions';
import {
  HTTPS_LINK_PATTERN,
  OCCUPYING_SESSION_STATUSES,
  SchedulingErrorCode,
  schedulingError,
} from './scheduling.types';
import type { ActorContext, OpenSlotsPayload } from './scheduling.types';

// GET /scheduling/my-coaches row (S-SCHED-2).
export interface MyCoachForScheduling extends BookableCoach {
  bookable_type_count: number;
  welcome: {
    session_type_id: string;
    name: string;
    duration_minutes: number;
    // The client's upcoming welcome booking with this coach, if any.
    active_session_id: string | null;
    active_session_status: string | null;
    active_session_start_at: string | null;
    // When the client's most recent welcome call with this coach was marked
    // completed (persistent "welcome done" signal for onboarding), else null.
    completed_at: string | null;
  } | null;
}

export type SessionTypeView = Omit<SessionType, 'default_meeting_url'> & {
  default_meeting_url: string | null;
};

// Re-export the OpenSlotsPayload shape from the types module so callers
// that imported it from scheduling.service.ts continue to resolve. Pure
// module-surface compatibility — no runtime change.
export type { OpenSlotsPayload } from './scheduling.types';

// SchedulingService is the only writer for the scheduling tables. State
// transitions, audit writes, and provider calls are all funnelled
// through here so the controller layer stays thin and the audit log
// stays complete.
//
// M9 refactor: this is now a facade. Session lifecycle moved to
// SchedulingSessionLifecycleService; open-slot computation moved to
// SchedulingOpenSlotsService; availability-override CRUD moved to
// SchedulingAvailabilityService. The public method signatures the
// controller depends on are preserved verbatim.
@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name);

  // The new sub-services are wired through Nest DI in production. In
  // unit tests that hand-construct SchedulingService with the pre-split
  // shape `(prisma, audit, providers, bookingEmitter)`, the lifecycle
  // / open-slots / availability params are @Optional() and we fall
  // back to constructing them on the same prisma/audit/providers/
  // bookingEmitter — preserves the pre-split test surface.
  private readonly lifecycle: SchedulingSessionLifecycleService;
  private readonly openSlots: SchedulingOpenSlotsService;
  private readonly availability: SchedulingAvailabilityService;
  private readonly access: SchedulingAccessService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() providers?: SchedulingProviderRegistry,
    @Optional() bookingEmitter?: BookingEmitter,
    @Optional() lifecycle?: SchedulingSessionLifecycleService,
    @Optional() openSlots?: SchedulingOpenSlotsService,
    @Optional() availability?: SchedulingAvailabilityService,
    @Optional() access?: SchedulingAccessService,
  ) {
    this.access = access ?? new SchedulingAccessService(prisma);
    this.openSlots = openSlots ?? new SchedulingOpenSlotsService(prisma, this.access);
    this.lifecycle =
      lifecycle ??
      new SchedulingSessionLifecycleService(
        prisma,
        audit,
        providers as SchedulingProviderRegistry,
        bookingEmitter as BookingEmitter,
        this.access,
        this.openSlots,
      );
    this.availability = availability ?? new SchedulingAvailabilityService(prisma);
  }

  // ---------------------------------------------------------------
  // My coaches (S-SCHED-2)
  // ---------------------------------------------------------------

  /**
   * The coaches this client can book with (head coach first, then the
   * current sub-coach), each with their timezone, how many appointment types
   * they offer, and their welcome type plus this client's upcoming welcome
   * booking. Coaches and owners get an empty list (they do not book).
   */
  async listMyCoaches(actor: ActorContext): Promise<MyCoachForScheduling[]> {
    const coaches = await this.access.listBookableCoaches(actor);
    if (coaches.length === 0) return [];
    const ids = coaches.map((c) => c.coach_id);
    const now = new Date();
    const [types, welcomeSessions, completedWelcomes] = await Promise.all([
      this.prisma.sessionType.findMany({
        where: { coach_id: { in: ids }, archived_at: null },
        select: { id: true, coach_id: true, name: true, duration_minutes: true, is_welcome: true },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.coachingSession.findMany({
        where: {
          coach_id: { in: ids },
          client_id: actor.id,
          status: { in: [...OCCUPYING_SESSION_STATUSES] },
          end_at: { gt: now },
          session_type: { is: { is_welcome: true } },
          // S-SCHED-5: a welcome request past its clear time is not active;
          // the client can book the welcome call again.
          OR: [
            { status: { not: 'requested' } },
            { request_expires_at: null },
            { request_expires_at: { gt: now } },
          ],
        },
        select: { id: true, coach_id: true, status: true, start_at: true },
        orderBy: { start_at: 'asc' },
      }),
      this.prisma.coachingSession.findMany({
        where: {
          coach_id: { in: ids },
          client_id: actor.id,
          status: 'completed',
          session_type: { is: { is_welcome: true } },
        },
        select: { coach_id: true, end_at: true },
        orderBy: { end_at: 'desc' },
      }),
    ]);
    return coaches.map((c) => {
      const mine = types.filter((t) => t.coach_id === c.coach_id);
      const welcomeType = mine.find((t) => t.is_welcome) ?? null;
      const active = welcomeSessions.find((s) => s.coach_id === c.coach_id) ?? null;
      const completed = completedWelcomes.find((s) => s.coach_id === c.coach_id) ?? null;
      return {
        ...c,
        bookable_type_count: mine.length,
        welcome: welcomeType
          ? {
              session_type_id: welcomeType.id,
              name: welcomeType.name,
              duration_minutes: welcomeType.duration_minutes,
              active_session_id: active?.id ?? null,
              active_session_status: active?.status ?? null,
              active_session_start_at: active ? active.start_at.toISOString() : null,
              completed_at: completed ? completed.end_at.toISOString() : null,
            }
          : null,
      };
    });
  }

  // ---------------------------------------------------------------
  // SessionType CRUD
  // ---------------------------------------------------------------

  /**
   * S-SCHED-2 (T4): a client sees only their bookable coaches' ACTIVE types
   * and never the coach's default meeting link (it is attached to the
   * session once confirmed). The coach sees their own, optionally including
   * archived ones. Everyone else: 403 COACH_NOT_BOOKABLE.
   */
  async listSessionTypes(
    actor: ActorContext,
    coachId: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<SessionTypeView[]> {
    await this.access.assertCanBrowseCoach(actor, coachId);
    const includeArchived = opts.includeArchived === true && actor.role !== 'student';
    const rows = await this.prisma.sessionType.findMany({
      where: { coach_id: coachId, ...(includeArchived ? {} : { archived_at: null }) },
      orderBy: [{ is_welcome: 'desc' }, { created_at: 'asc' }],
    });
    if (actor.role !== 'student') return rows;
    return rows.map((r) => ({ ...r, default_meeting_url: null }));
  }

  async createSessionType(actor: ActorContext, dto: CreateSessionTypeDto): Promise<SessionType> {
    if (actor.role !== 'coach' && actor.role !== 'owner') {
      throw new BadRequestException('Only coaches can create session types');
    }
    // C9: Only 'stub' and 'manual' are supported until real provider
    // adapters ship. Reject google_meet / zoom to prevent fake meeting
    // links from being stored on sessions.
    const allowedVideoProviders = ['stub', 'manual'];
    if (dto.default_video_provider && !allowedVideoProviders.includes(dto.default_video_provider)) {
      throw new BadRequestException('Video provider not yet available. Use manual link entry.');
    }
    const coachId = actor.id;
    const defaultMeetingUrl = normalizeDefaultMeetingUrl(dto.default_meeting_url);
    const row = await this.writeWelcomeAware(coachId, dto.is_welcome === true, null, (tx) =>
      tx.sessionType.create({
        data: {
          coach_id: coachId,
          name: dto.name,
          description: dto.description ?? null,
          duration_minutes: dto.duration_minutes,
          auto_approve: dto.auto_approve ?? false,
          default_video_provider: (dto.default_video_provider as VideoProviderEnum) ?? 'stub',
          is_welcome: dto.is_welcome === true,
          default_meeting_url: defaultMeetingUrl ?? null,
        },
      }),
    );
    await this.audit.write({
      action: AuditAction.SESSION_TYPE_CREATED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: coachId,
      targetType: 'session_type',
      targetId: row.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        name: row.name,
        duration_minutes: row.duration_minutes,
        auto_approve: row.auto_approve,
        is_welcome: row.is_welcome,
        has_default_meeting_url: row.default_meeting_url !== null,
      },
    });
    return row;
  }

  async updateSessionType(
    actor: ActorContext,
    sessionTypeId: string,
    dto: UpdateSessionTypeDto,
  ): Promise<SessionType> {
    const existing = await this.prisma.sessionType.findUnique({
      where: { id: sessionTypeId },
    });
    if (!existing || (existing.coach_id !== actor.id && actor.role !== 'owner')) {
      throw new NotFoundException(
        schedulingError(
          SchedulingErrorCode.SESSION_TYPE_UNAVAILABLE,
          'We could not find that appointment type. Refresh your appointment types and try the change again.',
        ),
      );
    }
    // C9: Same provider guard as createSessionType.
    const allowedVideoProviders = ['stub', 'manual'];
    if (dto.default_video_provider && !allowedVideoProviders.includes(dto.default_video_provider)) {
      throw new BadRequestException('Video provider not yet available. Use manual link entry.');
    }
    const data: Prisma.SessionTypeUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.duration_minutes !== undefined) data.duration_minutes = dto.duration_minutes;
    if (dto.auto_approve !== undefined) data.auto_approve = dto.auto_approve;
    if (dto.default_video_provider !== undefined) {
      data.default_video_provider = dto.default_video_provider as VideoProviderEnum;
    }
    if (dto.archived !== undefined) {
      data.archived_at = dto.archived ? new Date() : null;
    }
    if (dto.is_welcome !== undefined) data.is_welcome = dto.is_welcome;
    if (dto.default_meeting_url !== undefined) {
      data.default_meeting_url = normalizeDefaultMeetingUrl(dto.default_meeting_url);
    }
    // S-SCHED-3 (B-634-5): restoring an archived former welcome type while
    // the coach has since marked another active welcome type keeps the
    // current one. The restored type comes back as a regular type instead of
    // colliding with SessionType_one_active_welcome_per_coach. Asking for
    // is_welcome: true explicitly still moves the marker (below).
    const restoring = dto.archived === false && existing.archived_at !== null;
    if (restoring && existing.is_welcome && dto.is_welcome === undefined) {
      const currentWelcome = await this.prisma.sessionType.findFirst({
        where: {
          coach_id: existing.coach_id,
          is_welcome: true,
          archived_at: null,
          id: { not: sessionTypeId },
        },
        select: { id: true },
      });
      if (currentWelcome) data.is_welcome = false;
    }
    // Becoming (or staying) the active welcome type clears the marker on the
    // coach's other active types in the same transaction.
    const willBeActiveWelcome =
      (dto.is_welcome ?? existing.is_welcome) &&
      (dto.archived !== undefined ? !dto.archived : existing.archived_at === null);
    const updated = await this.writeWelcomeAware(
      existing.coach_id,
      willBeActiveWelcome && dto.is_welcome === true,
      sessionTypeId,
      (tx) => tx.sessionType.update({ where: { id: sessionTypeId }, data }),
    );
    await this.audit.write({
      action: AuditAction.SESSION_TYPE_UPDATED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: existing.coach_id,
      targetType: 'session_type',
      targetId: sessionTypeId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { changed_fields: Object.keys(data) },
    });
    return updated;
  }

  // ---------------------------------------------------------------
  // CoachAvailability (recurring windows)
  // ---------------------------------------------------------------

  /** S-SCHED-2 (T4): weekly hours are readable by the coach, owner, and that coach's assigned clients only. */
  async getAvailability(actor: ActorContext, coachId: string) {
    await this.access.assertCanBrowseCoach(actor, coachId);
    return this.readAvailability(coachId);
  }

  private async readAvailability(coachId: string) {
    return this.prisma.coachAvailability.findMany({
      where: { coach_id: coachId },
      orderBy: [{ day_of_week: 'asc' }, { start_minute: 'asc' }],
    });
  }

  async setAvailability(actor: ActorContext, coachId: string, windows: AvailabilityWindowDto[]) {
    assertCanManageAvailability({ id: actor.id, role: actor.role }, coachId);
    for (const w of windows) {
      if (w.end_minute <= w.start_minute) {
        throw new BadRequestException(
          schedulingError(
            SchedulingErrorCode.INVALID_TIME,
            'Each open-hours window must end after it starts. Fix the end time and save again.',
          ),
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.coachAvailability.deleteMany({ where: { coach_id: coachId } });
      if (windows.length > 0) {
        await tx.coachAvailability.createMany({
          data: windows.map((w) => ({
            coach_id: coachId,
            day_of_week: w.day_of_week,
            start_minute: w.start_minute,
            end_minute: w.end_minute,
            session_type_id: w.session_type_id ?? null,
          })),
        });
      }
    });
    await this.audit.write({
      action: AuditAction.COACH_AVAILABILITY_UPDATED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: coachId,
      targetType: 'coach_availability',
      targetId: coachId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { window_count: windows.length },
    });
    this.openSlots.invalidateCoach(coachId);
    return this.readAvailability(coachId);
  }

  // ---------------------------------------------------------------
  // Sessions — delegated to SchedulingSessionLifecycleService
  // ---------------------------------------------------------------

  async requestSession(actor: ActorContext, dto: RequestSessionDto): Promise<SessionView> {
    return this.view(actor, await this.lifecycle.requestSession(actor, dto));
  }

  async approveSession(
    actor: ActorContext,
    sessionId: string,
    opts: TransitionOptions = {},
  ): Promise<SessionView> {
    return this.view(actor, await this.lifecycle.approveSession(actor, sessionId, opts));
  }

  async declineSession(
    actor: ActorContext,
    sessionId: string,
    reason?: string,
    opts: TransitionOptions = {},
  ): Promise<SessionView> {
    return this.view(actor, await this.lifecycle.declineSession(actor, sessionId, reason, opts));
  }

  async rescheduleSession(
    actor: ActorContext,
    sessionId: string,
    dto: RescheduleSessionDto,
  ): Promise<SessionView> {
    return this.view(actor, await this.lifecycle.rescheduleSession(actor, sessionId, dto));
  }

  async cancelSession(
    actor: ActorContext,
    sessionId: string,
    dto: CancelSessionDto,
  ): Promise<SessionView> {
    return this.view(actor, await this.lifecycle.cancelSession(actor, sessionId, dto));
  }

  async completeSession(
    actor: ActorContext,
    sessionId: string,
    dto: CompleteSessionDto,
  ): Promise<SessionView> {
    return this.view(actor, await this.lifecycle.completeSession(actor, sessionId, dto));
  }

  async markNoShow(
    actor: ActorContext,
    sessionId: string,
    reason?: string,
    opts: TransitionOptions = {},
  ): Promise<SessionView> {
    return this.view(actor, await this.lifecycle.markNoShow(actor, sessionId, reason, opts));
  }

  async attachManualVideoLink(
    actor: ActorContext,
    sessionId: string,
    dto: AttachManualVideoLinkDto,
  ): Promise<SessionView> {
    return this.view(actor, await this.lifecycle.attachManualVideoLink(actor, sessionId, dto));
  }

  // ---------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------

  /** Back-compat: GET /scheduling/sessions without scope. */
  async listUpcomingForActor(actor: ActorContext, limit = 25): Promise<SessionView[]> {
    return this.listSessionsForActor(actor, { scope: 'upcoming', limit });
  }

  /**
   * S-SCHED-2: upcoming (end_at > now, soonest first; includes a session in
   * progress) or past (end_at <= now, most recent first). Owners see all,
   * coaches their own calendar, clients their own sessions (with any coach,
   * so history survives a coach change).
   *
   * S-SCHED-3 (B-634-4, C-634-3): keyset pages on the full sort key
   * (start_at, id), so rows that share a start time are never skipped or
   * repeated across pages:
   *   past:     before=<start_at of last row>&before_id=<id of last row>
   *             -> start_at < before OR (start_at = before AND id < before_id)
   *   upcoming: after=<start_at of last row>&after_id=<id of last row>
   *             -> start_at > after OR (start_at = after AND id > after_id)
   * `before` alone keeps the older (timestamp-only) meaning for old clients.
   * `statuses` narrows either scope (e.g. the coach inbox asks only for
   * `requested`), so terminal rows never crowd live ones out of a page.
   */
  async listSessionsForActor(
    actor: ActorContext,
    args: {
      scope?: 'upcoming' | 'past';
      limit?: number;
      before?: string | null;
      before_id?: string | null;
      after?: string | null;
      after_id?: string | null;
      statuses?: SessionStatus[] | null;
    },
  ): Promise<SessionView[]> {
    const cap = Math.min(Math.max(Number.isFinite(args.limit) ? Number(args.limit) : 25, 1), 100);
    const now = new Date();
    const scope = args.scope ?? 'upcoming';
    const who: Prisma.CoachingSessionWhereInput =
      actor.role === 'owner'
        ? {}
        : actor.role === 'coach'
          ? { coach_id: actor.id }
          : { client_id: actor.id };
    const statusFilter: Prisma.CoachingSessionWhereInput =
      args.statuses && args.statuses.length > 0 ? { status: { in: args.statuses } } : {};
    if (scope === 'past') {
      const before = parseCursorTime(args.before, 'before');
      const beforeId = parseCursorId(args.before_id, 'before_id', before);
      const cursor: Prisma.CoachingSessionWhereInput = before
        ? beforeId
          ? { OR: [{ start_at: { lt: before } }, { start_at: before, id: { lt: beforeId } }] }
          : { start_at: { lt: before } }
        : {};
      const rows = await this.prisma.coachingSession.findMany({
        where: { AND: [{ ...who, ...statusFilter, end_at: { lte: now } }, cursor] },
        orderBy: [{ start_at: 'desc' }, { id: 'desc' }],
        take: cap,
        include: SESSION_VIEW_INCLUDE,
      });
      return rows.map((r) => toSessionView(r, actor, now));
    }
    const after = parseCursorTime(args.after, 'after');
    const afterId = parseCursorId(args.after_id, 'after_id', after);
    const cursor: Prisma.CoachingSessionWhereInput = after
      ? afterId
        ? { OR: [{ start_at: { gt: after } }, { start_at: after, id: { gt: afterId } }] }
        : { start_at: { gt: after } }
      : {};
    const rows = await this.prisma.coachingSession.findMany({
      where: { AND: [{ ...who, ...statusFilter, end_at: { gt: now } }, cursor] },
      orderBy: [{ start_at: 'asc' }, { id: 'asc' }],
      take: cap,
      include: SESSION_VIEW_INCLUDE,
    });
    return rows.map((r) => toSessionView(r, actor, now));
  }

  async getSession(actor: ActorContext, sessionId: string): Promise<SessionView> {
    const session = await this.lifecycle.loadSessionOrThrow(sessionId);
    this.access.assertCanViewSession(actor, session);
    return this.view(actor, session);
  }

  private async view(actor: ActorContext, row: { id: string }): Promise<SessionView> {
    const full = await this.prisma.coachingSession.findUnique({
      where: { id: row.id },
      include: SESSION_VIEW_INCLUDE,
    });
    if (!full) {
      throw new NotFoundException(
        schedulingError(
          SchedulingErrorCode.SESSION_NOT_FOUND,
          'We could not find that session. It may have been removed. Open Calendar to see your sessions.',
        ),
      );
    }
    return toSessionView(full, actor);
  }

  // Create/update a session type; when it becomes the active welcome type,
  // clear the marker on the coach's other active types first, in the same
  // transaction. The partial unique index is the floor; a concurrent race
  // surfaces as 409 instead of a 500.
  private async writeWelcomeAware(
    coachId: string,
    markWelcome: boolean,
    selfId: string | null,
    write: (tx: Prisma.TransactionClient) => Promise<SessionType>,
  ): Promise<SessionType> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (markWelcome) {
          await tx.sessionType.updateMany({
            where: {
              coach_id: coachId,
              is_welcome: true,
              archived_at: null,
              ...(selfId ? { id: { not: selfId } } : {}),
            },
            data: { is_welcome: false },
          });
        }
        return write(tx);
      });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'P2002') {
        throw new ConflictException(
          schedulingError(
            SchedulingErrorCode.SESSION_STATE_CHANGED,
            'Another change to your welcome call type landed at the same time. Refresh your appointment types and try again.',
          ),
        );
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------
  // Open slots — delegated to SchedulingOpenSlotsService
  // ---------------------------------------------------------------

  async getOpenSlots(
    actor: ActorContext,
    coachId: string,
    args: {
      from: string;
      to: string;
      duration_minutes?: number | null;
      session_type_id?: string | null;
    },
  ): Promise<OpenSlotsPayload> {
    return this.openSlots.getOpenSlots(actor, coachId, args);
  }

  // ---------------------------------------------------------------
  // Coach availability overrides — delegated to
  // SchedulingAvailabilityService
  // ---------------------------------------------------------------

  async listMyAvailabilityOverrides(actor: ActorContext, args: { from?: string; to?: string }) {
    return this.availability.listMyAvailabilityOverrides(actor, args);
  }

  async createAvailabilityOverride(actor: ActorContext, dto: CreateAvailabilityOverrideDto) {
    const row = await this.availability.createAvailabilityOverride(actor, dto);
    this.openSlots.invalidateCoach(row.coach_id);
    return row;
  }

  async updateAvailabilityOverride(
    actor: ActorContext,
    id: string,
    dto: UpdateAvailabilityOverrideDto,
  ) {
    const row = await this.availability.updateAvailabilityOverride(actor, id, dto);
    this.openSlots.invalidateCoach(row.coach_id);
    return row;
  }

  async deleteAvailabilityOverride(actor: ActorContext, id: string) {
    const res = await this.availability.deleteAvailabilityOverride(actor, id);
    // The coach is unknown after delete; clear the whole per-process cache.
    this.openSlots.invalidateAll();
    return res;
  }
}

// Coach-entered default room link: trimmed; empty means "remove". Must be https.
// Keyset cursor parts (S-SCHED-3 B-634-4). Unreadable values are a coded
// 400 with a next step, never a silent full list.
function parseCursorTime(raw: string | null | undefined, name: string): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestException(
      schedulingError(
        SchedulingErrorCode.INVALID_LIST_QUERY,
        `The ${name} cursor could not be read. Reload the list from the start.`,
      ),
    );
  }
  return at;
}

const CURSOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function parseCursorId(
  raw: string | null | undefined,
  name: string,
  time: Date | null,
): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!CURSOR_ID_PATTERN.test(raw) || time === null) {
    throw new BadRequestException(
      schedulingError(
        SchedulingErrorCode.INVALID_LIST_QUERY,
        `The ${name} cursor could not be read. Reload the list from the start.`,
      ),
    );
  }
  return raw;
}

function normalizeDefaultMeetingUrl(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const v = raw.trim();
  if (v === '') return null;
  if (!HTTPS_LINK_PATTERN.test(v)) {
    throw new BadRequestException(
      schedulingError(
        SchedulingErrorCode.INVALID_MEETING_LINK,
        'Use a meeting link that starts with https://, for example your Zoom or Google Meet room.',
      ),
    );
  }
  return v;
}
