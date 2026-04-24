import { Transform } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

// SECURITY: allow-list DTOs. Global ValidationPipe has whitelist=true and
// forbidNonWhitelisted=true so extra fields (e.g. coach_id, read_at) get
// rejected — callers cannot spoof authorship or read state via mass-assignment.

// Trim before validating so a title/body of whitespace-only fails the
// MinLength(1) check instead of slipping through as an empty-looking nudge.
export class CreateNudgeDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(80)
  title!: string;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(500)
  body!: string;
}

export class ListNudgesQueryDto {
  // ISO-8601 cursor. Listing is newest-first; `since` returns rows strictly
  // newer than the supplied timestamp (the mobile client passes the most
  // recent nudge it has already seen).
  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : parseInt(String(value), 10)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
