import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CalendarProvider as CalendarProviderEnum,
  CoachingSession,
  Prisma,
  SessionStatus,
  SessionType,
  VideoProvider as VideoProviderEnum,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditAction, AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma.service';
import {
  AttachManualVideoLinkDto,
  AvailabilityWindowDto,
  CancelSessionDto,
  CompleteSessionDto,
  CreateSessionTypeDto,
  RequestSessionDto,
  RescheduleSessionDto,
  UpdateSessionTypeDto,
} from './dto/scheduling.dto';
import { SchedulingProviderRegistry } from './providers/scheduling-provider.registry';
import {
  assertCanApproveOrDecline,
  assertCanCancel,
  assertCanCompleteOrNoShow,
  assertCanManageAvailability,
  assertCanRequestSession,
  assertCanReschedule,
  assertCanViewSession,
} from './scheduling.permissions';

// State-machine: which `SessionStatus` transitions the service will
// accept. Anything outside this map throws a 400 — keeps the audit log
// honest (no "completed -> requested" loops).
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  requested: ['scheduled', 'declined', 'canceled', 'pending_provider'],
  pending_provider: ['scheduled', 'canceled'],
  scheduled: ['canceled', 'completed', 'no_show'],
  declined: [],
  canceled: [],
  no_show: [],
  completed: [],
};

interface ActorContext {
  id: string;
  role: 'student' | 'coach' | 'owner';
  email: string | null;
  coach_id: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

// SchedulingService is the only writer for the scheduling tables. State
// transitions, audit writes, and provider calls are all funnelled
// through here so the controller layer stays thin and the audit log
// stays complete.
@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly providers: SchedulingProviderRegistry,
  ) {}

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
  // CoachAvailability
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
  // Sessions: request / approve / decline / reschedule / cancel /
  // complete / no-show / list
  // ---------------------------------------------------------------

  async requestSession(actor: ActorContext, dto: RequestSessionDto) {
    assertCanRequestSession(
      { id: actor.id, role: actor.role, coach_id: actor.coach_id },
      dto.coach_id,
    );
    const start = new Date(dto.start_at);
    const end = new Date(dto.end_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid start_at or end_at');
    }
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException('end_at must be after start_at');
    }
    let sessionType: SessionType | null = null;
    if (dto.session_type_id) {
      sessionType = await this.prisma.sessionType.findUnique({
        where: { id: dto.session_type_id },
      });
      if (!sessionType || sessionType.coach_id !== dto.coach_id) {
        throw new BadRequestException('Unknown session_type_id');
      }
    }

    const initialStatus: SessionStatus = sessionType?.auto_approve
      ? 'scheduled'
      : 'requested';
    const videoProvider: VideoProviderEnum =
      sessionType?.default_video_provider ?? 'stub';

    const session = await this.prisma.coachingSession.create({
      data: {
        coach_id: dto.coach_id,
        client_id: actor.id,
        session_type_id: sessionType?.id ?? null,
        status: initialStatus,
        start_at: start,
        end_at: end,
        title: dto.title,
        video_provider: videoProvider,
        calendar_provider: 'stub',
      },
    });
    await this.audit.write({
      action: AuditAction.SESSION_REQUESTED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: dto.coach_id,
      targetUserId: dto.coach_id,
      targetType: 'coaching_session',
      targetId: session.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        auto_approved: initialStatus === 'scheduled',
      },
    });
    if (initialStatus === 'scheduled') {
      // Auto-approved sessions get the same provisioning step a manual
      // approval triggers — so the audit log shows both events and the
      // calendar event/video link are minted exactly once.
      return this.runProviderProvisioning(session.id, actor);
    }
    return session;
  }

  async approveSession(actor: ActorContext, sessionId: string) {
    const existing = await this.loadSessionOrThrow(sessionId);
    assertCanApproveOrDecline(actor, existing);
    this.assertTransition(existing.status, 'scheduled');
    const updated = await this.prisma.coachingSession.update({
      where: { id: sessionId },
      data: { status: 'scheduled', approved_at: new Date() },
    });
    await this.audit.write({
      action: AuditAction.SESSION_APPROVED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: existing.coach_id,
      targetUserId: existing.client_id ?? null,
      targetType: 'coaching_session',
      targetId: sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { from: existing.status, to: 'scheduled' },
    });
    return this.runProviderProvisioning(updated.id, actor);
  }

  async declineSession(
    actor: ActorContext,
    sessionId: string,
    reason?: string,
  ) {
    const existing = await this.loadSessionOrThrow(sessionId);
    assertCanApproveOrDecline(actor, existing);
    this.assertTransition(existing.status, 'declined');
    const updated = await this.prisma.coachingSession.update({
      where: { id: sessionId },
      data: {
        status: 'declined',
        ended_at: new Date(),
        end_reason: reason ?? null,
      },
    });
    await this.audit.write({
      action: AuditAction.SESSION_DECLINED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: existing.coach_id,
      targetUserId: existing.client_id ?? null,
      targetType: 'coaching_session',
      targetId: sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { from: existing.status, to: 'declined', reason: reason ?? null },
    });
    return updated;
  }

  async rescheduleSession(
    actor: ActorContext,
    sessionId: string,
    dto: RescheduleSessionDto,
  ) {
    const existing = await this.loadSessionOrThrow(sessionId);
    assertCanReschedule(
      { id: actor.id, role: actor.role, coach_id: actor.coach_id },
      existing,
    );
    if (existing.status !== 'requested' && existing.status !== 'scheduled') {
      throw new BadRequestException(
        `Cannot reschedule a session in status=${existing.status}`,
      );
    }
    const start = new Date(dto.start_at);
    const end = new Date(dto.end_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid start_at or end_at');
    }
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException('end_at must be after start_at');
    }
    const updated = await this.prisma.coachingSession.update({
      where: { id: sessionId },
      data: { start_at: start, end_at: end },
    });
    await this.audit.write({
      action: AuditAction.SESSION_RESCHEDULED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: existing.coach_id,
      targetUserId: existing.client_id ?? null,
      targetType: 'coaching_session',
      targetId: sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        previous_start_at: existing.start_at.toISOString(),
        previous_end_at: existing.end_at.toISOString(),
        new_start_at: start.toISOString(),
        new_end_at: end.toISOString(),
        reason: dto.reason ?? null,
      },
    });
    return updated;
  }

  async cancelSession(
    actor: ActorContext,
    sessionId: string,
    dto: CancelSessionDto,
  ) {
    const existing = await this.loadSessionOrThrow(sessionId);
    assertCanCancel(
      { id: actor.id, role: actor.role, coach_id: actor.coach_id },
      existing,
    );
    this.assertTransition(existing.status, 'canceled');
    const updated = await this.prisma.coachingSession.update({
      where: { id: sessionId },
      data: {
        status: 'canceled',
        ended_at: new Date(),
        end_reason: dto.reason ?? null,
      },
    });
    await this.audit.write({
      action: AuditAction.SESSION_CANCELED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: existing.coach_id,
      targetUserId: existing.client_id ?? null,
      targetType: 'coaching_session',
      targetId: sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { from: existing.status, to: 'canceled', reason: dto.reason ?? null },
    });
    if (existing.calendar_event_id) {
      await this.cancelProviderArtifacts(existing);
    }
    return updated;
  }

  async completeSession(
    actor: ActorContext,
    sessionId: string,
    dto: CompleteSessionDto,
  ) {
    const existing = await this.loadSessionOrThrow(sessionId);
    assertCanCompleteOrNoShow(actor, existing);
    this.assertTransition(existing.status, 'completed');
    const updated = await this.prisma.coachingSession.update({
      where: { id: sessionId },
      data: {
        status: 'completed',
        ended_at: new Date(),
        coach_notes_md: dto.coach_notes_md ?? existing.coach_notes_md,
      },
    });
    await this.audit.write({
      action: AuditAction.SESSION_COMPLETED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: existing.coach_id,
      targetUserId: existing.client_id ?? null,
      targetType: 'coaching_session',
      targetId: sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { from: existing.status, to: 'completed' },
    });
    return updated;
  }

  async markNoShow(actor: ActorContext, sessionId: string, reason?: string) {
    const existing = await this.loadSessionOrThrow(sessionId);
    assertCanCompleteOrNoShow(actor, existing);
    this.assertTransition(existing.status, 'no_show');
    const updated = await this.prisma.coachingSession.update({
      where: { id: sessionId },
      data: {
        status: 'no_show',
        ended_at: new Date(),
        end_reason: reason ?? null,
      },
    });
    await this.audit.write({
      action: AuditAction.SESSION_NO_SHOW,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: existing.coach_id,
      targetUserId: existing.client_id ?? null,
      targetType: 'coaching_session',
      targetId: sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { from: existing.status, to: 'no_show', reason: reason ?? null },
    });
    return updated;
  }

  async attachManualVideoLink(
    actor: ActorContext,
    sessionId: string,
    dto: AttachManualVideoLinkDto,
  ) {
    const existing = await this.loadSessionOrThrow(sessionId);
    if (
      existing.coach_id !== actor.id &&
      actor.role !== 'owner'
    ) {
      throw new NotFoundException('Session not found');
    }
    const updated = await this.prisma.coachingSession.update({
      where: { id: sessionId },
      data: {
        video_provider: 'manual',
        video_url: dto.video_url,
        video_meeting_id: null,
      },
    });
    await this.audit.write({
      action: AuditAction.SESSION_VIDEO_LINK_ATTACHED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: existing.coach_id,
      targetUserId: existing.client_id ?? null,
      targetType: 'coaching_session',
      targetId: sessionId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { provider: 'manual' },
    });
    return updated;
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
    const session = await this.loadSessionOrThrow(sessionId);
    assertCanViewSession(
      { id: actor.id, role: actor.role, coach_id: actor.coach_id },
      session,
    );
    return session;
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------

  private async loadSessionOrThrow(sessionId: string): Promise<CoachingSession> {
    const session = await this.prisma.coachingSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  private assertTransition(from: SessionStatus, to: SessionStatus): void {
    const allowed = ALLOWED_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new BadRequestException(
        `Cannot transition session from ${from} to ${to}`,
      );
    }
  }

  // Provider provisioning is intentionally fire-and-forget on the happy
  // path *for the stub* — the stub always succeeds synchronously. When
  // a real adapter is wired up, the controller path can return
  // immediately and a worker (CalendarSyncJob.run) reconciles the row.
  // For this PR we just call the (stub) provider inline so callers see
  // the populated fields in the response.
  private async runProviderProvisioning(
    sessionId: string,
    actor: ActorContext,
  ): Promise<CoachingSession> {
    const session = await this.loadSessionOrThrow(sessionId);
    if (session.status !== 'scheduled') return session;
    const idempotencyKey =
      session.provider_idempotency_key ?? `sess-${session.id}-${randomUUID()}`;

    const calendarAdapter = this.providers.resolveCalendar(
      session.calendar_provider as CalendarProviderEnum,
    );
    const calResult = await calendarAdapter.createEvent({
      idempotencyKey,
      coachExternalAccountId: null,
      title: session.title,
      description: undefined,
      startAt: session.start_at,
      endAt: session.end_at,
      attendeeEmails: [],
    });
    await this.audit.write({
      action: AuditAction.SESSION_PROVIDER_CALENDAR_CREATED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: session.coach_id,
      targetType: 'coaching_session',
      targetId: session.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        provider: calResult.resolvedProvider,
        external_event_id: calResult.externalEventId,
        idempotency_key: idempotencyKey,
      },
    });

    let videoUrl: string | null = session.video_url;
    let videoMeetingId: string | null = session.video_meeting_id;
    let resolvedVideoProvider: VideoProviderEnum = session.video_provider;
    if (session.video_provider !== 'manual') {
      const videoAdapter = this.providers.resolveVideo(session.video_provider);
      const v = await videoAdapter.createMeeting({
        idempotencyKey,
        coachExternalAccountId: null,
        title: session.title,
        startAt: session.start_at,
        endAt: session.end_at,
      });
      videoUrl = v.joinUrl;
      videoMeetingId = v.externalMeetingId;
      resolvedVideoProvider = v.resolvedProvider as VideoProviderEnum;
      await this.audit.write({
        action: AuditAction.SESSION_PROVIDER_VIDEO_CREATED,
        actorId: actor.id,
        actorRole: actor.role,
        actorEmail: actor.email,
        tenantCoachId: session.coach_id,
        targetType: 'coaching_session',
        targetId: session.id,
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: {
          provider: v.resolvedProvider,
          external_meeting_id: v.externalMeetingId,
          idempotency_key: idempotencyKey,
        },
      });
    }

    return this.prisma.coachingSession.update({
      where: { id: sessionId },
      data: {
        provider_idempotency_key: idempotencyKey,
        calendar_provider: calResult.resolvedProvider as CalendarProviderEnum,
        calendar_event_id: calResult.externalEventId,
        video_provider: resolvedVideoProvider,
        video_url: videoUrl,
        video_meeting_id: videoMeetingId,
      },
    });
  }

  private async cancelProviderArtifacts(
    session: CoachingSession,
  ): Promise<void> {
    try {
      if (session.calendar_event_id) {
        const cal = this.providers.resolveCalendar(
          session.calendar_provider as CalendarProviderEnum,
        );
        await cal.cancelEvent(session.calendar_event_id);
      }
      if (
        session.video_meeting_id &&
        session.video_provider !== 'manual' &&
        session.video_provider !== 'stub'
      ) {
        const vid = this.providers.resolveVideo(session.video_provider);
        await vid.cancelMeeting(session.video_meeting_id);
      }
      await this.audit.write({
        action: AuditAction.SESSION_PROVIDER_CANCELED,
        tenantCoachId: session.coach_id,
        targetType: 'coaching_session',
        targetId: session.id,
        metadata: {
          calendar_provider: session.calendar_provider,
          video_provider: session.video_provider,
        },
      });
    } catch (err) {
      // Provider cancellation failure must not roll back the local
      // cancel — the user-visible row is already canceled. Log and
      // leave the calendar/video reconciliation to the sync job.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Provider cancellation failed for session=${session.id}: ${msg}`,
      );
    }
  }
}
