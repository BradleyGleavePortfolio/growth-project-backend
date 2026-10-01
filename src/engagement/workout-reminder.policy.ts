/**
 * Workout reminder policy (C05 item 7). Pure functions, no I/O.
 *
 * When: the client's preferred training time (consultation S2) in the
 * client's own timezone, on the first session day (C1) and on every day that
 * has a scheduled plan workout. All comparisons are on client-local wall-clock
 * time, so DST changes move the UTC instant, never the local time.
 */

export const DEFAULT_REMINDER_TIMEZONE = 'America/Los_Angeles';

/**
 * S2 answer -> local minute-of-day the reminder goes out. 'varies' and an
 * unanswered S2 get a mid-morning nudge for the day.
 */
export const REMINDER_SLOT_MINUTES: Readonly<Record<string, number>> = {
  morning: 7 * 60, // 07:00
  midday: 11 * 60 + 30, // 11:30
  evening: 17 * 60, // 17:00
  varies: 9 * 60, // 09:00
};
export const DEFAULT_SLOT = 'varies';

/**
 * How long after the slot a reminder may still go out. Lets a restart or a
 * missed cron tick catch up without sending an evening reminder at midnight.
 */
export const REMINDER_SEND_WINDOW_MINUTES = 180;

export function slotFor(preferredTime: string | null | undefined): string {
  return preferredTime && preferredTime in REMINDER_SLOT_MINUTES ? preferredTime : DEFAULT_SLOT;
}

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimezone(tz: unknown): string {
  return isValidTimezone(tz) ? tz : DEFAULT_REMINDER_TIMEZONE;
}

export interface LocalClock {
  /** Client-local calendar date, YYYY-MM-DD. */
  date: string;
  /** Client-local minutes since midnight, 0..1439. */
  minutes: number;
}

export function localClock(now: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = Number(get('hour')) % 24;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  };
}

/** Plan dates are date-only (UTC midnight of the calendar day). */
export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function dateFromKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

export interface ReminderInputs {
  now: Date;
  timezone: string;
  preferredTime: string | null;
  /** C1, YYYY-MM-DD, or null. */
  firstSessionDate: string | null;
  /** Calendar dates (YYYY-MM-DD) that carry a scheduled plan workout. */
  planDates: ReadonlySet<string>;
}

export type ReminderDecision =
  | { send: true; localDate: string; slot: string; firstDay: boolean }
  | {
      send: false;
      reason: 'not_plan_day' | 'before_slot' | 'window_passed' | 'before_first_session';
      localDate: string;
    };

export function decideReminder(input: ReminderInputs): ReminderDecision {
  const clock = localClock(input.now, input.timezone);
  const slot = slotFor(input.preferredTime);
  const firstDay = input.firstSessionDate === clock.date;
  if (input.firstSessionDate && clock.date < input.firstSessionDate) {
    return { send: false, reason: 'before_first_session', localDate: clock.date };
  }
  if (!firstDay && !input.planDates.has(clock.date)) {
    return { send: false, reason: 'not_plan_day', localDate: clock.date };
  }
  const target = REMINDER_SLOT_MINUTES[slot];
  if (clock.minutes < target) return { send: false, reason: 'before_slot', localDate: clock.date };
  if (clock.minutes > target + REMINDER_SEND_WINDOW_MINUTES) {
    return { send: false, reason: 'window_passed', localDate: clock.date };
  }
  return { send: true, localDate: clock.date, slot, firstDay };
}

// ── Copy: Roman's butler voice. Short, warm, no medical claims, no
// exclamation marks, no emojis (Quiet Luxury doctrine). ─────────────────────

export const REMINDER_TITLE = 'From Roman';

export const FIRST_DAY_BODY =
  'Your first session is today. Everything is laid out and ready when you are.';

export const PLAN_DAY_BODIES: readonly string[] = [
  "Today's session is ready when you are. Everything is laid out.",
  'A gentle reminder: your session is on the plan for today.',
  'Your session is waiting for you today. Take it at your own pace.',
];

export function reminderCopy(
  localDate: string,
  firstDay: boolean,
): { title: string; body: string } {
  if (firstDay) return { title: REMINDER_TITLE, body: FIRST_DAY_BODY };
  // Deterministic rotation by date so a retry never changes the wording.
  const day = Math.floor(dateFromKey(localDate).getTime() / 86_400_000);
  const body =
    PLAN_DAY_BODIES[
      ((day % PLAN_DAY_BODIES.length) + PLAN_DAY_BODIES.length) % PLAN_DAY_BODIES.length
    ];
  return { title: REMINDER_TITLE, body };
}
