import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * B5 — Request DTOs for the contract endpoints (spec §3.4 / §3.5). Validation
 * is intentionally minimal: names/bodies are bounded, merge overrides are a
 * free-form object the render layer validates token-by-token (contract-merge).
 */

export class CreateTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  body_markdown!: string;

  @IsOptional()
  @IsObject()
  dynamic_fields_json?: Record<string, unknown>;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  body_markdown?: string;

  @IsOptional()
  @IsObject()
  dynamic_fields_json?: Record<string, unknown>;
}

export class TestRenderDto {
  @IsOptional()
  @IsObject()
  merge_data?: Record<string, string>;
}
