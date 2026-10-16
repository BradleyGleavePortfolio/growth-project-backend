import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsDateString,
  MaxLength,
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { HabitScheduleKind } from '@prisma/client';

// Optional, but never null: for columns that always hold a value.
const Present = () => ValidateIf((_, value) => value !== undefined);

// HB1: how the habit is planned and reminded. Set with POST, changed with PATCH.
class HabitPlanDto {
  @Present()
  @IsEnum(HabitScheduleKind)
  schedule_kind?: HabitScheduleKind;

  // 0 = Sunday ... 6 = Saturday.
  @Present()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  schedule_days?: number[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  times_per_week?: number | null;

  @Present()
  @IsBoolean()
  reminder_enabled?: boolean;

  // Local time, "HH:mm".
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  reminder_time?: string | null;

  @IsOptional()
  @IsDateString()
  starts_on?: string | null;
}

// SECURITY: allow-list DTOs for habit writes. Previously both endpoints took
// `@Body() body: any`. Create would spread into prisma.habit.create, letting a
// client set `user_id` to another account. See audit C4.
export class CreateHabitDto extends HabitPlanDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsNumber()
  target_value?: number;

  // Mobile client sends `target_count` (historically), service coerces both.
  @IsOptional()
  @IsNumber()
  target_count?: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string;
}

// PATCH /habits/:id. Who set the habit and the coach's note are never the
// client's to send; on a habit the coach set, only REMINDER_FIELDS may change.
export class UpdateHabitDto extends HabitPlanDto {
  @Present()
  @IsString()
  @MaxLength(120)
  name?: string;

  @Present()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsNumber()
  target_value?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string | null;

  @Present()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

export const REMINDER_FIELDS: readonly string[] = ['reminder_enabled', 'reminder_time'];

export class LogHabitDto {
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @IsOptional()
  @IsNumber()
  value?: number;
}
