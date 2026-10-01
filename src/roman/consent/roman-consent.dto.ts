/**
 * R2 — DTOs for /me/ai-consent. `forbidNonWhitelisted: true` is global, so
 * every field the mobile may send is declared with a validator.
 */

import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const ROMAN_CONSENT_PLATFORMS = ['ios', 'android', 'web'] as const;

/** POST /me/ai-consent/roman — record that the user tapped Allow. */
export class GrantRomanConsentDto {
  /** Must equal the server's current version, else 409 CONSENT_VERSION_MISMATCH. */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  version!: string;

  /** sha256 hex of the exact sheet text shown. Optional audit aid. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  copy_sha256?: string;

  @IsOptional()
  @IsIn(ROMAN_CONSENT_PLATFORMS)
  platform?: (typeof ROMAN_CONSENT_PLATFORMS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(32)
  app_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}

/**
 * POST /me/ai-consent/onboarding — the single onboarding "I agree" box
 * (owner ruling 2026-09-30 16:31 #5). Records the AI processing grant AND the
 * personal-training waiver acceptance in one call. Both versions must equal
 * the server's current versions, else 409 CONSENT_VERSION_MISMATCH.
 */
export class GrantOnboardingConsentDto {
  /** AI processing copy version shown (must equal current_version). */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  ai_consent_version!: string;

  /** Personal-training waiver version shown (must equal waiver_current_version). */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  waiver_version!: string;

  /** sha256 hex of the exact combined text shown. Optional audit aid. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  copy_sha256?: string;

  @IsOptional()
  @IsIn(ROMAN_CONSENT_PLATFORMS)
  platform?: (typeof ROMAN_CONSENT_PLATFORMS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(32)
  app_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;
}
