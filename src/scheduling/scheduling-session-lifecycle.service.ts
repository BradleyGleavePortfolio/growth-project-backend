import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
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
import { BookingEmitter } from '../notifications/emitters/booking.emitter';
import { NotificationKind } from '../notifications/notification-kind';
import { PrismaService } from '../prisma.service';
import type {
  AttachManualVideoLinkDto,
  CancelSessionDto,
  CompleteSessionDto,
  RequestSessionDto,
  RescheduleSessionDto,
} from './dto/scheduling.dto';
import { SchedulingProviderRegistry } from './providers/scheduling-provider.registry';
import { SchedulingAccessService } from './scheduling-access.service';
import { SchedulingOpenSlotsService } from './scheduling-open-slots.service';
import {
  MAX_BOOKING_HORIZON_DAYS,
  MAX_PENDING_REQUESTS_PER_COACH,
  MEETING_LINK_PATTERN,
  MIN_BOOKING_LEAD_MINUTES,
  OCCUPYING_SESSION_STATUSES,
  SchedulingErrorCode,
  hasUsableLink,
  requestExpiresAt,
  schedulingError,
} from './scheduling.types';
import {
  auditExpired,
  expireLapsedForCoach,
  isExpiredOrLapsed,
  requestExpiredError,
  type LapsedRow,
} from './request-expiry';
import type { ActorContext } from './scheduling.types';

// State machine: which SessionStatus transitions the service accepts.
// Anything outside this map is a 409 SESSION_STATE_CHANGED (the row moved
// on, or the action does not apply to it), so the audit log stays honest.
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  requested: ['scheduled', 'declined', 'canceled', 'pending_provider'],
  pending_provider: ['scheduled', 'canceled'],
  // A client moving a confirmed coach-approval session back to 'requested'
  // is handled inside rescheduleSession (locked, compare-and-set), not here.
  scheduled: ['canceled', 'completed', 'no_show'],
  declined: [],
  canceled: [],
  no_show: [],
  completed: [],
  // S-SCHED-5: closed by the expiry sweep (or the booking transaction) at the
  // request's clear time. Terminal.
  expired: [],
};

// pg_advisory_xact_lock(int4, int4): first key is a namespace so this lock
// can never collide with another feature's advisory locks. ASCII "schd".
export const ADVISORY_LOCK_NAMESPACE_COACH_CALENDAR = 0x73636864;

export const BOOKING_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 15_000,
} as const;

const DAY_MS = 24 * 60 * 60_000;

type Tx = Prisma.TransactionClient;

// True when a Prisma/Postgres error is the no-double-booking floor
// (exclusion constraint 23P01 on CoachingSession_no_overlapping_active_booking).
export function isOverlapConstraintViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown; meta?: unknown };
  const text = `${typeof e.message === 'string' ? e.message : ''} ${
    e.meta ? JSON.stringify(e.meta) : ''
  }`;
  if (text.includes('CoachingSession_no_overlapping_active_booking')) return true;
  if (text.includes('23P01')) return true;
  return false;
}

// Session lifecycle: every state transition for CoachingSession.
//
// S-SCHED-2 integrity model:
//  - Booking writes that occupy calendar time (request, reschedule) run in a
//    READ COMMITTED transaction that first takes a per-coach advisory lock,
//    then re-validates everything against fresh rows (type active and owned,
//    duration = type duration, interval inside availability/overrides and
//    free of other occupying sessions, per-client limits), then writes.
//    Writers for one coach are therefore serialised; readers are not blocked.
//  - The CoachingSession_no_overlapping_active_booking exclusion constraint is
//    the database floor under that: any writer that skips the lock (another
//    code path, a script, a future bug) still cannot store an overlap. Its
//    violation maps to the same 409 SLOT_TAKEN.
//  - Status transitions (approve, decline, cancel, complete, no-show) are
//    compare-and-set on the booking revision the caller read:
//    UPDATE ... WHERE id AND status AND start_at AND end_at = <seen>, plus the
//    start-boundary rule in the same statement (approve / client cancel only
//    while start_at > now; complete / no-show only once start_at <= now).
//    A client can move a request without changing its status, so status alone
//    is not a fence (S-SCHED-3 B-634-1). Zero rows updated means another actor
//    won; the loser gets 409 SESSION_MOVED (same status, new time) or
//    SESSION_STATE_CHANGED, and nothing is notified twice. Callers may also
//    send expected_start_at (the time on their screen) for stale cards.
//  - Provider provisioning runs after commit and writes back fenced on the
//    revision and call link it read, so a coach's newer manual link, a cancel
//    or a move during provisioning is never overwritten; artifacts made for a
//    superseded revision are cancelled (S-SCHED-3 B-634-3).
//  - Notifications go out after commit, are built from the committed row, and
//    never fail the transition.
@Injectable()
export class SchedulingSessionLifecycleService {
  private readonly logger = new Logger(SchedulingSessionLifecycleService.name);
  private readonly access: SchedulingAccessService;
  private readonly openSlots: SchedulingOpenSlotsService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly providers: SchedulingProviderRegistry,
    private readonly bookingEmitter: BookingEmitter,
    @Optional() access?: SchedulingAccessService,
    @Optional() openSlots?: SchedulingOpenSlotsService,
  ) {
    this.access = access ?? new SchedulingAccessService(prisma);
    this.openSlots = openSlots ?? new SchedulingOpenSlotsService(prisma, this.access);
  }

  // ── request ─────────────────────────────────────────────────────────

  async requestSession(actor: ActorContext, dto: RequestSessionDto): Promise<CoachingSession> {
    if (actor.role === 'coach') {
      throw new ForbiddenException(
        schedulingError(
          SchedulingErrorCode.NOT_SESSION_PARTICIPANT,
          'Booking requests come from clients. To hold time yourself, add a time-off block in Availability.',
        ),
      );
    }
    await this.access.assertCanBrowseCoach(actor, dto.coach_id);
    if (!dto.session_type_id) {
      throw new BadRequestException(
        schedulingError(
          SchedulingErrorCode.SESSION_TYPE_REQUIRED,
          'Pick an appointment type before choosing a time.',
        ),
      );
    }
    const { start, end } = parseInterval(dto.start_at, dto.end_at);
    const now = new Date();
    assertWithinBookingWindow(start, now);

    const sessionTypeId = dto.session_type_id;
    const session = await this.runBookingTx(dto.coach_id, async (tx) => {
      // S-SCHED-5: close this coach's requests that reached their clear time
      // first, so their slots (and the client's pending count) are free now.
      const lapsed = await expireLapsedForCoach(tx, dto.coach_id, now);
      const type = await this.openSlots.resolveBookableType(dto.coach_id, sessionTypeId, tx);
      assertTypeDuration(type, start, end);

      if (actor.role === 'student') {
        if (!type.auto_approve) {
          const pending = await tx.coachingSession.count({
            where: {
              coach_id: dto.coach_id,
              client_id: actor.id,
              status: 'requested',
              start_at: { gt: now },
            },
          });
          if (pending >= MAX_PENDING_REQUESTS_PER_COACH) {
            throw new ConflictException(
              schedulingError(
                SchedulingErrorCode.PENDING_REQUEST_LIMIT,
                `You already have ${pending} requests waiting for your coach. Wait for an answer or cancel one before asking for another time.`,
              ),
            );
          }
        }
        if (type.is_welcome) {
          const welcome = await tx.coachingSession.findFirst({
            where: {
              coach_id: dto.coach_id,
              client_id: actor.id,
              status: { in: [...OCCUPYING_SESSION_STATUSES] },
              end_at: { gt: now },
              session_type: { is: { is_welcome: true } },
            },
            select: { id: true },
          });
          if (welcome) {
            throw new ConflictException(
              schedulingError(
                SchedulingErrorCode.WELCOME_ALREADY_BOOKED,
                'Your welcome call is already booked. You can move it from Calendar if the time no longer works.',
              ),
            );
          }
        }
      }

      await this.assertIntervalBookable(tx, dto.coach_id, start, end, {
        sessionTypeId: type.id,
        excludeSessionId: null,
      });

      const status: SessionStatus = type.auto_approve ? 'scheduled' : 'requested';
      const created = await tx.coachingSession.create({
        data: {
          coach_id: dto.coach_id,
          client_id: actor.id,
          session_type_id: type.id,
          status,
          start_at: start,
          end_at: end,
          title: dto.title.trim().slice(0, 200) || type.name,
          video_provider: type.default_video_provider ?? 'stub',
          calendar_provider: 'stub',
          approved_at: status === 'scheduled' ? now : null,
          request_expires_at: status === 'requested' ? requestExpiresAt(now, start) : null,
        },
      });
      return { created, type, lapsed };
    });

    const { created, type } = session;
    this.openSlots.invalidateCoach(dto.coach_id);
    await this.afterLazyExpiry(session.lapsed);
    await this.audit.write({
      action: AuditAction.SESSION_REQUESTED,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: dto.coach_id,
      targetUserId: dto.coach_id,
      targetType: 'coaching_session',
      targetId: created.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: {
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        session_type_id: type.id,
        auto_approved: created.status === 'scheduled',
      },
    });

    if (created.status === 'requested') {
      await this.bookingEmitter.emitRequested({
        coachUserId: dto.coach_id,
        clientDisplayName: await this.resolveDisplayName(actor.id),
        sessionId: created.id,
        sessionTypeName: type.name,
        requestedAt: created.created_at,
        scheduledAt: start,
        notes: null,
      });
      return created;
    }

    // Instant confirmation: provision first so the confirmation and the
    // coach's "add a link" prompt reflect the final link state.
    const provisioned = await this.provisionSafely(created.id, actor);
    // A cancel or move that landed while provisioning ran makes this
    // confirmation obsolete; the other party already heard about that change.
    if (!isConfirmedRevision(provisioned)) return provisioned;
    const [clientName, coachName] = await Promise.all([
      this.resolveDisplayName(actor.id),
      this.resolveDisplayName(dto.coach_id),
    ]);
    await this.bookingEmitter.emitConfirmed({
      clientUserId: actor.id,
      coachDisplayName: coachName,
      sessionId: created.id,
      sessionTypeName: type.name,
      scheduledAt: provisioned.start_at,
      instant: true,
    });
    await this.bookingEmitter.emitBooked({
      coachUserId: dto.coach_id,
      clientDisplayName: clientName,
      sessionId: created.id,
      sessionTypeName: type.name,
      scheduledAt: provisioned.start_at,
    });
    await this.promptForMissingLink(provisioned, type.name, clientName);
    return provisioned;
  }

  // ── approve / decline ──────────────────────────────────────────────

  async approveSession(
    actor: ActorContext,
    sessionId: string,
    opts: TransitionOptions = {},
  ): Promise<CoachingSession> {
    const existing = await this.loadSessionOrThrow(sessionId);
    this.access.assertIsSessionCoach(actor, existing);
    this.assertRequestOpen(existing, actor);
    this.assertTransition(existing, 'scheduled');
    assertExpectedStart(existing, opts.expectedStartAt);
    if (existing.start_at.getTime() <= Date.now()) throw approvalTooLate();
    const updated = await this.compareAndSet(
      existing,
      'scheduled',
      { approved_at: new Date(), request_expires_at: null },
      { start: 'future', onStarted: approvalTooLate, requestOpenFor: viewerOf(actor) },
    );
    this.openSlots.invalidateCoach(existing.coach_id);
    await this.writeTransitionAudit(AuditAction.SESSION_APPROVED, actor, existing, 'scheduled');

    const provisioned = await this.provisionSafely(updated.id, actor);
    // Built from the committed row (time included). If the session was
    // cancelled or moved back to a request while provisioning ran, the
    // confirmation is obsolete.
    if (!isConfirmedRevision(provisioned)) return provisioned;
    const typeName = await this.resolveTypeName(provisioned.session_type_id);
    if (provisioned.client_id) {
      await this.bookingEmitter.emitConfirmed({
        clientUserId: provisioned.client_id,
        coachDisplayName: await this.resolveDisplayName(provisioned.coach_id),
        sessionId,
        sessionTypeName: typeName,
        scheduledAt: provisioned.start_at,
      });
    }
    await this.promptForMissingLink(
      provisioned,
      typeName,
      await this.resolveDisplayName(provisioned.client_id),
    );
    return provisioned;
  }

  async declineSession(
    actor: ActorContext,
    sessionId: string,
    reason?: string,
    opts: TransitionOptions = {},
  ): Promise<CoachingSession> {
    const existing = await this.loadSessionOrThrow(sessionId);
    this.access.assertIsSessionCoach(actor, existing);
    this.assertRequestOpen(existing, actor);
    this.assertTransition(existing, 'declined');
    assertExpectedStart(existing, opts.expectedStartAt);
    const updated = await this.compareAndSet(
      existing,
      'declined',
      { ended_at: new Date(), end_reason: reason ?? null },
      { requestOpenFor: viewerOf(actor) },
    );
    this.openSlots.invalidateCoach(existing.coach_id);
    await this.writeTransitionAudit(AuditAction.SESSION_DECLINED, actor, existing, 'declined', {
      reason: reason ?? null,
    });
    if (updated.client_id) {
      await this.bookingEmitter.emitDeclined({
        clientUserId: updated.client_id,
        coachDisplayName: await this.resolveDisplayName(updated.coach_id),
        sessionId,
        sessionTypeName: await this.resolveTypeName(updated.session_type_id),
        requestedAt: updated.created_at,
        scheduledAt: updated.start_at,
        declineReason: reason ?? null,
      });
    }
    return updated;
  }

  // ── reschedule ─────────────────────────────────────────────────────

  async rescheduleSession(
    actor: ActorContext,
    sessionId: string,
    dto: RescheduleSessionDto,
  ): Promise<CoachingSession> {
    const existing = await this.loadSessionOrThrow(sessionId);
    await this.access.assertCanActAsParticipant(actor, existing);
    this.assertRequestOpen(existing, actor);
    if (existing.status !== 'requested' && existing.status !== 'scheduled') {
      throw new ConflictException(
        schedulingError(
          SchedulingErrorCode.SESSION_NOT_ACTIVE,
          `This session is ${statusWord(existing.status)}, so it cannot be moved. Book a new time from Calendar instead.`,
        ),
      );
    }
    const isClient = actor.role === 'student';
    const now = new Date();
    if (existing.start_at.getTime() <= now.getTime()) {
      throw new ConflictException(
        schedulingError(
          SchedulingErrorCode.SESSION_STARTED,
          'This session has already started, so it cannot be moved. Message the other person if plans changed.',
        ),
      );
    }
    const { start, end } = parseInterval(dto.start_at, dto.end_at);
    assertWithinBookingWindow(start, now);

    const result = await this.runBookingTx(existing.coach_id, async (tx) => {
      const current = await tx.coachingSession.findUnique({ where: { id: sessionId } });
      if (
        !current ||
        current.status !== existing.status ||
        current.start_at.getTime() !== existing.start_at.getTime() ||
        current.end_at.getTime() !== existing.end_at.getTime()
      ) {
        if (current && isExpiredOrLapsed(current, now))
          throw requestExpiredError(current, viewerOf(actor));
        throw stateChanged();
      }
      if (isExpiredOrLapsed(current, now)) throw requestExpiredError(current, viewerOf(actor));
      // S-SCHED-5: free the coach's other lapsed requests before validating.
      const lapsed = await expireLapsedForCoach(tx, current.coach_id, now);
      const type = current.session_type_id
        ? await tx.sessionType.findUnique({ where: { id: current.session_type_id } })
        : null;

      if (isClient) {
        const expected = type
          ? type.duration_minutes
          : Math.round((current.end_at.getTime() - current.start_at.getTime()) / 60_000);
        assertDurationMinutes(expected, start, end);
        await this.assertIntervalBookable(tx, current.coach_id, start, end, {
          sessionTypeId: type?.id ?? null,
          excludeSessionId: current.id,
        });
      } else {
        const minutes = (end.getTime() - start.getTime()) / 60_000;
        if (minutes < 5 || minutes > 480) {
          throw new BadRequestException(
            schedulingError(
              SchedulingErrorCode.DURATION_MISMATCH,
              'A session must be between 5 minutes and 8 hours long.',
            ),
          );
        }
        await this.assertNoOverlap(tx, current.coach_id, start, end, current.id);
      }

      // A client moving a confirmed coach-approval session asks again: it
      // goes back to the coach's inbox at the new time. Instant-confirm
      // types and coach moves keep their status.
      const nextStatus: SessionStatus =
        isClient && current.status === 'scheduled' && type && !type.auto_approve
          ? 'requested'
          : current.status;

      const moved = await tx.coachingSession.updateMany({
        where: {
          id: current.id,
          status: current.status,
          start_at: current.start_at,
          end_at: current.end_at,
          // A request moved at its clear time loses to the expiry.
          ...(current.status === 'requested' ? requestStillOpen(now) : {}),
        },
        data: {
          start_at: start,
          end_at: end,
          status: nextStatus,
          ...(nextStatus === 'requested' && current.status === 'scheduled'
            ? { approved_at: null }
            : {}),
          // A move that asks the coach again starts a fresh answer window.
          ...(nextStatus === 'requested'
            ? { request_expires_at: requestExpiresAt(now, start) }
            : {}),
        },
      });
      if (moved.count !== 1) {
        const after = await tx.coachingSession.findUnique({ where: { id: current.id } });
        if (after && isExpiredOrLapsed(after, now))
          throw requestExpiredError(after, viewerOf(actor));
        throw stateChanged();
      }
      // Reminder claims are per (session, user, kind); a moved session must
      // be reminded again for its new time.
      await tx.notificationDeliveryLog.deleteMany({
        where: {
          session_id: current.id,
          kind: {
            in: [NotificationKind.BOOKING_REMINDER_24H, NotificationKind.BOOKING_REMINDER_1H],
          },
        },
      });
      const row = await tx.coachingSession.findUniqueOrThrow({ where: { id: current.id } });
      return { row, typeName: type?.name ?? null, previousStatus: current.status, lapsed };
    });

    this.openSlots.invalidateCoach(existing.coach_id);
    await this.afterLazyExpiry(result.lapsed);
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
        from: result.previousStatus,
        to: result.row.status,
        reason: dto.reason ?? null,
      },
    });

    const actorName = await this.resolveDisplayName(actor.id);
    if (isClient) {
      if (result.row.status === 'requested') {
        await this.bookingEmitter.emitMoveRequested({
          coachUserId: existing.coach_id,
          clientDisplayName: actorName,
          sessionId,
          sessionTypeName: result.typeName,
          oldScheduledAt: existing.start_at,
          newScheduledAt: start,
        });
      } else {
        await this.bookingEmitter.emitRescheduled({
          recipientUserId: existing.coach_id,
          recipientRole: 'coach',
          reschedulerDisplayName: actorName,
          sessionId,
          sessionTypeName: result.typeName,
          oldScheduledAt: existing.start_at,
          newScheduledAt: start,
        });
      }
    } else if (existing.client_id && existing.client_id !== actor.id) {
      await this.bookingEmitter.emitRescheduled({
        recipientUserId: existing.client_id,
        recipientRole: 'client',
        reschedulerDisplayName: actorName,
        sessionId,
        sessionTypeName: result.typeName,
        oldScheduledAt: existing.start_at,
        newScheduledAt: start,
      });
    }
    return result.row;
  }

  // ── cancel ─────────────────────────────────────────────────────────

  async cancelSession(
    actor: ActorContext,
    sessionId: string,
    dto: CancelSessionDto,
  ): Promise<CoachingSession> {
    const existing = await this.loadSessionOrThrow(sessionId);
    await this.access.assertCanActAsParticipant(actor, existing);
    this.assertRequestOpen(existing, actor);
    this.assertTransition(existing, 'canceled');
    assertExpectedStart(existing, dto.expected_start_at);
    const clientCancel = actor.role === 'student';
    if (clientCancel && existing.start_at.getTime() <= Date.now()) throw clientCancelTooLate();
    const updated = await this.compareAndSet(
      existing,
      'canceled',
      { ended_at: new Date(), end_reason: dto.reason ?? null },
      {
        ...(clientCancel ? { start: 'future' as const, onStarted: clientCancelTooLate } : {}),
        requestOpenFor: viewerOf(actor),
      },
    );
    this.openSlots.invalidateCoach(existing.coach_id);
    await this.writeTransitionAudit(AuditAction.SESSION_CANCELED, actor, existing, 'canceled', {
      reason: dto.reason ?? null,
    });
    const actorIsCoachSide = actor.id === existing.coach_id || actor.role === 'owner';
    const recipientId = actorIsCoachSide ? existing.client_id : existing.coach_id;
    if (recipientId && recipientId !== actor.id) {
      await this.bookingEmitter.emitCancelled({
        recipientUserId: recipientId,
        recipientRole: actorIsCoachSide ? 'client' : 'coach',
        cancellingPartyDisplayName: await this.resolveDisplayName(actor.id),
        sessionId,
        sessionTypeName: await this.resolveTypeName(updated.session_type_id),
        scheduledAt: updated.start_at,
        cancelReason: dto.reason ?? null,
      });
    }
    // The committed row carries any artifacts provisioning stored after the read.
    if (updated.calendar_event_id || updated.video_meeting_id) {
      await this.cancelProviderArtifacts(updated);
    }
    return updated;
  }

  // ── complete / no-show ─────────────────────────────────────────────

  async completeSession(
    actor: ActorContext,
    sessionId: string,
    dto: CompleteSessionDto,
  ): Promise<CoachingSession> {
    const existing = await this.loadSessionOrThrow(sessionId);
    this.access.assertIsSessionCoach(actor, existing);
    this.assertTransition(existing, 'completed');
    assertHasStarted(existing, 'complete');
    const updated = await this.compareAndSet(
      existing,
      'completed',
      { ended_at: new Date(), coach_notes_md: dto.coach_notes_md ?? existing.coach_notes_md },
      { start: 'started', onStarted: () => notStartedYet('complete') },
    );
    await this.writeTransitionAudit(AuditAction.SESSION_COMPLETED, actor, existing, 'completed');
    return updated;
  }

  async markNoShow(
    actor: ActorContext,
    sessionId: string,
    reason?: string,
    opts: TransitionOptions = {},
  ): Promise<CoachingSession> {
    const existing = await this.loadSessionOrThrow(sessionId);
    this.access.assertIsSessionCoach(actor, existing);
    this.assertTransition(existing, 'no_show');
    assertExpectedStart(existing, opts.expectedStartAt);
    assertHasStarted(existing, 'no_show');
    const updated = await this.compareAndSet(
      existing,
      'no_show',
      { ended_at: new Date(), end_reason: reason ?? null },
      { start: 'started', onStarted: () => notStartedYet('no_show') },
    );
    await this.writeTransitionAudit(AuditAction.SESSION_NO_SHOW, actor, existing, 'no_show', {
      reason: reason ?? null,
    });
    return updated;
  }

  // ── call link ──────────────────────────────────────────────────────

  async attachManualVideoLink(
    actor: ActorContext,
    sessionId: string,
    dto: AttachManualVideoLinkDto,
  ): Promise<CoachingSession> {
    const existing = await this.loadSessionOrThrow(sessionId);
    this.access.assertIsSessionCoach(actor, existing);
    const url = dto.video_url.trim();
    if (!MEETING_LINK_PATTERN.test(url)) {
      throw new BadRequestException(
        schedulingError(
          SchedulingErrorCode.INVALID_MEETING_LINK,
          'Use a meeting link that starts with https:// (or a tel: number for a phone call).',
        ),
      );
    }
    if (!(OCCUPYING_SESSION_STATUSES as readonly string[]).includes(existing.status)) {
      throw new ConflictException(
        schedulingError(
          SchedulingErrorCode.SESSION_NOT_ACTIVE,
          `This session is ${statusWord(existing.status)}, so a call link is no longer needed.`,
        ),
      );
    }
    // Adding the link recovers a session stuck waiting on a provider link.
    const nextStatus: SessionStatus =
      existing.status === 'pending_provider' ? 'scheduled' : existing.status;
    const res = await this.prisma.coachingSession.updateMany({
      where: { id: sessionId, status: existing.status },
      data: {
        video_provider: 'manual',
        video_url: url,
        video_meeting_id: null,
        status: nextStatus,
      },
    });
    if (res.count !== 1) throw stateChanged();
    const updated = await this.loadSessionOrThrow(sessionId);
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
      metadata: { provider: 'manual', from: existing.status, to: nextStatus },
    });
    if (
      existing.client_id &&
      updated.status === 'scheduled' &&
      existing.video_url !== url &&
      updated.start_at.getTime() > Date.now()
    ) {
      await this.bookingEmitter.emitLinkReady({
        clientUserId: existing.client_id,
        coachDisplayName: await this.resolveDisplayName(existing.coach_id),
        sessionId,
        sessionTypeName: await this.resolveTypeName(existing.session_type_id),
        scheduledAt: updated.start_at,
      });
    }
    return updated;
  }

  // ── helpers ────────────────────────────────────────────────────────

  async loadSessionOrThrow(sessionId: string): Promise<CoachingSession> {
    const session = await this.prisma.coachingSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException(
        schedulingError(
          SchedulingErrorCode.SESSION_NOT_FOUND,
          'We could not find that session. It may have been removed. Open Calendar to see your sessions.',
        ),
      );
    }
    return session;
  }

  // Per-coach serialised booking transaction. Lock first, then every read
  // inside `fn` sees the latest committed rows (READ COMMITTED takes a new
  // snapshot per statement), so the re-check cannot be stale.
  private async runBookingTx<T>(coachId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE_COACH_CALENDAR}::int4, hashtext(${coachId}))`;
        return fn(tx);
      }, BOOKING_TX_OPTIONS);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (isOverlapConstraintViolation(err)) throw slotTaken();
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'P2034') throw slotTaken();
      if (code === 'P2028' || code === 'P2024') {
        throw new ServiceUnavailableException(
          schedulingError(
            SchedulingErrorCode.CALENDAR_BUSY,
            "Your coach's calendar is busy with other bookings right now. Wait a few seconds, then pick the time again.",
          ),
        );
      }
      throw err;
    }
  }

  private async assertIntervalBookable(
    tx: Tx,
    coachId: string,
    start: Date,
    end: Date,
    opts: { sessionTypeId: string | null; excludeSessionId: string | null },
  ): Promise<void> {
    const open = await this.openSlots.isIntervalOpen(tx, coachId, start, end, opts);
    if (open) return;
    // Explain why: someone else holds it, or it is outside the coach's hours.
    await this.assertNoOverlap(tx, coachId, start, end, opts.excludeSessionId);
    throw new ConflictException(
      schedulingError(
        SchedulingErrorCode.SLOT_UNAVAILABLE,
        "That time is outside your coach's open hours for this type. Pick one of the times shown.",
      ),
    );
  }

  private async assertNoOverlap(
    tx: Tx,
    coachId: string,
    start: Date,
    end: Date,
    excludeSessionId: string | null,
  ): Promise<void> {
    const overlap = await tx.coachingSession.findFirst({
      where: {
        coach_id: coachId,
        status: { in: [...OCCUPYING_SESSION_STATUSES] },
        start_at: { lt: end },
        end_at: { gt: start },
        ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
      },
      select: { id: true },
    });
    if (overlap) throw slotTaken();
  }

  private assertTransition(existing: CoachingSession, to: SessionStatus): void {
    const allowed = ALLOWED_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(to)) {
      throw new ConflictException(
        schedulingError(
          SchedulingErrorCode.SESSION_STATE_CHANGED,
          `This session is ${statusWord(existing.status)}, so it cannot be ${actionWord(to)}. Refresh to see its current state.`,
        ),
      );
    }
  }

  // Compare-and-set transition on the booking revision this request read:
  // status AND the exact interval, plus the start-boundary rule evaluated in
  // the same UPDATE (so the time cannot pass between check and write). The
  // loser of a race gets 409: SESSION_MOVED when the row only moved,
  // the caller's boundary error when the start passed, else
  // SESSION_STATE_CHANGED.
  private async compareAndSet(
    existing: CoachingSession,
    to: SessionStatus,
    data: Prisma.CoachingSessionUpdateManyMutationInput,
    fence: {
      start?: 'future' | 'started';
      onStarted?: () => HttpException;
      /** S-SCHED-5: a request transition must land before its clear time. */
      requestOpenFor?: 'client' | 'coach';
    } = {},
  ): Promise<CoachingSession> {
    const now = new Date();
    const startFilter: Prisma.DateTimeFilter = { equals: existing.start_at };
    if (fence.start === 'future') startFilter.gt = now;
    if (fence.start === 'started') startFilter.lte = now;
    const guardRequest = fence.requestOpenFor !== undefined && existing.status === 'requested';
    const res = await this.prisma.coachingSession.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        start_at: startFilter,
        end_at: existing.end_at,
        ...(guardRequest ? requestStillOpen(now) : {}),
      },
      data: { ...data, status: to },
    });
    if (res.count === 1) return this.loadSessionOrThrow(existing.id);
    const current = await this.prisma.coachingSession.findUnique({ where: { id: existing.id } });
    if (guardRequest && fence.requestOpenFor && current && isExpiredOrLapsed(current, now)) {
      throw requestExpiredError(current, fence.requestOpenFor);
    }
    if (current && current.status === existing.status) {
      if (!sameInterval(current, existing)) throw sessionMoved();
      if (fence.onStarted) throw fence.onStarted();
    }
    throw stateChanged();
  }

  // S-SCHED-5: a request that is closed by expiry, or has reached its clear
  // time, cannot be confirmed, declined, cancelled or moved.
  private assertRequestOpen(existing: CoachingSession, actor: ActorContext): void {
    if (isExpiredOrLapsed(existing)) throw requestExpiredError(existing, viewerOf(actor));
  }

  // Requests the booking transaction closed: audited now; the sweep sends
  // both notices from the committed rows on its next tick.
  private async afterLazyExpiry(rows: LapsedRow[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await auditExpired(this.audit, rows, 'booking');
    } catch (err) {
      this.logger.warn(`expiry audit failed: ${(err as Error).name}`);
    }
  }

  private async writeTransitionAudit(
    action: (typeof AuditAction)[keyof typeof AuditAction],
    actor: ActorContext,
    existing: CoachingSession,
    to: SessionStatus,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit.write({
      action,
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      tenantCoachId: existing.coach_id,
      targetUserId: existing.client_id ?? null,
      targetType: 'coaching_session',
      targetId: existing.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { from: existing.status, to, ...extra },
    });
  }

  // Coach prompt when a confirmed session has no usable call link.
  private async promptForMissingLink(
    session: CoachingSession,
    typeName: string | null,
    clientName: string,
  ): Promise<void> {
    if (session.status !== 'scheduled' && session.status !== 'pending_provider') return;
    if (hasUsableLink(session.video_url)) return;
    await this.bookingEmitter.emitLinkNeeded({
      coachUserId: session.coach_id,
      clientDisplayName: clientName,
      sessionId: session.id,
      sessionTypeName: typeName,
      scheduledAt: session.start_at,
    });
  }

  // Display name for notifications. Never throws: delivery must not block
  // a transition. 'Someone' when the row is missing.
  private async resolveDisplayName(userId: string | null): Promise<string> {
    if (!userId) return 'Someone';
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

  private async resolveTypeName(sessionTypeId: string | null): Promise<string | null> {
    if (!sessionTypeId) return null;
    try {
      const t = await this.prisma.sessionType.findUnique({
        where: { id: sessionTypeId },
        select: { name: true },
      });
      return t?.name ?? null;
    } catch {
      return null;
    }
  }

  // Provisioning runs after the booking committed. A provider failure must
  // not turn a confirmed booking into an error for the client: log it and
  // return the committed row (the coach is prompted for a link instead).
  private async provisionSafely(sessionId: string, actor: ActorContext): Promise<CoachingSession> {
    try {
      return await this.runProviderProvisioning(sessionId, actor);
    } catch (err) {
      this.logger.error(
        `provider provisioning failed for session=${sessionId}: ${(err as Error).message}`,
      );
      return this.loadSessionOrThrow(sessionId);
    }
  }

  private async runProviderProvisioning(
    sessionId: string,
    actor: ActorContext,
  ): Promise<CoachingSession> {
    const session = await this.loadSessionOrThrow(sessionId);
    if (session.status !== 'scheduled') return session;
    const idempotencyKey = session.provider_idempotency_key ?? `sess-${session.id}-${randomUUID()}`;

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
    if (session.video_provider !== 'manual' && !hasUsableLink(session.video_url)) {
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

    // No provider link: fall back to the coach's default room for this type.
    if (!hasUsableLink(videoUrl) && session.session_type_id) {
      const type: Pick<SessionType, 'default_meeting_url'> | null =
        await this.prisma.sessionType.findUnique({
          where: { id: session.session_type_id },
          select: { default_meeting_url: true },
        });
      if (type?.default_meeting_url && hasUsableLink(type.default_meeting_url)) {
        videoUrl = type.default_meeting_url;
        videoMeetingId = null;
        resolvedVideoProvider = 'manual';
      }
    }

    // S-SCHED-3 (B-634-3): write back only onto the revision and call link
    // this run read. Providers are awaited above, so a coach can save a
    // manual link, or either side can cancel or move, in the meantime.
    const calendarData = {
      provider_idempotency_key: idempotencyKey,
      calendar_provider: calResult.resolvedProvider as CalendarProviderEnum,
      calendar_event_id: calResult.externalEventId,
    };
    const fenced = await this.prisma.coachingSession.updateMany({
      where: {
        id: sessionId,
        status: session.status,
        start_at: session.start_at,
        end_at: session.end_at,
        video_provider: session.video_provider,
        video_url: session.video_url,
      },
      data: {
        ...calendarData,
        video_provider: resolvedVideoProvider,
        video_url: videoUrl,
        video_meeting_id: videoMeetingId,
      },
    });
    if (fenced.count === 1) return this.loadSessionOrThrow(sessionId);

    const createdMeetingId = videoMeetingId !== session.video_meeting_id ? videoMeetingId : null;
    const current = await this.loadSessionOrThrow(sessionId);
    if (current.status === session.status && sameInterval(current, session)) {
      // Same booking; only the call link changed (the coach saved one). Keep
      // their link, still record the calendar event for this revision, and
      // drop the meeting this run created for it.
      const kept = await this.prisma.coachingSession.updateMany({
        where: {
          id: sessionId,
          status: session.status,
          start_at: session.start_at,
          end_at: session.end_at,
          calendar_event_id: current.calendar_event_id,
        },
        data: calendarData,
      });
      await this.discardSupersededArtifacts(
        current,
        kept.count === 1 ? null : calResult,
        createdMeetingId ? { provider: resolvedVideoProvider, meetingId: createdMeetingId } : null,
      );
      return this.loadSessionOrThrow(sessionId);
    }
    // Cancelled or moved meanwhile: nothing this run made belongs to the
    // current revision.
    await this.discardSupersededArtifacts(
      current,
      calResult,
      createdMeetingId ? { provider: resolvedVideoProvider, meetingId: createdMeetingId } : null,
    );
    return current;
  }

  // Cancels provider artifacts created for a booking revision that no longer
  // exists. Stub and manual providers create nothing external.
  private async discardSupersededArtifacts(
    session: CoachingSession,
    calendar: { resolvedProvider: string; externalEventId: string | null } | null,
    meeting: { provider: VideoProviderEnum; meetingId: string } | null,
  ): Promise<void> {
    const cancelCalendar =
      calendar !== null && calendar.resolvedProvider !== 'stub' && !!calendar.externalEventId;
    const cancelMeeting =
      meeting !== null && meeting.provider !== 'stub' && meeting.provider !== 'manual';
    if (!cancelCalendar && !cancelMeeting) return;
    try {
      if (cancelCalendar && calendar?.externalEventId) {
        await this.providers
          .resolveCalendar(calendar.resolvedProvider as CalendarProviderEnum)
          .cancelEvent(calendar.externalEventId);
      }
      if (cancelMeeting && meeting) {
        await this.providers.resolveVideo(meeting.provider).cancelMeeting(meeting.meetingId);
      }
      await this.audit.write({
        action: AuditAction.SESSION_PROVIDER_CANCELED,
        tenantCoachId: session.coach_id,
        targetType: 'coaching_session',
        targetId: session.id,
        metadata: {
          reason: 'superseded_revision',
          calendar_provider: cancelCalendar ? calendar?.resolvedProvider : null,
          video_provider: cancelMeeting ? meeting?.provider : null,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`superseded artifact cleanup failed for session=${session.id}: ${msg}`);
    }
  }

  private async cancelProviderArtifacts(session: CoachingSession): Promise<void> {
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
      // Provider cancellation failure must not roll back the local cancel.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Provider cancellation failed for session=${session.id}: ${msg}`);
    }
  }
}

// ── pure helpers (exported for tests) ────────────────────────────────

export function parseInterval(startIso: string, endIso: string): { start: Date; end: Date } {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BadRequestException(
      schedulingError(
        SchedulingErrorCode.INVALID_TIME,
        'The start or end time could not be read. Pick the time again.',
      ),
    );
  }
  if (end.getTime() <= start.getTime()) {
    throw new BadRequestException(
      schedulingError(
        SchedulingErrorCode.INVALID_TIME,
        'The end time must be after the start time. Pick the time again.',
      ),
    );
  }
  if (start.getTime() % 60_000 !== 0 || end.getTime() % 60_000 !== 0) {
    throw new BadRequestException(
      schedulingError(
        SchedulingErrorCode.INVALID_TIME,
        'Session times must fall on a whole minute. Pick one of the times shown.',
      ),
    );
  }
  return { start, end };
}

export function assertWithinBookingWindow(start: Date, now: Date): void {
  if (start.getTime() < now.getTime() + MIN_BOOKING_LEAD_MINUTES * 60_000) {
    throw new BadRequestException(
      schedulingError(
        SchedulingErrorCode.SESSION_IN_PAST,
        `That time is too soon. Pick a time at least ${MIN_BOOKING_LEAD_MINUTES} minutes from now.`,
      ),
    );
  }
  if (start.getTime() > now.getTime() + MAX_BOOKING_HORIZON_DAYS * DAY_MS) {
    throw new BadRequestException(
      schedulingError(
        SchedulingErrorCode.BEYOND_BOOKING_HORIZON,
        `Sessions can be booked up to ${MAX_BOOKING_HORIZON_DAYS} days ahead. Pick an earlier date.`,
      ),
    );
  }
}

export function assertTypeDuration(type: SessionType, start: Date, end: Date): void {
  assertDurationMinutes(type.duration_minutes, start, end);
}

function assertDurationMinutes(expected: number, start: Date, end: Date): void {
  const minutes = (end.getTime() - start.getTime()) / 60_000;
  if (minutes !== expected) {
    throw new BadRequestException(
      schedulingError(
        SchedulingErrorCode.DURATION_MISMATCH,
        `This appointment type is ${expected} minutes long. Pick one of the times shown.`,
      ),
    );
  }
}

function assertHasStarted(existing: CoachingSession, action: 'complete' | 'no_show'): void {
  if (existing.start_at.getTime() <= Date.now()) return;
  throw notStartedYet(action);
}

export interface TransitionOptions {
  /** The start time on the caller's screen (ISO). Mismatch -> 409 SESSION_MOVED. */
  expectedStartAt?: string | null;
}

function sameInterval(
  a: Pick<CoachingSession, 'start_at' | 'end_at'>,
  b: Pick<CoachingSession, 'start_at' | 'end_at'>,
): boolean {
  return a.start_at.getTime() === b.start_at.getTime() && a.end_at.getTime() === b.end_at.getTime();
}

// True while the session is still confirmed after provisioning. A cancel, a
// decline or a client move back to approval in the meantime makes the
// confirmation obsolete. (An instant-confirm session moved meanwhile stays
// confirmed; the notice then states its current time.)
function isConfirmedRevision(row: CoachingSession): boolean {
  return row.status === 'scheduled' || row.status === 'pending_provider';
}

function assertExpectedStart(existing: CoachingSession, expected: string | null | undefined): void {
  if (expected === undefined || expected === null || expected === '') return;
  const at = new Date(expected);
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestException(
      schedulingError(
        SchedulingErrorCode.INVALID_TIME,
        'The session time on your screen could not be read. Refresh to see the current time.',
      ),
    );
  }
  if (at.getTime() !== existing.start_at.getTime()) throw sessionMoved();
}

function sessionMoved(): ConflictException {
  return new ConflictException(
    schedulingError(
      SchedulingErrorCode.SESSION_MOVED,
      'This session moved to a new time a moment ago. Refresh to see the new time, then choose again.',
    ),
  );
}

function approvalTooLate(): ConflictException {
  return new ConflictException(
    schedulingError(
      SchedulingErrorCode.SESSION_STARTED,
      'The requested time has already passed. Decline it so the client can pick a new time.',
    ),
  );
}

function clientCancelTooLate(): ConflictException {
  return new ConflictException(
    schedulingError(
      SchedulingErrorCode.SESSION_STARTED,
      'This session has already started, so it cannot be cancelled from the app. Message your coach instead.',
    ),
  );
}

function notStartedYet(action: 'complete' | 'no_show'): ConflictException {
  return new ConflictException(
    schedulingError(
      SchedulingErrorCode.SESSION_NOT_ACTIVE,
      action === 'complete'
        ? 'This session has not started yet. Mark it complete after it starts.'
        : 'This session has not started yet. You can mark a no-show once the start time has passed.',
    ),
  );
}

function slotTaken(): ConflictException {
  return new ConflictException(
    schedulingError(
      SchedulingErrorCode.SLOT_TAKEN,
      'Someone just took that time. Pick another time from the list.',
    ),
  );
}

function stateChanged(): ConflictException {
  return new ConflictException(
    schedulingError(
      SchedulingErrorCode.SESSION_STATE_CHANGED,
      'This session changed while you were looking at it. Refresh to see its current state.',
    ),
  );
}

function statusWord(s: SessionStatus): string {
  switch (s) {
    case 'requested':
      return 'waiting for approval';
    case 'scheduled':
      return 'confirmed';
    case 'pending_provider':
      return 'confirmed and waiting for a call link';
    case 'declined':
      return 'declined';
    case 'canceled':
      return 'cancelled';
    case 'completed':
      return 'completed';
    case 'no_show':
      return 'marked as a no-show';
    case 'expired':
      return 'closed because it was not confirmed in time';
    default:
      return 'closed';
  }
}

function actionWord(to: SessionStatus): string {
  switch (to) {
    case 'scheduled':
      return 'confirmed';
    case 'declined':
      return 'declined';
    case 'canceled':
      return 'cancelled';
    case 'completed':
      return 'marked complete';
    case 'no_show':
      return 'marked as a no-show';
    default:
      return 'changed';
  }
}

// S-SCHED-5: the person acting, for REQUEST_EXPIRED copy.
function viewerOf(actor: ActorContext): 'client' | 'coach' {
  return actor.role === 'student' ? 'client' : 'coach';
}

// S-SCHED-5: where-fragment for "this request has not reached its clear time".
function requestStillOpen(now: Date): Prisma.CoachingSessionWhereInput {
  return { OR: [{ request_expires_at: null }, { request_expires_at: { gt: now } }] };
}
