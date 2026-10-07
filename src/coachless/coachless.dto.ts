import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  INVITE_CODE_MAX_LENGTH,
  INVITE_CODE_MIN_LENGTH,
} from '../invite-codes/invite-codes.service';
import { CoachSharingNoticeProperty } from '../consent/coach-sharing-notice';

const CODE_SHAPE = /^\s*[A-Za-z0-9-]+\s*$/;

export class CoachCodeDto {
  @ApiProperty({
    example: 'GP-A1B2C3',
    minLength: INVITE_CODE_MIN_LENGTH,
    maxLength: INVITE_CODE_MAX_LENGTH + 8,
  })
  @IsString()
  @MinLength(INVITE_CODE_MIN_LENGTH)
  // Whitespace around a pasted code is trimmed server-side; allow a little.
  @MaxLength(INVITE_CODE_MAX_LENGTH + 8)
  @Matches(CODE_SHAPE)
  code!: string;

  // Redeem only: the coach-sharing sentence the code sheet showed above its
  // Join button (src/consent/coach-sharing-notice.ts). Ignored by check.
  @CoachSharingNoticeProperty()
  coach_sharing_notice?: string;
}

/** Owner PUT /admin/featured-coach. Every field is replaced (null clears). */
export class FeaturedCoachConfigDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  coach_user_id?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'GP-A1B2C3' })
  @IsOptional()
  @IsString()
  @MinLength(INVITE_CODE_MIN_LENGTH)
  @MaxLength(INVITE_CODE_MAX_LENGTH)
  @Matches(/^[A-Za-z0-9-]+$/)
  code?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  package_id?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  banner_title?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  offer_text?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 400 })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  roman_pitch_text?: string | null;

  @ApiProperty()
  @IsBoolean()
  accepting_clients!: boolean;

  @ApiProperty()
  @IsBoolean()
  roman_enabled!: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 720 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  roman_min_hours_between?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 14 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(14)
  roman_max_per_week?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 365 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  roman_snooze_days?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  roman_max_not_now?: number;

  @ApiPropertyOptional({
    description:
      'Create `code` as a permanent code of the featured coach when it does not exist yet.',
  })
  @IsOptional()
  @IsBoolean()
  create_code_if_missing?: boolean;
}
