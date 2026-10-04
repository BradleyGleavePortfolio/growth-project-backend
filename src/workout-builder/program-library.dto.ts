/**
 * S-MWB Programs — request DTOs for the coach program library
 * (`/v1/coach/programs`). class-validator, enforced by the global
 * ValidationPipe (whitelist + forbidNonWhitelisted), like the MWB-1 DTOs.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Weeks a program may span (one training block up to a year). */
export const PROGRAM_MAX_WEEKS = 52;
/** A week has seven day slots; day_index is the day offset within the week. */
export const PROGRAM_DAYS_PER_WEEK_MAX = 7;
/** Clients per bulk-assign request (mobile sends larger rosters in batches). */
export const BULK_ASSIGN_MAX_CLIENTS = 50;
export const PROGRAM_NAME_MAX = 120;
export const PROGRAM_DESCRIPTION_MAX = 2000;
export const PROGRAM_GOAL_TAG_MAX = 40;

const WORKOUT_TYPES = ['strength', 'cardio', 'mobility'] as const;
export type ProgramWorkoutType = (typeof WORKOUT_TYPES)[number];

/** Calendar date, YYYY-MM-DD. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateProgramDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROGRAM_NAME_MAX)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(PROGRAM_DESCRIPTION_MAX)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(PROGRAM_GOAL_TAG_MAX)
  goal_tag?: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROGRAM_MAX_WEEKS)
  weeks!: number;

  /** Training days per week (the target shown on the card; 1-7). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROGRAM_DAYS_PER_WEEK_MAX)
  days_per_week!: number;
}

export class UpdateProgramDto {
  /** Optimistic concurrency: the `version` the coach last saw. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROGRAM_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(PROGRAM_DESCRIPTION_MAX)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(PROGRAM_GOAL_TAG_MAX)
  goal_tag?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROGRAM_MAX_WEEKS)
  weeks?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROGRAM_DAYS_PER_WEEK_MAX)
  days_per_week?: number;
}

/**
 * Fill an empty day slot: a new blank workout, or a copy of a saved workout
 * (a standalone plan from the saved-workouts library) or of another day.
 */
export class SetProgramDayDto {
  @IsIn(['blank', 'saved_workout', 'copy_day'])
  source!: 'blank' | 'saved_workout' | 'copy_day';

  /** blank: the new workout's name (defaults to "Week N, Day M"). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROGRAM_NAME_MAX)
  name?: string;

  /** blank: workout type (default strength). */
  @IsOptional()
  @IsIn(WORKOUT_TYPES)
  type?: ProgramWorkoutType;

  /** saved_workout: the standalone WorkoutPlan id to copy. */
  @IsOptional()
  @IsUUID()
  plan_id?: string;

  /** copy_day: the source slot in the same program. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(PROGRAM_MAX_WEEKS - 1)
  from_week_index?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(PROGRAM_DAYS_PER_WEEK_MAX - 1)
  from_day_index?: number;
}

export class DuplicateProgramDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PROGRAM_NAME_MAX)
  name?: string;
}

export class BulkAssignProgramDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_ASSIGN_MAX_CLIENTS)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  client_ids!: string[];

  /** Calendar date of week 1 / day 1, YYYY-MM-DD (scheduled at 12:00 UTC). */
  @IsString()
  @Matches(DATE_ONLY_RE, { message: 'start_date must be a date in the form YYYY-MM-DD' })
  start_date!: string;

  /** Assign again to clients who already have an active copy of this program. */
  @IsOptional()
  @IsBoolean()
  allow_repeat?: boolean;
}
