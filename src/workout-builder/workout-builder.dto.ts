/**
 * DTOs for the Workout Builder module.
 * Covers WorkoutPlan CRUD, WorkoutPlanExercise rows, and
 * ClientWorkoutAssignment (assign + complete).
 */

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import { IsTimeOfDay } from '../common/validators/time-of-day';

// ─── Enums (mirror Prisma) ────────────────────────────────────────────────────

export enum WorkoutType {
  strength = 'strength',
  cardio = 'cardio',
  mobility = 'mobility',
}

// ─── WorkoutPlan ──────────────────────────────────────────────────────────────

export class CreateWorkoutPlanDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsEnum(WorkoutType)
  type!: WorkoutType;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  duration_estimate_minutes?: number;
}

export class UpdateWorkoutPlanDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEnum(WorkoutType)
  type?: WorkoutType;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  duration_estimate_minutes?: number;
}

// ─── WorkoutPlanExercise ──────────────────────────────────────────────────────

export class UpsertExerciseRowDto {
  /** ExerciseDB external catalog id. */
  @IsString()
  @IsNotEmpty()
  exercise_external_id!: string;

  /** Display order within the plan (1-indexed). */
  @IsInt()
  @Min(1)
  order!: number;

  @IsInt()
  @Min(1)
  @Max(100)
  sets!: number;

  /**
   * Either a rep count (e.g. 12) or a duration in seconds (e.g. 60).
   * Column name intentionally generic to support both.
   */
  @IsInt()
  @Min(1)
  reps_or_duration_seconds!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  weight_lbs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  rest_seconds?: number;

  /**
   * Exercises sharing the same superset_group_id are performed back-to-back
   * before rest. Null = no superset.
   */
  @IsOptional()
  @IsString()
  superset_group_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** C1V2-C1: the coach's chosen swaps, first choice first; ids as exercise_external_id takes them (an /exercises id or a seed: id). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(200, { each: true })
  alternative_external_ids?: string[];
}

// Wrapper so class-validator actually validates each row in the array.
// Without ValidateNested + Type, the @Body() parameter binds an untyped
// array and per-element decorators are skipped.
export class UpsertExerciseRowsDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => UpsertExerciseRowDto)
  rows!: UpsertExerciseRowDto[];
}

// ─── ClientWorkoutAssignment ──────────────────────────────────────────────────

export class CreateAssignmentDto {
  @IsString()
  @IsNotEmpty()
  client_id!: string;

  @IsDateString()
  scheduled_for!: string;

  /** C2-C0: the coach's planned training time that day, "HH:MM"; absent = no time. */
  @IsOptional()
  @IsTimeOfDay()
  scheduled_time?: string | null;
}

// MWB-1 (§3.4): program-level assignment fan-out. Assigns every plan
// ("day") in a WorkoutProgram to one client, scheduling each plan by its
// (week_index, day_index) offset from start_date. A single idempotency key
// (header) covers the whole fan-out.
export class AssignProgramDto {
  @IsString()
  @IsNotEmpty()
  client_id!: string;

  /** Anchor date for week 0 / day 0. Each plan is scheduled relative to it. */
  @IsDateString()
  start_date!: string;

  /** C2-C0: one planned training time, "HH:MM", for every day of the program; absent = no time. */
  @IsOptional()
  @IsTimeOfDay()
  scheduled_time?: string | null;
}

// ─── MWB-2: clone-to-client (FEATURE_MWB_TEMPLATES) ───────────────────────────

/**
 * MWB-2 (§3.3) request body for POST /workout-programs/:programId/clone-to-client.
 * The acting coach clones a master template program (the path param) onto a
 * specific client by value. The body carries only the target client; the
 * source program id is the route param and the acting coach is the JWT subject,
 * so neither is trusted from the body. `client_id` must be a UUID (R68: every
 * DTO field is typed and validated).
 */
export class CloneProgramToClientDto {
  /** Target client the master is cloned onto. Must be a UUID. */
  @IsUUID('all')
  @IsNotEmpty()
  client_id!: string;
}

/**
 * MWB-2 (§3.3) typed result of a clone-to-client. Returns the new program id
 * and the ids of every cloned plan (in week/day order) plus the fresh
 * program-level revision id the clone now points at via head_revision_id. The
 * shape is explicit (no `unknown`/`any`) so OpenAPI regenerates a stable
 * contract and callers can act on the result without re-fetching.
 */
export class CloneProgramResultDto {
  /** Id of the newly created (non-template) program owned by the coach. */
  program_id!: string;

  /** Source master program this clone was taken from (echoed for provenance). */
  cloned_from_id!: string;

  /** Always false on a clone — the brief's Decision A invariant. */
  is_template!: boolean;

  /** Fresh program-level revision the clone starts from (its "v1" anchor). */
  head_revision_id!: string;

  /** Ids of every cloned plan, in (week_index, day_index) order. */
  plan_ids!: string[];
}

// Mobile sends idempotency_key, started_at, and completion_payload on
// PATCH /assignments/:id/complete. Server stores all three and uses
// idempotency_key for per-assignment dedup (unique partial index in
// migration 20260508000003 makes a duplicate complete a no-op at the DB
// layer; the service short-circuits earlier to return the original row).
export class CompleteAssignmentDto {
  /**
   * Client-generated UUID. Required for retry-safety on flaky
   * connections. Accepted in any standard version (v1–v5); the mobile
   * client uses v4, but we don't force a specific version so older app
   * builds keep working.
   */
  @IsUUID('all')
  @IsNotEmpty()
  idempotency_key!: string;

  /** ISO 8601 timestamp when the client started the workout. */
  @IsOptional()
  @IsISO8601()
  started_at?: string;

  /**
   * Free-form completion payload (per-set logs, RPE per exercise, etc).
   * Schema kept open at this layer so the mobile app can evolve the
   * shape without coordinated backend deploys. Stored as Jsonb.
   * C1V2-C1: when `exercises` is sent it is a list, and each exercise's
   * `swap_reason` (why they swapped) and `skip_note` (why they skipped), when
   * set, are text of at most 500 characters. Older payloads read as before.
   */
  @IsOptional()
  @IsObject()
  @ValidateBy({
    name: 'completionPayloadShape',
    validator: {
      validate: completionPayloadShapeOk,
      defaultMessage: () => 'completion_payload.exercises must be a list; swap_reason and skip_note are text of at most 500 characters',
    },
  })
  completion_payload?: Record<string, unknown>;

  /** RPE (Rating of Perceived Exertion) 1–10. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  post_rpe?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  post_notes?: string;
}

/** Longest coach or client note on a workout day (client_note, client_reason, swap_reason, skip_note). */
export const COACH_TEXT_MAX = 500;

/** C1V2-C1: the agreed completion_payload.exercises[] fields (see CompleteAssignmentDto). */
export function completionPayloadShapeOk(payload: unknown): boolean {
  const list = (payload as { exercises?: unknown } | null)?.exercises;
  if (list == null) return true;
  return Array.isArray(list) && list.every((e) => ['swap_reason', 'skip_note'].every((k) => {
    const v = (e as Record<string, unknown> | null)?.[k];
    return v == null || (typeof v === 'string' && v.length <= COACH_TEXT_MAX);
  }));
}

/**
 * C1V2-C1: PATCH /assignments/:assignmentId, exactly one field. The client
 * moves (scheduled_for) or skips (skip: true) their own day; the client's
 * coach writes the day's note to the client (client_note; null or blank
 * clears it) and, C2-C0, the day's planned time (scheduled_time; null clears it).
 */
export class UpdateAssignmentDto {
  @IsOptional()
  @IsDateString()
  scheduled_for?: string;

  @IsOptional()
  @Equals(true)
  skip?: true;

  @IsOptional()
  @IsString()
  @MaxLength(COACH_TEXT_MAX)
  client_note?: string | null;

  @IsOptional()
  @IsTimeOfDay()
  scheduled_time?: string | null;
}
