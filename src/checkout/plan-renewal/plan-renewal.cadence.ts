import { localDayNumber } from '../../notifications/local-time';

/**
 * RENEWAL-BE: the plan-renewal sequence a client gets after a plan with their
 * coach ends normally (a fixed-term package ran out, or a subscription ended
 * or was cancelled). Failed payments never enter it: Smart Dunning v2 owns
 * them.
 *
 * Owner #RENEWAL-PUSH (10-21): Day 0 and Day 1 are in-app pop-ups, Day 7 is
 * the one app notification (two buttons: the coach's packages, or TGP's house
 * coach). Days are the client's local calendar days; Day 0 is the day the plan
 * ends. A pop-up shows on the first app open of its day; a day the client
 * never opens the app is skipped, not stacked.
 *
 * FEATURE_PLAN_RENEWAL (default OFF; only "true" turns it on): off means no
 * sequence opens, nothing is sent, and the entitlement answer carries no
 * `renewal` block.
 */
export const FEATURE_PLAN_RENEWAL_ENV = 'FEATURE_PLAN_RENEWAL';

export function isPlanRenewalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[FEATURE_PLAN_RENEWAL_ENV] ?? '').toLowerCase() === 'true';
}

export const PLAN_RENEWAL_DAY_MS = 24 * 60 * 60 * 1000;

/** The pop-up days; the one app notification goes out on PLAN_RENEWAL_PUSH_DAY. */
export const PLAN_RENEWAL_POPUP_DAYS: readonly number[] = [0, 1];
export const PLAN_RENEWAL_PUSH_DAY = 7;

/** A plan that ended longer ago than this never opens a sequence (Day 7 + one day to send it). */
export const PLAN_RENEWAL_OPEN_WINDOW_MS = 8 * PLAN_RENEWAL_DAY_MS;

/** Hourly at minute 17 UTC (dunning v2 runs at minute 7). */
export const PLAN_RENEWAL_SWEEP_CRON = '17 * * * *';

/** Local calendar days from the day the plan ended to `now`, in `tz` (UTC when the client's zone is unknown). */
export function planRenewalDay(endedAt: Date, now: Date, tz: string | null): number {
  return localDayNumber(now, tz ?? 'UTC') - localDayNumber(endedAt, tz ?? 'UTC');
}

/** HOUSE_COACH_USER_ID: TGP's house coach (the second choice). Unset = the choice is never offered. */
export const houseCoachUserId = (env: NodeJS.ProcessEnv = process.env): string | null =>
  env.HOUSE_COACH_USER_ID?.trim() || null;
