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
} as const;

export type NotificationKindValue = (typeof NotificationKind)[keyof typeof NotificationKind];
