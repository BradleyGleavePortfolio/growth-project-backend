import {
  IsString,
  IsEnum,
  IsOptional,
  MaxLength,
  IsArray,
  Matches,
} from 'class-validator';
import { LandingPageTemplate, LandingCtaType } from '@prisma/client';

export class CreateLandingPageDto {
  @IsEnum(LandingPageTemplate)
  template!: LandingPageTemplate;

  @IsString()
  @MaxLength(120)
  headline!: string;

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

  @IsEnum(LandingCtaType)
  primary_cta_type!: LandingCtaType;

  @IsString()
  @MaxLength(40)
  primary_cta_label!: string;

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
}
