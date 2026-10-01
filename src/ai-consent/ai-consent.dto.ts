/**
 * R2a — request DTO for POST /me/ai-consent/roman. The global ValidationPipe
 * runs with `whitelist` + `forbidNonWhitelisted`, so every field the mobile
 * may send is declared here and anything else is a 400.
 */
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const AI_CONSENT_PLATFORMS = ['ios', 'android', 'web'] as const;
export type AiConsentPlatform = (typeof AI_CONSENT_PLATFORMS)[number];

export class GrantClientAiConsentDto {
  /** Copy version the client displayed. Must equal the server's current version, else 409. */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  version!: string;

  /**
   * Optional sha256 (lowercase or uppercase hex) of `paragraph + "\n\n" + box_label`
   * as displayed. When present it must equal the server's `copy.sha256`, else 409.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  copy_sha256?: string;

  @IsOptional()
  @IsIn(AI_CONSENT_PLATFORMS)
  platform?: AiConsentPlatform;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[0-9A-Za-z.+-]+$/)
  app_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/)
  locale?: string;
}
