import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

// A lowercase slug rather than an enum: the supported platform list is driven
// by the extension ROADMAP and grows one at a time, so a pattern avoids a
// migration per new extractor.
const PLATFORM_SLUG = /^[a-z0-9_-]+$/;

// 6-digit numeric (DESIGN.md v0.3 §4); rejected at the DTO boundary before any
// DB lookup.
const SIX_DIGIT = /^[0-9]{6}$/;

export class PairInitDto {
  @ApiProperty({
    example: 'truecoach',
    description:
      'Source coaching platform the coach is migrating from. Lowercase slug ' +
      'driven by the extension ROADMAP matrix (truecoach, trainerize, mypthub, …).',
  })
  @IsString()
  @MaxLength(64)
  @Matches(PLATFORM_SLUG, {
    message: 'chosen_platform must be a lowercase slug (a-z, 0-9, dash, underscore)',
  })
  chosen_platform!: string;
}

export class PairRedeemDto {
  @ApiProperty({
    example: '142856',
    description: '6-digit numeric pairing code minted by POST /api/extension/pair/init.',
  })
  @IsString()
  @Matches(SIX_DIGIT, { message: 'code must be exactly 6 digits' })
  code!: string;
}

// Status is a POST (not a GET with ?code=) so the pairing code never lands in a
// URL — query strings leak into access logs, browser history, proxies and APM.
// The code travels in the request body instead. Same 6-digit constraint as
// redeem, enforced at the DTO boundary before any DB lookup.
export class PairStatusDto {
  @ApiProperty({
    example: '142856',
    description: '6-digit numeric pairing code to poll (the code the caller minted).',
  })
  @IsString()
  @Matches(SIX_DIGIT, { message: 'code must be exactly 6 digits' })
  code!: string;
}

// Status of a pairing code as reported to the polling mobile app.
export const PAIR_STATUSES = ['pending', 'paired', 'expired'] as const;
export type PairStatus = (typeof PAIR_STATUSES)[number];

// Result shapes are decorated classes (not bare interfaces) so @nestjs/swagger
// can emit their schemas into the frozen importer contract (R80). Structural
// typing keeps the service layer, which returns plain object literals,
// compatible without change.
export class PairInitResult {
  @ApiProperty({
    description: '6-digit numeric pairing code the coach reads out to the extension.',
    example: '142856',
  })
  pairing_code!: string;

  @ApiProperty({
    description: 'ISO-8601 instant the code expires (short TTL, DESIGN §4).',
    format: 'date-time',
    example: '2026-07-09T18:35:00.000Z',
  })
  expires_at!: string;
}

export class PairStatusResult {
  @ApiProperty({
    description: 'Lifecycle state of the polled code.',
    enum: PAIR_STATUSES,
    example: 'pending',
  })
  status!: PairStatus;
}

export class PairRedeemResult {
  @ApiProperty({ description: 'Coach-bound Supabase access token.' })
  access_token!: string;

  @ApiProperty({ description: 'Coach-bound Supabase refresh token.' })
  refresh_token!: string;

  @ApiProperty({
    description: 'Source platform the code was minted for (echoed to the extension).',
    example: 'truecoach',
  })
  chosen_platform!: string;
}

// Structured failure reasons for redeem (DESIGN.md v0.3 §4). Surfaced in the
// error body's `code` field so the extension popup can map each to the right
// user-facing string. `locked` = the code burned through its per-code attempt
// budget and is hard-invalidated (re-mint required).
export const PAIR_REDEEM_ERROR_CODES = ['expired', 'already_used', 'invalid', 'locked'] as const;
export type PairRedeemErrorCode = (typeof PAIR_REDEEM_ERROR_CODES)[number];

// Error body returned by redeem on the 400/410 paths. Modeled so the contract
// pins both the enum of failure reasons and the presence of a human message.
export class PairRedeemErrorDto {
  @ApiProperty({
    description: 'Machine-readable failure reason for a rejected redeem.',
    enum: PAIR_REDEEM_ERROR_CODES,
    example: 'expired',
  })
  code!: PairRedeemErrorCode;

  @ApiProperty({
    description: 'Human-readable failure message.',
    example: 'This pairing code has expired.',
  })
  message!: string;
}
