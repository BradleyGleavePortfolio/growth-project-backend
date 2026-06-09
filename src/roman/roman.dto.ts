/**
 * Roman chat DTOs. `forbidNonWhitelisted: true` is global (ENGINEERING_RULES
 * §5), so every field a client may send is declared here with an explicit
 * validator.
 */

import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** The two Roman surfaces. Mirrors the Prisma `RomanSurface` enum. */
export const ROMAN_SURFACES = ['client', 'coach'] as const;
export type RomanSurfaceDto = (typeof ROMAN_SURFACES)[number];

/** POST /roman/sessions — open or resume the caller's session for a surface. */
export class OpenSessionDto {
  @IsIn(ROMAN_SURFACES)
  surface!: RomanSurfaceDto;
}

/** POST /roman/sessions/:id/messages — submit a user turn. */
export class SendMessageDto {
  @IsString()
  @MinLength(1)
  // Hard cap on a single user turn. Generous for chat; prevents abuse / giant
  // payloads. Older turns are tail-sliced server-side (brief §3).
  @MaxLength(8000)
  content!: string;
}

/** GET /roman/sessions/:id/messages?cursor=&limit= — paginated, newest first. */
export class ListMessagesQueryDto {
  // Opaque cursor: the id of the oldest message already seen (we page backwards
  // in time). Validated as a string; the service treats an unknown id as "from
  // the newest".
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
