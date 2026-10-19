import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsIn,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsTimeOfDay } from '../common/validators/time-of-day';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Ranges chosen to reject obvious typos while leaving room for
// realistic single-meal entries (a 1500 kcal coach-prescribed dinner
// is high but valid; 9999 kcal is not).
export class CreateMealTemplateDto {
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(500)
  description?: string;

  @IsInt() @Min(0) @Max(2000) calories_kcal!: number;
  @IsInt() @Min(0) @Max(300) protein_g!: number;
  @IsInt() @Min(0) @Max(400) carbs_g!: number;
  @IsInt() @Min(0) @Max(200) fats_g!: number;

  @IsOptional() @IsInt() @Min(0) @Max(100) fiber_g?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  items?: { name: string; grams?: number; portion?: string }[];
}

export class UpdateMealTemplateDto {
  @IsOptional() @IsString() @Transform(trim) @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @Transform(trim) @MaxLength(500) description?: string;
  @IsOptional() @IsInt() @Min(0) @Max(2000) calories_kcal?: number;
  @IsOptional() @IsInt() @Min(0) @Max(300) protein_g?: number;
  @IsOptional() @IsInt() @Min(0) @Max(400) carbs_g?: number;
  @IsOptional() @IsInt() @Min(0) @Max(200) fats_g?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) fiber_g?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(20)
  items?: { name: string; grams?: number; portion?: string }[];
}

export const SLOT_LABELS = [
  'breakfast',
  'lunch',
  'dinner',
  'snack',
  'preworkout',
  'postworkout',
] as const;

export class DailyPlanSlotInputDto {
  @IsString() meal_template_id!: string;
  @IsString() @IsIn(SLOT_LABELS as unknown as string[])
  slot_label!: typeof SLOT_LABELS[number];
  @IsOptional() @IsInt() @Min(0) @Max(20) order?: number;
  // C2-C0: the coach's planned time for the meal, "HH:MM"; absent or null = no time.
  @IsOptional() @IsTimeOfDay() time_of_day?: string | null;
}

export class CreateDailyMealPlanDto {
  @IsString() @Transform(trim) @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @Transform(trim) @MaxLength(2000) notes?: string;

  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => DailyPlanSlotInputDto)
  slots!: DailyPlanSlotInputDto[];
}

export class UpdateDailyMealPlanDto {
  @IsOptional() @IsString() @Transform(trim) @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @Transform(trim) @MaxLength(2000) notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => DailyPlanSlotInputDto)
  slots?: DailyPlanSlotInputDto[];
}

export class AssignDailyPlanDto {
  @IsString() client_id!: string;
  @IsISO8601() starts_on!: string;
  @IsOptional() @IsISO8601() ends_on?: string;
}

/** MEALPLAN-END: the client's last day on the plan. A day before it starts removes it. */
export class EndDailyPlanAssignmentDto {
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'ends_on must be a date in the form YYYY-MM-DD' })
  ends_on!: string;
}
