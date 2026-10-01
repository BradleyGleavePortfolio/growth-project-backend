import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  CoachingSession,
  Prisma,
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
import { SchedulingAvailabilityService } from './scheduling-availability.service';
import { SchedulingOpenSlotsService } from './scheduling-open-slots.service';
import { SchedulingSessionLifecycleService } from './scheduling-session-lifecycle.service';
import {
  assertCanBrowseCoachBooking,
  assertCanManageAvailability,
  assertCanViewSession,
} from './scheduling.permissions';
import type { ActorContext, OpenSlotsPayload } from './scheduling.types';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() providers?: SchedulingProviderRegistry,
    @Optional() bookingEmitter?: BookingEmitter,
    @Optional() lifecycle?: SchedulingSessionLifecycleService,
    @Optional() openSlots?: SchedulingOpenSlotsService,
    @Optional() availability?: SchedulingAvailabilityService,
  ) {
    this.openSlots = openSlots ?? new SchedulingOpenSlotsService(prisma);
    this.lifecycle =
      lifecycle ??
      new SchedulingSessionLifecycleService(
        prisma,
        audit,
        providers as SchedulingProviderRegistry,
        bookingEmitter as BookingEmitter,
        this.openSlots,
      );
    this.availability =
      availability ?? new SchedulingAvailabilityService(prisma);
  }

  // ---------------------------------------------------------------
  // SessionType CRUD
  // ---------------------------------------------------------------

  // S-SCHED: actor-gated (was readable by any authenticated user). Clients
  // see only their assigned coach's active types; the coach (or owner) may
  // ask for archived ones too, for the appointment-types manager.
  /**
   * S-SCHED: the coaches this actor can book with. Today that is exactly the
   * client's assigned coach (User.coach_id), which is the same rule
   * assertCanBrowseCoachBooking enforces; team sub-coach booking is a
   * separate product decision. Coaches and owners get an empty list (they
   * manage their own calendar, they do not book one).
   */
  async listMyCoaches(
    actor: ActorContext,
  ): Promise<Array<{ coach_id: string; name: string; timezone: string | null }>> {
    if (actor.role !== 'student' || !actor.coach_id) return [];
    const coach = await this.prisma.user.findUnique({
      where: { id: actor.coach_id },
      select: { id: true, name: true, role: true },
    });
    if (!coach || coach.role !== 'coach') return [];
    const profile = await this.prisma.coachProfile.findUnique({
      where: { user_id: coach.id },
      select: { timezone: true },
    });
    return [{ coach_id: coach.id, name: coach.name, timezone: profile?.timezone ?? null }];
  }

  async listSessionTypes(
    actor: ActorContext,
    coachId: string,
    opts: { includeArchived?: boolean } = {},
  ) {
    assertCanBrowseCoachBooking(
      { id: actor.id, role: actor.role, coach_id: actor.coach_id },
      coachId,
    );
    const canSeeArchived =
      actor.role === 'owner' || (actor.role === 'coach' && actor.id === coachId);
    const includeArchived = Boolean(opts.includeArchived) && canSeeArchived;
    const rows = await this.prisma.sessionType.findMany({
      where: includeArchived
        ? { coach_id: coachId }
        : { coach_id: coachId, archived_at: null },
      orderBy: { created_at: 'asc' },
    });
    // The coach's private meeting room link is attached to confirmed
    // sessions only; it is not advertised to clients on the type list.
    if (actor.role === 'student') {
      return rows.map((r) => ({ ...r, default_meeting_url: null }));
    }
    return rows;
  }

  // At most one active welcome type per coach (also a partial unique index).
  // Marking a type as the welcome type clears the flag on the others in the
  // same transaction, so the switch is atomic.
  private async clearOtherWelcomeTypes(
    tx: Prisma.TransactionClient,
    coachId: string,
    keepId: string | null,
  ): Promise<void> {
    await tx.sessionType.updateMany({
      where: {
        coach_id: coachId,
        is_welcome: true,
        ...(keepId ? { id: { not: keepId } } : {}),
      },
      data: { is_welcome: false },
    });
  }

  async createSessionType(
    actor: ActorContext,
    dto: CreateSessionTypeDto,
  ): Promise<SessionType> {
    if (actor.role !== 'coach' && actor.role !== 'owner') {
      throw new BadRequestException('Only coaches can create session types');
    }
    // C9: Only 'stub' and 'manual' are supported until real provider
    // adapters ship. Reject google_meet / zoom to prevent fake meeting
    // links from being stored on sessions.
    const allowedVideoProviders = ['stub', 'manual'];
    if (
      dto.default_video_provider &&
      !allowedVideoProviders.includes(dto.default_video_provider)
    ) {
      throw new BadRequestException(
        'Video provider not yet available. Use manual link entry.',
      );
    }
    const coachId = actor.id;
    const row = await this.prisma.$transaction(async (tx) => {
      if (dto.is_welcome) await this.clearOtherWelcomeTypes(tx, coachId, null);
      return tx.sessionType.create({
        data: {
          coach_id: coachId,
          name: dto.name,
          description: dto.description ?? null,
          duration_minutes: dto.duration_minutes,
          auto_approve: dto.auto_approve ?? false,
          default_video_provider:
            (dto.default_video_provider as VideoProviderEnum) ?? 'stub',
          is_welcome: dto.is_welcome ?? false,
          default_meeting_url: dto.default_meeting_url ?? null,
        },
      });
    });
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
    if (!existing) throw new NotFoundException('Session type not found');
    if (existing.coach_id !== actor.id && actor.role !== 'owner') {
      throw new NotFoundException('Session type not found');
    }
    // C9: Same provider guard as createSessionType.
    const allowedVideoProviders = ['stub', 'manual'];
    if (
      dto.default_video_provider &&
      !allowedVideoProviders.includes(dto.default_video_provider)
    ) {
      throw new BadRequestException(
        'Video provider not yet available. Use manual link entry.',
      );
    }
    const data: Prisma.SessionTypeUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.duration_minutes !== undefined)
      data.duration_minutes = dto.duration_minutes;
    if (dto.auto_approve !== undefined) data.auto_approve = dto.auto_approve;
    if (dto.default_video_provider !== undefined) {
      data.default_video_provider =
        dto.default_video_provider as VideoProviderEnum;
    }
    if (dto.archived !== undefined) {
      data.archived_at = dto.archived ? new Date() : null;
    }
    if (dto.is_welcome !== undefined) data.is_welcome = dto.is_welcome;
    if (dto.default_meeting_url !== undefined) {
      data.default_meeting_url = dto.default_meeting_url;
    }
    // Un-archiving a welcome type, or marking one, must not leave two
    // active welcome types for the coach.
    const willBeWelcome = dto.is_welcome ?? existing.is_welcome;
    const willBeActive =
      dto.archived !== undefined ? !dto.archived : existing.archived_at === null;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (willBeWelcome && willBeActive) {
        await this.clearOtherWelcomeTypes(tx, existing.coach_id, sessionTypeId);
      }
      return tx.sessionType.update({
        where: { id: sessionTypeId },
        data,
      });
    });
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

  // S-SCHED: actor-gated like the session-type list (was readable by any
  // authenticated user).
  async getAvailability(actor: ActorContext, coachId: string) {
    assertCanBrowseCoachBooking(
      { id: actor.id, role: actor.role, coach_id: actor.coach_id },
      coachId,
    );
    return this.readAvailability(coachId);
  }

  private async readAvailability(coachId: string) {
    return this.prisma.coachAvailability.findMany({
      where: { coach_id: coachId },
      orderBy: [{ day_of_week: 'asc' }, { start_minute: 'asc' }],
    });
  }

  async setAvailability(
    actor: ActorContext,
    coachId: string,
    windows: AvailabilityWindowDto[],
  ) {
    assertCanManageAvailability({ id: actor.id, role: actor.role }, coachId);
    for (const w of windows) {
      if (w.end_minute <= w.start_minute) {
        throw new BadRequestException(
          'Each availability window must have end_minute > start_minute',
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

  async requestSession(actor: ActorContext, dto: RequestSessionDto) {
    try {
      return toSessionView(actor, await this.lifecycle.requestSession(actor, dto));
    } finally {
      this.openSlots.invalidateCoach(dto.coach_id);
    }
  }

  async approveSession(actor: ActorContext, sessionId: string) {
    return this.afterWrite(actor, await this.lifecycle.approveSession(actor, sessionId));
  }

  async declineSession(
    actor: ActorContext,
    sessionId: string,
    reason?: string,
  ) {
    return this.afterWrite(
      actor,
      await this.lifecycle.declineSession(actor, sessionId, reason),
    );
  }

  async rescheduleSession(
    actor: ActorContext,
    sessionId: string,
    dto: RescheduleSessionDto,
  ) {
    return this.afterWrite(
      actor,
      await this.lifecycle.rescheduleSession(actor, sessionId, dto),
    );
  }

  async cancelSession(
    actor: ActorContext,
    sessionId: string,
    dto: CancelSessionDto,
  ) {
    return this.afterWrite(
      actor,
      await this.lifecycle.cancelSession(actor, sessionId, dto),
    );
  }

  async completeSession(
    actor: ActorContext,
    sessionId: string,
    dto: CompleteSessionDto,
  ) {
    return this.afterWrite(
      actor,
      await this.lifecycle.completeSession(actor, sessionId, dto),
    );
  }

  async markNoShow(actor: ActorContext, sessionId: string, reason?: string) {
    return this.afterWrite(
      actor,
      await this.lifecycle.markNoShow(actor, sessionId, reason),
    );
  }

  async attachManualVideoLink(
    actor: ActorContext,
    sessionId: string,
    dto: AttachManualVideoLinkDto,
  ) {
    return toSessionView(
      actor,
      await this.lifecycle.attachManualVideoLink(actor, sessionId, dto),
    );
  }

  private afterWrite(actor: ActorContext, row: CoachingSession) {
    this.openSlots.invalidateCoach(row.coach_id);
    return toSessionView(actor, row);
  }

  // ---------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------

  // S-SCHED: `upcoming` keeps a session until it ENDS (so an in-progress
  // session still shows its Join link); `past` is everything that ended,
  // newest first. Clients receive the client view (no coach-internal notes
  // or provider bookkeeping).
  async listUpcomingForActor(
    actor: ActorContext,
    limit = 25,
    scope: 'upcoming' | 'past' = 'upcoming',
  ) {
    const cap = Math.min(Math.max(Number.isFinite(limit) ? limit : 25, 1), 100);
    const now = new Date();
    const timeFilter =
      scope === 'past' ? { end_at: { lt: now } } : { end_at: { gte: now } };
    const orderBy =
      scope === 'past'
        ? ({ start_at: 'desc' } as const)
        : ({ start_at: 'asc' } as const);
    const owner =
      actor.role === 'owner'
        ? {}
        : actor.role === 'coach'
          ? { coach_id: actor.id }
          : { client_id: actor.id };
    const rows = await this.prisma.coachingSession.findMany({
      where: { ...owner, ...timeFilter },
      orderBy,
      take: cap,
    });
    return rows.map((r) => toSessionView(actor, r));
  }

  async getSession(actor: ActorContext, sessionId: string) {
    const session = await this.lifecycle.loadSessionOrThrow(sessionId);
    assertCanViewSession(
      { id: actor.id, role: actor.role, coach_id: actor.coach_id },
      session,
    );
    return toSessionView(actor, session);
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

  async listMyAvailabilityOverrides(
    actor: ActorContext,
    args: { from?: string; to?: string },
  ) {
    return this.availability.listMyAvailabilityOverrides(actor, args);
  }

  async createAvailabilityOverride(
    actor: ActorContext,
    dto: CreateAvailabilityOverrideDto,
  ) {
    const row = await this.availability.createAvailabilityOverride(actor, dto);
    // S-SCHED: time off must hide slots at once, not after the 60s cache.
    this.openSlots.invalidateCoach(actor.id);
    return row;
  }

  async updateAvailabilityOverride(
    actor: ActorContext,
    id: string,
    dto: UpdateAvailabilityOverrideDto,
  ) {
    const row = await this.availability.updateAvailabilityOverride(actor, id, dto);
    this.openSlots.invalidateCoach(actor.id);
    return row;
  }

  async deleteAvailabilityOverride(actor: ActorContext, id: string) {
    const out = await this.availability.deleteAvailabilityOverride(actor, id);
    this.openSlots.invalidateCoach(actor.id);
    return out;
  }
}

// S-SCHED: what a client may see of a session row. `coach_notes_md` is the
// coach's internal note (schema comment: "Internal coach-only notes");
// provider ids / idempotency keys are server bookkeeping. Coaches and
// owners keep the full row. `client_recap_md` is the client-visible recap.
export type ClientSessionView = Omit<
  CoachingSession,
  'coach_notes_md' | 'provider_idempotency_key' | 'calendar_event_id' | 'video_meeting_id'
>;

export function toSessionView(
  actor: { role: ActorContext['role'] },
  row: CoachingSession,
): CoachingSession | ClientSessionView {
  if (actor.role !== 'student') return row;
  const {
    coach_notes_md: _notes,
    provider_idempotency_key: _key,
    calendar_event_id: _cal,
    video_meeting_id: _vid,
    ...rest
  } = row;
  return rest;
}
