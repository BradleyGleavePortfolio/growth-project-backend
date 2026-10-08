import { KG_PER_LB } from '../macros/macro-calculator';

/**
 * CF-NOTIF-DIGEST-128 (FW-NOTIF-128 U6): the numbers a client digest email
 * states, computed from the client's own rows. Pure functions, no I/O.
 *
 * Check-in and weigh-in dates are date-only columns (UTC midnight of the
 * calendar day), so every comparison here is on UTC calendar days.
 */

const DAY_MS = 86_400_000;

/** The digest counts the seven complete days before the send day. */
export const DIGEST_WINDOW_DAYS = 7;

export type DigestWeightUnit = 'kg' | 'lbs';

/** UTC midnight of the calendar day `now` falls on. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The seven complete days before the send day: `start` is inclusive, `end`
 * (the send day's UTC midnight) is exclusive. The send day itself is left out
 * because it has barely begun when the digest goes out, so "of 7" never
 * reads 8 of 7.
 */
export function digestWindow(now: Date): { start: Date; end: Date } {
  const end = utcDayStart(now);
  return { start: new Date(end.getTime() - DIGEST_WINDOW_DAYS * DAY_MS), end };
}

function dayNumber(d: Date): number {
  return Math.floor(utcDayStart(d).getTime() / DAY_MS);
}

/** Distinct calendar days in [start, end) that carry a check-in. */
export function checkInDaysInWindow(dates: readonly Date[], start: Date, end: Date): number {
  const from = dayNumber(start);
  const to = dayNumber(end);
  const days = new Set(dates.map(dayNumber).filter((n) => n >= from && n < to));
  return days.size;
}

/**
 * Check-in streaks in consecutive calendar days.
 *   current: the run that ends on the send day or the day before (the send
 *            day has barely begun), else 0.
 *   best:    the longest run in the dates given.
 */
export function checkInStreaks(dates: readonly Date[], now: Date): { current: number; best: number } {
  const days = [...new Set(dates.map(dayNumber))].sort((a, b) => b - a);
  if (days.length === 0) return { current: 0, best: 0 };
  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i - 1] - days[i] === 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  const today = dayNumber(now);
  let current = 0;
  if (days[0] === today || days[0] === today - 1) {
    current = 1;
    while (current < days.length && days[current - 1] - days[current] === 1) current += 1;
  }
  return { current, best };
}

/** The profile's display unit for weight ('kg' or 'lbs'; anything else is lbs). */
export function digestWeightUnit(profileUnit: string | null | undefined): DigestWeightUnit {
  return profileUnit === 'kg' ? 'kg' : 'lbs';
}

function inUnit(lbs: number, unit: DigestWeightUnit): number {
  const v = unit === 'kg' ? lbs * KG_PER_LB : lbs;
  // Math.round(-0.4) is -0; adding 0 turns it into 0 so it never prints "-0.0".
  return Math.round(v * 10) / 10 + 0;
}

/** A logged weight (stored in lbs) in the client's unit: "182.4 lbs", "82.7 kg". */
export function formatWeight(lbs: number, unit: DigestWeightUnit): string {
  return `${inUnit(lbs, unit).toFixed(1)} ${unit}`;
}

/**
 * The change from the first to the last weigh-in, in the client's unit:
 * "+1.2 lbs", "-0.5 kg", "0.0 lbs". Null with fewer than two weigh-ins.
 */
export function formatWeightChange(
  weighInsOldestFirst: readonly number[],
  unit: DigestWeightUnit,
): string | null {
  if (weighInsOldestFirst.length < 2) return null;
  const delta = inUnit(weighInsOldestFirst[weighInsOldestFirst.length - 1] - weighInsOldestFirst[0], unit);
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)} ${unit}`;
}
