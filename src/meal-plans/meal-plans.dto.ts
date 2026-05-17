import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// SECURITY: allow-list DTOs. Global ValidationPipe has whitelist=true and
// forbidNonWhitelisted=true, so extra fields (coach_id, client_id, id,
// archived_at, …) get rejected — callers cannot spoof ownership or
// un-archive via mass-assignment.

// Whitespace trim before length validation so a title of spaces only fails
// MinLength(1) instead of slipping through as an empty-looking plan.
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// A single meal item inside a plan. Schema is intentionally loose (spec §A.1):
// `name` is the only required field; everything else is optional so mobile
// UI can evolve without a migration. `time_of_day` is a free-form string
// (e.g. "breakfast", "09:30", "post-workout") rather than an enum for the
// same reason.
export class MealPlanItemDto {
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  calories?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  protein?: number;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(40)
  time_of_day?: string;
}

export class CreateMealPlanDto {
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(4000)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MealPlanItemDto)
  items!: MealPlanItemDto[];

  // Optional structured per-day shape (AI-generated plans only). Not
  // validated deeply here — the AI payload is already validated by the
  // prompt validator before reaching the materializer. The global
  // ValidationPipe whitelist strips any extra fields callers try to sneak
  // in via the coach CRUD endpoints; this field is only populated
  // programmatically by the materializer, not by the mobile API surface.
  @IsOptional()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  days?: any;
}

// PATCH body — every field optional; the service treats undefined as
// "don't touch" so callers can update a single field at a time.
export class UpdateMealPlanDto {
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MealPlanItemDto)
  items?: MealPlanItemDto[];
}
