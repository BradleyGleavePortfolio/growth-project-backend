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
  /** Signup that bundled an invite code in the same call. */
  USER_SIGNUP_WITH_CODE: 'user_signup_with_code',

  // ── Coach provisioning ───────────────────────────────────────────────
  /** A CoachProfile was created (user is now able to take clients). */
  COACH_PROVISIONED: 'coach_provisioned',
  /** Existing user was promoted to coach role by an OWNER. */
  COACH_PROMOTED: 'coach_promoted',
  /** Coach took an action against a client (archive/unarchive/guidelines). */
  COACH_ACTION: 'coach_action',

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

  // ── Messaging ────────────────────────────────────────────────────────
  /** Coach sent a message to a client. */
  COACH_MESSAGE_SENT: 'coach_message_sent',
  /** Client sent a message to their coach. */
  CLIENT_MESSAGE_SENT: 'client_message_sent',

  // ── Client logging ───────────────────────────────────────────────────
  /** Client logged a food entry (one event per logFood call). */
  CLIENT_FOOD_LOGGED: 'client_food_logged',
} as const;

export type EventName = (typeof Events)[keyof typeof Events];
