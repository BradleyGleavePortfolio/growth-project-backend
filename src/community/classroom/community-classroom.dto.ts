import {
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
import { Transform, Type } from 'class-transformer';
import { z } from 'zod';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Defensive page size for the classroom feed read. The mobile client sends an
 * explicit `limit`, but the DTO is the authoritative clamp so a hand-crafted
 * request (or an older client) can never ask the database for an unbounded
 * result set (D-040 / Failure #28 unbounded read).
 */
export const CLASSROOM_PAGE_DEFAULT_LIMIT = 20;
export const CLASSROOM_PAGE_MAX_LIMIT = 50;

/** The four media kinds a lesson asset may be. Mirrors the storage caps below. */
export const CLASSROOM_MEDIA_KINDS = ['video', 'audio', 'pdf', 'image'] as const;
export type ClassroomMediaKind = (typeof CLASSROOM_MEDIA_KINDS)[number];

/**
 * Maximum body length for a lesson. The Prisma column is `Text` (unbounded at
 * the DB), so the DTO is the only place this is capped — a missing cap would be
 * an unbounded write (Failure #28).
 */
export const CLASSROOM_BODY_MAX_LENGTH = 20_000;

/** Maximum title length — mirrors the Prisma `@db.VarChar(200)` column. */
export const CLASSROOM_TITLE_MAX_LENGTH = 200;

/**
 * Per-kind upload size caps enforced SERVER-SIDE before a signed upload URL is
 * minted (brief thresholds). A client that lies about `bytes` still cannot
 * exceed the bucket policy, but we reject obviously-oversized requests up front
 * so we never hand out a URL for an upload we will refuse. Bytes, not MB, to
 * avoid a float multiply at the call site.
 */
export const CLASSROOM_MEDIA_MAX_BYTES: Record<ClassroomMediaKind, number> = {
  video: 500 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
  image: 25 * 1024 * 1024,
};

/**
 * Coerce an inbound query-string `limit` to an integer. Query params arrive as
 * strings, so a bare `@IsInt()` would reject the valid `?limit=20`; this parses
 * the string to a number and leaves a non-integer untouched so @IsInt/@Min/@Max
 * reject `abc`, `1.5`, `0`. A missing value stays undefined so the
 * `?? CLASSROOM_PAGE_DEFAULT_LIMIT` default applies downstream.
 */
const toIntLimit = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return value;
    return Number(trimmed);
  }
  return value;
};

// ── Request DTOs ────────────────────────────────────────────────────────────

/** One media asset declared at lesson-create / media-attach time. */
export class ClassroomMediaInputDto {
  @IsIn(CLASSROOM_MEDIA_KINDS, {
    message: `kind must be one of ${CLASSROOM_MEDIA_KINDS.join(', ')}`,
  })
  kind!: ClassroomMediaKind;

  /**
   * Declared upload size in bytes. Required so the server can enforce the
   * per-kind cap BEFORE minting a signed upload URL — a request over the cap is
   * rejected up front rather than discovered after the object lands.
   */
  @IsInt({ message: 'bytes must be an integer' })
  @Min(1, { message: 'bytes must be at least 1' })
  bytes!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120, { message: 'mime_type must be 120 characters or fewer' })
  mime_type?: string;

  @IsOptional()
  @IsInt({ message: 'duration_sec must be an integer' })
  @Min(0, { message: 'duration_sec must not be negative' })
  duration_sec?: number;

  @IsOptional()
  @IsInt({ message: 'width must be an integer' })
  @Min(0, { message: 'width must not be negative' })
  width?: number;

  @IsOptional()
  @IsInt({ message: 'height must be an integer' })
  @Min(0, { message: 'height must not be negative' })
  height?: number;
}

/** POST /community/workspaces/:workspaceId/classroom — coach creates a lesson. */
export class CreateClassroomPostDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'lesson title must not be empty' })
  @MaxLength(CLASSROOM_TITLE_MAX_LENGTH, {
    message: `lesson title must be ${CLASSROOM_TITLE_MAX_LENGTH} characters or fewer`,
  })
  title!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(CLASSROOM_BODY_MAX_LENGTH, {
    message: `lesson body must be ${CLASSROOM_BODY_MAX_LENGTH} characters or fewer`,
  })
  body_markdown!: string;

  /**
   * Optional cohort scope. When set the lesson is visible only to that cohort's
   * active members; when null the lesson is workspace-wide.
   */
  @IsOptional()
  @IsUUID('4', { message: 'cohort_id must be a valid id' })
  cohort_id?: string;

  /**
   * Release-lock timestamp. When set in the future the lesson is published in a
   * `scheduled` state and stays invisible to students until `release_at` passes
   * (the release-time-lock guarantee). When omitted, a published lesson is
   * immediately visible.
   */
  @IsOptional()
  @IsISO8601({}, { message: 'release_at must be an ISO-8601 timestamp' })
  release_at?: string;

  @IsOptional()
  @IsBoolean({ message: 'pinned must be a boolean' })
  pinned?: boolean;

  @IsOptional()
  @IsInt({ message: 'pinned_order must be an integer' })
  @Min(0, { message: 'pinned_order must not be negative' })
  pinned_order?: number;

  /**
   * Media declared with the lesson. Each entry yields one signed upload URL in
   * the create response; the asset row is persisted in the SAME transaction as
   * the post so a partial write can never leave an orphaned post or asset.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClassroomMediaInputDto)
  media?: ClassroomMediaInputDto[];
}

/** PATCH /community/classroom/:postId — coach edits an owned lesson. */
export class UpdateClassroomPostDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'lesson title must not be empty' })
  @MaxLength(CLASSROOM_TITLE_MAX_LENGTH, {
    message: `lesson title must be ${CLASSROOM_TITLE_MAX_LENGTH} characters or fewer`,
  })
  title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(CLASSROOM_BODY_MAX_LENGTH, {
    message: `lesson body must be ${CLASSROOM_BODY_MAX_LENGTH} characters or fewer`,
  })
  body_markdown?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'release_at must be an ISO-8601 timestamp' })
  release_at?: string;

  @IsOptional()
  @IsBoolean({ message: 'pinned must be a boolean' })
  pinned?: boolean;

  @IsOptional()
  @IsInt({ message: 'pinned_order must be an integer' })
  @Min(0, { message: 'pinned_order must not be negative' })
  pinned_order?: number;
}

/** POST /community/classroom/:postId/media — coach attaches more media. */
export class AttachClassroomMediaDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClassroomMediaInputDto)
  media!: ClassroomMediaInputDto[];
}

/** POST /community/classroom/:postId/publish — coach publishes a lesson. */
export class PublishClassroomPostDto {
  /**
   * Optional override release time at publish. When set in the future the
   * lesson publishes as `scheduled`; when omitted or in the past it publishes
   * immediately visible. Kept separate from the create DTO so a coach can draft
   * then schedule in two steps.
   */
  @IsOptional()
  @IsISO8601({}, { message: 'release_at must be an ISO-8601 timestamp' })
  release_at?: string;
}

/** Shared cursor/limit page controls for the classroom feed read (D-040). */
export class ListClassroomQueryDto {
  @IsOptional()
  @Transform(toIntLimit)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1, { message: 'limit must be at least 1' })
  @Max(CLASSROOM_PAGE_MAX_LIMIT, {
    message: `limit must be ${CLASSROOM_PAGE_MAX_LIMIT} or fewer`,
  })
  limit?: number;

  @IsOptional()
  @Transform(trim)
  @IsUUID('4', { message: 'cursor must be a valid id' })
  cursor?: string;

  @IsOptional()
  @IsUUID('4', { message: 'cohort_id must be a valid id' })
  cohort_id?: string;
}

// ── Response schemas (Zod) ──────────────────────────────────────────────────

export const ClassroomMediaSchema = z
  .object({
    id: z.guid(),
    post_id: z.guid(),
    kind: z.enum(CLASSROOM_MEDIA_KINDS),
    /**
     * Time-limited signed GET URL for the object. Minted at read time, never a
     * public/permanent URL (paid content). Null when signing is unavailable
     * (storage not configured) so the client degrades to a disabled tile rather
     * than a broken link.
     */
    url: z.string().nullable(),
    duration_sec: z.number().int().nullable(),
    bytes: z.number().int().nullable(),
    mime_type: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    created_at: z.string().datetime(),
  })
  .strict();
export type ClassroomMediaView = z.infer<typeof ClassroomMediaSchema>;

export const ClassroomPostSchema = z
  .object({
    id: z.guid(),
    workspace_id: z.guid(),
    cohort_id: z.guid().nullable(),
    coach_id: z.guid(),
    title: z.string(),
    body_markdown: z.string(),
    status: z.enum(['draft', 'scheduled', 'published', 'archived']),
    pinned: z.boolean(),
    pinned_order: z.number().int().nullable(),
    release_at: z.string().datetime().nullable(),
    /**
     * True when the lesson is published but its release_at is still in the
     * future — the client renders a LessonReleaseLockBadge and suppresses media
     * playback. Derived server-side so the client never has to compare clocks.
     */
    release_locked: z.boolean(),
    published_at: z.string().datetime().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    media: z.array(ClassroomMediaSchema),
  })
  .strict();
export type ClassroomPostView = z.infer<typeof ClassroomPostSchema>;

/**
 * A single signed upload URL paired with the media-asset id it was minted for.
 * Returned only on create/attach so the coach client can PUT each file; never
 * returned on a feed read (read returns download URLs via `media[].url`).
 */
export const ClassroomUploadTargetSchema = z
  .object({
    media_id: z.guid(),
    kind: z.enum(CLASSROOM_MEDIA_KINDS),
    upload_url: z.string(),
    storage_key: z.string(),
    /** Seconds the upload URL stays valid (the configured signing TTL). */
    expires_in_seconds: z.number().int().positive(),
  })
  .strict();
export type ClassroomUploadTarget = z.infer<typeof ClassroomUploadTargetSchema>;

export const ClassroomPostResponseSchema = z
  .object({
    post: ClassroomPostSchema,
    /**
     * Upload targets for media declared on create. Empty on edits/reads. The
     * client uploads each file to its `upload_url`, then the object is readable
     * via the post's `media[].url` on the next feed fetch.
     */
    upload_targets: z.array(ClassroomUploadTargetSchema),
  })
  .strict();
export type ClassroomPostResponse = z.infer<typeof ClassroomPostResponseSchema>;

export const ClassroomFeedResponseSchema = z
  .object({
    posts: z.array(ClassroomPostSchema),
    /** Page cursor (D-040): id of the last lesson when more remain, else null. */
    next_cursor: z.guid().nullable(),
  })
  .strict();
export type ClassroomFeedResponse = z.infer<typeof ClassroomFeedResponseSchema>;
