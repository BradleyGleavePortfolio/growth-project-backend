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

  // NUDGE-V1 — Behavioral re-engagement nudges. Four trigger types,
  // each independently opt-out-able via NotificationPreferences.
  // Tone standard: calm, premium, mindful — see src/notifications/nudges/copy.ts.
  NUDGE_MISSED_CHECKIN: 'nudge_missed_checkin',
  NUDGE_STREAK_BROKEN: 'nudge_streak_broken',
  NUDGE_ONBOARDING_ABANDONED: 'nudge_onboarding_abandoned',
  NUDGE_INACTIVE: 'nudge_inactive',

  // Stream 2 — AI execution capabilities. Fired by AssignWorkoutMaterializer
  // / AssignMealPlanMaterializer after a coach approves the corresponding
  // draft. The notification deep-links into the assigned row so the
  // client can see what their coach just queued for them.
  WORKOUT_ASSIGNED: 'workout_assigned',
  MEAL_PLAN_ASSIGNED: 'meal_plan_assigned',

  // PR-10 — Buyer: a scheduled package drop just unlocked. Decision #9
  // ("push + in-app every time content unlocks") emits this kind from the
  // DripDispatcherCron after a successful materialise. The deep-link points
  // at the underlying assignment / message / asset grant so the buyer can
  // tap straight into the new content.
  DRIP_RELEASED: 'drip_released',

  // PR-15A — Coach: a buyer just entitled a purchase against one of this
  // coach's packages. Fired from PurchaseFanoutService.onPurchaseEntitled
  // (same in-tx stage / post-commit flush pattern as DRIP_RELEASED, idempotent
  // across Stripe webhook replay via DripResolverMarker(purpose=
  // 'coach_new_purchase')). Default prefs ON for the selling coach.
  COACH_NEW_PURCHASE: 'coach_new_purchase',
} as const;

export type NotificationKindValue = (typeof NotificationKind)[keyof typeof NotificationKind];
