import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// SECURITY: allow-list DTO for notification preferences. Only fields
// explicitly listed here can be updated by the client — unknown fields
// are stripped by ValidationPipe (whitelist: true) before they reach
// the service layer. This prevents a malicious client from overwriting
// user_id or any FK column.

const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpdateNotificationPreferencesDto {
  // ── Legacy channel flags (PR #145 baseline, kept for backwards compat) ──

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
  @IsBoolean()
  new_client_alerts?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  // ── Phase 9: Global mute ─────────────────────────────────────────────────

  @IsOptional()
  @IsBoolean()
  muted?: boolean;

  // ── Phase 9: milestone channel flags ────────────────────────────────────

  @IsOptional()
  @IsBoolean()
  milestone_email?: boolean;

  @IsOptional()
  @IsBoolean()
  milestone_push?: boolean;

  @IsOptional()
  @IsBoolean()
  milestone_inapp?: boolean;

  // ── message ─────────────────────────────────────────────────────────────

  @IsOptional()
  @IsBoolean()
  message_email?: boolean;

  @IsOptional()
  @IsBoolean()
  message_push?: boolean;

  @IsOptional()
  @IsBoolean()
  message_inapp?: boolean;

  // ── missed_checkin ───────────────────────────────────────────────────────

  @IsOptional()
  @IsBoolean()
  missed_checkin_email?: boolean;

  @IsOptional()
  @IsBoolean()
  missed_checkin_push?: boolean;

  @IsOptional()
  @IsBoolean()
  missed_checkin_inapp?: boolean;

  // ── weight_trend ─────────────────────────────────────────────────────────

  @IsOptional()
  @IsBoolean()
  weight_trend_email?: boolean;

  @IsOptional()
  @IsBoolean()
  weight_trend_push?: boolean;

  @IsOptional()
  @IsBoolean()
  weight_trend_inapp?: boolean;

  // ── checkin_submitted (coach-facing) ────────────────────────────────────

  @IsOptional()
  @IsBoolean()
  checkin_submitted_email?: boolean;

  @IsOptional()
  @IsBoolean()
  checkin_submitted_push?: boolean;

  @IsOptional()
  @IsBoolean()
  checkin_submitted_inapp?: boolean;

  // ── build_week ───────────────────────────────────────────────────────────

  @IsOptional()
  @IsBoolean()
  build_week_email?: boolean;

  @IsOptional()
  @IsBoolean()
  build_week_push?: boolean;

  @IsOptional()
  @IsBoolean()
  build_week_inapp?: boolean;

  // ── coach_alert (coach-facing) ────────────────────────────────────────

  @IsOptional()
  @IsBoolean()
  coach_alert_email?: boolean;

  @IsOptional()
  @IsBoolean()
  coach_alert_push?: boolean;

  @IsOptional()
  @IsBoolean()
  coach_alert_inapp?: boolean;

  // ── digest ───────────────────────────────────────────────────────────────

  @IsOptional()
  @IsBoolean()
  digest_email?: boolean;

  @IsOptional()
  @IsBoolean()
  digest_push?: boolean;

  @IsOptional()
  @IsBoolean()
  digest_inapp?: boolean;

  // ── booking (Concierge lifecycle + reminders) ─────────────────────────────

  @IsOptional()
  @IsBoolean()
  booking_email?: boolean;

  @IsOptional()
  @IsBoolean()
  booking_push?: boolean;

  @IsOptional()
  @IsBoolean()
  booking_inapp?: boolean;

  // ── PR-15A: COACH_NEW_PURCHASE — selling coach alerted on entitlement ─

  @IsOptional()
  @IsBoolean()
  coach_new_purchase_email?: boolean;

  @IsOptional()
  @IsBoolean()
  coach_new_purchase_push?: boolean;

  @IsOptional()
  @IsBoolean()
  coach_new_purchase_inapp?: boolean;

  // ── NUDGE-V1: behavioral nudge per-trigger opt-out (spec §6) ──────────
  // Surfaced in user notification preferences so each trigger type can
  // be muted independently in one tap. Schema columns added in the same
  // migration as the NudgeLog model.

  @IsOptional()
  @IsBoolean()
  nudge_missed_checkin_email?: boolean;

  @IsOptional()
  @IsBoolean()
  nudge_missed_checkin_push?: boolean;

  @IsOptional()
  @IsBoolean()
  nudge_missed_checkin_inapp?: boolean;

  // Streak-broken trigger — schema columns use 'practice_paused' per the
  // schema doctrine; the TS-side trigger value remains 'streak_broken'.

  @IsOptional()
  @IsBoolean()
  nudge_practice_paused_email?: boolean;

  @IsOptional()
  @IsBoolean()
  nudge_practice_paused_push?: boolean;

  @IsOptional()
  @IsBoolean()
  nudge_practice_paused_inapp?: boolean;

  @IsOptional()
  @IsBoolean()
  nudge_onboarding_abandoned_email?: boolean;

  @IsOptional()
  @IsBoolean()
  nudge_onboarding_abandoned_push?: boolean;

  @IsOptional()
  @IsBoolean()
  nudge_onboarding_abandoned_inapp?: boolean;

  @IsOptional()
  @IsBoolean()
  nudge_inactive_email?: boolean;

  @IsOptional()
  @IsBoolean()
  nudge_inactive_push?: boolean;

  @IsOptional()
  @IsBoolean()
  nudge_inactive_inapp?: boolean;
}

// ── Notification center query params ────────────────────────────────────────

export class GetNotificationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  // When 'unread', only returns rows where read_at IS NULL.
  @IsOptional()
  @IsString()
  filter?: 'unread' | 'all';
}
