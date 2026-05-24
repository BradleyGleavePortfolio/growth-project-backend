/**
 * DTOs for the Workout Builder module.
 * Covers WorkoutPlan CRUD, WorkoutPlanExercise rows, and
 * ClientWorkoutAssignment (assign + complete).
 */

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  ValidateNested,
} from 'class-validator';

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
   */
  @IsOptional()
  @IsObject()
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
