import { IsOptional, IsInt, IsBoolean, IsString, Min, Max } from 'class-validator';

export class ViewEventDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  scroll_depth?: number;

  @IsOptional()
  @IsBoolean()
  cta_clicked?: boolean;

  @IsOptional()
  @IsBoolean()
  form_submitted?: boolean;

  @IsOptional()
  @IsString()
  utm_source?: string;

  @IsOptional()
  @IsString()
  utm_medium?: string;

  @IsOptional()
  @IsString()
  utm_campaign?: string;
}
