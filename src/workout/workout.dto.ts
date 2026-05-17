import {
  IsString,
  IsOptional,
  IsNumber,
  IsInt,
  IsIn,
  IsArray,
  ValidateNested,
  IsDateString,
  MaxLength,
  ArrayMaxSize,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

// SECURITY: allow-list DTOs for workout writes. Previous impl accepted
// `@Body() body: any` and spread into Prisma — which (for routines) let a
// client set `creator_id` to another user, claiming ownership of arbitrary
// routines. See audit C4/H10.

const MUSCLE_GROUPS = ['chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'full_body'] as const;
type MuscleGroup = (typeof MUSCLE_GROUPS)[number];
const INTENSITIES = ['light', 'moderate', 'hard', 'max'] as const;
type Intensity = (typeof INTENSITIES)[number];

export class CreateExerciseSetDto {
  @IsString()
  @MaxLength(200)
  exercise_name!: string;

  @IsIn(MUSCLE_GROUPS)
  muscle_group!: MuscleGroup;

  @IsInt()
  @Min(0)
  @Max(100)
  sets_completed!: number;

  @IsArray()
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  reps_per_set!: number[];

  @IsArray()
  @ArrayMaxSize(100)
  @IsNumber({}, { each: true })
  weight_per_set!: number[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  rpe?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  video_url?: string;
}

export class CreateWorkoutDto {
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsString()
  @MaxLength(200)
  workout_name!: string;

  @IsString()
  @MaxLength(100)
  workout_type!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  duration_minutes?: number;

  @IsOptional()
  @IsIn(INTENSITIES)
  intensity?: Intensity;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateExerciseSetDto)
  exercises?: CreateExerciseSetDto[];
}

export class CreateRoutineExerciseDto {
  @IsString()
  @MaxLength(200)
  exercise_name!: string;

  @IsIn(MUSCLE_GROUPS)
  muscle_group!: MuscleGroup;

  @IsInt()
  @Min(0)
  @Max(100)
  default_sets!: number;

  @IsInt()
  @Min(0)
  @Max(1000)
  default_reps!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  default_rest_seconds?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  video_url?: string;

  @IsInt()
  @Min(0)
  order_index!: number;
}

export class CreateRoutineDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  // `is_template` is intentionally NOT writable here — only admins should be
  // able to flip this bit, since is_template=true makes the routine visible to
  // every user via the `{ OR: [...] }` clause in getRoutines. Exposing it here
  // would let a client publish arbitrary routines to the whole platform.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateRoutineExerciseDto)
  exercises?: CreateRoutineExerciseDto[];
}

export class UpdateRoutineDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

// Patch DTO for an already-logged WorkoutSession. Mirrors the create-side
// allow-list — every field is optional, but if present each is bounded the
// same way as CreateWorkoutDto. `exercises` is intentionally replace-all so
// the mobile client can send the corrected canonical list without having to
// reason about per-row id reconciliation. See QA P0-W1.
export class UpdateWorkoutDto {
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  workout_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  workout_type?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  duration_minutes?: number;

  @IsOptional()
  @IsIn(INTENSITIES)
  intensity?: Intensity;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateExerciseSetDto)
  exercises?: CreateExerciseSetDto[];
}
