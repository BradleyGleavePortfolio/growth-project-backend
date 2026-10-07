// R11-W1: personal_baselines ("your normal"). The doubles record every query, so the tests assert
// the where clauses: only the caller's rows are asked for; numbers are computed in code.

import 'reflect-metadata';
import { RomanReadToolbox } from '../../../src/roman/tools/roman-read-tools';
import { BASELINE_LIMITS, baselineFlag, type BaselineRow } from '../../../src/roman/tools/roman-baselines';
import { ROMAN_TOOL_LIMITS } from '../../../src/roman/tools/roman-tool.types';
import { ADJUST_THRESHOLDS as T } from '../../../src/roman-adjust/roman-adjust.rules';
import type { RomanTimelineReader } from '../../../src/roman/memory/roman-timeline.reader';
import type { PrismaService } from '../../../src/prisma.service';
import { fakeOf } from '../../ai-egress/ai-egress.fakes';

const NOW = new Date('2026-10-06T19:00:00.000Z'); // 12:00 in Los Angeles, local 2026-10-06
const day = (n: number) => new Date(Date.parse('2026-10-06T00:00:00.000Z') + n * 86_400_000).toISOString().slice(0, 10);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => day(from + i));
const D = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const prev = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);

type Row = { user: string; key: number } & Record<string, unknown>;
const sample = (user: string, metric: string, ymd: string, value: number, s = 0): Row => {
  const sleep = metric.startsWith('SLEEP_');
  const start = new Date(sleep ? `${prev(ymd)}T06:00:00.000Z` : Date.parse(`${ymd}T15:00:00.000Z`) + s * 1000);
  const end = new Date(sleep ? `${ymd}T14:00:00.000Z` : +start + 1000);
  return { user, key: +start, metric, provider: 'apple_health', value, start_at: start, end_at: end, recorded_at: end, source_tz: null };
};
const weight = (user: string, ymd: string, lbs: number): Row => ({ user, key: +D(ymd), date: D(ymd), weight_lbs: lbs });
const food = (user: string, ymd: string, protein_g: number, q = 1): Row =>
  ({ user, key: +D(ymd), date: D(ymd), quantity_multiplier: q, food_item: { protein_g } });
const workout = (user: string, ymd: string): Row => ({ user, key: +D(ymd), date: D(ymd) });

type Where = { user_id?: string; id?: string };
type Find = { where: Where; take?: number };
function setup(rows: Row[], signup: Record<string, string> = {}) {
  const table = (pick: (r: Row) => boolean) => jest.fn(async ({ where, take }: Find) =>
    rows.filter((r) => pick(r) && r.user === where.user_id).sort((a, b) => b.key - a.key).slice(0, take)
      .map(({ user: _u, key: _k, ...rest }) => rest));
  const user = (id: string) => ({ deleted_at: null, notification_prefs: { timezone: 'America/Los_Angeles' },
    created_at: new Date(`${signup[id] ?? '2026-08-01'}T17:00:00.000Z`), wearable_metric_preferences: [] });
  const prisma = {
    user: { findUnique: jest.fn(async ({ where }: Find) => user(where.id ?? '')) },
    wearableSample: { findMany: table((r) => 'metric' in r) },
    weightLog: { findMany: table((r) => 'weight_lbs' in r) },
    loggedFoodEntry: { findMany: table((r) => 'food_item' in r) },
    workoutSession: { findMany: table((r) => Object.keys(r).length === 3) },
  };
  const box = new RomanReadToolbox(fakeOf<PrismaService>(prisma), fakeOf<RomanTimelineReader>({ read: jest.fn() }));
  const run = (input: unknown = {}, caller = { id: 'client-a', role: 'student' }) =>
    box.run(caller, 'personal_baselines', input, { now: NOW });
  const finds = [prisma.wearableSample, prisma.weightLog, prisma.loggedFoodEntry, prisma.workoutSession].map((t) => t.findMany);
  const wheres = () => finds.flatMap((f) => f.mock.calls.map(([a]) => a.where));
  return { prisma, box, run, finds, wheres };
}
const metricsOf = (content: string): Record<string, BaselineRow> =>
  Object.fromEntries((JSON.parse(content).metrics as BaselineRow[]).map((m) => [m.metric, m]));

function fullFixture(user: string, k = 1): Row[] {
  const rows: Row[] = [];
  for (const d of range(-26, -17)) {
    rows.push(sample(user, 'HRV_MS', d, 60 * k), sample(user, 'RESTING_HEART_RATE_BPM', d, 55 * k));
    rows.push(sample(user, 'SLEEP_TOTAL_MIN', d, 450 * k), sample(user, 'ACTIVE_ENERGY_KCAL', d, 500 * k));
    rows.push(food(user, d, 50 * k, 1.5), food(user, d, 25 * k));
  }
  for (const d of range(-2, 0)) {
    rows.push(sample(user, 'HRV_MS', d, 48 * k), sample(user, 'RESTING_HEART_RATE_BPM', d, 61 * k));
    rows.push(sample(user, 'SLEEP_TOTAL_MIN', d, 330 * k), sample(user, 'ACTIVE_ENERGY_KCAL', d, 450 * k));
  }
  range(-26, -20).forEach((d, i) => rows.push(sample(user, 'STEPS', d, (6 + i) * 1000 * k)));
  rows.push(sample(user, 'STEPS', day(-2), 5000 * k), sample(user, 'STEPS', day(-1), 5000 * k), sample(user, 'STEPS', day(0), 100));
  range(-26, -20).forEach((d) => rows.push(weight(user, d, 182 * k)));
  rows.push(weight(user, day(-26), 181 * k), weight(user, day(-26), 183 * k), weight(user, day(-1), 180.4 * k));
  range(-5, -1).forEach((d) => rows.push(food(user, d, 80 * k)));
  rows.push(food(user, day(0), 500 * k));
  for (const k7 of [1, 2, 3, 4]) rows.push(workout(user, day(-7 * k7)), workout(user, day(-7 * k7 - 3)));
  range(-3, 0).forEach((d) => rows.push(workout(user, d)));
  return rows;
}

describe('R11-W1 personal_baselines: numbers computed in code', () => {
  it('28 days before the last 7 vs the last 7: median, mean, range, change and the adjust flags', async () => {
    const t = setup([...fullFixture('client-a'), ...fullFixture('client-b', 9)]);
    const r = await t.run();
    expect(r).toMatchObject({ ok: true, rows: 8, truncated: false });
    const m = metricsOf(r.content);
    expect(m.hrv_ms).toMatchObject({ status: 'ok', normal: { from: day(-34), to: day(-7), days: 10, median: 60 },
      last_7: { from: day(-6), to: day(0), days: 3, median: 48 }, change: -12, change_pct: -20, flag: 'below_normal', marked: false });
    expect(m.resting_hr_bpm).toMatchObject({ change: 6, flag: 'above_normal', marked: false });
    expect(m.sleep_min).toMatchObject({ unit: 'min', normal: { median: 450 }, last_7: { median: 330 }, flag: 'short', marked: false });
    // Steps end yesterday: today's partial 100 is not in the last 7.
    expect(m.steps).toMatchObject({ normal: { from: day(-35), to: day(-8), days: 7, median: 9000, mean: 9000, min: 6000, max: 12000 },
      last_7: { to: day(-1), days: 2, median: 5000 }, change: -4000, change_pct: -44, flag: null });
    expect(m.active_kcal).toMatchObject({ normal: { median: 500 }, last_7: { median: 450 }, change: -50, flag: null });
    // Two logs on one day count as their mean (182), one day, never two.
    expect(m.weight_lbs).toMatchObject({ unit: 'lb', normal: { days: 7, median: 182 }, last_7: { median: 180.4 }, change: -1.6 });
    // 50 g x 1.5 + 25 g = 100 g a day; today's 500 g is not a finished day.
    expect(m.protein_g).toMatchObject({ normal: { days: 10, median: 100 }, last_7: { days: 5, median: 80, mean: 80 }, change: -20 });
    expect(m.sessions_per_week).toMatchObject({ normal: { days: 28, weeks: 4, median: 2, min: 2, max: 2 },
      last_7: { from: day(-6), to: day(0), days: 7, count: 4 }, change: 2, change_pct: 100, flag: 'above_normal' });
    expect(r.facts?.burned_past_kcal).toEqual([500, 500, 500, 500, 450, 450, 450, 450]);
  });

  it.each([
    ['hrv_ms', 100, 100 - T.hrvDropPct, 'below_normal', false], ['hrv_ms', 100, 101 - T.hrvDropPct, null, false],
    ['hrv_ms', 100, 100 - T.hrvDropMarkedPct, 'below_normal', true],
    ['resting_hr_bpm', 55, 55 + T.rhrRiseBpm, 'above_normal', false], ['resting_hr_bpm', 55, 54 + T.rhrRiseBpm, null, false],
    ['resting_hr_bpm', 55, 55 + T.rhrRiseMarkedBpm, 'above_normal', true],
    ['sleep_min', 450, T.sleepShortMin - 1, 'short', false], ['sleep_min', 450, T.sleepShortMin, null, false],
    ['sleep_min', 450, T.sleepShortMarkedMin - 1, 'short', true],
    ['sessions_per_week', 2, 2 * T.loadRatio, 'above_normal', false], ['steps', 9000, 1000, null, false],
  ] as const)('%s normal %d, last 7 %d -> %s (ADJUST_THRESHOLDS)', (metric, normal, recent, flag, marked) => {
    const f = baselineFlag(metric, normal, recent, 3);
    expect(f?.flag ?? null).toBe(flag);
    if (f) expect(f.marked).toBe(marked);
    expect(baselineFlag(metric, normal, recent, T.sleepMinNights - 1)).toBeNull();
  });
});

describe('R11-W1 personal_baselines: not enough data', () => {
  it('fewer than 7 data days in the 28, or no full week since sign-up -> not_enough_data, no numbers, no flag', async () => {
    const rows = range(-26, -21).flatMap((d) => [sample('client-a', 'HRV_MS', d, 60), weight('client-a', d, 180)]);
    rows.push(sample('client-a', 'HRV_MS', day(0), 20), workout('client-a', day(-1)), workout('client-a', day(-9)));
    const t = setup(rows, { 'client-a': day(-8) });
    const r = await t.run();
    const m = metricsOf(r.content);
    expect(m.hrv_ms).toEqual({ metric: 'hrv_ms', unit: 'ms', status: 'not_enough_data', data_days: 6, needed_days: 7 });
    expect(m.weight_lbs).toMatchObject({ status: 'not_enough_data', data_days: 6 });
    expect(m.sleep_min).toMatchObject({ status: 'not_enough_data', data_days: 0 });
    expect(m.sessions_per_week).toMatchObject({ status: 'not_enough_data', data_days: 2, needed_days: T.baselineMinDays });
    expect(r.content).not.toMatch(/median|flag/);
    expect(r.facts?.burned_past_kcal).toEqual([]);
  });
});

describe('R11-W1 personal_baselines: tenancy', () => {
  it('every query filters on the caller; another user is never read', async () => {
    const t = setup([...fullFixture('client-a'), ...fullFixture('client-b', 9)]);
    const r = await t.run();
    expect(t.wheres()).toHaveLength(4);
    for (const where of t.wheres()) expect(where.user_id).toBe('client-a');
    for (const [arg] of t.prisma.user.findUnique.mock.calls) expect(arg.where).toEqual({ id: 'client-a' });
    expect(r.content).not.toMatch(/540|4050/); // client-b's HRV and active kcal
  });

  it.each(['coach', 'owner', 'sub_coach'])('a %s caller gets not_allowed and no query', async (role) => {
    const t = setup(fullFixture('client-a'));
    expect(await t.run({}, { id: 'client-a', role })).toMatchObject({ ok: false, error_code: 'not_allowed' });
    expect(t.wheres()).toHaveLength(0);
    expect(t.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('a subject in the input is bad_input before any query; the tool is listed', async () => {
    const t = setup(fullFixture('client-b'));
    expect(await t.run({ user_id: 'client-b' })).toMatchObject({ ok: false, error_code: 'bad_input' });
    expect(t.wheres()).toHaveLength(0);
    const def = t.box.definitions().find((d) => d.name === 'personal_baselines');
    expect(def?.input_schema).toEqual({ type: 'object', properties: {} });
  });
});

describe('R11-W1 personal_baselines: clamp', () => {
  it('wearable rows over the cap: the oldest partly read days are dropped and truncated is set', async () => {
    const rows = range(-35, 0).flatMap((d) => Array.from({ length: 401 }, (_, i) => sample('client-a', 'STEPS', d, 25, i)));
    expect(rows.length).toBeGreaterThan(BASELINE_LIMITS.wearable_samples);
    const t = setup(rows);
    const r = await t.run();
    expect(t.prisma.wearableSample.findMany.mock.calls[0][0].take).toBe(BASELINE_LIMITS.wearable_samples + 1);
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect(r.content.length).toBeLessThanOrEqual(ROMAN_TOOL_LIMITS.max_result_chars);
    // Kept: the newest 12,000 rows reach into day -29 (partly); days up to -28 are dropped.
    expect(metricsOf(r.content).steps).toMatchObject({ normal: { from: day(-35), days: 20, median: 10025 }, last_7: { days: 7 } });
  });
});
