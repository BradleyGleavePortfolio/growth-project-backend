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

  // ── Community v1-4 — realtime/push slice ──────────────────────────────────
  // Seven push kinds for the Community Expansion. Code-level only: no schema
  // migration. The v1-1 NotificationPreferences table has NO per-kind column
  // for these, so their channel defaults live in the community push-defaults
  // table (src/community/notifications/community-notifications.service.ts,
  // COMMUNITY_PUSH_DEFAULTS) and are applied at the READ path — see the
  // Community block appended to src/notifications/README.md. Each maps onto an
  // EXISTING NotificationCategory (COACH_DIRECT / CLIENT_BOT / MILESTONE /
  // SYSTEM) — no new category. All gated behind FEATURE_COMMUNITY_PUSH.
  COMMUNITY_MESSAGE_RECEIVED: 'community_message_received',
  COMMUNITY_DM_RECEIVED: 'community_dm_received',
  COMMUNITY_POST_REPLIED: 'community_post_replied',
  COMMUNITY_EVENT_STARTING_SOON: 'community_event_starting_soon',
  COMMUNITY_CHALLENGE_MILESTONE: 'community_challenge_milestone',
  COMMUNITY_MODERATION_ACTION_AGAINST_ME: 'community_moderation_action_against_me',
  COMMUNITY_MEMBERSHIP_CHANGED: 'community_membership_changed',

  // B3 Smart Dunning v2 — the Day-3 / Day-7 in-app blocker pop-up the client
  // reads on session start (spec §8.2). Emitted ONLY behind FEATURE_DUNNING_V2
  // from DunningV2Dispatcher; the mobile client renders DunningBlockerModal
  // from the payload. Additive: no v1 emitter uses this kind.
  DUNNING_BLOCKER: 'dunning_blocker',

  // ── B5 Digital Contracts — envelope lifecycle ─────────────────────────────
  // Code-level only (no schema migration), gated behind
  // FEATURE_CONTRACTS_ENABLED at the emit sites. Coach-targeted awareness of
  // a required-contract envelope's terminal/near-terminal transitions so the
  // coach can follow up (declined/expired) or knows a purchase can proceed
  // (signed). Client-side signing prompts are surfaced inline at checkout
  // (ContractRequiredException), not as notifications. Default prefs follow
  // the COACH_DIRECT category. Additive: no existing emitter uses these.
  CONTRACT_SIGNED: 'contract_signed',
  CONTRACT_DECLINED: 'contract_declined',
  CONTRACT_EXPIRED: 'contract_expired',
} as const;

export type NotificationKindValue = (typeof NotificationKind)[keyof typeof NotificationKind];
