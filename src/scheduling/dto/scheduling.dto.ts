import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const VIDEO_PROVIDERS = ['stub', 'google_meet', 'zoom', 'manual'] as const;
export type VideoProviderDtoValue = (typeof VIDEO_PROVIDERS)[number];

export class CreateSessionTypeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsInt()
  @Min(5)
  @Max(480)
  duration_minutes!: number;

  @IsOptional()
  @IsBoolean()
  auto_approve?: boolean;

  @IsOptional()
  @IsIn(VIDEO_PROVIDERS as readonly string[])
  default_video_provider?: VideoProviderDtoValue;

  // S-SCHED-2: marks the coach's welcome / first call type. Setting it
  // clears the marker on the coach's other active types.
  @IsOptional()
  @IsBoolean()
  is_welcome?: boolean;

  // S-SCHED-2: the coach's own https room for this type, attached to
  // sessions of this type when they are confirmed without a link.
  // Empty string removes it. Never returned to clients on the type list.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  default_meeting_url?: string | null;
}

export class UpdateSessionTypeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  duration_minutes?: number;

  @IsOptional()
  @IsBoolean()
  auto_approve?: boolean;

  @IsOptional()
  @IsIn(VIDEO_PROVIDERS as readonly string[])
  default_video_provider?: VideoProviderDtoValue;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;

  @IsOptional()
  @IsBoolean()
  is_welcome?: boolean;

  // Empty string or null removes the default link.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  default_meeting_url?: string | null;
}

export class AvailabilityWindowDto {
  @IsInt()
  @Min(0)
  @Max(6)
  day_of_week!: number;

  @IsInt()
  @Min(0)
  @Max(60 * 24 - 1)
  start_minute!: number;

  @IsInt()
  @Min(1)
  @Max(60 * 24)
  end_minute!: number;

  @IsOptional()
  @IsUUID()
  session_type_id?: string;
}

export class SetAvailabilityDto {
  // The full new set of windows for the coach. The service replaces
  // the existing rows in a single transaction so partial-update edge
  // cases (orphaned rows, half-applied edits) are impossible.
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityWindowDto)
  windows!: AvailabilityWindowDto[];
}

// S-AVAIL-122: PATCH /scheduling/coach/booking-options. Every field is
// optional (omitted = unchanged); daily_max_sessions null removes the cap.
// Ranges are checked by the service (mergeBookingOptions) so a refusal names
// the field and its allowed range.
export class UpdateBookingOptionsDto {
  @IsOptional()
  @IsInt({ message: 'Minimum notice must be a whole number of minutes.' })
  min_notice_minutes?: number;

  @IsOptional()
  @IsInt({ message: 'How far ahead clients may book must be a whole number of days.' })
  booking_window_days?: number;

  @IsOptional()
  @IsInt({ message: 'Buffer before each session must be a whole number of minutes.' })
  buffer_before_minutes?: number;

  @IsOptional()
  @IsInt({ message: 'Buffer after each session must be a whole number of minutes.' })
  buffer_after_minutes?: number;

  @IsOptional()
  @IsInt({ message: 'Daily maximum must be a whole number of sessions, or empty for no limit.' })
  daily_max_sessions?: number | null;
}

export class RequestSessionDto {
  @IsUUID()
  coach_id!: string;

  // Required by the service (400 SESSION_TYPE_REQUIRED with a readable
  // message when missing); optional here so the error is coded, not a
  // generic validation string.
  @IsOptional()
  @IsUUID()
  session_type_id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsISO8601()
  start_at!: string;

  @IsISO8601()
  end_at!: string;
}

export class RescheduleSessionDto {
  @IsISO8601()
  start_at!: string;

  @IsISO8601()
  end_at!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CancelSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  // S-SCHED-3 (B-634-1): the start time the caller was looking at. When it
  // no longer matches the session, the server answers 409 SESSION_MOVED
  // instead of declining or cancelling a time the caller never saw.
  @IsOptional()
  @IsISO8601()
  expected_start_at?: string;
}

// S-SCHED-3 (B-634-1): approve carries the start time the coach reviewed.
export class ApproveSessionDto {
  @IsOptional()
  @IsISO8601()
  expected_start_at?: string;
}

export class CompleteSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  coach_notes_md?: string;
}

export class AttachManualVideoLinkDto {
  // Free-form URL (Whereby, FaceTime, Zoom personal room, phone-call
  // marker like "tel:+1..." etc). The endpoint stamps the session as
  // video_provider=manual so reminder jobs do not try to mint a new
  // link via a real adapter.
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  video_url!: string;
}

// CoachAvailabilityOverride DTOs — date-keyed exceptions to the
// recurring weekly availability. See Prisma model `CoachAvailabilityOverride`.
//
// `kind`:
//   - 'holiday' / 'block': remove availability. Full-day if start_time/end_time omitted.
//   - 'extra': add availability outside the recurring windows. Always requires start_time + end_time.

export const AVAILABILITY_OVERRIDE_KINDS = ['holiday', 'block', 'extra'] as const;
export type AvailabilityOverrideKind = (typeof AVAILABILITY_OVERRIDE_KINDS)[number];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^\d{2}:\d{2}$/;

export class CreateAvailabilityOverrideDto {
  // YYYY-MM-DD (no time component).
  @IsISO8601({ strict: true })
  @MaxLength(10)
  date!: string;

  @IsIn(AVAILABILITY_OVERRIDE_KINDS as unknown as string[])
  kind!: AvailabilityOverrideKind;

  // HH:MM (24h, coach-local). Required for `block`/`extra`, forbidden for `holiday`.
  @IsOptional()
  @IsString()
  @MaxLength(5)
  start_time?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  end_time?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateAvailabilityOverrideDto {
  @IsOptional()
  @IsIn(AVAILABILITY_OVERRIDE_KINDS as unknown as string[])
  kind?: AvailabilityOverrideKind;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  start_time?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  end_time?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// Helpers exported for use by the service layer. Inline so the DTO
// file stays the single home for shape rules.

export function validateOverridePayload(input: {
  kind?: AvailabilityOverrideKind;
  date?: string;
  start_time?: string | null;
  end_time?: string | null;
}): { date_ok: boolean; minutes: { start: number | null; end: number | null } } {
  if (input.date !== undefined && !ISO_DATE_RE.test(input.date)) {
    return { date_ok: false, minutes: { start: null, end: null } };
  }
  const hasStart = input.start_time !== undefined && input.start_time !== null;
  const hasEnd = input.end_time !== undefined && input.end_time !== null;
  if (input.kind === 'holiday' && (hasStart || hasEnd)) {
    throw new Error('HOLIDAY overrides must be full-day; remove start_time and end_time');
  }
  if ((input.kind === 'block' || input.kind === 'extra') && !(hasStart && hasEnd)) {
    throw new Error('BLOCK/EXTRA overrides require both start_time and end_time');
  }
  if (hasStart !== hasEnd) {
    throw new Error('start_time and end_time must be supplied together');
  }
  if (hasStart && hasEnd) {
    if (!HHMM_RE.test(input.start_time as string) || !HHMM_RE.test(input.end_time as string)) {
      throw new Error('start_time and end_time must be HH:MM (24h)');
    }
    const sMin = toMinutes(input.start_time as string);
    const eMin = toMinutes(input.end_time as string);
    if (eMin <= sMin) {
      throw new Error('end_time must be after start_time');
    }
    return { date_ok: true, minutes: { start: sMin, end: eMin } };
  }
  return { date_ok: true, minutes: { start: null, end: null } };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((s) => parseInt(s, 10));
  return h * 60 + m;
}
