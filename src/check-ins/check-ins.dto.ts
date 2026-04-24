import { Transform } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// SECURITY: allow-list DTOs. Global ValidationPipe has whitelist=true and
// forbidNonWhitelisted=true, so extra fields (user_id, coach_id, …) are
// rejected — callers cannot spoof authorship via mass-assignment.

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Shared int-coercion so query-string numbers ("3" rather than 3) still pass
// class-validator's @IsInt(). Mirrors how existing DTOs (e.g. ListNudgesQueryDto)
// handle query-string ints.
const coerceInt = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) ? value : n;
};

const coerceFloat = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
};

export class CreateCheckInDto {
  // ISO-8601 (date or datetime). The service normalizes to midnight UTC so
  // the unique (user_id, date) constraint enforces one check-in per calendar
  // day.
  @IsISO8601()
  date!: string;

  @IsOptional()
  @Transform(coerceInt)
  @IsInt()
  @Min(1)
  @Max(5)
  mood?: number;

  @IsOptional()
  @Transform(coerceInt)
  @IsInt()
  @Min(1)
  @Max(5)
  energy?: number;

  @IsOptional()
  @Transform(coerceFloat)
  @IsNumber()
  @Min(0)
  @Max(24)
  sleep_hours?: number;

  @IsOptional()
  @Transform(coerceFloat)
  @IsNumber()
  @Min(0)
  @Max(1000) // kg; upper bound is a sanity check, not a medical limit
  weight_kg?: number;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(2000)
  notes?: string;
}

export class ListCheckInsQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Transform(coerceInt)
  @IsInt()
  @Min(1)
  @Max(365)
  limit?: number;
}
