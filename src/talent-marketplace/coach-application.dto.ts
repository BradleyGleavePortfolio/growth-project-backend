/**
 * DTOs for the CoachApplication flow.
 *
 * Validation is handled by class-validator decorators; NestJS ValidationPipe
 * (configured globally in main.ts) rejects payloads that fail.
 */

import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

/** Shape of the preferences jsonb field. */
export interface WorkPreferences {
  commission: boolean;
  rev_share: boolean;
  w2: boolean;
  hybrid: boolean;
}

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
    example: { commission: true, rev_share: false, w2: false, hybrid: true },
  })
  @IsObject()
  preferences!: WorkPreferences;

  @ApiProperty({ example: 20 })
  @IsInt()
  @Min(1)
  @Max(80)
  availability_hours_per_week!: number;

  @ApiProperty({ enum: CoachClientTypeDto, example: CoachClientTypeDto.FITNESS })
  @IsEnum(CoachClientTypeDto)
  preferred_client_type!: CoachClientTypeDto;
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

  @ApiPropertyOptional({ example: '2024-01-01T00:00:00Z' })
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
