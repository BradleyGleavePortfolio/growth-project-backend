import {
  IsString,
  IsOptional,
  MaxLength,
  IsArray,
  Matches,
  IsEnum,
  ValidateNested,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { LandingCtaType, LandingSectionKind } from '@prisma/client';

export class UpsertSectionDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsEnum(LandingSectionKind)
  kind!: LandingSectionKind;

  @IsInt()
  @Min(0)
  order_index!: number;

  // Payload is validated per-kind by Zod in the service layer
  payload!: Record<string, unknown>;
}

export class UpdateLandingPageDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  headline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  subheadline?: string;

  @IsOptional()
  @IsString()
  hero_image_url?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
    message: 'accent_color must be a valid #RGB or #RRGGBB hex color',
  })
  accent_color?: string;

  @IsOptional()
  @IsEnum(LandingCtaType)
  primary_cta_type?: LandingCtaType;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  primary_cta_label?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  package_ids?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  lead_capture_fields?: string[];

  @IsOptional()
  @IsString()
  crm_integration_id?: string;

  /**
   * Optional explicit slug override.
   * If provided: slugified, deduplicated, and saved.
   * If omitted: slug is NEVER auto-regenerated from headline (broken links
   * are worse than ugly slugs — spec §3 Hard Requirement #3).
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  slug?: string;

  /**
   * Full section list — replaces all existing sections atomically.
   * Order is determined by order_index on each item.
   * If omitted, existing sections are untouched.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpsertSectionDto)
  sections?: UpsertSectionDto[];
}
