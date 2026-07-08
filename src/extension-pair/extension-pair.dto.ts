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
export type PairStatus = 'pending' | 'paired' | 'expired';

export interface PairInitResult {
  pairing_code: string;
  expires_at: string;
}

export interface PairStatusResult {
  status: PairStatus;
}

export interface PairRedeemResult {
  access_token: string;
  refresh_token: string;
  chosen_platform: string;
}

// Structured failure reasons for redeem (DESIGN.md v0.3 §4). Surfaced in the
// error body's `code` field so the extension popup can map each to the right
// user-facing string. `locked` = the code burned through its per-code attempt
// budget and is hard-invalidated (re-mint required).
export type PairRedeemErrorCode = 'expired' | 'already_used' | 'invalid' | 'locked';
