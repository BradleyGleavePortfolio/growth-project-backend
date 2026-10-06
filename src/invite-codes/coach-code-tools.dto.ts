import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import type { InviteGrantMode } from '@prisma/client';

// SECURITY: allow-list DTOs (global ValidationPipe whitelist +
// forbidNonWhitelisted), so coach_id / code / used_count can never be
// mass-assigned. Tenancy always comes from req.user.id.

export const CODE_LABEL_MAX = 60;
export const ROTATE_GRACE_HOURS_MAX = 168; // one week
export const SIGNUP_DAYS_MAX = 90;

export class CreateCoachCodeDto {
  @ApiPropertyOptional({
    maxLength: CODE_LABEL_MAX,
    description: 'Coach-facing name, e.g. "Clinic front desk".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CODE_LABEL_MAX)
  label?: string;

  @ApiPropertyOptional({
    description: 'Signup limit. Omit or null for unlimited.',
    minimum: 1,
    maximum: 100000,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(100000)
  max_uses?: number | null;

  @ApiPropertyOptional({
    description: 'ISO time the code stops working. Omit or null for no expiry.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  expires_at?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Package granted to each signup (one of your active packages).',
  })
  @IsOptional()
  @IsUUID()
  package_id?: string;

  @ApiPropertyOptional({ enum: ['free', 'prepaid'], description: 'Required with package_id.' })
  @IsOptional()
  @IsIn(['free', 'prepaid'])
  grant_mode?: Exclude<InviteGrantMode, 'none'>;
}

export class RotateCoachCodeDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: ROTATE_GRACE_HOURS_MAX,
    description: 'Hours the old code keeps working after rotation. 0 (default) turns it off now.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(ROTATE_GRACE_HOURS_MAX)
  grace_hours?: number;

  @ApiPropertyOptional({
    maxLength: 32,
    description:
      'Required for the coach link (`coach-link`): the link code on screen. A retry returns the first successor.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  expected_code?: string;
}

export class CoachCodeSignupsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: SIGNUP_DAYS_MAX, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SIGNUP_DAYS_MAX)
  days?: number;
}
