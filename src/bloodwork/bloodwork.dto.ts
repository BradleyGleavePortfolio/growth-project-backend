import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  BloodworkReviewState,
  BloodworkScanStatus,
  BloodworkSource,
} from './bloodwork.constants';

// Global ValidationPipe has whitelist=true and forbidNonWhitelisted=true,
// so any extra field on the wire is rejected — clients cannot spoof
// authorship, validation status, or review_state via mass-assignment.

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const coerceFloat = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
};

const coerceInt = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) ? value : n;
};

export class CreateBloodworkResultDto {
  @IsString()
  @Transform(trim)
  @MaxLength(200)
  marker_name!: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(64)
  marker_code?: string;

  @IsOptional()
  @Transform(coerceFloat)
  @IsNumber()
  value_numeric?: number;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(200)
  value_text?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(64)
  unit?: string;

  @IsOptional()
  @Transform(coerceFloat)
  @IsNumber()
  reference_low?: number;

  @IsOptional()
  @Transform(coerceFloat)
  @IsNumber()
  reference_high?: number;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(200)
  reference_text?: string;
}

export class CreateBloodworkPanelDto {
  @IsISO8601()
  collection_date!: string;

  @IsOptional()
  @IsIn(Object.values(BloodworkSource))
  source?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(200)
  panel_label?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  source_missing?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateBloodworkResultDto)
  results?: CreateBloodworkResultDto[];
}

export class UpdateBloodworkPanelDto {
  @IsOptional()
  @IsISO8601()
  collection_date?: string;

  @IsOptional()
  @IsIn(Object.values(BloodworkSource))
  source?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(200)
  panel_label?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  source_missing?: boolean;
}

export class ListPanelsQueryDto {
  @IsOptional()
  @IsIn(Object.values(BloodworkReviewState))
  review_state?: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  include_drafts?: boolean;

  @IsOptional()
  @Transform(coerceInt)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

// Coach-side review/flag/hide payload. Transitions are validated in the
// service against COACH_TRANSITIONS so the controller doesn't need to
// duplicate the rule.
export class ReviewPanelDto {
  @IsIn([
    BloodworkReviewState.REVIEWED,
    BloodworkReviewState.FLAGGED,
    BloodworkReviewState.HIDDEN,
    BloodworkReviewState.NEEDS_INFO,
  ])
  review_state!: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(2000)
  review_note?: string;
}

export class RegisterAttachmentDto {
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(1024)
  storage_ref?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(64)
  storage_backend?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(128)
  content_type?: string;

  @IsOptional()
  @Transform(coerceInt)
  @IsInt()
  @Min(0)
  @Max(50 * 1024 * 1024) // 50 MiB sanity cap; storage layer enforces real limit
  byte_size?: number;
}

// Internal/admin-driven update of a scan result. Not exposed on the
// client surface — controllers gate this behind the OWNER role.
export class UpdateAttachmentScanDto {
  @IsIn(Object.values(BloodworkScanStatus))
  scan_status!: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(500)
  scan_message?: string;
}
