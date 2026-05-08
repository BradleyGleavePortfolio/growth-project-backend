/**
 * DTOs for CoachOffer operations.
 */

import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';

export enum CoachCompensationTypeDto {
  COMMISSION = 'commission',
  REV_SHARE = 'rev_share',
  FLAT = 'flat',
  HYBRID = 'hybrid',
}

export class CreateOfferDto {
  @ApiProperty({ description: 'CoachApplication.id of the pool candidate' })
  @IsUUID()
  application_id!: string;

  @ApiProperty({ enum: CoachCompensationTypeDto })
  @IsEnum(CoachCompensationTypeDto)
  compensation_type!: CoachCompensationTypeDto;

  /**
   * Compensation terms shape by type:
   *   commission:  { rate_pct: number }
   *   rev_share:   { rate_pct: number, cap_usd?: number }
   *   flat:        { amount_usd: number, period: 'monthly' | 'weekly' }
   *   hybrid:      { base_usd: number, rate_pct: number }
   *
   * Must satisfy Prisma.InputJsonObject for the jsonb column.
   */
  @ApiProperty({ description: 'Structured compensation terms (see JSDoc for shape by type)' })
  @IsObject()
  compensation_terms!: Prisma.InputJsonObject;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  @Max(500)
  client_capacity!: number;

  @ApiPropertyOptional({ example: 'We run a 12-week transformation programme.' })
  @IsOptional()
  @IsString()
  onboarding_message?: string;
}

export class AcceptRejectOfferDto {
  // Currently no body fields needed; placeholder for future fields
  // (e.g. applicant counter-terms in a later iteration).
}

export class SearchPoolQueryDto {
  @ApiPropertyOptional({ example: 'strength' })
  @IsOptional()
  @IsString()
  specialty?: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(80)
  min_availability?: number;

  @ApiPropertyOptional({ description: 'commission | rev_share | w2 | hybrid' })
  @IsOptional()
  @IsString()
  work_type?: string;

  @ApiPropertyOptional({ description: 'Cursor: last seen application.id for keyset pagination' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  take?: number;
}
