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

/**
 * Day of the hard lockout, counted from the first failed charge of the cycle
 * (Day 0). The owner's sequence: charges on Days 0/1/3/7 (Stripe's retry
 * schedule), access kept through Day 9, locked from Day 10.
 */
export const DUNNING_V2_LOCKOUT_DAY = 10;

/** One day in milliseconds. All cadence arithmetic is UTC instants. */
export const DUNNING_V2_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * v2 sweep cron (S-DUNNING). Runs HOURLY at minute 7 UTC (was a single daily
 * 02:00 UTC run). The sweep does two things, both idempotent and safe to
 * overlap across machines: it advances each active cycle to the step its
 * elapsed time calls for (sending that step's notices once, CAS-claimed on
 * DunningState.step_index), and it locks cycles that reached Day 10. Hourly
 * means the lockout lands within an hour of the Day-10 instant instead of up
 * to 24 hours late, and Day 1/3/7 notices still go out when Stripe's retry
 * does not produce a webhook (hard declines: Stripe schedules the retry but
 * does not execute it until a new payment method exists).
 */
export const DUNNING_V2_SWEEP_CRON_EXPRESSION = '7 * * * *';

/** Back-compat alias: the sweep cron (now hourly, see above). */
export const DUNNING_LOCKOUT_SWEEP_CRON_EXPRESSION = DUNNING_V2_SWEEP_CRON_EXPRESSION;

/**
 * The cadence step a cycle should be at after `elapsedMs` since its first
 * failure: Day 0 -> 0, Day 1 -> 1, Day 3 -> 2, Day 7 -> 3. Pure.
 */
export function dunningV2StepForElapsed(elapsedMs: number): number {
  let step = 0;
  for (let i = 0; i < DUNNING_V2_CADENCE_DAYS.length; i += 1) {
    if (elapsedMs >= DUNNING_V2_CADENCE_DAYS[i] * DUNNING_V2_DAY_MS) step = i;
  }
  return step;
}

/** The UTC instant a cycle that started at `cycleStart` locks (Day 10). */
export function dunningV2LockoutAt(cycleStart: Date): Date {
  return new Date(cycleStart.getTime() + DUNNING_V2_LOCKOUT_DAY * DUNNING_V2_DAY_MS);
}

/** Stable 403 error code returned by the lockout guard for non-billing routes. */
export const LOCKED_DUNNING_CODE = 'LOCKED_DUNNING';
