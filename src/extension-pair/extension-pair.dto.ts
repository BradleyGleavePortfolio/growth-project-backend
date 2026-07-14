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
//
// The reasons split by HTTP status, matching ExtensionPairService.redeem():
//   400 → `invalid`                              (BadRequestException)
//   410 → `expired` | `already_used` | `locked`  (GoneException)
// The contract pins each enum against the status it can actually appear on, so
// a client can exhaustively switch on `code` per status. PAIR_REDEEM_ERROR_CODES
// remains the union for the service's shared type.
// Domain failure code for init: after the mint-retry budget is exhausted the
// service throws BadRequestException({ code: 'code_mint_failed' }) (see
// ExtensionPairService.init). A 400 can ALSO arise code-less from the global
// ValidationPipe (a chosen_platform that fails the slug/length constraints),
// so the contract pins this enum only WHEN a `code` is present.
export const PAIR_INIT_400_CODES = ['code_mint_failed'] as const;
export type PairInitErrorCode = (typeof PAIR_INIT_400_CODES)[number];

export const PAIR_REDEEM_400_CODES = ['invalid'] as const;
export const PAIR_REDEEM_410_CODES = ['expired', 'already_used', 'locked'] as const;
export const PAIR_REDEEM_ERROR_CODES = [
  ...PAIR_REDEEM_410_CODES,
  ...PAIR_REDEEM_400_CODES,
] as const;
export type PairRedeemErrorCode = (typeof PAIR_REDEEM_ERROR_CODES)[number];
