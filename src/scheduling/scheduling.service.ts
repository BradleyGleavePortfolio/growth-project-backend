import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
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
import { assertCanManageAvailability, assertCanViewSession } from './scheduling.permissions';
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
    this.lifecycle =
      lifecycle ??
      new SchedulingSessionLifecycleService(
        prisma,
        audit,
        providers as SchedulingProviderRegistry,
        bookingEmitter as BookingEmitter,
      );
    this.openSlots = openSlots ?? new SchedulingOpenSlotsService(prisma);
    this.availability =
      availability ?? new SchedulingAvailabilityService(prisma);
  }

  // ---------------------------------------------------------------
  // SessionType CRUD
  // ---------------------------------------------------------------

  async listSessionTypes(coachId: string) {
    return this.prisma.sessionType.findMany({
      where: { coach_id: coachId, archived_at: null },
      orderBy: { created_at: 'asc' },
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
    const row = await this.prisma.sessionType.create({
      data: {
        coach_id: coachId,
        name: dto.name,
        description: dto.description ?? null,
        duration_minutes: dto.duration_minutes,
        auto_approve: dto.auto_approve ?? false,
        default_video_provider:
          (dto.default_video_provider as VideoProviderEnum) ?? 'stub',
      },
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
    const updated = await this.prisma.sessionType.update({
      where: { id: sessionTypeId },
      data,
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

  async getAvailability(coachId: string) {
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
    return this.getAvailability(coachId);
  }

  // ---------------------------------------------------------------
  // Sessions — delegated to SchedulingSessionLifecycleService
  // ---------------------------------------------------------------

  async requestSession(actor: ActorContext, dto: RequestSessionDto) {
    return this.lifecycle.requestSession(actor, dto);
  }

  async approveSession(actor: ActorContext, sessionId: string) {
    return this.lifecycle.approveSession(actor, sessionId);
  }

  async declineSession(
    actor: ActorContext,
    sessionId: string,
    reason?: string,
  ) {
    return this.lifecycle.declineSession(actor, sessionId, reason);
  }

  async rescheduleSession(
    actor: ActorContext,
    sessionId: string,
    dto: RescheduleSessionDto,
  ) {
    return this.lifecycle.rescheduleSession(actor, sessionId, dto);
  }

  async cancelSession(
    actor: ActorContext,
    sessionId: string,
    dto: CancelSessionDto,
  ) {
    return this.lifecycle.cancelSession(actor, sessionId, dto);
  }

  async completeSession(
    actor: ActorContext,
    sessionId: string,
    dto: CompleteSessionDto,
  ) {
    return this.lifecycle.completeSession(actor, sessionId, dto);
  }

  async markNoShow(actor: ActorContext, sessionId: string, reason?: string) {
    return this.lifecycle.markNoShow(actor, sessionId, reason);
  }

  async attachManualVideoLink(
    actor: ActorContext,
    sessionId: string,
    dto: AttachManualVideoLinkDto,
  ) {
    return this.lifecycle.attachManualVideoLink(actor, sessionId, dto);
  }

  // ---------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------

  async listUpcomingForActor(actor: ActorContext, limit = 25) {
    const cap = Math.min(Math.max(limit, 1), 100);
    const now = new Date();
    if (actor.role === 'owner') {
      return this.prisma.coachingSession.findMany({
        where: { start_at: { gte: now } },
        orderBy: { start_at: 'asc' },
        take: cap,
      });
    }
    if (actor.role === 'coach') {
      return this.prisma.coachingSession.findMany({
        where: { coach_id: actor.id, start_at: { gte: now } },
        orderBy: { start_at: 'asc' },
        take: cap,
      });
    }
    return this.prisma.coachingSession.findMany({
      where: { client_id: actor.id, start_at: { gte: now } },
      orderBy: { start_at: 'asc' },
      take: cap,
    });
  }

  async getSession(actor: ActorContext, sessionId: string) {
    const session = await this.lifecycle.loadSessionOrThrow(sessionId);
    assertCanViewSession(
      { id: actor.id, role: actor.role, coach_id: actor.coach_id },
      session,
    );
    return session;
  }

  // ---------------------------------------------------------------
  // Open slots — delegated to SchedulingOpenSlotsService
  // ---------------------------------------------------------------

  async getOpenSlots(
    actor: ActorContext,
    coachId: string,
    args: { from: string; to: string; duration_minutes?: number | null },
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
    return this.availability.createAvailabilityOverride(actor, dto);
  }

  async updateAvailabilityOverride(
    actor: ActorContext,
    id: string,
    dto: UpdateAvailabilityOverrideDto,
  ) {
    return this.availability.updateAvailabilityOverride(actor, id, dto);
  }

  async deleteAvailabilityOverride(actor: ActorContext, id: string) {
    return this.availability.deleteAvailabilityOverride(actor, id);
  }
}
