import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

// SECURITY: allow-list DTO for notification preferences. Previously
// updatePreferences took `@Body() body: any` and spread into prisma.update,
// which could overwrite `user_id` (reassigning prefs to another account).
// See audit C4. ValidationPipe strips anything not in this DTO.
const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpdateNotificationPreferencesDto {
  @IsOptional()
  @IsBoolean()
  water_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  workout_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  eat_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  mindset_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  fasting_enabled?: boolean;

  @IsOptional()
  @IsString()
  @Matches(TIME_HHMM, { message: 'quiet_hours_start must be HH:MM (00:00–23:59)' })
  quiet_hours_start?: string;

  @IsOptional()
  @IsString()
  @Matches(TIME_HHMM, { message: 'quiet_hours_end must be HH:MM (00:00–23:59)' })
  quiet_hours_end?: string;

  @IsOptional()
  @IsBoolean()
  daily_checkin_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  weekly_summary_enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
