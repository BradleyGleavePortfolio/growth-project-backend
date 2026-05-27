/**
 * Nudge v1 — Quiet-hours policy.
 *
 * Spec §4: never send between 9pm and 8am LOCAL user time. Schedule for
 * next morning if triggered overnight.
 *
 * Implementation: `Intl.DateTimeFormat` resolves the user's wall-clock
 * hour in their preferred timezone (NotificationPreferences.timezone,
 * default America/Los_Angeles). We compute the local hour-of-day on the
 * passed-in `now` instant and apply the window:
 *
 *   - hour < 8                  → defer until today's 8am local
 *   - hour >= 21                → defer until tomorrow's 8am local
 *   - otherwise                 → allow
 *
 * Defer instants are returned as a UTC `Date`. The next cron pass that
 * runs after this instant retries the candidate.
 */

import {
  NUDGE_QUIET_HOURS_END,
  NUDGE_QUIET_HOURS_START,
} from './nudge.types';

export interface QuietHoursDecision {
  allowed: boolean;
  /** When `allowed=false`, the next UTC instant at which the candidate may retry. */
  deferred_until?: Date;
}

export class QuietHoursPolicy {
  /**
   * Evaluate the quiet-hours window for a user in their local timezone.
   * Static so tests can exercise it without DI plumbing.
   */
  static evaluate(
    now: Date,
    timezone: string,
  ): QuietHoursDecision {
    const tz = isValidTimeZone(timezone) ? timezone : 'America/Los_Angeles';

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);

    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? '';

    // `hour` is 0..23 from { hour12: false }. Defensive: Intl returns "24"
    // for midnight in some Node builds; normalise.
    let hour = Number.parseInt(get('hour'), 10);
    if (Number.isNaN(hour)) hour = 12; // safe fallback — treat as allowed
    if (hour === 24) hour = 0;

    const year = Number.parseInt(get('year'), 10);
    const month = Number.parseInt(get('month'), 10);
    const day = Number.parseInt(get('day'), 10);

    if (hour >= NUDGE_QUIET_HOURS_END && hour < NUDGE_QUIET_HOURS_START) {
      return { allowed: true };
    }

    // Compute the next 8am local-time instant as a UTC Date.
    let targetYear = year;
    let targetMonth = month;
    let targetDay = day;

    if (hour >= NUDGE_QUIET_HOURS_START) {
      // Roll forward to tomorrow's 8am local.
      const next = new Date(Date.UTC(year, month - 1, day));
      next.setUTCDate(next.getUTCDate() + 1);
      targetYear = next.getUTCFullYear();
      targetMonth = next.getUTCMonth() + 1;
      targetDay = next.getUTCDate();
    }
    // else hour < 8 → defer to today's 8am local (already correct date parts).

    const deferred_until = localWallClockToUtc(
      targetYear,
      targetMonth,
      targetDay,
      NUDGE_QUIET_HOURS_END,
      0,
      tz,
    );
    return { allowed: false, deferred_until };
  }
}

/**
 * Convert a wall-clock instant (year/month/day/hour/minute in `tz`) to a
 * UTC Date. Iterative offset resolution handles DST cleanly without a
 * timezone library.
 */
function localWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  // Initial guess: pretend the wall clock IS UTC.
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  // Compute the offset between `guess` rendered in `tz` vs. its UTC
  // components, then subtract it. One iteration is enough except across
  // DST transitions, where two passes converge.
  for (let i = 0; i < 2; i++) {
    const localParts = formatTzParts(guess, tz);
    const localUtcEquivalent = Date.UTC(
      localParts.year,
      localParts.month - 1,
      localParts.day,
      localParts.hour,
      localParts.minute,
      0,
    );
    const wantedUtcEquivalent = Date.UTC(year, month - 1, day, hour, minute, 0);
    const offsetMs = localUtcEquivalent - wantedUtcEquivalent;
    if (offsetMs === 0) break;
    guess = new Date(guess.getTime() - offsetMs);
  }
  return guess;
}

function formatTzParts(
  d: Date,
  tz: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes): number =>
    Number.parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  let hour = get('hour');
  if (hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
  };
}

function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
