/**
 * DTOs for the CoachApplication flow.
 *
 * Validation is handled by class-validator decorators; NestJS ValidationPipe
 * (configured globally in main.ts) rejects payloads that fail.
 */

import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';

/** Allowed preferred-client-type values — mirrors the Prisma enum. */
export enum CoachClientTypeDto {
  FITNESS = 'fitness',
  WELLNESS = 'wellness',
  BOTH = 'both',
}

/** Allowed application status values — mirrors the Prisma enum. */
export enum CoachApplicationStatusDto {
  PENDING = 'pending',
  REVIEWED = 'reviewed',
  APPROVED = 'approved',
  POOL = 'pool',
  PLACED = 'placed',
  INACTIVE = 'inactive',
}

/**
 * Strict shape for the preferences jsonb field. Each work arrangement is an
 * explicit boolean flag; an unknown top-level key fails class-validator's
 * `whitelist` setting (configured globally in main.ts) and the request is
 * rejected with 400.
 */
export class PreferencesDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  commission!: boolean;

  @ApiProperty({ example: false })
  @IsBoolean()
  rev_share!: boolean;

  @ApiProperty({ example: false })
  @IsBoolean()
  w2!: boolean;

  @ApiProperty({ example: true })
  @IsBoolean()
  hybrid!: boolean;
}

// Backwards-compatible alias kept so other modules that imported the
// JSON-shaped interface continue to type-check. The runtime contract is now
// PreferencesDto; this type only exists so older Prisma-input call sites still
// satisfy InputJsonObject.
export type WorkPreferences = PreferencesDto & Prisma.JsonObject;

// ─── Submit Application ────────────────────────────────────────────────────────

export class SubmitCoachApplicationDto {
  @ApiProperty({ example: 'alex@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Alex' })
  @IsString()
  first_name!: string;

  @ApiProperty({ example: 'Chen' })
  @IsString()
  last_name!: string;

  @ApiProperty({ example: ['NASM-CPT', 'CSCS'], type: [String] })
  @IsArray()
  @IsString({ each: true })
  certifications!: string[];

  @ApiProperty({ example: ['strength', 'weight-loss'], type: [String] })
  @IsArray()
  @IsString({ each: true })
  specializations!: string[];

  @ApiProperty({ example: 5 })
  @IsInt()
  @Min(0)
  @Max(50)
  years_experience!: number;

  @ApiPropertyOptional({ example: 'https://drive.google.com/my-program' })
  @IsOptional()
  @IsUrl()
  sample_program_url?: string;

  @ApiProperty({
    type: PreferencesDto,
    example: { commission: true, rev_share: false, w2: false, hybrid: true },
  })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => PreferencesDto)
  preferences!: PreferencesDto;

  @ApiProperty({ example: 20 })
  @IsInt()
  @Min(1)
  @Max(80)
  availability_hours_per_week!: number;

  @ApiProperty({ enum: CoachClientTypeDto, example: CoachClientTypeDto.FITNESS })
  @IsEnum(CoachClientTypeDto)
  preferred_client_type!: CoachClientTypeDto;

  @ApiProperty({
    description:
      'Client-generated UUID. A retry with the same key returns the original application instead of creating a duplicate.',
    example: '7f1a3e6c-2b9d-4d5b-9a1f-3b3a2b9d4d5b',
  })
  @IsUUID()
  @IsNotEmpty()
  idempotency_key!: string;
}

// ─── Admin Review ─────────────────────────────────────────────────────────────

export class ReviewCoachApplicationDto {
  @ApiProperty({ enum: CoachApplicationStatusDto })
  @IsEnum(CoachApplicationStatusDto)
  status!: CoachApplicationStatusDto;

  @ApiPropertyOptional({ example: 4, minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  reviewer_score?: number;

  @ApiPropertyOptional({ example: 'Strong fundamentals, needs more specialization depth.' })
  @IsOptional()
  @IsString()
  reviewer_notes?: string;

  @ApiPropertyOptional({ description: 'Mark background check as completed' })
  @IsOptional()
  @IsBoolean()
  background_verified?: boolean;
}

// ─── Admin List Query ─────────────────────────────────────────────────────────

export class ListApplicationsQueryDto {
  @ApiPropertyOptional({ enum: CoachApplicationStatusDto })
  @IsOptional()
  @IsEnum(CoachApplicationStatusDto)
  status?: CoachApplicationStatusDto;

  /**
   * Keyset cursor. Format: `<ISO8601 created_at>|<application id>`. The tuple
   * is required so concurrent inserts at the same instant cannot skip or
   * repeat rows the way an id-only cursor against a created_at order does.
   */
  @ApiPropertyOptional({
    description: 'Keyset cursor: `<created_at ISO>|<application id>`',
    example: '2026-05-24T12:00:00.000Z|6f1a3e6c-2b9d-4d5b-9a1f-3b3a2b9d4d5b',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}
