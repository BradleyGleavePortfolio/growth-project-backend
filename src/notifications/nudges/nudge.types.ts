/**
 * Nudge v1 — shared types.
 *
 * Behavioral re-engagement subsystem. NOT dunning (payment-failure
 * domain owned by src/checkout/dunning.service.ts). NOT marketing.
 *
 * Tone standard (per design intelligence brief Part II): calm, premium,
 * lifestyle. Never guilt-trip. Streak loss framed as "your practice has
 * been quiet" — not "you broke your streak". See copy.ts.
 */

export const NudgeTriggerType = {
  MISSED_CHECKIN: 'missed_checkin',
  STREAK_BROKEN: 'streak_broken',
  ONBOARDING_ABANDONED: 'onboarding_abandoned',
  INACTIVE: 'inactive',
} as const;
export type NudgeTriggerType =
  (typeof NudgeTriggerType)[keyof typeof NudgeTriggerType];

/** Every nudge decision lands in NudgeLog under exactly one of these statuses. */
export const NudgeStatus = {
  SENT: 'sent',
  SUPPRESSED_CAP: 'suppressed_cap',
  SUPPRESSED_QUIET_HOURS: 'suppressed_quiet_hours',
  SUPPRESSED_OPT_OUT: 'suppressed_opt_out',
  SUPPRESSED_MUTED: 'suppressed_muted',
  SUPPRESSED_DEDUPE: 'suppressed_dedupe',
  DEFERRED: 'deferred',
  FAILED: 'failed',
} as const;
export type NudgeStatus = (typeof NudgeStatus)[keyof typeof NudgeStatus];

/** Channel descriptors. Match Notification.channel column values. */
export type NudgeChannel = 'inapp' | 'email' | 'push';

/**
 * A candidate is a deterministic "we *might* want to nudge this user
 * for this reason today" record produced by a detector. The engine then
 * walks it through the suppression / delivery gates.
 */
export interface NudgeCandidate {
  user_id: string;
  trigger_type: NudgeTriggerType;
  /**
   * Deterministic per-event id. Two scans that observe the same event
   * must produce the same signal_key so the unique index on
   * NudgeLog(user_id, trigger_type, signal_key) dedupes correctly.
   * Format suggestion: `<trigger>:<YYYY-MM-DD>[:<context>]`.
   */
  signal_key: string;
  /** Optional context surfaced into the rendered copy (e.g. first name). */
  context?: Record<string, unknown>;
}

/**
 * The outcome of one engine pass over a candidate. Returned to detectors
 * for tests and to the scheduler for log aggregation.
 */
export interface NudgeOutcome {
  status: NudgeStatus;
  channels: NudgeChannel[];
  log_id?: string;
  deferred_until?: Date;
}

/** Hard cap (spec §3). Tested explicitly so a future tweak fails loudly. */
export const NUDGE_FREQUENCY_CAP_MS = 48 * 60 * 60 * 1000;

/** Quiet hours (spec §4). Local clock, user timezone. */
export const NUDGE_QUIET_HOURS_START = 21; // 9pm — first hour of suppression
export const NUDGE_QUIET_HOURS_END = 8;   // 8am — first hour open again
