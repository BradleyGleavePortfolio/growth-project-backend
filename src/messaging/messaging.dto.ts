import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// SECURITY: allow-list DTOs. Global ValidationPipe has whitelist=true and
// forbidNonWhitelisted=true, so extra fields (e.g. sender_id, coach_id) get
// rejected — senders cannot spoof authorship via mass-assignment.

// Phase 6C — async voice notes. The client uploads audio first via
// /messages/voice-upload (or /coach/clients/:id/messages/voice-upload),
// then attaches the metadata returned by that endpoint here. Server
// re-validates duration/size/content_type against the env-driven limits
// before persisting the message — the upload endpoint's response is
// not trusted blindly.
export class CreateMessageVoiceDto {
  @IsString()
  @MaxLength(2048)
  // Public URL written by the upload endpoint. We accept an empty/relative
  // value only in dev when SUPABASE storage is not wired; in that mode the
  // upload endpoint returns 501 anyway.
  @IsUrl({ require_tld: false, require_protocol: false })
  url!: string;

  @IsInt()
  @Min(1)
  // Hard upper bound — service additionally enforces VOICE_NOTE_MAX_DURATION_SEC.
  @Max(600)
  duration_sec!: number;

  @IsInt()
  @Min(1)
  // Hard upper bound — service additionally enforces VOICE_NOTE_MAX_SIZE_MB.
  @Max(25 * 1024 * 1024)
  size_bytes!: number;

  // Allowlist enforced at the DTO level (R7 Fix 4.1) and again in
  // assertVoiceWithinLimits. Dual validation ensures the content_type is
  // rejected before it touches service logic even when the DTO is reused
  // in future code paths that bypass the service guard.
  @IsIn(['audio/m4a', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/webm', 'audio/ogg'])
  content_type!: string;
}

// The body length is bounded at 4000 chars (per spec). We trim whitespace
// before validation so a message of spaces only fails the MinLength(1) check
// instead of quietly storing an empty-looking thread entry.
//
// Phase 6C: `body` becomes optional when `voice` is supplied. The service
// enforces "at least one of body|voice" — DTO validation alone cannot, since
// validators run independently per field.
export class CreateMessageDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(4000)
  body?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateMessageVoiceDto)
  voice?: CreateMessageVoiceDto;
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

// Phase 6C — request a signed upload URL for a voice attachment. The
// client passes the intended size + duration + content_type; the server
// validates against the same limits enforced at message-send time so a
// signed URL is never issued for a payload the service would later reject.
export class VoiceUploadRequestDto {
  @IsInt()
  @Min(1)
  @Max(600)
  duration_sec!: number;

  @IsInt()
  @Min(1)
  @Max(25 * 1024 * 1024)
  size_bytes!: number;

  // Allowlist enforced at the DTO level (R7 Fix 4.1) and again in
  // assertVoiceWithinLimits inside MessagingService.
  @IsIn(['audio/m4a', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/webm', 'audio/ogg'])
  content_type!: string;
}
