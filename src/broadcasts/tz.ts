/**
 * Minimal, dependency-free IANA time-zone helpers (Intl only). Used by the
 * recurrence engine; quiet hours reuse QuietHoursPolicy (notifications/nudges)
 * so there is one definition of the 21:00-08:00 window.
 */

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sun..6=Sat
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(at: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(at);
  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? '';
  let hour = Number.parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  return {
    year: Number.parseInt(get('year'), 10),
    month: Number.parseInt(get('month'), 10),
    day: Number.parseInt(get('day'), 10),
    hour,
    minute: Number.parseInt(get('minute'), 10),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/**
 * The UTC instant at which the wall clock in `tz` reads
 * year-month-day hour:minute. Iterative offset resolution (two passes)
 * converges across DST changes. A wall time that does not exist (spring
 * forward gap) resolves to the instant just after the gap.
 */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const delta = target - seen;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

/** Days between two civil dates (y/m/d), ignoring time zones. */
export function civilDayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function civilFromDayNumber(n: number): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const d = new Date(n * 86_400_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
