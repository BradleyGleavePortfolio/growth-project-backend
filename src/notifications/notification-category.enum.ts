/**
 * notification-category.enum.ts — Phase 11 / Push Notification Taxonomy
 *
 * NotificationCategory maps to the four-tier taxonomy defined on the mobile
 * side in src/notifications/push-channels.ts. Every outgoing Expo push
 * payload must include a `category` field set to one of these values.
 *
 * Default: SYSTEM — used when no category is specified to avoid breaking
 * existing call sites. Callers should explicitly set the appropriate category.
 *
 * Taxonomy:
 *   COACH_DIRECT  — messages/alerts initiated by or for a specific coach
 *   CLIENT_BOT    — automated nudges (meal reminders, water, check-in)
 *   MILESTONE     — streak, workout count, and PR celebrations
 *   SYSTEM        — billing, app updates, critical/security alerts
 */

export enum NotificationCategory {
  /** Direct coach DMs, session reminders, coach-to-client messages. */
  COACH_DIRECT = 'COACH_DIRECT',

  /** Automated bot nudges: meal, water, daily check-in reminders. */
  CLIENT_BOT = 'CLIENT_BOT',

  /** Streak extensions, personal records, workout-count milestones. */
  MILESTONE = 'MILESTONE',

  /** Billing events, app updates, account security alerts. */
  SYSTEM = 'SYSTEM',
}

/** Default category applied when a call site does not specify one. */
export const DEFAULT_NOTIFICATION_CATEGORY = NotificationCategory.SYSTEM;
