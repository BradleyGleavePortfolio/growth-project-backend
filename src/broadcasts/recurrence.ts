import { broadcastError } from './broadcast-errors';
import {
  civilDayNumber,
  civilFromDayNumber,
  daysInMonth,
  zonedParts,
  zonedWallTimeToUtc,
} from './tz';

/**
 * Recurrence rule (an RRULE subset that covers coaching cadences):
 *   freq          daily | weekly | monthly
 *   interval      every N days / weeks / months (1-12, default 1)
 *   local_time    "HH:MM" wall time in the broadcast's time zone
 *   by_weekday    weekly only: 0=Sun..6=Sat (default: the anchor's weekday)
 *   by_month_day  monthly only: 1-31; months without that day use their
 *                 last day (31 -> Feb 28/29), never skipped
 *   until         optional ISO instant; no occurrence after it
 *   count         optional 1-366 total occurrences
 *   anchor_date   "YYYY-MM-DD" civil date the interval counts from; set by
 *                 the server from the first occurrence, never trusted input
 */
export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly';

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  interval: number;
  local_time: string;
  by_weekday?: number[];
  by_month_day?: number;
  until?: string;
  count?: number;
  anchor_date?: string;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_SCAN_DAYS = 800;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate untrusted input. Throws broadcast.recurrence_invalid. */
export function parseRecurrence(input: unknown): RecurrenceRule {
  const bad = (reason: string) => broadcastError('broadcast.recurrence_invalid', { reason });
  if (!isPlainObject(input)) throw bad('not_an_object');
  const allowed = new Set([
    'freq',
    'interval',
    'local_time',
    'by_weekday',
    'by_month_day',
    'until',
    'count',
  ]);
  for (const k of Object.keys(input)) if (!allowed.has(k)) throw bad(`unknown_field:${k}`);
  const freq = input.freq;
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly') throw bad('freq');
  const interval = input.interval === undefined ? 1 : input.interval;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > 12)
    throw bad('interval');
  if (typeof input.local_time !== 'string' || !TIME_RE.test(input.local_time))
    throw bad('local_time');
  const rule: RecurrenceRule = { freq, interval, local_time: input.local_time };
  if (input.by_weekday !== undefined) {
    if (freq !== 'weekly') throw bad('by_weekday_needs_weekly');
    const days = input.by_weekday;
    if (!Array.isArray(days) || days.length === 0 || days.length > 7) throw bad('by_weekday');
    const set = new Set<number>();
    for (const d of days) {
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) throw bad('by_weekday');
      set.add(d);
    }
    rule.by_weekday = [...set].sort((a, b) => a - b);
  }
  if (input.by_month_day !== undefined) {
    if (freq !== 'monthly') throw bad('by_month_day_needs_monthly');
    const d = input.by_month_day;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 31) throw bad('by_month_day');
    rule.by_month_day = d;
  }
  if (input.until !== undefined) {
    if (typeof input.until !== 'string' || Number.isNaN(Date.parse(input.until)))
      throw bad('until');
    rule.until = new Date(input.until).toISOString();
  }
  if (input.count !== undefined) {
    const c = input.count;
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > 366) throw bad('count');
    rule.count = c;
  }
  return rule;
}

function anchorDay(rule: RecurrenceRule): number | null {
  if (!rule.anchor_date) return null;
  const m = DATE_RE.exec(rule.anchor_date);
  if (!m) return null;
  return civilDayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
}

function matchesDay(rule: RecurrenceRule, dayNum: number, anchor: number): boolean {
  const c = civilFromDayNumber(dayNum);
  if (dayNum < anchor) return false;
  if (rule.freq === 'daily') return (dayNum - anchor) % rule.interval === 0;
  if (rule.freq === 'weekly') {
    const a = civilFromDayNumber(anchor);
    const weekdays = rule.by_weekday ?? [a.weekday];
    if (!weekdays.includes(c.weekday)) return false;
    // Week index counted from the Sunday that starts the anchor's week.
    const anchorWeekStart = anchor - a.weekday;
    const week = Math.floor((dayNum - anchorWeekStart) / 7);
    return week % rule.interval === 0;
  }
  const a = civilFromDayNumber(anchor);
  const months = (c.year - a.year) * 12 + (c.month - a.month);
  if (months % rule.interval !== 0) return false;
  const want = rule.by_month_day ?? a.day;
  const effective = Math.min(want, daysInMonth(c.year, c.month));
  return c.day === effective;
}

/**
 * First occurrence strictly after `after` (an instant), or null when the rule
 * has ended (`until`). `count` is enforced by the caller, which tracks the
 * occurrences already sent. When the rule has no anchor yet, the local date
 * of `after` is the anchor.
 */
export function nextOccurrence(rule: RecurrenceRule, tz: string, after: Date): Date | null {
  const [hh, mm] = rule.local_time.split(':').map((x) => Number(x));
  const local = zonedParts(after, tz);
  const startDay = civilDayNumber(local.year, local.month, local.day);
  const anchor = anchorDay(rule) ?? startDay;
  const until = rule.until ? new Date(rule.until) : null;
  for (let n = Math.max(startDay - 1, anchor); n < startDay + MAX_SCAN_DAYS; n++) {
    if (!matchesDay(rule, n, anchor)) continue;
    const c = civilFromDayNumber(n);
    const at = zonedWallTimeToUtc(c.year, c.month, c.day, hh, mm, tz);
    if (at.getTime() <= after.getTime()) continue;
    if (until && at.getTime() > until.getTime()) return null;
    return at;
  }
  return null;
}

/** Civil "YYYY-MM-DD" of an instant in `tz` (used to pin the anchor). */
export function localDateString(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
