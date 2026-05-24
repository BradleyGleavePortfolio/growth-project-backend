/**
 * DTOs for CoachOffer operations.
 *
 * Strict runtime validation: nested DTOs for compensation_terms and a closed
 * enum for work_type. The Prisma schema stores compensation_terms as jsonb,
 * but the service layer relies on the shape matching the compensation_type;
 * weak validation would let invalid revenue-routing inputs land in the DB.
 */

import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum CoachCompensationTypeDto {
  COMMISSION = 'commission',
  REV_SHARE = 'rev_share',
  FLAT = 'flat',
  HYBRID = 'hybrid',
}

/**
 * Closed enum of work-type filters for talent-pool search. Mirrors the keys
 * accepted in CoachApplication.preferences so the JSON-path filter cannot be
 * driven by an arbitrary client-supplied string.
 */
export enum WorkTypeEnum {
  COMMISSION = 'commission',
  REV_SHARE = 'rev_share',
  W2 = 'w2',
  HYBRID = 'hybrid',
}

export enum FlatPeriodEnum {
  MONTHLY = 'monthly',
  WEEKLY = 'weekly',
}

// ─── Compensation terms — one nested DTO per compensation type ────────────────

export class CommissionTermsDto {
  @ApiProperty({ example: 85, minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  rate_pct!: number;
}

export class RevShareTermsDto {
  @ApiProperty({ example: 30, minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  rate_pct!: number;

  @ApiPropertyOptional({ example: 5000, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cap_usd?: number;
}

export class FlatTermsDto {
  @ApiProperty({ example: 3000, minimum: 0 })
  @IsNumber()
  @Min(0)
  amount_usd!: number;

  @ApiProperty({ enum: FlatPeriodEnum })
  @IsEnum(FlatPeriodEnum)
  period!: FlatPeriodEnum;
}

export class HybridTermsDto {
  @ApiProperty({ example: 1500, minimum: 0 })
  @IsNumber()
  @Min(0)
  base_usd!: number;

  @ApiProperty({ example: 10, minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  rate_pct!: number;
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
   * The service layer (validateCompensationTerms) re-validates the inner shape
   * against the chosen compensation_type after class-validator runs so the
   * persisted JSON is guaranteed safe for revenue-routing math.
   */
  @ApiProperty({ description: 'Structured compensation terms (see JSDoc for shape by type)' })
  @IsObject()
  compensation_terms!: Record<string, unknown>;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  @Max(500)
  client_capacity!: number;

  @ApiPropertyOptional({ example: 'We run a 12-week transformation programme.' })
  @IsOptional()
  @IsString()
  onboarding_message?: string;

  @ApiProperty({
    description:
      'Client-generated UUID. Server dedupes — a retry with the same key returns the original offer.',
    example: '6f1a3e6c-2b9d-4d5b-9a1f-3b3a2b9d4d5b',
  })
  @IsUUID()
  @IsNotEmpty()
  idempotency_key!: string;
}

export class AcceptRejectOfferDto {
  @ApiProperty({
    description:
      'Client-generated UUID for accept/reject idempotency. Required so a retried tap does not flip state twice.',
    example: '6f1a3e6c-2b9d-4d5b-9a1f-3b3a2b9d4d5b',
  })
  @IsUUID()
  @IsNotEmpty()
  idempotency_key!: string;
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

  @ApiPropertyOptional({ enum: WorkTypeEnum })
  @IsOptional()
  @IsEnum(WorkTypeEnum)
  work_type?: WorkTypeEnum;

  /**
   * Cursor for keyset pagination. Format: `<ISO8601 created_at>|<application id>`.
   * Encoded with `|` rather than a comma so URL parsing stays trivial.
   */
  @ApiPropertyOptional({
    description: 'Keyset cursor: `<created_at ISO>|<application id>`',
  })
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

// Re-export the nested terms DTO classes via this convenience union so the
// service layer can `instanceof`-check while still typing on the discriminated
// shape. Kept exported above so they show up in OpenAPI.
export type CompensationTermsUnion =
  | CommissionTermsDto
  | RevShareTermsDto
  | FlatTermsDto
  | HybridTermsDto;
