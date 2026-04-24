import { Transform } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

// SECURITY: allow-list DTOs. Global ValidationPipe has whitelist=true and
// forbidNonWhitelisted=true, so extra fields (e.g. sender_id, coach_id) get
// rejected — senders cannot spoof authorship via mass-assignment.

// The body length is bounded at 4000 chars (per spec). We trim whitespace
// before validation so a message of spaces only fails the MinLength(1) check
// instead of quietly storing an empty-looking thread entry.
export class CreateMessageDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class ListThreadQueryDto {
  // ISO-8601 cursor. Thread is ordered newest-first; `before` returns rows
  // strictly older than the supplied timestamp.
  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : parseInt(String(value), 10)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
