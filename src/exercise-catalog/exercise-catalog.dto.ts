/**
 * DTOs for the /exercise-catalog endpoints + owner attach surface.
 *
 * Contract with mobile (growth-project-mobile `feat/video-library-v1-mobile`):
 *
 *   GET /exercise-catalog
 *     query: q?, category?, primaryMuscle?, equipment?, limit?, cursor?
 *     → { items: Exercise[]; nextCursor: string | null; total: number }
 *
 *   GET /exercise-catalog/:idOrSlug
 *     → Exercise & { playbackUrl: string | null }
 *
 * Item shape (response):
 *   { id, slug, name, category, primaryMuscle, secondaryMuscles,
 *     equipment, difficulty, instructions, muxPlaybackId? }
 */

import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ExerciseCatalogListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  primaryMuscle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  equipment?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

export class AttachMuxAssetDto {
  // Pre-existing Mux asset id (already in Ready state on Mux). The
  // attach flow trusts the owner to provide a valid id — we fetch the
  // asset back via Mux to validate before persisting.
  @IsString()
  @MaxLength(120)
  muxAssetId!: string;
}

export class CreateMuxUploadDto {
  @IsOptional()
  @IsIn(['public', 'signed'])
  playbackPolicy?: 'public' | 'signed';

  // Optional CORS allowed origin for the upload URL. Defaults to '*'.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  corsOrigin?: string;
}

export class CreateCatalogItemDto {
  @IsString()
  @MaxLength(120)
  slug!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(80)
  category!: string;

  @IsString()
  @MaxLength(80)
  primaryMuscle!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  secondaryMuscles?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  equipment?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  difficulty?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  instructions?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sourceRef?: string;
}

// Response DTO shape (documentation-only; we hand-construct in the service).
export interface ExerciseCatalogItemDto {
  id: string;
  slug: string;
  name: string;
  category: string;
  primaryMuscle: string;
  secondaryMuscles: string[];
  equipment: string[];
  difficulty: string;
  instructions: string[];
  muxPlaybackId: string | null;
}

export interface ExerciseCatalogDetailDto extends ExerciseCatalogItemDto {
  playbackUrl: string | null;
}

export interface ExerciseCatalogListResponse {
  items: ExerciseCatalogItemDto[];
  nextCursor: string | null;
  total: number;
}
