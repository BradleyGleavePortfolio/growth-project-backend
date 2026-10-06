import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import type { UpdateBookingOptionsDto } from './dto/scheduling.dto';
import { toBookingOptions } from './scheduling-open-slots.service';
import {
  BOOKING_OPTION_LIMITS,
  DEFAULT_BOOKING_OPTIONS,
  SchedulingErrorCode,
  formatNoticeMinutes,
  schedulingError,
} from './scheduling.types';
import type { ActorContext, BookingOptions } from './scheduling.types';

// S-AVAIL-122: a coach's own booking options (minimum notice, booking window,
// buffers, optional daily maximum). Coach-only, own data. Stored as additive
// CoachProfile columns whose defaults are today's fixed rules; open slots and
// the locked booking validation read them (SchedulingOpenSlotsService).

export interface BookingOptionsView extends BookingOptions {
  coach_id: string;
  defaults: BookingOptions;
  limits: typeof BOOKING_OPTION_LIMITS;
}

const SELECT = {
  booking_min_notice_minutes: true,
  booking_window_days: true,
  booking_buffer_before_min: true,
  booking_buffer_after_min: true,
  booking_daily_max: true,
} as const;

const LABELS: Record<keyof BookingOptions, string> = {
  min_notice_minutes: 'Minimum notice (minutes)',
  booking_window_days: 'How far ahead clients may book (days)',
  buffer_before_minutes: 'Buffer before each session (minutes)',
  buffer_after_minutes: 'Buffer after each session (minutes)',
  daily_max_sessions: 'Daily maximum (sessions)',
};

function assertCoach(actor: ActorContext): void {
  if (actor.role !== 'coach') {
    throw new ForbiddenException(
      'Booking options belong to a coach account. Sign in as the coach to change them.',
    );
  }
}

function invalid(message: string): BadRequestException {
  return new BadRequestException(
    schedulingError(SchedulingErrorCode.INVALID_BOOKING_OPTIONS, message),
  );
}

function view(coachId: string, options: BookingOptions): BookingOptionsView {
  return {
    coach_id: coachId,
    ...options,
    defaults: { ...DEFAULT_BOOKING_OPTIONS },
    limits: BOOKING_OPTION_LIMITS,
  };
}

/**
 * Validate a partial edit against the merged result. Returns the full options
 * that would be saved. Every refusal names the field and its allowed range.
 */
export function mergeBookingOptions(
  current: BookingOptions,
  patch: UpdateBookingOptionsDto,
): BookingOptions {
  const next: BookingOptions = { ...current };
  const intKeys = [
    'min_notice_minutes',
    'booking_window_days',
    'buffer_before_minutes',
    'buffer_after_minutes',
  ] as const;
  for (const key of intKeys) {
    const value: unknown = patch[key];
    if (value === undefined) continue;
    const { min, max } = BOOKING_OPTION_LIMITS[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw invalid(`${LABELS[key]} must be a whole number from ${min} to ${max}.`);
    }
    next[key] = value;
  }
  const cap: unknown = patch.daily_max_sessions;
  if (cap !== undefined) {
    const { min, max } = BOOKING_OPTION_LIMITS.daily_max_sessions;
    if (cap === null) {
      next.daily_max_sessions = null;
    } else if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < min || cap > max) {
      throw invalid(
        `${LABELS.daily_max_sessions} must be a whole number from ${min} to ${max}, or empty for no limit.`,
      );
    } else {
      next.daily_max_sessions = cap;
    }
  }
  if (next.min_notice_minutes >= next.booking_window_days * 1440) {
    throw invalid(
      `Minimum notice (${formatNoticeMinutes(next.min_notice_minutes)}) must be shorter than how far ahead clients may book (${next.booking_window_days} day${next.booking_window_days === 1 ? '' : 's'}).`,
    );
  }
  return next;
}

export class SchedulingBookingOptionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyBookingOptions(actor: ActorContext): Promise<BookingOptionsView> {
    assertCoach(actor);
    const row = await this.prisma.coachProfile.findUnique({
      where: { user_id: actor.id },
      select: SELECT,
    });
    return view(actor.id, toBookingOptions(row));
  }

  async updateMyBookingOptions(
    actor: ActorContext,
    patch: UpdateBookingOptionsDto,
  ): Promise<BookingOptionsView> {
    assertCoach(actor);
    const row = await this.prisma.coachProfile.findUnique({
      where: { user_id: actor.id },
      select: SELECT,
    });
    if (!row) {
      throw new NotFoundException(
        schedulingError(
          SchedulingErrorCode.COACH_NOT_FOUND,
          'Finish coach setup before changing booking options.',
        ),
      );
    }
    const next = mergeBookingOptions(toBookingOptions(row), patch);
    const data: Prisma.CoachProfileUpdateInput = {
      booking_min_notice_minutes: next.min_notice_minutes,
      booking_window_days: next.booking_window_days,
      booking_buffer_before_min: next.buffer_before_minutes,
      booking_buffer_after_min: next.buffer_after_minutes,
      booking_daily_max: next.daily_max_sessions,
    };
    const saved = await this.prisma.coachProfile.update({
      where: { user_id: actor.id },
      data,
      select: SELECT,
    });
    return view(actor.id, toBookingOptions(saved));
  }
}
