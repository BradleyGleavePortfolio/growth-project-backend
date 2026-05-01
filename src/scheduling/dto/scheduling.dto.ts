import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const VIDEO_PROVIDERS = ['stub', 'google_meet', 'zoom', 'manual'] as const;
export type VideoProviderDtoValue = (typeof VIDEO_PROVIDERS)[number];

export class CreateSessionTypeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsInt()
  @Min(5)
  @Max(480)
  duration_minutes!: number;

  @IsOptional()
  @IsBoolean()
  auto_approve?: boolean;

  @IsOptional()
  @IsIn(VIDEO_PROVIDERS as readonly string[])
  default_video_provider?: VideoProviderDtoValue;
}

export class UpdateSessionTypeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  duration_minutes?: number;

  @IsOptional()
  @IsBoolean()
  auto_approve?: boolean;

  @IsOptional()
  @IsIn(VIDEO_PROVIDERS as readonly string[])
  default_video_provider?: VideoProviderDtoValue;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class AvailabilityWindowDto {
  @IsInt()
  @Min(0)
  @Max(6)
  day_of_week!: number;

  @IsInt()
  @Min(0)
  @Max(60 * 24 - 1)
  start_minute!: number;

  @IsInt()
  @Min(1)
  @Max(60 * 24)
  end_minute!: number;

  @IsOptional()
  @IsUUID()
  session_type_id?: string;
}

export class SetAvailabilityDto {
  // The full new set of windows for the coach. The service replaces
  // the existing rows in a single transaction so partial-update edge
  // cases (orphaned rows, half-applied edits) are impossible.
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityWindowDto)
  windows!: AvailabilityWindowDto[];
}

export class RequestSessionDto {
  @IsUUID()
  coach_id!: string;

  @IsOptional()
  @IsUUID()
  session_type_id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsISO8601()
  start_at!: string;

  @IsISO8601()
  end_at!: string;
}

export class RescheduleSessionDto {
  @IsISO8601()
  start_at!: string;

  @IsISO8601()
  end_at!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CancelSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CompleteSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  coach_notes_md?: string;
}

export class AttachManualVideoLinkDto {
  // Free-form URL (Whereby, FaceTime, Zoom personal room, phone-call
  // marker like "tel:+1..." etc). The endpoint stamps the session as
  // video_provider=manual so reminder jobs do not try to mint a new
  // link via a real adapter.
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  video_url!: string;
}
