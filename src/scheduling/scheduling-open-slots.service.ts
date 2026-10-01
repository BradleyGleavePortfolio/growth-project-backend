import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { SessionType } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { assertCanBrowseCoachBooking } from './scheduling.permissions';
import { computeOpenSlots, validateRange } from './slot-computer.service';
import { dateOnly } from './scheduling.types';
import type { ActorContext, OpenSlotsPayload } from './scheduling.types';

// Statuses that occupy a coach's time. Shared by open-slot computation and
// the booking overlap check so "shown as open" and "bookable" agree.
export const OCCUPYING_SESSION_STATUSES = [
  'requested',
  'scheduled',
  'pending_provider',
] as const;

// Minimum lead time between "now" and a bookable slot start. The request
// path enforces the same floor (SESSION_IN_PAST).
export const MIN_BOOKING_LEAD_MINUTES = 5;

// ---------------- Open slots (Phase 1 — TGP-exclusive) ----------------
//
// Concrete bookable slots over [from, to] for `coachId`. Phase 1
// intentionally consumes only TGP state: recurring availability,
// coach overrides, and existing active sessions.
//
// S-SCHED changes:
//  - Access uses assertCanBrowseCoachBooking (assigned client, the coach,
//    owner) — unchanged rule, now shared with the types/availability reads.
//  - Optional session_type_id: the slot length is the type's duration and
//    only windows that are unscoped or scoped to that type count. Archived
//    or foreign types are rejected.
//  - Slots that start before now + MIN_BOOKING_LEAD_MINUTES are dropped.
//  - The 60s per-process cache is invalidated per coach on every booking
//    write (invalidateCoach) so a just-booked slot is not offered again by
//    this instance. Other instances may serve a stale list for <= 60s; the
//    booking path re-validates against fresh state, so a stale slot can
//    only produce a 409 SLOT_TAKEN, never a double booking.
//  - isIntervalOpen() is the authoritative check the booking path uses.
@Injectable()
export class SchedulingOpenSlotsService {
  private readonly logger = new Logger(SchedulingOpenSlotsService.name);

  private readonly _openSlotsCache = new Map<
    string,
    { expiresAt: number; payload: OpenSlotsPayload }
  >();
  private static readonly OPEN_SLOTS_TTL_MS = 60_000;
  private static readonly MAX_CACHE_ENTRIES = 500;

  constructor(private readonly prisma: PrismaService) {}

  invalidateCoach(coachId: string): void {
    const prefix = `${coachId}|`;
    for (const key of Array.from(this._openSlotsCache.keys())) {
      if (key.startsWith(prefix)) this._openSlotsCache.delete(key);
    }
  }

  /** Resolve a bookable (same coach, not archived) session type or throw 400. */
  async resolveBookableType(
    coachId: string,
    sessionTypeId: string,
  ): Promise<SessionType> {
    const type = await this.prisma.sessionType.findUnique({
      where: { id: sessionTypeId },
    });
    if (!type || type.coach_id !== coachId || type.archived_at) {
      throw new BadRequestException({
        error: 'SESSION_TYPE_UNAVAILABLE',
        message: 'That appointment type is not available.',
      });
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
    assertCanBrowseCoachBooking(
      { id: actor.id, role: actor.role, coach_id: actor.coach_id },
      coachId,
    );

    const fromDate = new Date(args.from);
    const toDate = new Date(args.to);
    const rangeError = validateRange(fromDate, toDate);
    if (rangeError) throw new BadRequestException(rangeError.message);

    let sessionType: SessionType | null = null;
    if (args.session_type_id) {
      sessionType = await this.resolveBookableType(coachId, args.session_type_id);
    }
    const duration = sessionType
      ? sessionType.duration_minutes
      : (args.duration_minutes ?? 60);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 8 * 60) {
      throw new BadRequestException('duration_minutes must be 1..480');
    }

    const cacheKey = `${coachId}|${fromDate.toISOString()}|${toDate.toISOString()}|${duration}|${sessionType?.id ?? '-'}`;
    const cached = this._openSlotsCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return this.dropTooSoon(cached.payload, now);
    }

    const { timezone, slots } = await this.compute(coachId, {
      from: fromDate,
      to: toDate,
      durationMinutes: duration,
      sessionTypeId: sessionType?.id ?? null,
      excludeSessionId: null,
    });

    const payload: OpenSlotsPayload = {
      coach_id: coachId,
      timezone,
      generated_at: new Date().toISOString(),
      slots,
    };
    if (this._openSlotsCache.size >= SchedulingOpenSlotsService.MAX_CACHE_ENTRIES) {
      this._openSlotsCache.clear();
    }
    this._openSlotsCache.set(cacheKey, {
      expiresAt: now + SchedulingOpenSlotsService.OPEN_SLOTS_TTL_MS,
      payload,
    });
    return this.dropTooSoon(payload, now);
  }

  /**
   * Authoritative, uncached check used by the booking and reschedule paths:
   * is [start, end) entirely inside the coach's bookable time (recurring
   * windows for this type + extra overrides, minus holidays/blocks, minus
   * other occupying sessions)? `excludeSessionId` lets a reschedule ignore
   * the session being moved.
   */
  async isIntervalOpen(
    coachId: string,
    start: Date,
    end: Date,
    opts: { sessionTypeId: string | null; excludeSessionId: string | null },
  ): Promise<boolean> {
    const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60_000);
    if (durationMinutes <= 0) return false;
    const { slots } = await this.compute(coachId, {
      from: start,
      to: end,
      durationMinutes,
      sessionTypeId: opts.sessionTypeId,
      excludeSessionId: opts.excludeSessionId,
    });
    return slots.some(
      (s) =>
        new Date(s.start_at).getTime() === start.getTime() &&
        new Date(s.end_at).getTime() === end.getTime(),
    );
  }

  private dropTooSoon(payload: OpenSlotsPayload, nowMs: number): OpenSlotsPayload {
    const floor = nowMs + MIN_BOOKING_LEAD_MINUTES * 60_000;
    const slots = payload.slots.filter((s) => new Date(s.start_at).getTime() >= floor);
    return slots.length === payload.slots.length ? payload : { ...payload, slots };
  }

  private async compute(
    coachId: string,
    args: {
      from: Date;
      to: Date;
      durationMinutes: number;
      sessionTypeId: string | null;
      excludeSessionId: string | null;
    },
  ): Promise<{ timezone: string; slots: OpenSlotsPayload['slots'] }> {
    const coach = await this.prisma.user.findUnique({
      where: { id: coachId },
      include: { coach_profile: true },
    });
    if (!coach || coach.role !== 'coach') {
      throw new NotFoundException('Coach not found');
    }
    const timezone = coach.coach_profile?.timezone ?? 'America/Los_Angeles';

    const [rawWindows, rawOverrides, activeSessions] = await Promise.all([
      this.prisma.coachAvailability.findMany({ where: { coach_id: coachId } }),
      this.prisma.coachAvailabilityOverride.findMany({
        where: {
          coach_id: coachId,
          date: { gte: dateOnly(args.from, -1), lte: dateOnly(args.to, 1) },
        },
      }),
      this.prisma.coachingSession.findMany({
        where: {
          coach_id: coachId,
          status: { in: [...OCCUPYING_SESSION_STATUSES] },
          start_at: { lt: args.to },
          end_at: { gt: args.from },
          ...(args.excludeSessionId ? { id: { not: args.excludeSessionId } } : {}),
        },
      }),
    ]);

    // A window scoped to a session type only offers that type. Unscoped
    // windows offer every type (and untyped requests).
    const windows = rawWindows.filter(
      (w) =>
        w.session_type_id === null ||
        w.session_type_id === undefined ||
        (args.sessionTypeId !== null && w.session_type_id === args.sessionTypeId),
    );

    const slots = computeOpenSlots({
      from: args.from,
      to: args.to,
      durationMinutes: args.durationMinutes,
      coachTimezone: timezone,
      windows: windows.map((w) => ({
        day_of_week: w.day_of_week,
        start_minute: w.start_minute,
        end_minute: w.end_minute,
      })),
      overrides: rawOverrides.map((o) => ({
        date: o.date.toISOString().slice(0, 10),
        start_minute: o.start_minute,
        end_minute: o.end_minute,
        kind: o.kind as 'holiday' | 'block' | 'extra',
      })),
      bookings: activeSessions.map((s) => ({
        start_at: s.start_at,
        end_at: s.end_at,
      })),
    });
    return { timezone, slots };
  }
}
