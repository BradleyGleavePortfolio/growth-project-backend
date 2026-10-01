/**
 * R2a — request DTO for POST /me/ai-consent/roman. The global ValidationPipe
 * runs with `whitelist` + `forbidNonWhitelisted`, so every field the mobile
 * may send is declared here and anything else is a 400.
 */
import { IsIn, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

/**
 * Optional means OMITTED, not null (Sol B-622-3). `@IsOptional()` would skip
 * validation for `null` too, so a `null` digest reached the service. Each
 * optional field is validated whenever its key is present with any value
 * other than `undefined`; `null` therefore fails its validators -> 400.
 */
const IfPresent = (key: keyof GrantClientAiConsentDto): PropertyDecorator =>
  ValidateIf((o: Partial<GrantClientAiConsentDto>) => o[key] !== undefined);

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
   * Omit it rather than sending null (null is a 400).
   */
  @IfPresent('copy_sha256')
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  copy_sha256?: string;

  @IfPresent('platform')
  @IsIn(AI_CONSENT_PLATFORMS)
  platform?: AiConsentPlatform;

  @IfPresent('app_version')
  @IsString()
  @MaxLength(32)
  @Matches(/^[0-9A-Za-z.+-]+$/)
  app_version?: string;

  @IfPresent('locale')
  @IsString()
  @MaxLength(16)
  @Matches(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/)
  locale?: string;
}
