import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  IsISO8601,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Range bounds chosen to reject obviously-broken inputs (e.g. a coach
// fat-fingering 99999 calories) while leaving generous headroom for
// real prescriptions on either tail (cut to 800kcal, bulk to 6500kcal).
export class CreateMacroTargetDto {
  @IsInt()
  @Min(800)
  @Max(7000)
  calories_kcal!: number;

  @IsInt()
  @Min(0)
  @Max(500)
  protein_g!: number;

  @IsInt()
  @Min(0)
  @Max(900)
  carbs_g!: number;

  @IsInt()
  @Min(0)
  @Max(400)
  fats_g!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200)
  fiber_g?: number;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(500)
  notes?: string;

  // ISO 8601 date string. Defaults to "now" on the server when omitted.
  @IsOptional()
  @IsISO8601()
  effective_from?: string;
}
