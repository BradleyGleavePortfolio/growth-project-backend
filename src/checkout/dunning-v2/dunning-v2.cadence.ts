/**
 * B3 Smart Dunning v2 — cadence config + state-machine vocabulary.
 *
 * Operator-locked cadence (spec §3.1): 5 conceptual steps over 4 charge
 * attempts plus a terminal lockout day. Charge attempts at Days 0/1/3/7; Day 10
 * is a separate terminal sweep (§7), NOT a cadence charge step.
 *
 *   Day | step | charge | client push | client email | in-app blocker | coach
 *   ----|------|--------|-------------|--------------|----------------|------
 *    0  |  0   | YES    | on fail     | —            | —              | —
 *    1  |  1   | retry  | YES         | YES          | —              | —
 *    3  |  2   | retry  | YES         | YES          | YES (pop-up)   | —
 *    7  |  3   | retry  | YES         | YES          | YES (pop-up)   | YES (3-ch)
 *   10  | sweep| NO     | —           | —            | LOCKED OUT     | (already)
 *
 * IMPORTANT: this file does NOT touch v1's DEFAULT_DUNNING_CADENCE constant in
 * `dunning.service.ts`. v2 declares its own immutable cadence so v1 stays the
 * active default until FEATURE_DUNNING_V2 flips. The numbers below are locked:
 * `[0, 1, 3, 7]` charge offsets + a `+3 days` lockout sweep at Day 10.
 */

/** v2 dunning lifecycle states (spec §1 state-machine vocabulary). */
export type DunningV2State = 'INACTIVE' | 'ACTIVE' | 'LOCKED' | 'RECOVERED';

/** The four charge-attempt day offsets, from first failure. LOCKED numbers. */
export const DUNNING_V2_CADENCE_DAYS: readonly number[] = [0, 1, 3, 7] as const;

/** Days after the Day-7 final step before the hard lockout fires (Day 10). */
export const DUNNING_V2_LOCKOUT_GRACE_DAYS = 3;

/** The Day-7 final-charge step index — the row eligible for the lockout sweep. */
export const DUNNING_V2_FINAL_STEP_INDEX = 3;

/**
 * Compressed late-reversal cadence (spec §6.2): a reversal does NOT restart at
 * Day 0. It enters at Step 2 (Day-3-equivalent) immediately, coach-notify at
 * the Day-7-equivalent (+4 days), lockout at the Day-10-equivalent (+3 days).
 * Steps 0 and 1 are skipped entirely.
 */
export const DUNNING_V2_REVERSAL_ENTRY_STEP = 2;
export const DUNNING_V2_REVERSAL_COACH_GAP_DAYS = 4;
export const DUNNING_V2_REVERSAL_LOCKOUT_GAP_DAYS = 3;

/** Daily lockout-sweep cron (spec §7.1). Fixed 02:00 UTC, not the tick loop. */
export const DUNNING_LOCKOUT_SWEEP_CRON_EXPRESSION = '0 2 * * *';

/** Stable 403 error code returned by the lockout guard for non-billing routes. */
export const LOCKED_DUNNING_CODE = 'LOCKED_DUNNING';
