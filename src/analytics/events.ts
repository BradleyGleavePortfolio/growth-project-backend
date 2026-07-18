/**
 * Canonical PostHog event taxonomy for the Growth Project backend.
 *
 * This file is the single source of truth for server-side event names. The
 * names are used both by AnalyticsService.capture() callers and by the
 * /admin/metrics endpoint which exposes the same counters via Postgres.
 *
 * The taxonomy is aligned to the "metrics_dashboard_spec" lanes:
 *   - INVITE_FUNNEL: how many codes resolve, how many convert into signups,
 *     how many of those signups attach to a coach
 *   - SIGNUP: account creation across email + Google
 *   - COACH: provisioning a CoachProfile (the moment a coach can take clients)
 *   - BILLING: Stripe subscription lifecycle mirrored from webhooks
 *   - AI: server-side chat invocations, including fallback rate
 *   - MESSAGING: coach <-> client messages sent
 *   - CLIENT_LOG: aggregate client logging activity (food, etc.)
 *
 * Event names use snake_case nouns with verb suffixes so they sort sensibly
 * in PostHog. NEVER include PII in event names (no email, no full names).
 *
 * No fake revenue or fake customer metrics are emitted from these events;
 * billing-tier amounts come straight from Stripe webhook payloads and are
 * the only "money" properties allowed.
 */

export const Events = {
  // ── Invite funnel ────────────────────────────────────────────────────
  /** A public preview lookup of an invite code (anonymous). */
  INVITE_PREVIEWED: 'invite_previewed',
  /** A code was redeemed and the user was attached to a coach. */
  INVITE_REDEEMED: 'invite_redeemed',

  // ── Signup ───────────────────────────────────────────────────────────
  /** A new user record was created (email signup, pre-verification). */
  USER_REGISTERED: 'user_registered',
  /** A new user record was created via Google OAuth (post-link). */
  USER_REGISTERED_GOOGLE: 'user_registered_google',
  /** A new user record was created via Sign in with Apple (post-link). */
  USER_REGISTERED_APPLE: 'user_registered_apple',
  /** Signup that bundled an invite code in the same call. */
  USER_SIGNUP_WITH_CODE: 'user_signup_with_code',

  // ── Coach provisioning ───────────────────────────────────────────────
  /** A CoachProfile was created (user is now able to take clients). */
  COACH_PROVISIONED: 'coach_provisioned',
  /** Existing user was promoted to coach role by an OWNER. */
  COACH_PROMOTED: 'coach_promoted',
  /** Coach took an action against a client (archive/unarchive/guidelines). */
  COACH_ACTION: 'coach_action',
  /**
   * ED.2 (Roman three-arc router) — the Coach Home daily-rings counts were
   * computed for a coach. Emitted once per flag-ON cache MISS (never on a hit
   * or the flag-OFF zeroed path). Properties are non-PII numbers/booleans only:
   * checkIns_reviewed, checkIns_submitted, brief_opened, review_reviewed,
   * review_total.
   */
  COACH_DAILY_RINGS_FETCHED: 'coach_daily_rings_fetched',
  /** Phase 6D — Coach Onboarding Wizard lifecycle. */
  COACH_ONBOARDING_STARTED: 'coach_onboarding_started',
  COACH_ONBOARDING_STEP_COMPLETED: 'coach_onboarding_step_completed',
  COACH_ONBOARDING_COMPLETED: 'coach_onboarding_completed',

  // ── Billing lifecycle ────────────────────────────────────────────────
  /** customer.subscription.created/updated mirrored from Stripe. */
  SUBSCRIPTION_UPDATED: 'subscription_updated',
  /** customer.subscription.deleted mirrored from Stripe. */
  SUBSCRIPTION_CANCELED: 'subscription_canceled',
  /** invoice.paid mirrored from Stripe. */
  INVOICE_PAID: 'invoice_paid',
  /** invoice.payment_failed mirrored from Stripe. */
  INVOICE_PAYMENT_FAILED: 'invoice_payment_failed',

  // ── AI ───────────────────────────────────────────────────────────────
  /** /ai/chat invocation, with `model_used` ('perplexity' | 'fallback'). */
  AI_CHAT_INVOKED: 'ai_chat_invoked',
  /**
   * MWB-5 — an approved live-create capability materialised a workout plan.
   * Emitted once per successful create/edit materialisation, carrying the
   * `capability` ('draft.create_workout_plan' | 'draft.edit_workout_plan'),
   * `draft_id`, `plan_id`, `coach_id`, `week_count`, `exercise_count`, and
   * `duration_ms`. NEVER emitted on a failed materialisation (failures flow
   * through the exception path).
   */
  MWB_LIVE_CREATE_INVOKED: 'mwb_live_create_invoked',

  // ── Messaging ────────────────────────────────────────────────────────
  /** Coach sent a message to a client. */
  COACH_MESSAGE_SENT: 'coach_message_sent',
  /** Client sent a message to their coach. */
  CLIENT_MESSAGE_SENT: 'client_message_sent',

  // ── Client logging ───────────────────────────────────────────────────
  /** Client logged a food entry (one event per logFood call). */
  CLIENT_FOOD_LOGGED: 'client_food_logged',

  // ── Workout builder (MWB-3 autosave/undo) ────────────────────────────
  /**
   * MWB-3 (spec §5.2): the revision-prune cron deleted one or more stale
   * WorkoutPlanRevision rows for a plan beyond the 30-revision retention limit.
   * Properties: { plan_id, deleted_count }. Emitted only when deleted_count > 0.
   */
  MWB_AUTOSAVE_REVISION_PRUNED: 'mwb_autosave_revision_pruned',

  // ── Scout ingest (tgp-importer extension) ────────────────────────────
  /**
   * IMPORTER-E (DESIGN.md v0.3 §2 step 11): an extension import settled to a
   * terminal state via POST /api/scout/ingest/complete. Emitted exactly once
   * per (coach, intent) — the completion ledger's unique key gates re-emits on
   * retry. Properties: { intent_id, terminal_status }. No PII.
   */
  SCOUT_INGEST_COMPLETED: 'scout.ingest.completed',
  /**
   * IMPORTER — GET /api/scout/import/status read one run's status. RED signal;
   * properties { intent_id, status }. No tokens, payloads, or PII.
   */
  SCOUT_IMPORT_STATUS_READ: 'scout.import.status.read',
  /**
   * IMPORTER — a settled ScoutImport carried an unrecognised terminal_status;
   * the read fails closed to `failed`. RED signal, { intent_id } only — the
   * offending value is never emitted (no tokens, payloads, or PII).
   */
  SCOUT_IMPORT_STATUS_INVALID: 'scout.import.status.invalid',
  /**
   * IMPORTER-F — a settled crawl intent's staged `clients` were reconstructed
   * into invite-pending roster Person records via POST /api/scout/reconstruct.
   * Emitted once per reconstruction pass; a replay re-emits with identical
   * ledger-derived counts. Properties: { intent_id, entity_type, staged,
   * reconstructed, skipped, failed }. No tokens, payloads, or PII.
   */
  SCOUT_RECONSTRUCT_COMPLETED: 'scout.reconstruct.completed',
  /**
   * IMPORTER-G — a coach read one settled intent's reconstructed invite-pending
   * roster via GET /api/scout/reconstruct/roster. RED signal, emitted once per
   * page read. Properties: { intent_id, entity_type, returned, has_more }. No
   * tokens, payloads, display names, or PII.
   */
  SCOUT_RECONSTRUCT_ROSTER_READ: 'scout.reconstruct.roster.read',
} as const;

export type EventName = (typeof Events)[keyof typeof Events];
