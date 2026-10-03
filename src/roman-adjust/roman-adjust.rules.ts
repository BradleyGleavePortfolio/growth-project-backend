/**
 * Roman approve-to-adjust: the deterministic recovery rule (rule v1).
 *
 * Pure functions only: no I/O, no clock, no model. The same inputs always
 * give the same proposal, so a coach can trust that Roman never "makes up"
 * a reason, and every proposal can be reproduced from its stored signals.
 *
 * Inputs: the client's wearable samples (last 31 days) and their completed
 * workouts (last 35 days). Output: either no proposal, or a proposal to trim
 * the next workout's set volume by 15% (moderate) or 25% (marked), with the
 * exact set-by-set change and the Roman-voiced sentence the coach sees.
 *
 * Personal training only: the rule speaks about recovery and training load,
 * never about illness, diagnosis or treatment.
 */

export const ADJUST_RULE_KEY = 'recovery_volume';
export const ADJUST_RULE_VERSION = 1;

/** Thresholds, named so the spec and the coach-facing docs quote one source. */
export const ADJUST_THRESHOLDS = {
  recentDays: 3,
  baselineMinDays: 7,
  hrvDropPct: 15,
  hrvDropMarkedPct: 25,
  rhrRiseBpm: 5,
  rhrRiseMarkedBpm: 8,
  sleepShortMin: 360,
  sleepShortMarkedMin: 300,
  sleepMinNights: 2,
  readinessLow: 60,
  readinessDropPoints: 10,
  readinessLowMarked: 45,
  loadRatio: 1.5,
  highEffortRpe: 9,
  moderatePct: 15,
  markedPct: 25,
} as const;

export type AdjustSignalKey =
  | 'hrv_drop'
  | 'rhr_rise'
  | 'short_sleep'
  | 'low_readiness'
  | 'load_spike'
  | 'high_effort';

export interface AdjustSignal {
  key: AdjustSignalKey;
  marked: boolean;
  /** The measured value, in the unit the phrase uses. */
  value: number;
  /** The comparison value (baseline), when there is one. */
  baseline: number | null;
}

export interface AdjustSample {
  metric: string;
  value: number;
  start_at: Date;
  end_at: Date;
}

export interface AdjustCompletion {
  completed_at: Date;
  post_rpe: number | null;
}

export interface AdjustExercise {
  exercise_external_id: string;
  order: number;
  sets: number;
  reps_or_duration_seconds: number;
  weight_lbs: number | null;
  rest_seconds: number | null;
  superset_group_id: string | null;
  notes: string | null;
}

export interface AdjustExerciseChange {
  order: number;
  exercise_external_id: string;
  sets_before: number;
  sets_after: number;
}

export interface AdjustChange {
  volume_pct: number;
  sets_before: number;
  sets_after: number;
  exercises: AdjustExerciseChange[];
}

/** Local calendar date (YYYY-MM-DD) of `d` in `timeZone`; UTC on a bad zone. */
export function localDate(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function addDays(ymd: string, days: number): string {
  const t = Date.parse(`${ymd}T12:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

type Daily = Map<string, number>;

/**
 * Per-day aggregates by the client's local date: HRV mean, resting heart rate
 * minimum, total sleep minutes (by wake day), readiness mean (readiness,
 * falling back to recovery score).
 */
export function dailySeries(
  samples: readonly AdjustSample[],
  timeZone: string,
): { hrv: Daily; rhr: Daily; sleep: Daily; readiness: Daily } {
  const buckets: Record<'hrv' | 'rhr' | 'sleep' | 'readiness' | 'recovery', Map<string, number[]>> = {
    hrv: new Map(),
    rhr: new Map(),
    sleep: new Map(),
    readiness: new Map(),
    recovery: new Map(),
  };
  const push = (k: keyof typeof buckets, day: string, v: number) => {
    const arr = buckets[k].get(day) ?? [];
    arr.push(v);
    buckets[k].set(day, arr);
  };
  for (const s of samples) {
    if (!Number.isFinite(s.value)) continue;
    switch (s.metric) {
      case 'HRV_MS':
        if (s.value > 0) push('hrv', localDate(s.start_at, timeZone), s.value);
        break;
      case 'RESTING_HEART_RATE_BPM':
        if (s.value > 20) push('rhr', localDate(s.start_at, timeZone), s.value);
        break;
      case 'SLEEP_TOTAL_MIN':
      case 'SLEEP_DURATION_MIN':
        if (s.value > 0) push('sleep', localDate(s.end_at, timeZone), s.value);
        break;
      case 'READINESS_SCORE':
        push('readiness', localDate(s.start_at, timeZone), s.value);
        break;
      case 'RECOVERY_SCORE':
        push('recovery', localDate(s.start_at, timeZone), s.value);
        break;
      default:
        break;
    }
  }
  const reduce = (m: Map<string, number[]>, f: (xs: number[]) => number): Daily =>
    new Map([...m].map(([d, xs]) => [d, f(xs)]));
  const readiness = reduce(buckets.readiness, (xs) => mean(xs) ?? 0);
  for (const [d, v] of reduce(buckets.recovery, (xs) => mean(xs) ?? 0)) {
    if (!readiness.has(d)) readiness.set(d, v);
  }
  return {
    hrv: reduce(buckets.hrv, (xs) => mean(xs) ?? 0),
    rhr: reduce(buckets.rhr, (xs) => Math.min(...xs)),
    // Two providers can both report a night; take the longer, never the sum.
    sleep: reduce(buckets.sleep, (xs) => Math.max(...xs)),
    readiness,
  };
}

function windowValues(series: Daily, from: string, to: string): number[] {
  const out: number[] = [];
  for (const [d, v] of series) if (d >= from && d <= to) out.push(v);
  return out;
}

export interface EvaluateInput {
  samples: readonly AdjustSample[];
  completions: readonly AdjustCompletion[];
  now: Date;
  timeZone: string;
}

/** Every signal the rule can see, before the decision. */
export function evaluateSignals(input: EvaluateInput): AdjustSignal[] {
  const T = ADJUST_THRESHOLDS;
  const today = localDate(input.now, input.timeZone);
  const recentFrom = addDays(today, -(T.recentDays - 1));
  const baseFrom = addDays(today, -30);
  const baseTo = addDays(today, -T.recentDays);
  const s = dailySeries(input.samples, input.timeZone);
  const out: AdjustSignal[] = [];

  const recentBase = (series: Daily) => {
    const recent = mean(windowValues(series, recentFrom, today));
    const baseVals = windowValues(series, baseFrom, baseTo);
    const base = baseVals.length >= T.baselineMinDays ? mean(baseVals) : null;
    return { recent, base };
  };

  const hrv = recentBase(s.hrv);
  if (hrv.recent !== null && hrv.base !== null && hrv.base > 0) {
    const drop = ((hrv.base - hrv.recent) / hrv.base) * 100;
    if (drop >= T.hrvDropPct) {
      out.push({ key: 'hrv_drop', marked: drop >= T.hrvDropMarkedPct, value: Math.round(drop), baseline: Math.round(hrv.base) });
    }
  }

  const rhr = recentBase(s.rhr);
  if (rhr.recent !== null && rhr.base !== null) {
    const rise = rhr.recent - rhr.base;
    if (rise >= T.rhrRiseBpm) {
      out.push({ key: 'rhr_rise', marked: rise >= T.rhrRiseMarkedBpm, value: Math.round(rise), baseline: Math.round(rhr.base) });
    }
  }

  const nights = windowValues(s.sleep, recentFrom, today);
  if (nights.length >= T.sleepMinNights) {
    const avg = mean(nights) ?? 0;
    if (avg < T.sleepShortMin) {
      out.push({ key: 'short_sleep', marked: avg < T.sleepShortMarkedMin, value: round1(avg / 60), baseline: null });
    }
  }

  const rd = recentBase(s.readiness);
  if (rd.recent !== null && rd.base !== null && rd.recent <= T.readinessLow && rd.base - rd.recent >= T.readinessDropPoints) {
    out.push({ key: 'low_readiness', marked: rd.recent <= T.readinessLowMarked, value: Math.round(rd.recent), baseline: Math.round(rd.base) });
  }

  // Training load: session-RPE units (sum of post-workout RPE). Acute = the
  // last 7 days, chronic = the weekly average of the 4 weeks before that.
  const rated = input.completions.filter((c) => c.post_rpe !== null && c.post_rpe > 0);
  const day = (c: AdjustCompletion) => localDate(c.completed_at, input.timeZone);
  const acuteFrom = addDays(today, -6);
  const chronicFrom = addDays(today, -34);
  const acute = rated.filter((c) => day(c) >= acuteFrom).reduce((a, c) => a + (c.post_rpe ?? 0), 0);
  const chronicWeekly =
    rated.filter((c) => day(c) >= chronicFrom && day(c) < acuteFrom).reduce((a, c) => a + (c.post_rpe ?? 0), 0) / 4;
  if (chronicWeekly > 0 && acute / chronicWeekly >= T.loadRatio) {
    out.push({ key: 'load_spike', marked: false, value: round1(acute / chronicWeekly), baseline: round1(chronicWeekly) });
  }
  const lastThree = [...rated]
    .sort((a, b) => b.completed_at.getTime() - a.completed_at.getTime())
    .slice(0, 3)
    .filter((c) => day(c) >= acuteFrom);
  if (lastThree.length === 3) {
    const avg = mean(lastThree.map((c) => c.post_rpe ?? 0)) ?? 0;
    if (avg >= T.highEffortRpe) out.push({ key: 'high_effort', marked: false, value: round1(avg), baseline: null });
  }
  return out;
}

const RECOVERY_KEYS: ReadonlySet<AdjustSignalKey> = new Set(['hrv_drop', 'rhr_rise', 'short_sleep', 'low_readiness']);

/**
 * The decision. At least two independent recovery signals, or one recovery
 * signal plus a training-load signal, are needed: one noisy night never
 * triggers a change on its own, and load alone (no wearable evidence) is the
 * coach's normal programming, not Roman's business.
 */
export function decideVolumeCut(signals: readonly AdjustSignal[]): { severity: 'moderate' | 'marked'; volume_pct: number } | null {
  const recovery = signals.filter((s) => RECOVERY_KEYS.has(s.key));
  const load = signals.filter((s) => !RECOVERY_KEYS.has(s.key));
  if (!(recovery.length >= 2 || (recovery.length >= 1 && load.length >= 1))) return null;
  const marked = recovery.some((s) => s.marked) || recovery.length + load.length >= 3;
  return marked
    ? { severity: 'marked', volume_pct: ADJUST_THRESHOLDS.markedPct }
    : { severity: 'moderate', volume_pct: ADJUST_THRESHOLDS.moderatePct };
}

/**
 * Trim total sets by `pct` percent. Sets come off the exercise with the most
 * sets first (the later exercise on a tie, so the opening lifts stay), never
 * below one set per exercise. Reps, load and rest are untouched: the coach's
 * prescription keeps its shape, there is just less of it.
 */
export function cutVolume(exercises: readonly AdjustExercise[], pct: number): AdjustChange {
  const ordered = [...exercises].sort((a, b) => a.order - b.order);
  const before = ordered.reduce((a, e) => a + e.sets, 0);
  const target = Math.max(ordered.length, Math.round(before * (1 - pct / 100)));
  const sets = ordered.map((e) => e.sets);
  let total = before;
  while (total > target) {
    let idx = -1;
    for (let i = 0; i < sets.length; i += 1) {
      if (sets[i] > 1 && (idx === -1 || sets[i] >= sets[idx])) idx = i;
    }
    if (idx === -1) break;
    sets[idx] -= 1;
    total -= 1;
  }
  return {
    volume_pct: pct,
    sets_before: before,
    sets_after: total,
    exercises: ordered.map((e, i) => ({
      order: e.order,
      exercise_external_id: e.exercise_external_id,
      sets_before: e.sets,
      sets_after: sets[i],
    })),
  };
}

/** Apply explicit per-exercise set counts (the coach's Edit). */
export function setsChange(
  exercises: readonly AdjustExercise[],
  sets: ReadonlyMap<number, number>,
): AdjustChange {
  const ordered = [...exercises].sort((a, b) => a.order - b.order);
  const before = ordered.reduce((a, e) => a + e.sets, 0);
  const rows = ordered.map((e) => ({
    order: e.order,
    exercise_external_id: e.exercise_external_id,
    sets_before: e.sets,
    sets_after: sets.get(e.order) ?? e.sets,
  }));
  const after = rows.reduce((a, r) => a + r.sets_after, 0);
  return {
    volume_pct: before > 0 ? Math.round(((before - after) / before) * 100) : 0,
    sets_before: before,
    sets_after: after,
    exercises: rows,
  };
}

export function applyChange(exercises: readonly AdjustExercise[], change: AdjustChange): AdjustExercise[] {
  const byOrder = new Map(change.exercises.map((c) => [c.order, c.sets_after]));
  return [...exercises]
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ ...e, sets: byOrder.get(e.order) ?? e.sets }));
}

// ─── Roman's phrasing (deterministic) ───────────────────────────────────────

function signalPhrase(s: AdjustSignal): string {
  switch (s.key) {
    case 'hrv_drop':
      return `heart-rate variability is ${s.value}% below the usual`;
    case 'rhr_rise':
      return `resting heart rate is up ${s.value} bpm`;
    case 'short_sleep':
      return `sleep has averaged ${s.value} hours over the last ${ADJUST_THRESHOLDS.recentDays} nights`;
    case 'low_readiness':
      return `readiness has averaged ${s.value}, down from ${s.baseline ?? s.value}`;
    case 'load_spike':
      return `training load this week is ${s.value} times the usual`;
    case 'high_effort':
      return `the last three sessions were rated ${s.value} out of 10 for effort`;
  }
}

function joinPhrases(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** "today's", "tomorrow's" or "Friday's", by the client's local calendar. */
export function whenWord(scheduledFor: Date, now: Date, timeZone: string): string {
  const today = localDate(now, timeZone);
  const day = localDate(scheduledFor, timeZone);
  if (day === today) return "today's";
  if (day === addDays(today, 1)) return "tomorrow's";
  try {
    return `${new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(scheduledFor)}'s`;
  } catch {
    return 'the next';
  }
}

export function romanProposalText(input: {
  clientFirstName: string;
  signals: readonly AdjustSignal[];
  change: AdjustChange;
  planName: string;
  when: string;
}): string {
  const name = input.clientFirstName.trim() || 'This client';
  const reasons = joinPhrases(input.signals.map(signalPhrase));
  const reasonsSentence = reasons.charAt(0).toUpperCase() + reasons.slice(1);
  return (
    `${name}'s recovery has dipped. ${reasonsSentence}. ` +
    `I suggest trimming ${input.when} ${input.planName} by ${input.change.volume_pct}%, ` +
    `from ${input.change.sets_before} to ${input.change.sets_after} sets. Reps and loads stay as you set them. ` +
    `Shall I apply it?`
  );
}
