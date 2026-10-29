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
  // S-SCHED-2: a confirmed session has no call link yet (to the coach, with
  // an "add the call link" action) and the link was added (to the client).
  // Same booking_* preference cluster.
  BOOKING_LINK_NEEDED: 'booking_link_needed',
  BOOKING_LINK_READY: 'booking_link_ready',
  // S-SCHED-5: a request reached its clear time without an answer (to both
  // sides; the slot is open again). Same booking_* preference cluster.
  BOOKING_REQUEST_EXPIRED: 'booking_request_expired',

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
  // C05 item 7 — Client: workout reminder at their preferred training time on
  // a plan day (WorkoutReminderService). Prefs: workout_reminder_push/_inapp.
  WORKOUT_REMINDER: 'workout_reminder',
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

  // ── Roman P4 (Option C) — first-payment celebration ───────────────────────
  // Coach: the coach just received their first-ever client payment. Emitted
  // exactly once, forever, from CheckoutWebhookHandlerService inside the same
  // $transaction that records the purchase, gated behind
  // FEATURE_ROMAN_FIRST_PAYMENT (default OFF). The DB-level CoachFirstPayment
  // Notification(coachId @unique) row is what guarantees exactly-once: the
  // notification is enqueued only on the INSERT that wins the unique
  // constraint. Mobile #242 subscribes to the notifications stream and filters
  // for this kind instead of reading ClientPurchase directly. Code-level only
  // (no NotificationPreferences migration); routes to the COACH_DIRECT
  // category like other coach-targeted kinds.
  // Payload: { amount: number; currency: string; clientId: string }.
  FIRST_PAYMENT: 'first_payment',

  // ── B-TRIALS (OR-113-2) — free trial ending ───────────────────────────────
  // Client: their free trial ends in three days and the card on file will be
  // charged then (or, after a cancel, that nothing will be charged). Emitted
  // once per (purchase, trial end) from the customer.subscription.trial_will_end
  // webhook (PackageTrialNotice ledger). A billing notice, not marketing: no
  // NotificationPreferences columns, so it is not opt-out-able per kind (a
  // money kind: see MONEY_NOTIFICATION_KINDS). Payload: { purchase_id, package_id,
  // trial_ends_at, amount_cents, currency, will_charge }.
  TRIAL_ENDING: 'trial_ending',
  // RENEWAL-BE: the client's plan with their coach ended normally (Day 0, 1
  // and 7 of the renewal sequence). Push only, no inbox row; it opens Home.
  // Prefs: plan_renewal_push (default on) for Day 0; Day 1 and Day 7 are offers that
  // need the person's yes (plan_renewal_offers_opt_in_at, STORE-B2) and obey Mute all.
  PLAN_RENEWAL: 'plan_renewal',
  // SWITCH-TELL-BE: to the coach a client left when the client moved to TGP's
  // house coach. In-app only (no push), no deep link; payload { client_id }.
  // The new coach is never named. Its created_at is Money's moved_away_at.
  COACH_CLIENT_MOVED: 'coach_client_moved',
} as const;

export type NotificationKindValue = (typeof NotificationKind)[keyof typeof NotificationKind];

/**
 * MUTE-PAY (owner #171-3, SoT A6.0-171): the money notices. "Mute all
 * notifications" never stops one of these on any channel (push-preferences.ts
 * muteAllStops); it mutes only the other phone pushes, and never an in-app row.
 * A new kind must be classed here or in the spec's not-money list
 * (test/dunning-kind-fix-notification-kinds.spec.ts fails otherwise). Senders:
 *   dunning_blocker    payment blocker: checkout/dunning-v2/dunning-v2.dispatcher.ts;
 *                      refund and dispute notice: checkout/refund-dispute-handler.service.ts
 *   first_payment      notifications/emitters/first-payment.emitter.ts
 *   trial_ending       packages/trials/trial-notice.service.ts
 *   plan_renewal       checkout/plan-renewal/plan-renewal.service.ts
 *   coach_new_purchase coach earnings: packages/purchase-fanout.service.ts
 * Receipts and dunning emails are emails with no kind here; no email sender
 * reads `muted`. Coach refund, dispute and payout notices ride `coach_alert`
 * (not money as a kind): their in-app rows pass Mute all like every row.
 */
export const MONEY_NOTIFICATION_KINDS: ReadonlySet<string> = new Set<NotificationKindValue>([
  NotificationKind.DUNNING_BLOCKER,
  NotificationKind.FIRST_PAYMENT,
  NotificationKind.TRIAL_ENDING,
  NotificationKind.PLAN_RENEWAL,
  NotificationKind.COACH_NEW_PURCHASE,
]);
