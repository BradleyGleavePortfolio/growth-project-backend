/**
 * Roman approve-to-adjust DTOs. `forbidNonWhitelisted: true` is global, so
 * every field a coach may send is declared with an explicit validator.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ADJUST_DISMISS_REASONS, type AdjustDismissReason } from './roman-adjust.constants';

export class AdjustSetsRowDto {
  @IsInt()
  @Min(0)
  order!: number;

  @IsInt()
  @Min(1)
  @Max(20)
  sets!: number;
}

/** POST /coach/adjustments/:id/approve. C1V2-C1: the coach's reason the client reads on that day. */
export class ApproveAdjustmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  client_reason?: string;
}

/** POST /coach/adjustments/:id/edit: a percentage OR explicit set counts. */
export class EditAdjustmentDto extends ApproveAdjustmentDto {
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(50)
  volume_pct?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => AdjustSetsRowDto)
  sets?: AdjustSetsRowDto[];
}

/** POST /coach/adjustments/:id/dismiss */
export class DismissAdjustmentDto {
  @IsOptional()
  @IsIn(ADJUST_DISMISS_REASONS)
  reason?: AdjustDismissReason;
}
