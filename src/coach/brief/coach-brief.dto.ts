// src/coach/brief/coach-brief.dto.ts
//
// Request DTOs for the coach-brief endpoints. The global ValidationPipe
// runs with whitelist + forbidNonWhitelisted, so any field not declared
// here is rejected with 400.

import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsValidTimezone } from '../../common/validators/is-valid-timezone.validator';

export class BriefHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  limit?: number = 10;
}

export class LogHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  limit?: number = 10;
}

export class UpsertDailyLogDto {
  @IsString()
  @MaxLength(4000)
  content!: string;
}

// HH:MM 24-hour format pattern.
const HH_MM_24H_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpdateBriefPreferencesDto {
  @IsOptional()
  @IsString()
  @Matches(HH_MM_24H_RE, {
    message: 'notification_time must be HH:MM in 24-hour format',
  })
  notification_time?: string;

  // IANA tz string. Validated via Intl.DateTimeFormat to block values that
  // would later crash brief generation / scheduler dispatch.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Validate(IsValidTimezone)
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
