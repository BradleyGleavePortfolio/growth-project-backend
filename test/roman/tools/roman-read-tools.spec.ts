// R11-T1: Roman's read tools are scoped to the caller. The doubles record every query, so the
// tests assert the where clauses: another user's rows are never asked for, bad input never queries.

import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { RomanReadToolbox, fitToolJson } from '../../../src/roman/tools/roman-read-tools';
import { ROMAN_TOOLBOX, ROMAN_TOOL_LIMITS } from '../../../src/roman/tools/roman-tool.types';
import { RomanModule } from '../../../src/roman/roman.module';
import type { RomanTimelineEvent } from '../../../src/roman/memory/roman-timeline.types';
import type { RomanTimelineReader } from '../../../src/roman/memory/roman-timeline.reader';
import type { PrismaService } from '../../../src/prisma.service';
import { fakeOf } from '../../ai-egress/ai-egress.fakes';

const NOW = new Date('2026-10-06T19:00:00.000Z'); // 12:00 in Los Angeles, local 2026-10-06
const A = { id: 'client-a', role: 'student' };
const D = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
type Where = Record<string, unknown> & { workout?: { user_id?: string }; user_id?: string };

const set = (user: string, date: string, name: string, w: number) => ({ user, exercise_name: name,
  sets_completed: 3, reps_per_set: [5, 5, 5], weight_per_set: [w, w, w], rpe: 8, workout: { date: D(date) } });
const food = (user: string, at: string, name: string, kcal: number, q = 1) => ({ user, meal_type: 'lunch',
  quantity_multiplier: q, logged_at: new Date(at), food_item: { name, calories: kcal, protein_g: 10.4, carbs_g: 20, fat_g: 5 } });
type Facts = RomanTimelineEvent['facts'];
const ev = (local_date: string, kind: RomanTimelineEvent['kind'], facts: Facts): RomanTimelineEvent => {
  const source = { table: 'WeightLog' as const, id: local_date };
  return { at: `${local_date}T07:00:00.000Z`, local_date, kind, source, facts };
};
type ReadOpts = { kinds: string[]; from: Date; to: Date };

function setup(events: RomanTimelineEvent[] = [], more = false) {
  const sets = [set('client-a', '2026-09-30', 'Bench Press', 205), set('client-a', '2026-09-02', 'Bench Press', 185),
    set('client-b', '2026-09-20', 'Bench Press B-CANARY', 315)];
  const foods = [food('client-a', '2026-10-02T19:00:00Z', 'Rice bowl', 333.3, 1.5),
    food('client-a', '2026-10-02T15:00:00Z', 'Oats', 300.2), food('client-b', '2026-10-02T15:00:00Z', 'B-CANARY', 999)];
  const strip = <T extends { user: string }>({ user: _u, ...rest }: T) => rest;
  const tz = { deleted_at: null, notification_prefs: { timezone: 'America/Los_Angeles' } };
  const byLog = (x: { logged_at: Date }, y: { logged_at: Date }) => +x.logged_at - +y.logged_at;
  const prisma = {
    user: { findUnique: jest.fn(async () => tz) },
    exerciseSet: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        sets.filter((s) => s.user === where.workout?.user_id).map(strip)),
    },
    loggedFoodEntry: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        foods.filter((f) => f.user === where.user_id).map(strip).sort(byLog)),
    },
    // R11-T1b extra kinds (roman-extra-history.spec.ts covers them).
    wearableSample: { findMany: jest.fn(async () => []) },
    wearableUserMetricPreference: { findMany: jest.fn(async () => []) },
    fastingWindow: { findMany: jest.fn(async () => []) },
    romanMessage: { findMany: jest.fn(async () => []) },
    communityPost: { findMany: jest.fn(async () => []) },
  };
  const page = { timezone: 'America/Los_Angeles', events, next_cursor: more ? 'c' : null, truncated: [] };
  const timeline = { read: jest.fn(async (client_id: string, _opts: ReadOpts) => ({ client_id, ...page })) };
  const box = new RomanReadToolbox(fakeOf<PrismaService>(prisma), fakeOf<RomanTimelineReader>(timeline));
  const run = (name: string, input: unknown, caller = A) => box.run(caller, name, input, { now: NOW });
  const { exerciseSet, loggedFoodEntry, wearableSample, wearableUserMetricPreference: prefs, fastingWindow } = prisma;
  const tables = [exerciseSet, loggedFoodEntry, wearableSample, prefs, fastingWindow, prisma.romanMessage, prisma.communityPost];
  const fns: { mock: { calls: unknown[] } }[] = [timeline.read, ...tables.map((m) => m.findMany)];
  const queries = () => fns.reduce((n, f) => n + f.mock.calls.length, 0);
  return { prisma, timeline, run, queries };
}

describe('R11-T1 read tools: caller only', () => {
  it.each(['coach', 'owner', 'sub_coach'])('a %s caller gets not_allowed and no query', async (role) => {
    const t = setup();
    for (const name of ['read_history', 'exercise_history', 'food_day']) {
      const input = { date: '2026-10-02', exercise: 'bench', from: '2026-10-01', to: '2026-10-02' };
      const r = await t.run(name, input, { id: 'coach-1', role });
      expect(r).toMatchObject({ ok: false, error_code: 'not_allowed', rows: 0 });
    }
    expect(t.queries()).toBe(0);
    expect(t.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('a subject in the input is an unknown key: bad_input before any query', async () => {
    const t = setup();
    const inputs: [string, unknown][] = [
      ['food_day', { date: '2026-10-02', user_id: 'client-b' }],
      ['exercise_history', { exercise: 'bench', client_id: 'client-b' }],
      ['read_history', { from: '2026-10-01', to: '2026-10-02', user_id: 'client-b' }],
      ['exercise_history', { exercise: 'be%ch' }],
      ['food_day', { date: '2026-02-30' }],
      ['nope', {}],
    ];
    for (const [name, input] of inputs) {
      expect(await t.run(name, input)).toMatchObject({ ok: false, error_code: 'bad_input' });
    }
    expect(t.queries()).toBe(0);
  });

  it('exercise_history reads through workout.user_id = caller and computes Epley and the change', async () => {
    const t = setup();
    const r = await t.run('exercise_history', { exercise: 'bench' });
    const where = t.prisma.exerciseSet.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      exercise_name: { contains: 'bench', mode: 'insensitive' },
      workout: { user_id: 'client-a', date: { gte: D('2026-07-09'), lte: D('2026-10-06') } },
    });
    expect(r.content).not.toContain('CANARY');
    const body = JSON.parse(r.content);
    expect(r).toMatchObject({ ok: true, rows: 2, truncated: false });
    expect(body.sessions[0]).toMatchObject({ top_set: { weight_lbs: 205, reps: 5 }, est_1rm_lbs: 239.2, volume_lbs: 3075 });
    // 185x5 -> 215.8 and 205x5 -> 239.2 (Epley); the change is computed in code.
    const change = { top_weight_lbs: 20, est_1rm_lbs: 23.4, est_1rm_pct: 10.8, volume_lbs: 300 };
    expect(body.changes).toEqual([expect.objectContaining({ exercise: 'Bench Press', sessions: 2, change })]);
    const wide = await t.run('exercise_history', { exercise: 'bench', from: '2026-01-01' });
    expect(wide).toMatchObject({ ok: false, error_code: 'range_too_large' });
  });

  it('food_day reads user_id = caller, matches client_data math and reports past-day facts', async () => {
    const t = setup();
    const r = await t.run('food_day', { date: '2026-10-02' });
    expect(t.prisma.loggedFoodEntry.findMany.mock.calls[0][0].where).toEqual({ user_id: 'client-a', date: D('2026-10-02') });
    expect(r.content).not.toContain('CANARY');
    const body = JSON.parse(r.content);
    // 300.2 + 333.3 * 1.5 = 800.15 -> 800 (sum first, round once); entries 300 and 500.
    expect(body.totals).toEqual({ kcal: 800, protein_g: 26, carbs_g: 50, fat_g: 13, entries: 2, meals: 1 });
    expect(body.entries.map((e: { kcal: number; time: string }) => [e.time, e.kcal])).toEqual([['08:00', 300], ['12:00', 500]]);
    const intake_past_g = { protein_g: [26, 10, 16], carbs_g: [50, 20, 30], fat_g: [13, 5, 8] }; // R11-T3
    expect(r.facts).toEqual({ intake_past_kcal: [800, 300, 500], intake_past_g });
    expect((await t.run('food_day', { date: '2026-10-06' })).facts).toEqual({ intake_past_kcal: [], intake_past_g: {} });
    expect(await t.run('food_day', { date: '2026-10-07' })).toMatchObject({ error_code: 'bad_input' });
    expect(await t.run('food_day', { date: '2025-10-05' })).toMatchObject({ error_code: 'range_too_large' });
  });
});

describe('R11-T1 read_history', () => {
  it('more than 31 days is range_too_large; activity and adjustment are bad_input', async () => {
    const t = setup();
    expect(await t.run('read_history', { from: '2026-09-01', to: '2026-10-02' })).toMatchObject({ error_code: 'range_too_large' });
    for (const kind of ['activity', 'adjustment']) {
      const r = await t.run('read_history', { from: '2026-10-01', to: '2026-10-02', kinds: [kind] });
      expect(r).toMatchObject({ error_code: 'bad_input' });
    }
    expect(t.timeline.read).not.toHaveBeenCalled();
  });

  it('reads only the caller, never the activity or adjustment kinds, with past-day kcal facts', async () => {
    const t = setup([
      ev('2026-10-02', 'food_day', { kcal: 650, protein_g: 40 }),
      ev('2026-10-03', 'wearable_day', { steps: 9000, active_kcal: 420, hrv_ms: null }),
      ev('2026-10-06', 'food_day', { kcal: 300 }),
      ev('2026-10-06', 'wearable_day', { active_kcal: 120 }),
    ]);
    const r = await t.run('read_history', { from: '2026-09-06', to: '2026-10-06' });
    const [subject, opts] = t.timeline.read.mock.calls[0];
    expect(subject).toBe('client-a');
    expect(opts.kinds).toHaveLength(10);
    expect(opts.kinds.filter((k) => k === 'activity' || k === 'adjustment')).toEqual([]);
    expect(opts.from.toISOString()).toBe('2026-09-06T07:00:00.000Z');
    expect(opts.to.getTime() - opts.from.getTime()).toBe(31 * 86_400_000);
    expect(r).toMatchObject({ ok: true, rows: 4, truncated: false });
    expect(JSON.parse(r.content).events[1]).toEqual({ date: '2026-10-03', kind: 'wearable_day', steps: 9000, active_kcal: 420 });
    const intake_past_g = { protein_g: [40], carbs_g: [], fat_g: [] }; // R11-T3
    expect(r.facts).toEqual({ intake_past_kcal: [650], intake_past_g, burned_past_kcal: [420] });
  });

  it('clamps to max_result_chars and sets truncated (also when the reader has more)', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ev('2026-10-01', 'check_in', { mood: i, type: 'x'.repeat(40) }));
    const r = await setup(many).run('read_history', { from: '2026-10-01', to: '2026-10-01', kinds: ['check_in'] });
    expect(r.content.length).toBeLessThanOrEqual(ROMAN_TOOL_LIMITS.max_result_chars);
    expect(r.truncated).toBe(true);
    expect(JSON.parse(r.content).events).toHaveLength(r.rows);
    expect(r.rows).toBeLessThan(500);
    const capped = await setup([ev('2026-10-01', 'weight', { weight_lbs: 180 })], true)
      .run('read_history', { from: '2026-10-01', to: '2026-10-01' });
    expect(capped).toMatchObject({ rows: 1, truncated: true });
    const fit = fitToolJson({ tool: 'x' }, 'items', ['a'.repeat(50), 'b'.repeat(50)], false, 100);
    expect(fit).toMatchObject({ kept: 1, truncated: true });
    expect(fit.content.length).toBeLessThanOrEqual(100);
  });

  it('the module provides ROMAN_TOOLBOX as the read toolbox', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RomanModule) ?? [];
    expect(providers).toContainEqual({ provide: ROMAN_TOOLBOX, useExisting: RomanReadToolbox });
  });
});
