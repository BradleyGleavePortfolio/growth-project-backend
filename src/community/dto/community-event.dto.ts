import {
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { z } from 'zod';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// Lifecycle states + RSVP statuses, mirrored from the Prisma enums so the DTO
// layer has a single literal source the Zod response schemas reuse.
export const EVENT_STATES = [
  'scheduled',
  'tomorrow',
  'live',
  'replay',
  'reflected',
] as const;

export const RSVP_STATUSES = [
  'going',
  'maybe',
  'declined',
  'attended',
  'missed',
] as const;

// RSVP statuses a CLIENT may set on themselves. attended/missed are
// system/coach-derived attendance outcomes, never self-asserted.
export const CLIENT_RSVP_STATUSES = ['going', 'maybe', 'declined'] as const;

// ── Request DTOs ────────────────────────────────────────────────────────────

/** POST /community/workspaces/:workspaceId/events — coach creates an event. */
export class CreateEventDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'event title must not be empty' })
  @MaxLength(160, { message: 'event title must be 160 characters or fewer' })
  title!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20000, {
    message: 'event description must be 20000 characters or fewer',
  })
  description?: string;

  @IsISO8601(
    { strict: true },
    { message: 'starts_at must be an ISO-8601 timestamp' },
  )
  starts_at!: string;

  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'ends_at must be an ISO-8601 timestamp' },
  )
  ends_at?: string;

  /** Optional cohort scope; omitted = workspace-wide event. */
  @IsOptional()
  @IsUUID('4', { message: 'cohort_id must be a UUID' })
  cohort_id?: string;

  /** Optional external live link (validated against the host allowlist). */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2048, { message: 'live_url must be 2048 characters or fewer' })
  live_url?: string;
}

/** PATCH /community/events/:eventId — coach edits fields and/or advances state. */
export class UpdateEventDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'event title must not be empty' })
  @MaxLength(160, { message: 'event title must be 160 characters or fewer' })
  title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(20000, {
    message: 'event description must be 20000 characters or fewer',
  })
  description?: string;

  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'starts_at must be an ISO-8601 timestamp' },
  )
  starts_at?: string;

  @IsOptional()
  @IsISO8601(
    { strict: true },
    { message: 'ends_at must be an ISO-8601 timestamp' },
  )
  ends_at?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2048, { message: 'live_url must be 2048 characters or fewer' })
  live_url?: string;

  /** Forward-only lifecycle advance; validated by the state machine. */
  @IsOptional()
  @IsString()
  state?: string;
}

/** POST /community/events/:eventId/rsvp — client sets/updates own RSVP. */
export class RsvpEventDto {
  @IsString()
  status!: string;
}

/** POST /community/events/:eventId/replay — coach attaches external replay. */
export class AttachReplayDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'replay_url must not be empty' })
  @MaxLength(2048, { message: 'replay_url must be 2048 characters or fewer' })
  replay_url!: string;
}

/** POST /community/events/:eventId/reflect — coach posts recap/reflection. */
export class ReflectEventDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000, {
    message: 'reflection summary must be 2000 characters or fewer',
  })
  summary?: string;
}

export class ListEventsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  state?: string;

  @IsOptional()
  @IsUUID('4')
  cohort_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  limit?: string;
}

// ── Response schemas (Zod, strict) ──────────────────────────────────────────

export const CommunityEventSchema = z
  .object({
    id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    cohort_id: z.string().uuid().nullable(),
    created_by_user_id: z.string().uuid(),
    title: z.string(),
    description: z.string().nullable(),
    state: z.enum(EVENT_STATES),
    starts_at: z.string().datetime(),
    ends_at: z.string().datetime().nullable(),
    /** External live OR replay link (no native room exists — Step 0). */
    external_url: z.string().nullable(),
    reflected_at: z.string().datetime().nullable(),
    canceled: z.boolean(),
    rsvp_counts: z
      .object({
        going: z.number().int().nonnegative(),
        maybe: z.number().int().nonnegative(),
        declined: z.number().int().nonnegative(),
        attended: z.number().int().nonnegative(),
        missed: z.number().int().nonnegative(),
      })
      .strict(),
    /** The caller's own RSVP status, or null when they have not responded. */
    viewer_rsvp_status: z.enum(RSVP_STATUSES).nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export type CommunityEventView = z.infer<typeof CommunityEventSchema>;

export const CommunityEventResponseSchema = z
  .object({ event: CommunityEventSchema })
  .strict();
export type CommunityEventResponse = z.infer<
  typeof CommunityEventResponseSchema
>;

export const CommunityEventListResponseSchema = z
  .object({
    events: z.array(CommunityEventSchema),
    next_before: z.string().nullable(),
  })
  .strict();
export type CommunityEventListResponse = z.infer<
  typeof CommunityEventListResponseSchema
>;

export const CommunityRsvpView = z
  .object({
    event_id: z.string().uuid(),
    user_id: z.string().uuid(),
    status: z.enum(RSVP_STATUSES),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const CommunityRsvpResponseSchema = z
  .object({ rsvp: CommunityRsvpView })
  .strict();
export type CommunityRsvpResponse = z.infer<typeof CommunityRsvpResponseSchema>;
