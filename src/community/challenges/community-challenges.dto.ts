import {
  IsBoolean,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { z } from 'zod';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// ── Request DTOs ────────────────────────────────────────────────────────────

/** POST /community/workspaces/:workspaceId/challenges — coach creates a challenge. */
export class CreateChallengeDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'challenge title must not be empty' })
  @MaxLength(160, { message: 'challenge title must be 160 characters or fewer' })
  title!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(4000, { message: 'challenge description must be 4000 characters or fewer' })
  description?: string;

  /**
   * Optional cohort scope. When set the challenge is visible only to that
   * cohort's active members (local + winnable competition, design §3.2). When
   * null the challenge is workspace-wide.
   */
  @IsOptional()
  @IsUUID('4', { message: 'cohort_id must be a valid id' })
  cohort_id?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'starts_at must be an ISO-8601 timestamp' })
  starts_at?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'ends_at must be an ISO-8601 timestamp' })
  ends_at?: string;

  /** Competence metric key (e.g. "steps", "sessions") — what skill the challenge grows. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80, { message: 'metric_key must be 80 characters or fewer' })
  metric_key?: string;

  /** Personal target value each participant works toward (own goal first, design §3.7). */
  @IsOptional()
  @IsNumber({}, { message: 'target_value must be a number' })
  @Min(0, { message: 'target_value must not be negative' })
  target_value?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40, { message: 'unit must be 40 characters or fewer' })
  unit?: string;

  /**
   * Leaderboard is STRICTLY opt-in and OFF by default (product §2.7). Even when
   * a coach enables it, an individual participant's row is shown only after they
   * personally opt in (no public-failure surface, design §3.4).
   */
  @IsOptional()
  @IsBoolean({ message: 'leaderboard_enabled must be a boolean' })
  leaderboard_enabled?: boolean;
}

/** PATCH /community/challenges/:challengeId — coach edits an owned challenge. */
export class EditChallengeDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'challenge title must not be empty' })
  @MaxLength(160, { message: 'challenge title must be 160 characters or fewer' })
  title?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(4000, { message: 'challenge description must be 4000 characters or fewer' })
  description?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'starts_at must be an ISO-8601 timestamp' })
  starts_at?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'ends_at must be an ISO-8601 timestamp' })
  ends_at?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80, { message: 'metric_key must be 80 characters or fewer' })
  metric_key?: string;

  @IsOptional()
  @IsNumber({}, { message: 'target_value must be a number' })
  @Min(0, { message: 'target_value must not be negative' })
  target_value?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40, { message: 'unit must be 40 characters or fewer' })
  unit?: string;

  @IsOptional()
  @IsBoolean({ message: 'leaderboard_enabled must be a boolean' })
  leaderboard_enabled?: boolean;
}

/** PUT /community/challenges/:challengeId/progress — participant logs progress. */
export class UpdateProgressDto {
  /**
   * The participant's cumulative progress toward their own target. Progress is
   * monotonic at the service layer (never decremented), so a slow day can never
   * reduce a visible number — there is no streak to break and no shame state.
   */
  @IsNumber({}, { message: 'progress_value must be a number' })
  @Min(0, { message: 'progress_value must not be negative' })
  progress_value!: number;
}

/** PUT /community/challenges/:challengeId/leaderboard-opt-in — participant opt-in toggle. */
export class LeaderboardOptInDto {
  @IsBoolean({ message: 'opted_in must be a boolean' })
  opted_in!: boolean;
}

/** POST /community/challenges/:challengeId/comments — encouragement comment. */
export class CreateChallengeCommentDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'comment body must not be empty' })
  @MaxLength(2000, { message: 'comment body must be 2000 characters or fewer' })
  body!: string;
}

export class ListChallengesQueryDto {
  @IsOptional()
  @IsUUID('4')
  cohort_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  status?: string;
}

// ── Response schemas (Zod) ──────────────────────────────────────────────────

export const ChallengeSchema = z
  .object({
    id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    cohort_id: z.string().uuid().nullable(),
    created_by_user_id: z.string().uuid(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(['draft', 'active', 'completed', 'archived']),
    starts_at: z.string().datetime().nullable(),
    ends_at: z.string().datetime().nullable(),
    metric_key: z.string().nullable(),
    target_value: z.number().nullable(),
    unit: z.string().nullable(),
    leaderboard_enabled: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    archived: z.boolean(),
  })
  .strict();
export type ChallengeView = z.infer<typeof ChallengeSchema>;

/**
 * The caller's OWN participation. Presented before any ranking: progress vs the
 * participant's own target is the primary competence signal (design §3.7), and
 * `completed` is a positive closure state — never a failure flag.
 */
export const ParticipationSchema = z
  .object({
    challenge_id: z.string().uuid(),
    user_id: z.string().uuid(),
    progress_value: z.number(),
    target_value: z.number().nullable(),
    /** 0..1 fraction toward own target; null when the challenge has no target. */
    progress_fraction: z.number().nullable(),
    completed: z.boolean(),
    completed_at: z.string().datetime().nullable(),
    last_logged_at: z.string().datetime().nullable(),
    leaderboard_opted_in: z.boolean(),
  })
  .strict();
export type ParticipationView = z.infer<typeof ParticipationSchema>;

export const ChallengeResponseSchema = z
  .object({
    challenge: ChallengeSchema,
    /** The caller's participation when joined; null when not joined. */
    participation: ParticipationSchema.nullable(),
  })
  .strict();
export type ChallengeResponse = z.infer<typeof ChallengeResponseSchema>;

export const ChallengeListResponseSchema = z
  .object({ challenges: z.array(ChallengeSchema) })
  .strict();
export type ChallengeListResponse = z.infer<typeof ChallengeListResponseSchema>;

export const ParticipationResponseSchema = z
  .object({ participation: ParticipationSchema })
  .strict();
export type ParticipationResponse = z.infer<typeof ParticipationResponseSchema>;

/**
 * A single leaderboard row. Display name is intentionally absent here — the
 * service returns opaque user ids and the rank; the mobile layer renders only
 * cohort-local rows and never a global ranking (local + winnable, design §3.2).
 */
export const LeaderboardRowSchema = z
  .object({
    user_id: z.string().uuid(),
    rank: z.number().int().positive(),
    progress_value: z.number(),
    is_self: z.boolean(),
  })
  .strict();
export type LeaderboardRowView = z.infer<typeof LeaderboardRowSchema>;

/**
 * Leaderboard envelope. `available` is false (and rows empty) whenever the coach
 * has not enabled it OR the caller has not personally opted in — the caller can
 * always see their own progress without ever appearing in, or seeing, a ranking.
 */
export const LeaderboardResponseSchema = z
  .object({
    available: z.boolean(),
    opted_in: z.boolean(),
    rows: z.array(LeaderboardRowSchema),
  })
  .strict();
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;

export const ChallengeCommentSchema = z
  .object({
    id: z.string().uuid(),
    challenge_id: z.string().uuid(),
    author_user_id: z.string().uuid(),
    body: z.string(),
    created_at: z.string().datetime(),
  })
  .strict();
export type ChallengeCommentView = z.infer<typeof ChallengeCommentSchema>;

export const ChallengeCommentResponseSchema = z
  .object({ comment: ChallengeCommentSchema })
  .strict();
export type ChallengeCommentResponse = z.infer<
  typeof ChallengeCommentResponseSchema
>;

export const ChallengeCommentListResponseSchema = z
  .object({ comments: z.array(ChallengeCommentSchema) })
  .strict();
export type ChallengeCommentListResponse = z.infer<
  typeof ChallengeCommentListResponseSchema
>;
