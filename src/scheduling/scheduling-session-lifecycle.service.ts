import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CalendarProvider as CalendarProviderEnum,
  CoachingSession,
  SessionStatus,
  SessionType,
  VideoProvider as VideoProviderEnum,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditAction, AuditService } from '../audit/audit.service';
import { BookingEmitter } from '../notifications/emitters/booking.emitter';
import { PrismaService } from '../prisma.service';
import type {
  AttachManualVideoLinkDto,
  CancelSessionDto,
  CompleteSessionDto,
  RequestSessionDto,
  RescheduleSessionDto,
} from './dto/scheduling.dto';
import { SchedulingProviderRegistry } from './providers/scheduling-provider.registry';
import {
  assertCanApproveOrDecline,
  assertCanCancel,
  assertCanCompleteOrNoShow,
  assertCanRequestSession,
  assertCanReschedule,
} from './scheduling.permissions';
import type { ActorContext } from './scheduling.types';

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

// Session lifecycle service — every state transition for CoachingSession.
// Pulled out of SchedulingService during the M9 refactor so the
// state-machine, audit writes, notification emits, and provider
// provisioning live in one focused unit. SchedulingService still owns
// the public surface and delegates here.
@Injectable()
export class SchedulingSessionLifecycleService {
  private readonly logger = new Logger(SchedulingSessionLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly providers: SchedulingProviderRegistry,
    private readonly bookingEmitter: BookingEmitter,
  ) {}

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

    // QA P0-S2. Without this check two clients hitting "request" against
    // the same slot at the same instant would both succeed (auto-approve
    // makes the impact worse — the coach finds out at the door). The
    // Serializable txn upgrades the overlap-check + create to a logical
    // unit; Postgres SSI will abort one of the racers with a 40001 and
    // Prisma surfaces that as a P2034 we map back to 409.
    const session = await this.prisma
      .$transaction(
        async (tx) => {
          const overlap = await tx.coachingSession.findFirst({
            where: {
              coach_id: dto.coach_id,
              status: { in: ['requested', 'scheduled'] },
              start_at: { lt: end },
              end_at: { gt: start },
            },
            select: { id: true },
          });
          if (overlap) {
            throw new ConflictException({
              error: 'SLOT_TAKEN',
              message:
                'That slot overlaps an existing pending or scheduled session.',
            });
          }
          return tx.coachingSession.create({
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
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((err) => {
        // Prisma surfaces a Postgres serialization failure (40001) as
        // P2034 in newer versions. Map it back to the same 409 surface so
        // the mobile client can render "slot just got booked" identically
        // regardless of whether it lost the check or the txn race.
        if (
          err &&
          typeof err === 'object' &&
          (err as { code?: string }).code === 'P2034'
        ) {
          throw new ConflictException({
            error: 'SLOT_TAKEN',
            message:
              'That slot was claimed by another booking; please pick another.',
          });
        }
        throw err;
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
    // Notify the coach of the request. Auto-approve path skips
    // "requested" semantics and emits a "confirmed" to the client
    // below, since from the client's perspective there is no
    // separate approval moment.
    if (initialStatus === 'requested') {
      const clientName = await this.resolveDisplayName(actor.id);
      await this.bookingEmitter.emitRequested({
        coachUserId: dto.coach_id,
        clientDisplayName: clientName,
        sessionId: session.id,
        requestedAt: session.created_at,
        // RequestSessionDto does not expose a notes field yet; the
        // payload column is provisioned so a follow-up PR can pass
        // through `dto.notes` without changing the emitter shape.
        notes: null,
      });
    } else {
      const coachName = await this.resolveDisplayName(dto.coach_id);
      await this.bookingEmitter.emitConfirmed({
        clientUserId: actor.id,
        coachDisplayName: coachName,
        sessionId: session.id,
        scheduledAt: start,
      });
    }

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
    if (existing.client_id) {
      const coachName = await this.resolveDisplayName(existing.coach_id);
      await this.bookingEmitter.emitConfirmed({
        clientUserId: existing.client_id,
        coachDisplayName: coachName,
        sessionId: sessionId,
        scheduledAt: existing.start_at,
      });
    }
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
    if (existing.client_id) {
      const coachName = await this.resolveDisplayName(existing.coach_id);
      await this.bookingEmitter.emitDeclined({
        clientUserId: existing.client_id,
        coachDisplayName: coachName,
        sessionId: sessionId,
        requestedAt: existing.created_at,
        declineReason: reason ?? null,
      });
    }
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
    const updated = await this.prisma
      .$transaction(
        async (tx) => {
          const overlap = await tx.coachingSession.findFirst({
            where: {
              id: { not: sessionId },
              coach_id: existing.coach_id,
              status: { in: ['requested', 'scheduled'] },
              start_at: { lt: end },
              end_at: { gt: start },
            },
            select: { id: true },
          });
          if (overlap) {
            throw new ConflictException({
              error: 'SLOT_TAKEN',
              message: 'Time slot is not available.',
            });
          }
          return tx.coachingSession.update({
            where: { id: sessionId },
            data: { start_at: start, end_at: end },
          });
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((err) => {
        if (
          err &&
          typeof err === 'object' &&
          (err as { code?: string }).code === 'P2034'
        ) {
          throw new ConflictException({
            error: 'SLOT_TAKEN',
            message: 'Time slot is not available.',
          });
        }
        throw err;
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
    const recipientId =
      actor.id === existing.coach_id ? existing.client_id : existing.coach_id;
    if (recipientId) {
      const reschedulerName = await this.resolveDisplayName(actor.id);
      await this.bookingEmitter.emitRescheduled({
        recipientUserId: recipientId,
        reschedulerDisplayName: reschedulerName,
        sessionId: sessionId,
        oldScheduledAt: existing.start_at,
        newScheduledAt: start,
      });
    }
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
    const recipientId =
      actor.id === existing.coach_id ? existing.client_id : existing.coach_id;
    if (recipientId) {
      const cancellerName = await this.resolveDisplayName(actor.id);
      await this.bookingEmitter.emitCancelled({
        recipientUserId: recipientId,
        cancellingPartyDisplayName: cancellerName,
        sessionId: sessionId,
        scheduledAt: existing.start_at,
        cancelReason: dto.reason ?? null,
      });
    }
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

  // ── helpers ───────────────────────────────────────────────────────

  // Resolve a User's display name for the lifecycle notifications.
  // Returns `'Someone'` when the row is missing (deleted user / data
  // race) — never throws, since notification dispatch must not block a
  // state transition. Bounded to a 32-char cap to keep push payloads
  // small.
  private async resolveDisplayName(userId: string | null): Promise<string> {
    if (!userId) return 'Someone';
    // Wrap in try/catch — notification dispatch must NEVER block a
    // lifecycle transition. Real PrismaService always has a `user`
    // delegate; some unit-test fakes do not, and they treat
    // notifications as out-of-scope.
    try {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      if (!u || !u.name) return 'Someone';
      return u.name.slice(0, 32);
    } catch {
      return 'Someone';
    }
  }

  async loadSessionOrThrow(sessionId: string): Promise<CoachingSession> {
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
