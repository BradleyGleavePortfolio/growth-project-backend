import {
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { z } from 'zod';

/**
 * coach-exercise.dto.ts — request/response shapes for the coach custom-exercise
 * library. class-validator DTOs guard the inbound write/upload bodies (global
 * forbidNonWhitelisted: true rejects unknown fields); zod schemas validate the
 * outbound view so a shape drift is a runtime parse error, not a silent leak.
 *
 * The server is authoritative on every limit: the mime allowlist, the size cap,
 * and the name/instructions length caps are enforced HERE and re-asserted in the
 * service — the client is never trusted on either hop.
 */

// ─── Server thresholds (brief §contract) ────────────────────────────────────

/** Max custom-exercise name length. */
export const MAX_NAME_LENGTH = 120;
/** Max written-instructions length. */
export const MAX_INSTRUCTIONS_LENGTH = 2000;
/** Max media payload size — 50 MB. */
export const MAX_MEDIA_BYTES = 50_000_000;

/**
 * The allowed media MIME types (brief §mime allowlist). A type outside this set
 * is rejected before any signed URL is minted. Images cover the common
 * coach-photo formats; videos cover the iOS (quicktime) + cross-platform (mp4)
 * recorder outputs.
 */
export const COACH_EXERCISE_MIME_ALLOWLIST = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
] as const;
export type CoachExerciseMimeType =
  (typeof COACH_EXERCISE_MIME_ALLOWLIST)[number];

/** Mutable copy for class-validator's @IsIn — derived from the tuple, no cast. */
export const COACH_EXERCISE_MIME_VALUES: string[] = [
  ...COACH_EXERCISE_MIME_ALLOWLIST,
];

/** The media-kind discriminator the create body carries. */
export const COACH_EXERCISE_MEDIA_KINDS = ['image', 'video', 'none'] as const;
export type CoachExerciseMediaKind =
  (typeof COACH_EXERCISE_MEDIA_KINDS)[number];
export const COACH_EXERCISE_MEDIA_KIND_VALUES: string[] = [
  ...COACH_EXERCISE_MEDIA_KINDS,
];

const toInt = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : value;
  }
  return value;
};

// ─── Request DTOs ───────────────────────────────────────────────────────────

/**
 * Body for POST /coach-exercises/media/upload-url — presign a media upload. The
 * server validates size + mime BEFORE minting the URL so a URL is never issued
 * for a payload that would be rejected at create time.
 */
export class IssueMediaUploadDto {
  @IsInt()
  @Min(1)
  @Max(MAX_MEDIA_BYTES)
  @Transform(toInt)
  bytes!: number;

  @IsIn(COACH_EXERCISE_MIME_VALUES)
  mime_type!: CoachExerciseMimeType;
}

/**
 * Body for POST /coach-exercises — durably record a custom exercise AFTER its
 * media upload (if any) is confirmed. When media_kind='none' the move is
 * instructions-only and storage_key/media_mime must be omitted. When
 * media_kind is 'image'/'video', storage_key (the key minted by upload-url) and
 * media_mime are required; the service re-asserts the owner namespace prefix and
 * the mime allowlist so a forged key or spoofed type is rejected.
 */
export class CreateCoachExerciseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_NAME_LENGTH)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_INSTRUCTIONS_LENGTH)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  instructions!: string;

  @IsIn(COACH_EXERCISE_MEDIA_KIND_VALUES)
  media_kind!: CoachExerciseMediaKind;

  // Required (and asserted in the service) only when media_kind != 'none'. The
  // storage key returned by upload-url; the service re-derives + re-asserts the
  // owner namespace prefix so a forged key is rejected (bucket-binding).
  @ValidateIf((o: CreateCoachExerciseDto) => o.media_kind !== 'none')
  @IsString()
  @MaxLength(512)
  storage_key?: string;

  @ValidateIf((o: CreateCoachExerciseDto) => o.media_kind !== 'none')
  @IsIn(COACH_EXERCISE_MIME_VALUES)
  media_mime?: CoachExerciseMimeType;
}

// ─── Response schemas (zod, strict) ─────────────────────────────────────────

export const MediaUploadTargetSchema = z
  .object({
    upload_url: z.string(),
    storage_key: z.string(),
    expires_at: z.string(),
    expires_in_seconds: z.number().int(),
    bucket: z.string(),
  })
  .strict();
export type MediaUploadTarget = z.infer<typeof MediaUploadTargetSchema>;

export const CoachExerciseViewSchema = z
  .object({
    id: z.string(),
    coach_id: z.string(),
    name: z.string(),
    instructions: z.string(),
    media_kind: z.enum(COACH_EXERCISE_MEDIA_KINDS),
    // Time-limited signed download URL minted at read time, or null when the
    // move is instructions-only or storage is unconfigured (client renders a
    // disabled media state, not a 500).
    media_url: z.string().nullable(),
    media_mime: z.string().nullable(),
    created_at: z.string(),
    archived_at: z.string().nullable(),
  })
  .strict();
export type CoachExerciseView = z.infer<typeof CoachExerciseViewSchema>;

export const CoachExerciseResponseSchema = z
  .object({ coach_exercise: CoachExerciseViewSchema })
  .strict();
export type CoachExerciseResponse = z.infer<typeof CoachExerciseResponseSchema>;

export const CoachExerciseListResponseSchema = z
  .object({ coach_exercises: z.array(CoachExerciseViewSchema) })
  .strict();
export type CoachExerciseListResponse = z.infer<
  typeof CoachExerciseListResponseSchema
>;
