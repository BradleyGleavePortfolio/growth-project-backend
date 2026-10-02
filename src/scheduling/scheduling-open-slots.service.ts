import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma, SessionType } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { DEFAULT_COACH_TIMEZONE, SchedulingAccessService } from './scheduling-access.service';
import {
  computeOpenSlots,
  isIntervalBookable,
  validateRange,
  type AvailabilityOverride,
  type AvailabilityWindow,
  type SessionInterval,
} from './slot-computer.service';
import {
  MAX_BOOKING_HORIZON_DAYS,
  MIN_BOOKING_LEAD_MINUTES,
  OCCUPYING_SESSION_STATUSES,
  SchedulingErrorCode,
  dateOnly,
  schedulingError,
} from './scheduling.types';
import type { ActorContext, OpenSlotsPayload } from './scheduling.types';

type Db = PrismaService | Prisma.TransactionClient;

export interface CoachCalendarInputs {
  timezone: string;
  windows: AvailabilityWindow[];
  overrides: AvailabilityOverride[];
  bookings: SessionInterval[];
}

// ---------------- Open slots (TGP-native scheduling) ----------------
//
// Concrete bookable slots over [from, to] for `coachId`, from TGP state only:
// recurring availability, coach overrides (time off / extra hours) and the
// coach's occupying sessions (OCCUPYING_SESSION_STATUSES: a pending request
// holds its slot).
//
// S-SCHED-2:
//  - Access: SchedulingAccessService.assertCanBrowseCoach (the assigned
//    client's head coach or current sub-coach, the coach, or owner).
//  - session_type_id: the slot length is the type's duration and only windows
//    that are unscoped or scoped to that type count. Archived or foreign types
//    are refused with SESSION_TYPE_UNAVAILABLE.
//  - Slots earlier than now + MIN_BOOKING_LEAD_MINUTES or later than the
//    booking horizon are not offered (the booking path refuses them too).
//  - isIntervalOpen() is the authoritative, uncached check the booking and
//    reschedule paths run inside their per-coach locked transaction.
//  - The 60 s per-process cache is invalidated per coach on every booking
//    write in this process. Another instance may serve a list up to 60 s old;
//    the booking path re-validates against fresh state, so a stale slot can
//    only produce a 409 SLOT_TAKEN / SLOT_UNAVAILABLE, never a double booking.
@Injectable()
export class SchedulingOpenSlotsService {
  private readonly logger = new Logger(SchedulingOpenSlotsService.name);
  private readonly access: SchedulingAccessService;

  private readonly _openSlotsCache = new Map<
    string,
    { expiresAt: number; payload: OpenSlotsPayload }
  >();
  private static readonly OPEN_SLOTS_TTL_MS = 60_000;
  private static readonly MAX_CACHE_ENTRIES = 500;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() access?: SchedulingAccessService,
  ) {
    this.access = access ?? new SchedulingAccessService(prisma);
  }

  invalidateCoach(coachId: string): void {
    const prefix = `${coachId}|`;
    for (const key of Array.from(this._openSlotsCache.keys())) {
      if (key.startsWith(prefix)) this._openSlotsCache.delete(key);
    }
  }

  invalidateAll(): void {
    this._openSlotsCache.clear();
  }

  /** Resolve an active type owned by this coach, or throw 400 SESSION_TYPE_UNAVAILABLE. */
  async resolveBookableType(
    coachId: string,
    sessionTypeId: string,
    db: Db = this.prisma,
  ): Promise<SessionType> {
    const type = await db.sessionType.findUnique({ where: { id: sessionTypeId } });
    if (!type || type.coach_id !== coachId || type.archived_at) {
      throw new BadRequestException(
        schedulingError(
          SchedulingErrorCode.SESSION_TYPE_UNAVAILABLE,
          'That appointment type is no longer offered. Pick another type from your coach.',
        ),
      );
    }
    return type;
  }

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
    await this.access.assertCanBrowseCoach(actor, coachId);

    const fromDate = new Date(args.from);
    const toDate = new Date(args.to);
    const rangeError = validateRange(fromDate, toDate);
    if (rangeError) {
      throw new BadRequestException(
        schedulingError(SchedulingErrorCode.INVALID_TIME, rangeError.message),
      );
    }

    let sessionType: SessionType | null = null;
    if (args.session_type_id) {
      sessionType = await this.resolveBookableType(coachId, args.session_type_id);
    }
    const duration = sessionType ? sessionType.duration_minutes : (args.duration_minutes ?? 60);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 8 * 60) {
      throw new BadRequestException(
        schedulingError(SchedulingErrorCode.INVALID_TIME, 'duration_minutes must be 1..480'),
      );
    }

    const cacheKey = `${coachId}|${fromDate.toISOString()}|${toDate.toISOString()}|${duration}|${sessionType?.id ?? '-'}`;
    const cached = this._openSlotsCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return this.withinBookingWindow(cached.payload, now);
    }

    const inputs = await this.loadCalendarInputs(this.prisma, coachId, fromDate, toDate, {
      sessionTypeId: sessionType?.id ?? null,
      excludeSessionId: null,
    });
    const slots = computeOpenSlots({
      from: fromDate,
      to: toDate,
      durationMinutes: duration,
      coachTimezone: inputs.timezone,
      windows: inputs.windows,
      overrides: inputs.overrides,
      bookings: inputs.bookings,
    });

    const payload: OpenSlotsPayload = {
      coach_id: coachId,
      timezone: inputs.timezone,
      generated_at: new Date().toISOString(),
      session_type_id: sessionType?.id ?? null,
      duration_minutes: duration,
      slots,
    };
    if (this._openSlotsCache.size >= SchedulingOpenSlotsService.MAX_CACHE_ENTRIES) {
      this._openSlotsCache.clear();
    }
    this._openSlotsCache.set(cacheKey, {
      expiresAt: now + SchedulingOpenSlotsService.OPEN_SLOTS_TTL_MS,
      payload,
    });
    return this.withinBookingWindow(payload, now);
  }

  /**
   * Authoritative, uncached check used by the booking and reschedule paths
   * (inside their locked transaction, so `db` is the transaction client): is
   * [start, end) entirely inside the coach's bookable time for this type,
   * with no other occupying session overlapping? `excludeSessionId` lets a
   * reschedule ignore the session being moved.
   */
  async isIntervalOpen(
    db: Db,
    coachId: string,
    start: Date,
    end: Date,
    opts: { sessionTypeId: string | null; excludeSessionId: string | null },
  ): Promise<boolean> {
    const inputs = await this.loadCalendarInputs(db, coachId, start, end, opts);
    return isIntervalBookable(
      {
        from: start,
        to: end,
        coachTimezone: inputs.timezone,
        windows: inputs.windows,
        overrides: inputs.overrides,
        bookings: inputs.bookings,
      },
      start,
      end,
    );
  }

  /** Coach timezone (CoachProfile.timezone, default America/Los_Angeles). Throws 404 for a non-coach. */
  async coachTimezone(db: Db, coachId: string): Promise<string> {
    const coach = await db.user.findUnique({
      where: { id: coachId },
      select: { role: true, coach_profile: { select: { timezone: true } } },
    });
    if (!coach || coach.role !== 'coach') {
      throw new NotFoundException(
        schedulingError(
          SchedulingErrorCode.COACH_NOT_FOUND,
          'We could not find that coach. Open Calendar to see who you can book with.',
        ),
      );
    }
    return coach.coach_profile?.timezone ?? DEFAULT_COACH_TIMEZONE;
  }

  async loadCalendarInputs(
    db: Db,
    coachId: string,
    from: Date,
    to: Date,
    opts: { sessionTypeId: string | null; excludeSessionId: string | null },
  ): Promise<CoachCalendarInputs> {
    const timezone = await this.coachTimezone(db, coachId);
    const [rawWindows, rawOverrides, activeSessions] = await Promise.all([
      db.coachAvailability.findMany({ where: { coach_id: coachId } }),
      db.coachAvailabilityOverride.findMany({
        where: {
          coach_id: coachId,
          date: { gte: dateOnly(from, -1), lte: dateOnly(to, 1) },
        },
      }),
      db.coachingSession.findMany({
        where: {
          coach_id: coachId,
          status: { in: [...OCCUPYING_SESSION_STATUSES] },
          start_at: { lt: to },
          end_at: { gt: from },
          ...(opts.excludeSessionId ? { id: { not: opts.excludeSessionId } } : {}),
        },
        select: { start_at: true, end_at: true },
      }),
    ]);
    // A window scoped to a session type only offers that type. Unscoped
    // windows offer every type.
    const windows = rawWindows.filter(
      (w) =>
        w.session_type_id === null ||
        (opts.sessionTypeId !== null && w.session_type_id === opts.sessionTypeId),
    );
    return {
      timezone,
      windows: windows.map((w) => ({
        day_of_week: w.day_of_week,
        start_minute: w.start_minute,
        end_minute: w.end_minute,
      })),
      overrides: rawOverrides.map((o) => ({
        date: o.date.toISOString().slice(0, 10),
        start_minute: o.start_minute,
        end_minute: o.end_minute,
        kind: o.kind as AvailabilityOverride['kind'],
      })),
      bookings: activeSessions.map((s) => ({ start_at: s.start_at, end_at: s.end_at })),
    };
  }

  private withinBookingWindow(payload: OpenSlotsPayload, nowMs: number): OpenSlotsPayload {
    const floor = nowMs + MIN_BOOKING_LEAD_MINUTES * 60_000;
    const ceiling = nowMs + MAX_BOOKING_HORIZON_DAYS * 24 * 60 * 60_000;
    const slots = payload.slots.filter((s) => {
      const t = new Date(s.start_at).getTime();
      return t >= floor && t <= ceiling;
    });
    return slots.length === payload.slots.length ? payload : { ...payload, slots };
  }
}
