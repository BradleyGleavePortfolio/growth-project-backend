import { IsNumber, IsOptional, IsString, IsDateString, Min, Max, MaxLength, ValidateIf } from 'class-validator';

// SECURITY: allow-list DTO for weight logging.
export class LogWeightDto {
  @IsNumber()
  @Min(40)
  @Max(1500)
  weight_lbs!: number;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

// SECURITY: allow-list DTO for editing a weigh-in (PATCH /weight/:id). Only the
// number and the note can change; the date and the owner cannot (the global
// pipe's forbidNonWhitelisted answers 400 for any other field).
export class UpdateWeightDto {
  // Optional, but never null: the column is required.
  @ValidateIf((_dto, value) => value !== undefined)
  @IsNumber()
  @Min(40)
  @Max(1500)
  weight_lbs?: number;

  // null clears the note.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
