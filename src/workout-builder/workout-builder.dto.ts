/**
 * DTOs for the Workout Builder module.
 * Covers WorkoutPlan CRUD, WorkoutPlanExercise rows, and ClientWorkoutAssignment.
 */

import {
  IsString,
  IsEnum,
  IsInt,
  IsOptional,
  IsNumber,
  Min,
  Max,
  IsDateString,
  IsNotEmpty,
  MaxLength,
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

// ─── ClientWorkoutAssignment ──────────────────────────────────────────────────

export class CreateAssignmentDto {
  @IsString()
  @IsNotEmpty()
  client_id!: string;

  @IsDateString()
  scheduled_for!: string;
}

export class CompleteAssignmentDto {
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
