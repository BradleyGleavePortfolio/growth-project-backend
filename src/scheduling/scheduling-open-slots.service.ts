import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { computeOpenSlots, validateRange } from './slot-computer.service';
import { dateOnly } from './scheduling.types';
import type { ActorContext, OpenSlotsPayload } from './scheduling.types';

// ---------------- Open slots (Phase 1 — TGP-exclusive) ----------------
//
// Concrete bookable slots over [from, to] for `coachId`. Phase 1
// intentionally consumes only TGP state: recurring availability,
// coach overrides, and existing active sessions. Phase 2 will fold
// in Google Calendar free-busy when the feature flag is on; that
// path is documented in the RFC addendum but not wired here.
//
// 60s in-process cache keyed on (coach|from|to|duration). Suitable
// for the booking-picker UX where the same client opens a coach
// page repeatedly; not a substitute for a real cache layer.
//
// Pulled out of SchedulingService during the M9 refactor — the
// behaviour, cache shape, and TTL match the pre-split code exactly.
@Injectable()
export class SchedulingOpenSlotsService {
  private readonly logger = new Logger(SchedulingOpenSlotsService.name);

  private readonly _openSlotsCache = new Map<
    string,
    { expiresAt: number; payload: OpenSlotsPayload }
  >();
  private static readonly OPEN_SLOTS_TTL_MS = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  async getOpenSlots(
    actor: ActorContext,
    coachId: string,
    args: { from: string; to: string; duration_minutes?: number | null },
  ): Promise<OpenSlotsPayload> {
    // Same auth rule as request-session: caller must be the assigned
    // client, the coach themselves, or owner.
    if (
      actor.role !== 'owner' &&
      !(actor.role === 'coach' && actor.id === coachId) &&
      !(actor.role === 'student' && actor.coach_id === coachId)
    ) {
      throw new ForbiddenException(
        'You can only view open slots for your assigned coach',
      );
    }

    const fromDate = new Date(args.from);
    const toDate = new Date(args.to);
    const duration = args.duration_minutes ?? 60;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 8 * 60) {
      throw new BadRequestException('duration_minutes must be 1..480');
    }
    const rangeError = validateRange(fromDate, toDate);
    if (rangeError) throw new BadRequestException(rangeError.message);

    const cacheKey = `${coachId}|${fromDate.toISOString()}|${toDate.toISOString()}|${duration}`;
    const cached = this._openSlotsCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.payload;
    }

    const coach = await this.prisma.user.findUnique({
      where: { id: coachId },
      include: { coach_profile: true },
    });
    if (!coach || coach.role !== 'coach') {
      throw new NotFoundException('Coach not found');
    }
    const timezone =
      coach.coach_profile?.timezone ?? 'America/Los_Angeles';

    const [rawWindows, rawOverrides, activeSessions] = await Promise.all([
      this.prisma.coachAvailability.findMany({ where: { coach_id: coachId } }),
      this.prisma.coachAvailabilityOverride.findMany({
        where: {
          coach_id: coachId,
          date: { gte: dateOnly(fromDate, -1), lte: dateOnly(toDate, 1) },
        },
      }),
      this.prisma.coachingSession.findMany({
        where: {
          coach_id: coachId,
          status: { in: ['requested', 'scheduled', 'pending_provider'] },
          start_at: { lt: toDate },
          end_at: { gt: fromDate },
        },
      }),
    ]);

    const slots = computeOpenSlots({
      from: fromDate,
      to: toDate,
      durationMinutes: duration,
      coachTimezone: timezone,
      windows: rawWindows.map((w) => ({
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

    const payload: OpenSlotsPayload = {
      coach_id: coachId,
      timezone,
      generated_at: new Date().toISOString(),
      slots,
    };
    this._openSlotsCache.set(cacheKey, {
      expiresAt: now + SchedulingOpenSlotsService.OPEN_SLOTS_TTL_MS,
      payload,
    });
    return payload;
  }
}
