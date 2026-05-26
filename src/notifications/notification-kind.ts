/**
 * NotificationKind — canonical list of every notification type in the system.
 *
 * These string values are stored verbatim in Notification.kind so that
 * adding a new kind requires a code change only (no schema migration) while
 * the DB can still be queried with a simple WHERE kind = $1.
 *
 * Each emitter file uses exactly one of these values. If you add a kind here
 * you must also:
 *   1. Add a matching row to the matrix table in src/notifications/README.md
 *   2. Add per-kind channel defaults to NotificationPreferences migration
 *   3. Write at least one unit test for the new emitter
 */
export const NotificationKind = {
  // Client: a body-composition or check-in milestone was hit.
  MILESTONE_REACHED: 'milestone_reached',

  // Client: a new message was received from their coach.
  MESSAGE_RECEIVED: 'message_received',

  // Client (or coach, targeting their own client): a check-in window was missed.
  MISSED_CHECKIN: 'missed_checkin',

  // Client: a weight trend alert (positive or negative direction).
  WEIGHT_TREND_ALERT: 'weight_trend_alert',

  // Coach: a client submitted their daily check-in.
  CHECKIN_SUBMITTED: 'checkin_submitted',

  // Client: a new Build Week day was unlocked.
  BUILD_WEEK_DAY_UNLOCKED: 'build_week_day_unlocked',

  // Coach: a coach-alert was created (mirrors CoachAlert table for inbox).
  COACH_ALERT: 'coach_alert',

  // System: daily/weekly digest email confirmation row (channel=email).
  CLIENT_DIGEST: 'client_digest',
  COACH_DIGEST: 'coach_digest',

  // Concierge booking lifecycle (PR feat/concierge-booking-notifications).
  // The seven kinds form one preference cluster ("booking_*"); a future
  // PR can split per-event if product wants finer control.
  BOOKING_REQUESTED: 'booking_requested',
  BOOKING_CONFIRMED: 'booking_confirmed',
  BOOKING_DECLINED: 'booking_declined',
  BOOKING_CANCELLED: 'booking_cancelled',
  BOOKING_RESCHEDULED: 'booking_rescheduled',
  BOOKING_REMINDER_24H: 'booking_reminder_24h',
  BOOKING_REMINDER_1H: 'booking_reminder_1h',

  // r50 Dunning v1 — failed-payment recovery lifecycle. One cluster
  // ("dunning_*") so a coach can mute all of them with a single
  // preference toggle if they're set up via auto-pay on a different card.
  DUNNING_RETRY_ATTEMPT: 'dunning_retry_attempt',
  DUNNING_FINAL_WARNING: 'dunning_final_warning',
  DUNNING_RECOVERED: 'dunning_recovered',
  DUNNING_CHURNED: 'dunning_churned',
} as const;

export type NotificationKindValue = (typeof NotificationKind)[keyof typeof NotificationKind];
