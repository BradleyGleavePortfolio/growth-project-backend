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
  MAX_RANGE_DAYS as OPEN_SLOTS_MAX_RANGE_DAYS,
  computeOpenSlots,
  intervalBookability,
  validateRange,
  type AvailabilityOverride,
  type AvailabilityWindow,
  type IntervalBookability,
  type SessionInterval,
} from './slot-computer.service';
import {
  DEFAULT_BOOKING_OPTIONS,
  OCCUPYING_SESSION_STATUSES,
  SchedulingErrorCode,
  dateOnly,
  schedulingError,
} from './scheduling.types';
import type { ActorContext, BookingOptions, OpenSlotsPayload } from './scheduling.types';

const DAY_MS = 24 * 60 * 60_000;

type Db = PrismaService | Prisma.TransactionClient;

export interface CoachCalendarInputs {
  timezone: string;
  windows: AvailabilityWindow[];
  overrides: AvailabilityOverride[];
  bookings: SessionInterval[];
  // S-AVAIL-122: the coach's booking options (defaults when never edited).
  options: BookingOptions;
}

// S-AVAIL-122: CoachProfile columns -> BookingOptions. A coach without a
// profile row gets the defaults (field by field).
const BOOKING_OPTION_SELECT = {
  booking_min_notice_minutes: true,
  booking_window_days: true,
  booking_buffer_before_min: true,
  booking_buffer_after_min: true,
  booking_daily_max: true,
} as const;

export function toBookingOptions(
  row:
    | {
        booking_min_notice_minutes?: number | null;
        booking_window_days?: number | null;
        booking_buffer_before_min?: number | null;
        booking_buffer_after_min?: number | null;
        booking_daily_max?: number | null;
      }
    | null
    | undefined,
): BookingOptions {
  const d = DEFAULT_BOOKING_OPTIONS;
  const pick = (v: number | null | undefined, fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
  const cap = row?.booking_daily_max;
  return {
    min_notice_minutes: pick(row?.booking_min_notice_minutes, d.min_notice_minutes),
    booking_window_days: pick(row?.booking_window_days, d.booking_window_days),
    buffer_before_minutes: pick(row?.booking_buffer_before_min, d.buffer_before_minutes),
    buffer_after_minutes: pick(row?.booking_buffer_after_min, d.buffer_after_minutes),
    daily_max_sessions: typeof cap === 'number' && Number.isInteger(cap) && cap > 0 ? cap : null,
  };
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
//  - Slots earlier than now + the coach's minimum notice or later than the
//    coach's booking window are not offered (the booking path refuses them
//    too). S-AVAIL-122: buffers and the daily maximum apply the same way.
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
        schedulingError(
          SchedulingErrorCode.INVALID_TIME,
          `Open times could not be listed: ${rangeError.message}. Ask again with a start before the end, at most ${OPEN_SLOTS_MAX_RANGE_DAYS} days apart.`,
        ),
      );
    }

    let sessionType: SessionType | null = null;
    if (args.session_type_id) {
      sessionType = await this.resolveBookableType(coachId, args.session_type_id);
    }
    const duration = sessionType ? sessionType.duration_minutes : (args.duration_minutes ?? 60);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 8 * 60) {
      throw new BadRequestException(
        schedulingError(
          SchedulingErrorCode.INVALID_TIME,
          'That appointment length cannot be booked (it must be 1 to 480 minutes). Pick an appointment type from your coach to see its open times.',
        ),
      );
    }

    const cacheKey = `${coachId}|${fromDate.toISOString()}|${toDate.toISOString()}|${duration}|${sessionType?.id ?? '-'}`;
    const cached = this._openSlotsCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return withinBookingWindow(cached.payload, now);
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
      bufferBeforeMinutes: inputs.options.buffer_before_minutes,
      bufferAfterMinutes: inputs.options.buffer_after_minutes,
      dailyMax: inputs.options.daily_max_sessions,
    });

    const payload: OpenSlotsPayload = {
      coach_id: coachId,
      timezone: inputs.timezone,
      generated_at: new Date().toISOString(),
      session_type_id: sessionType?.id ?? null,
      duration_minutes: duration,
      min_notice_minutes: inputs.options.min_notice_minutes,
      booking_window_days: inputs.options.booking_window_days,
      slots,
    };
    if (this._openSlotsCache.size >= SchedulingOpenSlotsService.MAX_CACHE_ENTRIES) {
      this._openSlotsCache.clear();
    }
    this._openSlotsCache.set(cacheKey, {
      expiresAt: now + SchedulingOpenSlotsService.OPEN_SLOTS_TTL_MS,
      payload,
    });
    return withinBookingWindow(payload, now);
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
    return (await this.intervalBookability(db, coachId, start, end, opts)).verdict === 'open';
  }

  /**
   * isIntervalOpen with the reason (S-AVAIL-122: buffers, daily maximum) and
   * the coach's booking options read in the same pass, so the caller can
   * apply the coach's notice and window under the same lock.
   */
  async intervalBookability(
    db: Db,
    coachId: string,
    start: Date,
    end: Date,
    opts: { sessionTypeId: string | null; excludeSessionId: string | null },
  ): Promise<{ verdict: IntervalBookability; options: BookingOptions }> {
    const inputs = await this.loadCalendarInputs(db, coachId, start, end, opts);
    const verdict = intervalBookability(
      {
        from: start,
        to: end,
        coachTimezone: inputs.timezone,
        windows: inputs.windows,
        overrides: inputs.overrides,
        bookings: inputs.bookings,
        bufferBeforeMinutes: inputs.options.buffer_before_minutes,
        bufferAfterMinutes: inputs.options.buffer_after_minutes,
        dailyMax: inputs.options.daily_max_sessions,
      },
      start,
      end,
    );
    return { verdict, options: inputs.options };
  }

  /** Coach timezone (CoachProfile.timezone, default America/Los_Angeles). Throws 404 for a non-coach. */
  async coachTimezone(db: Db, coachId: string): Promise<string> {
    return (await this.coachCalendarProfile(db, coachId)).timezone;
  }

  /** Timezone + booking options. Throws 404 COACH_NOT_FOUND for a non-coach. */
  async coachCalendarProfile(
    db: Db,
    coachId: string,
  ): Promise<{ timezone: string; options: BookingOptions }> {
    const coach = await db.user.findUnique({
      where: { id: coachId },
      select: {
        role: true,
        coach_profile: { select: { timezone: true, ...BOOKING_OPTION_SELECT } },
      },
    });
    if (!coach || coach.role !== 'coach') {
      throw new NotFoundException(
        schedulingError(
          SchedulingErrorCode.COACH_NOT_FOUND,
          'That coach is no longer available to book. Open Calendar to see who you can book with.',
        ),
      );
    }
    return {
      timezone: coach.coach_profile?.timezone ?? DEFAULT_COACH_TIMEZONE,
      options: toBookingOptions(coach.coach_profile),
    };
  }

  async loadCalendarInputs(
    db: Db,
    coachId: string,
    from: Date,
    to: Date,
    opts: { sessionTypeId: string | null; excludeSessionId: string | null },
  ): Promise<CoachCalendarInputs> {
    const { timezone, options } = await this.coachCalendarProfile(db, coachId);
    // S-AVAIL-122: sessions a day either side also count, for the coach's
    // daily maximum (whole local days) and for buffers reaching into range.
    const bookingsFrom = new Date(from.getTime() - DAY_MS);
    const bookingsTo = new Date(to.getTime() + DAY_MS);
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
          // S-SCHED-5: a request past its clear time no longer holds the
          // slot (the booking transaction closes it before writing).
          OR: [
            { status: { not: 'requested' } },
            { request_expires_at: null },
            { request_expires_at: { gt: new Date() } },
          ],
          start_at: { lt: bookingsTo },
          end_at: { gt: bookingsFrom },
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
      options,
    };
  }
}

// Slots earlier than now + the coach's minimum notice or later than the
// coach's booking window are not offered (the booking path refuses them too).
function withinBookingWindow(payload: OpenSlotsPayload, nowMs: number): OpenSlotsPayload {
  const floor = nowMs + payload.min_notice_minutes * 60_000;
  const ceiling = nowMs + payload.booking_window_days * DAY_MS;
  const slots = payload.slots.filter((s) => {
    const t = new Date(s.start_at).getTime();
    return t >= floor && t <= ceiling;
  });
  return slots.length === payload.slots.length ? payload : { ...payload, slots };
}
