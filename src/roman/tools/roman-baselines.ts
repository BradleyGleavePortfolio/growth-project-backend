/**
 * personal_baselines (R11-W1): the client's "normal". Per metric, the median,
 * average and range of the 28 local days before the last 7, versus the last 7
 * days, all computed here (never by the model).
 *
 * TENANCY AND PII (T4): every query filters on the caller's id (the toolbox
 * passes `caller.id`, students only). Wearables go through summarizeWearables
 * (client_data's provider policy and day keys; sleep counts on the day it
 * ends). Flags use ADJUST_THRESHOLDS (src/roman-adjust/roman-adjust.rules.ts)
 * so Roman and approve-to-adjust read the same lines. Fewer than
 * ADJUST_THRESHOLDS.baselineMinDays (7) data days in the 28 -> not_enough_data,
 * no numbers. Day totals still growing today (steps, active kcal, protein)
 * end yesterday. A source over its row cap drops its oldest, incomplete days.
 */

import { PrismaService } from '../../prisma.service';
import { ADJUST_THRESHOLDS } from '../../roman-adjust/roman-adjust.rules';
import { addDays, dateOnly, localDateOf, localDayStart, summarizeWearables } from '../context/roman-client-context.service';

export const BASELINE_LIMITS = Object.freeze({
  recent_days: 7,
  baseline_days: 28,
  wearable_samples: 12_000,
  food_entries: 3_000,
  rows: 500,
});

const WEARABLE_METRICS = ['STEPS', 'ACTIVE_ENERGY_KCAL', 'RESTING_HEART_RATE_BPM', 'HRV_MS',
  'SLEEP_TOTAL_MIN', 'SLEEP_DURATION_MIN'] as const;

export type BaselineMetric = 'sleep_min' | 'hrv_ms' | 'resting_hr_bpm' | 'steps' | 'active_kcal'
  | 'weight_lbs' | 'protein_g' | 'sessions_per_week';
export type BaselineFlag = 'short' | 'below_normal' | 'above_normal';
type Digits = 0 | 1;
/** local YYYY-MM-DD -> that day's value */
type Series = Map<string, number>;

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const roundTo = (n: number, d: Digits) => (d === 1 ? Math.round(n * 10) / 10 : Math.round(n));

function stats(xs: readonly number[], d: Digits) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const r = (n: number) => roundTo(n, d);
  return { days: xs.length, median: r(median(xs)), mean: r(mean), min: r(Math.min(...xs)), max: r(Math.max(...xs)) };
}

/** The approve-to-adjust lines, applied to the shown (rounded) medians. */
export function baselineFlag(metric: BaselineMetric, normal: number, recent: number, recentDays: number) {
  const T = ADJUST_THRESHOLDS;
  if (recentDays < T.sleepMinNights) return null;
  const f = (flag: BaselineFlag, marked: boolean) => ({ flag, marked });
  switch (metric) {
    case 'sleep_min':
      return recent < T.sleepShortMin ? f('short', recent < T.sleepShortMarkedMin) : null;
    case 'hrv_ms': {
      const drop = normal > 0 ? ((normal - recent) / normal) * 100 : 0;
      return drop >= T.hrvDropPct ? f('below_normal', drop >= T.hrvDropMarkedPct) : null;
    }
    case 'resting_hr_bpm':
      return recent - normal >= T.rhrRiseBpm ? f('above_normal', recent - normal >= T.rhrRiseMarkedBpm) : null;
    case 'sessions_per_week':
      return normal > 0 && recent / normal >= T.loadRatio ? f('above_normal', false) : null;
    default:
      return null;
  }
}

const UNITS: Record<BaselineMetric, string> = { sleep_min: 'min', hrv_ms: 'ms', resting_hr_bpm: 'bpm', steps: 'steps',
  active_kcal: 'kcal', weight_lbs: 'lb', protein_g: 'g', sessions_per_week: 'workouts' };

export interface BaselineWindow {
  from: string;
  to: string;
  days: number;
  weeks?: number;
  count?: number;
  median?: number;
  mean?: number;
  min?: number;
  max?: number;
}
export interface BaselineRow {
  metric: BaselineMetric;
  unit: string;
  status: 'ok' | 'not_enough_data';
  data_days?: number;
  needed_days?: number;
  normal?: BaselineWindow;
  last_7?: BaselineWindow;
  change?: number | null;
  change_pct?: number | null;
  flag?: BaselineFlag | null;
  marked?: boolean;
}
interface Windows { normal_from: string; normal_to: string; last_from: string; last_to: string }

const notEnough = (metric: BaselineMetric, dataDays: number): BaselineRow => ({ metric, unit: UNITS[metric],
  status: 'not_enough_data', data_days: dataDays, needed_days: ADJUST_THRESHOLDS.baselineMinDays });

function compare(metric: BaselineMetric, normalXs: number[], recentXs: number[], d: Digits, w: Windows,
  recentDays = recentXs.length): BaselineRow {
  const normal = { from: w.normal_from, to: w.normal_to, ...stats(normalXs, d) };
  const head = { metric, unit: UNITS[metric], status: 'ok' as const, normal };
  if (recentXs.length === 0) return { ...head, last_7: { from: w.last_from, to: w.last_to, days: 0 }, change: null, flag: null };
  const last_7 = { from: w.last_from, to: w.last_to, ...stats(recentXs, d) };
  const change = roundTo(last_7.median - normal.median, d);
  const change_pct = normal.median ? Math.round((change / normal.median) * 100) : null;
  const f = baselineFlag(metric, normal.median, last_7.median, recentDays);
  return { ...head, last_7, change, change_pct, flag: f?.flag ?? null, marked: f?.marked ?? false };
}

const windowsEnding = (end: string): Windows => {
  const R = BASELINE_LIMITS.recent_days;
  const normal_from = addDays(end, 1 - R - BASELINE_LIMITS.baseline_days);
  return { normal_from, normal_to: addDays(end, -R), last_from: addDays(end, 1 - R), last_to: end };
};

/** Daily series: the 28 days before the last 7, both ending at `end`. */
function daily(metric: BaselineMetric, series: Series, end: string, after: string | null, d: Digits): BaselineRow {
  const w = windowsEnding(end);
  const pick = (from: string, to: string) =>
    [...series].filter(([day]) => day >= from && day <= to && (after === null || day > after)).map(([, v]) => v);
  const normalXs = pick(w.normal_from, w.normal_to);
  if (normalXs.length < ADJUST_THRESHOLDS.baselineMinDays) return notEnough(metric, normalXs.length);
  return compare(metric, normalXs, pick(w.last_from, w.last_to), d, w);
}

/** Workouts per week: the four 7-day blocks before the last 7, counting only blocks after sign-up. */
function sessions(days: readonly string[], today: string, signup: string, after: string | null): BaselineRow {
  const count = (from: string, to: string) => days.filter((day) => day >= from && day <= to).length;
  const w = windowsEnding(today);
  const weeks: number[] = [];
  for (let k = 1; k <= BASELINE_LIMITS.baseline_days / 7; k++) {
    const to = addDays(today, -7 * k);
    const from = addDays(to, -6);
    if (from >= signup && (after === null || from > after)) weeks.push(count(from, to));
  }
  if (weeks.length === 0) {
    // No full block since sign-up: fewer than 7 data days.
    const since = w.normal_to < signup ? 0 : Math.round((+dateOnly(w.normal_to) - +dateOnly(signup)) / 86_400_000) + 1;
    return notEnough('sessions_per_week', Math.min(since, BASELINE_LIMITS.baseline_days));
  }
  const n = count(w.last_from, today);
  const r = compare('sessions_per_week', weeks, [n], 1, w, BASELINE_LIMITS.recent_days);
  // A week is one value: say how many weeks the normal holds and the last 7 days' count.
  const from = addDays(w.normal_to, 1 - 7 * weeks.length);
  const normal = r.normal && { ...r.normal, from, days: weeks.length * 7, weeks: weeks.length };
  return { ...r, normal, last_7: { from: w.last_from, to: w.last_to, days: 7, count: n } };
}

function capped<R>(rows: R[], cap: number, dayOf: (r: R) => string, pad: number) {
  if (rows.length <= cap) return { kept: rows, after: null };
  const kept = rows.slice(0, cap);
  return { kept, after: addDays(dayOf(kept[cap - 1]), pad) };
}

const ymdOf = (d: Date) => d.toISOString().slice(0, 10);

export async function readBaselines(prisma: PrismaService, callerId: string, tz: string, today: string) {
  const yesterday = addDays(today, -1);
  const first = addDays(yesterday, 1 - BASELINE_LIMITS.recent_days - BASELINE_LIMITS.baseline_days);
  const dates = { gte: dateOnly(first), lte: dateOnly(today) };
  const take = BASELINE_LIMITS.rows + 1;
  const [user, samples, weights, foods, workouts] = await Promise.all([
    prisma.user.findUnique({
      where: { id: callerId },
      select: { created_at: true, wearable_metric_preferences: {
        where: { metric: { in: [...WEARABLE_METRICS] } }, select: { metric: true, preferred_provider: true } } },
    }),
    prisma.wearableSample.findMany({
      where: { user_id: callerId, metric: { in: [...WEARABLE_METRICS] },
        // One extra day before: sleep counts on the day it ends.
        start_at: { gte: localDayStart(addDays(first, -1), tz), lt: localDayStart(addDays(today, 1), tz) } },
      orderBy: { start_at: 'desc' },
      take: BASELINE_LIMITS.wearable_samples + 1,
      select: { metric: true, provider: true, value: true, start_at: true, end_at: true, recorded_at: true, source_tz: true },
    }),
    prisma.weightLog.findMany({ where: { user_id: callerId, date: dates }, orderBy: { date: 'desc' }, take,
      select: { date: true, weight_lbs: true } }),
    prisma.loggedFoodEntry.findMany({
      where: { user_id: callerId, date: { gte: dates.gte, lte: dateOnly(yesterday) } },
      orderBy: { date: 'desc' },
      take: BASELINE_LIMITS.food_entries + 1,
      select: { date: true, quantity_multiplier: true, food_item: { select: { protein_g: true } } },
    }),
    prisma.workoutSession.findMany({ where: { user_id: callerId, date: dates }, orderBy: { date: 'desc' }, take,
      select: { date: true } }),
  ]);
  const dayOf = localDateOf(tz);
  // A partly read day can also miss the sleep that ends the next morning.
  const wear = capped(samples, BASELINE_LIMITS.wearable_samples, (s) => dayOf(s.start_at), 1);
  const rows = wear.kept.map((s) => ({ ...s, metric: String(s.metric), provider: String(s.provider) }));
  const preferences = (user?.wearable_metric_preferences ?? [])
    .map((p) => ({ metric: String(p.metric), preferred_provider: String(p.preferred_provider) }));
  const w: Record<'sleep_min' | 'hrv_ms' | 'resting_hr_bpm' | 'steps' | 'active_kcal', Series> = {
    sleep_min: new Map(), hrv_ms: new Map(), resting_hr_bpm: new Map(), steps: new Map(), active_kcal: new Map() };
  // summarizeWearables covers 7 local days ending at `end`; walk back in 7-day steps.
  for (let end = today; end >= first; end = addDays(end, -7)) {
    for (const day of summarizeWearables([], rows, end, tz, { preferences, complete: true }).days) {
      if (day.date < first) continue;
      if (day.sleep_hours !== null) w.sleep_min.set(day.date, Math.round(day.sleep_hours * 60));
      if (day.hrv_ms !== null) w.hrv_ms.set(day.date, day.hrv_ms);
      if (day.resting_hr_bpm !== null) w.resting_hr_bpm.set(day.date, day.resting_hr_bpm);
      if (day.steps !== null) w.steps.set(day.date, day.steps);
      if (day.active_kcal !== null) w.active_kcal.set(day.date, day.active_kcal);
    }
  }
  const wt = capped(weights, BASELINE_LIMITS.rows, (r) => ymdOf(r.date), 0);
  const perDay = new Map<string, number[]>();
  for (const r of wt.kept) perDay.set(ymdOf(r.date), [...(perDay.get(ymdOf(r.date)) ?? []), r.weight_lbs]);
  const weight: Series = new Map([...perDay].map(([d, xs]) => [d, xs.reduce((a, b) => a + b, 0) / xs.length]));
  const fd = capped(foods, BASELINE_LIMITS.food_entries, (r) => ymdOf(r.date), 0);
  const protein: Series = new Map();
  for (const e of fd.kept) protein.set(ymdOf(e.date), (protein.get(ymdOf(e.date)) ?? 0) + e.food_item.protein_g * e.quantity_multiplier);
  for (const [d, g] of protein) protein.set(d, Math.round(g));
  const wo = capped(workouts, BASELINE_LIMITS.rows, (r) => ymdOf(r.date), 0);
  const signup = user ? dayOf(user.created_at) : today;
  const metrics: BaselineRow[] = [
    daily('sleep_min', w.sleep_min, today, wear.after, 0),
    daily('hrv_ms', w.hrv_ms, today, wear.after, 0),
    daily('resting_hr_bpm', w.resting_hr_bpm, today, wear.after, 0),
    daily('steps', w.steps, yesterday, wear.after, 0),
    daily('active_kcal', w.active_kcal, yesterday, wear.after, 0),
    daily('weight_lbs', weight, today, wt.after, 1),
    daily('protein_g', protein, yesterday, fd.after, 0),
    sessions(wo.kept.map((r) => ymdOf(r.date)), today, signup, wo.after),
  ];
  const truncated = [wear, wt, fd, wo].some((c) => c.after !== null);
  return { metrics, truncated };
}

/** Active kcal numbers shown (earlier days or averages): the post-check's burned_past facts. */
export function burnedFacts(metrics: readonly BaselineRow[]): number[] {
  const out: number[] = [];
  for (const m of metrics) {
    if (m.metric !== 'active_kcal' || m.status !== 'ok') continue;
    for (const s of [m.normal, m.last_7]) {
      for (const v of [s?.median, s?.mean, s?.min, s?.max]) if (typeof v === 'number') out.push(v);
    }
  }
  return out;
}
