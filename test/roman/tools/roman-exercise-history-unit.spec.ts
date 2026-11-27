/**
 * ROMAN-HISTORY-UNIT-BE (agent alm): Roman's exercise_history tool tells a timed hold in seconds, never as reps.
 * Each session carries `unit`, last: the unit stored on its set (ExerciseSet.asked_unit, 'reps' or 'seconds'),
 * null when none was stored (never guessed). A 'seconds' session gets no rep math (est_1rm_lbs and volume_lbs
 * null); a change never puts a 'seconds' session in one group with any other, and carries the unit its sessions
 * share; the head's weight unit is `weight_unit`; the description says what a session's unit means.
 * summarizeExerciseSet, shared with GET /workouts/exercise-history, answers as on main (U9).
 *
 * Every case goes through RomanReadToolbox.run and definitions() over a fake that follows
 * test/set-asked-be.spec.ts's history fake: exerciseSet.findMany applies the where as Prisma does (exercise_name
 * contains, mode insensitive; workout.user_id; workout.date gte and lte), orders as the orderBy says, applies take,
 * and returns only the keys the select names (a column left unwritten reads null, as Postgres returns it; the
 * workout as { date }); anything it does not model throws. The "main" literals were taken from a run at backend
 * main 31b489c5. The live twin is test/rls/roman-exercise-history-unit-rls.spec.ts.
 */
import 'reflect-metadata';
import { RomanReadToolbox } from '../../../src/roman/tools/roman-read-tools';
import {
  summarizeExerciseSet,
  type ExerciseSetRow,
} from '../../../src/roman/tools/roman-exercise-history';
import type { RomanTimelineReader } from '../../../src/roman/memory/roman-timeline.reader';
import type { PrismaService } from '../../../src/prisma.service';
import { fakeOf } from '../../ai-egress/ai-egress.fakes';

// R75: the repo's typed test double, in place of inline casts.
function stub<T>(value: unknown): T {
  return value as T;
}

const NOW = new Date('2026-10-06T19:00:00.000Z'); // 12:00 in Los Angeles, local 2026-10-06 (as roman-read-tools.spec.ts:14)
const A = { id: 'client-a', role: 'student' };
const B = { id: 'client-b', role: 'student' };
const D = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

type Unit = 'reps' | 'seconds' | null;
/** One logged set on its own workout; `unit` set = logged from a plan row (the server stored the plan's ask). */
interface Logged {
  user: string;
  date: string;
  name: string;
  lbs: number[];
  counts: number[];
  unit?: 'reps' | 'seconds';
  rpe?: number;
}
type Row = Record<string, unknown> & { id: string; workout_id: string };
type Workout = { id: string; user_id: string; date: Date; created_at: Date };
type Json = Record<string, unknown>;

const ASKED = [
  'plan_assignment_id',
  'plan_order',
  'asked_sets',
  'asked_count',
  'asked_unit',
  'asked_weight_lbs',
] as const;
const NO_ASK = Object.fromEntries(ASKED.map((k) => [k, null]));
const LIVE_STUDENT_SELECT = {
  deleted_at: true,
  notification_prefs: { select: { timezone: true } },
};

function world(logged: readonly Logged[], opts: { down?: boolean } = {}) {
  const workouts: Workout[] = [];
  const sets: Row[] = [];
  logged.forEach((l, i) => {
    const id = String(i).padStart(3, '0');
    const w: Workout = {
      id: `w-${id}`,
      user_id: l.user,
      date: D(l.date),
      created_at: new Date(+D(l.date) + 3_600_000),
    };
    workouts.push(w);
    const asked = l.unit
      ? {
          plan_assignment_id: `pa-${id}`,
          plan_order: 0,
          asked_sets: l.counts.length,
          asked_count: l.counts[0],
          asked_unit: l.unit,
          asked_weight_lbs: l.lbs[0],
        }
      : {};
    // A row as Postgres returns it: every column, the plan's ask null unless the server wrote it.
    sets.push({
      ...NO_ASK,
      exercise_external_id: null,
      muscle_group: 'core',
      notes: null,
      video_url: null,
      exercise_name: l.name,
      sets_completed: l.counts.length,
      reps_per_set: [...l.counts],
      weight_per_set: [...l.lbs],
      rpe: l.rpe ?? null,
      ...asked,
      id: `set-${id}`,
      workout_id: w.id,
    });
  });
  const unmodelled = (what: string): never => {
    throw new Error(`fake exerciseSet.findMany (exercise_history read): ${what} is not modelled`);
  };
  const workoutOf = (x: Row) =>
    workouts.find((w) => w.id === x.workout_id) ?? unmodelled(`a set of no workout (${x.id})`);
  const only = (o: Json, keys: string[], what: string) => {
    const extra = Object.keys(o).filter((k) => !keys.includes(k));
    if (extra.length > 0) unmodelled(`${what}.${extra.join(', ')}`);
  };
  const matches = (x: Row, where: Json): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'exercise_name') {
        const { contains, mode } = stub<{ contains?: unknown; mode?: unknown }>(value);
        only(stub<Json>(value), ['contains', 'mode'], 'where.exercise_name');
        if (typeof contains !== 'string' || mode !== 'insensitive')
          return unmodelled('where.exercise_name');
        return String(x.exercise_name).toLowerCase().includes(contains.toLowerCase());
      }
      if (key === 'workout') {
        const { user_id, date } = stub<{ user_id?: unknown; date?: Json }>(value);
        only(stub<Json>(value), ['user_id', 'date'], 'where.workout');
        if (typeof user_id !== 'string' || !date) return unmodelled('where.workout');
        only(date, ['gte', 'lte'], 'where.workout.date');
        const { gte, lte } = date;
        if (!(gte instanceof Date) || !(lte instanceof Date))
          return unmodelled('where.workout.date');
        const w = workoutOf(x);
        return w.user_id === user_id && +w.date >= +gte && +w.date <= +lte;
      }
      return unmodelled(`where.${key}`);
    });
  const order = (orderBy: unknown) => {
    if (!Array.isArray(orderBy)) return unmodelled('an orderBy that is not a list');
    const keys = orderBy.map((o: Json) => {
      const [[key, value], ...more] = Object.entries(o);
      if (more.length > 0) unmodelled('an orderBy entry with two keys');
      if (key === 'id' && (value === 'asc' || value === 'desc'))
        return { at: (x: Row) => x.id, dir: value };
      if (key === 'workout') {
        const [[wk, dir], ...more2] = Object.entries(stub<Json>(value));
        if (
          more2.length === 0 &&
          (wk === 'date' || wk === 'created_at') &&
          (dir === 'asc' || dir === 'desc')
        ) {
          return { at: (x: Row) => workoutOf(x)[wk].toISOString(), dir };
        }
      }
      return unmodelled(`orderBy ${JSON.stringify(o)}`);
    });
    return (a: Row, b: Row) => {
      for (const { at, dir } of keys) {
        const [p, q] = [at(a), at(b)];
        if (p !== q) return (p < q ? -1 : 1) * (dir === 'asc' ? 1 : -1);
      }
      return 0;
    };
  };
  const pick = (x: Row, select: Json) => {
    const row: Json = {};
    for (const [key, on] of Object.entries(select)) {
      if (key === 'workout') {
        const keys =
          stub<{ select?: Json } | undefined>(on)?.select ??
          unmodelled('select.workout without its own select');
        const workout: Json = {};
        for (const [wk, won] of Object.entries(keys)) {
          if (wk !== 'date' || won !== true) unmodelled(`select.workout.${wk}`);
          workout.date = workoutOf(x).date;
        }
        row.workout = workout;
      } else {
        if (on !== true || !(key in x)) unmodelled(`select.${key}`);
        row[key] = x[key] ?? null;
      }
    }
    return row;
  };
  const findMany = jest.fn(async (args: Json) => {
    if (opts.down) throw new Error('connection refused');
    const { where, orderBy, take, select } = args;
    only(args, ['where', 'orderBy', 'take', 'select'], 'findMany');
    if (typeof take !== 'number' || !where || !select)
      return unmodelled('a read with no where, take or select');
    return sets
      .filter((x) => matches(x, stub<Json>(where)))
      .sort(order(orderBy))
      .slice(0, take)
      .map((x) => pick(x, stub<Json>(select)));
  });
  const users: Record<string, Date | null> = {
    'client-a': null,
    'client-b': null,
    'client-gone': D('2026-09-01'),
  };
  const findUnique = jest.fn(async (args: { where: { id: string }; select: unknown }) => {
    only(args, ['where', 'select'], 'user.findUnique');
    if (JSON.stringify(args.select) !== JSON.stringify(LIVE_STUDENT_SELECT))
      unmodelled('this user select');
    if (!(args.where.id in users)) return null;
    return {
      deleted_at: users[args.where.id],
      notification_prefs: { timezone: 'America/Los_Angeles' },
    };
  });
  const prisma = { user: { findUnique }, exerciseSet: { findMany } };
  const timeline = {
    read: jest.fn(async () => unmodelled('the timeline (exercise_history never reads it)')),
  };
  const box = new RomanReadToolbox(
    fakeOf<PrismaService>(prisma),
    fakeOf<RomanTimelineReader>(timeline),
  );
  const run = (input: unknown, caller: { id: string; role: string } = A) =>
    box.run(caller, 'exercise_history', input, { now: NOW });
  const body = async (input: unknown, caller?: { id: string; role: string }) => {
    const r = await run(input, caller);
    expect(r).toMatchObject({ ok: true });
    return { r, body: stub<{ sessions: Json[]; changes: Json[] } & Json>(JSON.parse(r.content)) };
  };
  return { box, run, body, findMany, findUnique, timeline };
}

// client-b's own hold; its name carries CANARY so a leak into client-a's answer shows.
const B_PLANK: Logged = {
  user: 'client-b',
  date: '2026-10-01',
  name: 'Plank B-CANARY',
  lbs: [0, 0],
  counts: [90, 90],
  unit: 'seconds',
};
// Work item 1: a plank from her plan, 0 lb x [60, 60, 60] seconds.
const PLANK: Logged = {
  user: 'client-a',
  date: '2026-10-01',
  name: 'Plank',
  lbs: [0, 0, 0],
  counts: [60, 60, 60],
  unit: 'seconds',
};
// Work item 2: a weighted hold from her plan, 25 lb x [20, 20] seconds.
const WALL_SIT: Logged = {
  user: 'client-a',
  date: '2026-10-02',
  name: 'Wall Sit',
  lbs: [25, 25],
  counts: [20, 20],
  unit: 'seconds',
};
// Work item 3: bench from her plan, 135 lb x [8, 8, 8] reps.
const BENCH: Logged = {
  user: 'client-a',
  date: '2026-10-03',
  name: 'Bench Press',
  lbs: [135, 135, 135],
  counts: [8, 8, 8],
  unit: 'reps',
};
// Work item 4: no stored unit (a free workout, an added or swapped exercise, an older app, a PUT without the plan reference).
const BENCH_FREE: Logged = {
  user: 'client-a',
  date: '2026-09-20',
  name: 'Bench Press',
  lbs: [145, 145],
  counts: [5, 5],
};
// roman-read-tools.spec.ts:31's pair (205 lb and 185 lb, 3 x 5, RPE 8), stored with no unit as there.
const pair = (date: string, w: number): Logged => ({
  user: 'client-a',
  date,
  name: 'Bench Press',
  lbs: [w, w, w],
  counts: [5, 5, 5],
  rpe: 8,
});

const sessionKeys = [
  'date',
  'exercise',
  'sets',
  'reps_per_set',
  'weight_per_set_lbs',
  'rpe',
  'top_set',
  'est_1rm_lbs',
  'volume_lbs',
];
const HEAD_KEYS = [
  'tool',
  'exercise',
  'from',
  'to',
  'weight_unit',
  'changes',
  'sessions',
  'truncated',
];
const withoutUnit = ({ unit: _unit, ...rest }: Json) => rest;

describe('ROMAN-HISTORY-UNIT-BE: each session carries its stored unit; a timed hold gets no rep math', () => {
  it('U1: a bodyweight plank stored in seconds reads unit seconds, no 1RM, no volume; the head says weight_unit lb', async () => {
    const t = world([PLANK, B_PLANK]);
    const { r, body } = await t.body({ exercise: 'plank' });
    expect(r).toMatchObject({ ok: true, rows: 1, truncated: false });
    expect(JSON.stringify(body.sessions)).toBe(
      JSON.stringify([
        {
          date: '2026-10-01',
          exercise: 'Plank',
          sets: 3,
          reps_per_set: [60, 60, 60],
          weight_per_set_lbs: [0, 0, 0],
          rpe: null,
          top_set: { weight_lbs: 0, reps: 60 },
          est_1rm_lbs: null,
          volume_lbs: null,
          unit: 'seconds',
        },
      ]),
    );
    expect(Object.keys(body)).toEqual(HEAD_KEYS);
    expect(body.weight_unit).toBe('lb');
    expect('unit' in body).toBe(false);
  });

  it('U2: a 25 lb hold of 20 seconds is no 41.7 lb 1RM and no 1000 lb volume', async () => {
    const t = world([WALL_SIT]);
    const { body } = await t.body({ exercise: 'wall sit' });
    expect(JSON.stringify(body.sessions)).toBe(
      JSON.stringify([
        {
          date: '2026-10-02',
          exercise: 'Wall Sit',
          sets: 2,
          reps_per_set: [20, 20],
          weight_per_set_lbs: [25, 25],
          rpe: null,
          top_set: { weight_lbs: 25, reps: 20 },
          est_1rm_lbs: null,
          volume_lbs: null,
          unit: 'seconds',
        },
      ]),
    );
  });

  it("U3: a bench stored in reps reads unit reps and keeps main's 1RM and volume", async () => {
    const t = world([BENCH]);
    const { body } = await t.body({ exercise: 'bench' });
    expect(JSON.stringify(body.sessions)).toBe(
      JSON.stringify([
        {
          date: '2026-10-03',
          exercise: 'Bench Press',
          sets: 3,
          reps_per_set: [8, 8, 8],
          weight_per_set_lbs: [135, 135, 135],
          rpe: null,
          top_set: { weight_lbs: 135, reps: 8 },
          est_1rm_lbs: 171,
          volume_lbs: 3240,
          unit: 'reps',
        },
      ]),
    );
  });

  it('U4: a set with no stored unit sends unit null (never guessed) and every other value as main', async () => {
    const t = world([BENCH_FREE]);
    const { body } = await t.body({ exercise: 'bench' });
    const [s] = body.sessions;
    expect(Object.keys(s)).toEqual([...sessionKeys, 'unit']);
    expect(s.unit).toBeNull();
    expect(JSON.stringify(withoutUnit(s))).toBe(
      '{"date":"2026-09-20","exercise":"Bench Press","sets":2,"reps_per_set":[5,5],"weight_per_set_lbs":[145,145],"rpe":null,"top_set":{"weight_lbs":145,"reps":5},"est_1rm_lbs":169.2,"volume_lbs":1450}',
    );
  });

  it('U5: changes never pair seconds with anything else, and carry the unit their sessions share', async () => {
    const t = world([
      {
        user: 'client-a',
        date: '2026-09-01',
        name: 'Plank',
        lbs: [0, 0],
        counts: [30, 30],
        unit: 'seconds',
      },
      {
        user: 'client-a',
        date: '2026-09-15',
        name: 'Plank',
        lbs: [10, 10],
        counts: [45, 45],
        unit: 'seconds',
      },
      { user: 'client-a', date: '2026-09-25', name: 'plank', lbs: [0], counts: [40] },
      {
        user: 'client-a',
        date: '2026-09-01',
        name: 'Bench Press',
        lbs: [135, 135, 135],
        counts: [8, 8, 8],
        unit: 'reps',
      },
      {
        user: 'client-a',
        date: '2026-09-05',
        name: 'Incline Bench Press',
        lbs: [95, 95],
        counts: [10, 10],
        unit: 'reps',
      },
      {
        user: 'client-a',
        date: '2026-09-10',
        name: 'Bench Press',
        lbs: [140, 140],
        counts: [8, 8],
      },
      {
        user: 'client-a',
        date: '2026-09-20',
        name: 'Bench Press',
        lbs: [145, 145, 145],
        counts: [8, 8, 8],
        unit: 'reps',
      },
      {
        user: 'client-a',
        date: '2026-09-25',
        name: 'Incline Bench Press',
        lbs: [100, 100],
        counts: [10, 10],
        unit: 'reps',
      },
      B_PLANK,
    ]);
    // Plank: the seconds pair is one change (10 lb more on the bar, no 1RM or volume); the lone null plank makes none.
    const plank = (await t.body({ exercise: 'plank' })).body;
    expect(JSON.stringify(plank.changes)).toBe(
      JSON.stringify([
        {
          exercise: 'Plank',
          sessions: 2,
          first: {
            date: '2026-09-01',
            top_set: { weight_lbs: 0, reps: 30 },
            est_1rm_lbs: null,
            volume_lbs: null,
          },
          last: {
            date: '2026-09-15',
            top_set: { weight_lbs: 10, reps: 45 },
            est_1rm_lbs: null,
            volume_lbs: null,
          },
          change: { top_weight_lbs: 10, est_1rm_lbs: null, est_1rm_pct: null, volume_lbs: null },
          unit: 'seconds',
        },
      ]),
    );
    // Bench reps, null, reps: one change of 3 as main, unit null (they differ); Incline all reps: unit reps.
    const bench = (await t.body({ exercise: 'bench' })).body;
    expect(JSON.stringify(bench.changes)).toBe(
      JSON.stringify([
        {
          exercise: 'Bench Press',
          sessions: 3,
          first: {
            date: '2026-09-01',
            top_set: { weight_lbs: 135, reps: 8 },
            est_1rm_lbs: 171,
            volume_lbs: 3240,
          },
          last: {
            date: '2026-09-20',
            top_set: { weight_lbs: 145, reps: 8 },
            est_1rm_lbs: 183.7,
            volume_lbs: 3480,
          },
          change: { top_weight_lbs: 10, est_1rm_lbs: 12.7, est_1rm_pct: 7.4, volume_lbs: 240 },
          unit: null,
        },
        {
          exercise: 'Incline Bench Press',
          sessions: 2,
          first: {
            date: '2026-09-05',
            top_set: { weight_lbs: 95, reps: 10 },
            est_1rm_lbs: 126.7,
            volume_lbs: 1900,
          },
          last: {
            date: '2026-09-25',
            top_set: { weight_lbs: 100, reps: 10 },
            est_1rm_lbs: 133.3,
            volume_lbs: 2000,
          },
          change: { top_weight_lbs: 5, est_1rm_lbs: 6.6, est_1rm_pct: 5.2, volume_lbs: 100 },
          unit: 'reps',
        },
      ]),
    );
  });

  it("U6: with no seconds session the answer is main's, byte for byte, once the unit keys are taken out", async () => {
    const t = world([BENCH, BENCH_FREE, pair('2026-09-30', 205), pair('2026-09-02', 185)]);
    const { r } = await t.body({ exercise: 'bench' });
    // The head's weight_unit read back as unit (same place); unit taken off each session and each change entry
    // (the only objects inside a list). At main this changes nothing.
    const strip = (k: string, v: unknown): unknown => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
      const o = stub<Json>(v);
      if (k === '')
        return Object.fromEntries(
          Object.entries(o).map(([key, x]) => [key === 'weight_unit' ? 'unit' : key, x]),
        );
      return /^\d+$/.test(k) ? withoutUnit(o) : o;
    };
    expect(JSON.stringify(JSON.parse(r.content, strip))).toBe(MAIN_U6);
  });

  it("U7: the read stays the caller's own: where, orderBy and take as main; the select adds asked_unit only", async () => {
    const t = world([PLANK, B_PLANK]);
    const { r } = await t.body({ exercise: 'plank' });
    expect(t.findMany).toHaveBeenCalledTimes(1);
    const args = stub<Json>(t.findMany.mock.calls[0][0]);
    expect(Object.keys(args).sort()).toEqual(['orderBy', 'select', 'take', 'where']);
    expect(args.where).toEqual({
      exercise_name: { contains: 'plank', mode: 'insensitive' },
      workout: { user_id: 'client-a', date: { gte: D('2026-07-09'), lte: D('2026-10-06') } },
    });
    expect(args.orderBy).toEqual([
      { workout: { date: 'desc' } },
      { workout: { created_at: 'desc' } },
      { id: 'asc' },
    ]);
    expect(args.take).toBe(61);
    expect(r.content).not.toContain('CANARY');
    const own = (await t.body({ exercise: 'plank' }, B)).body;
    expect(own.sessions.map((s) => s.exercise)).toEqual(['Plank B-CANARY']);
    for (const role of ['coach', 'owner', 'sub_coach']) {
      const u = world([PLANK, B_PLANK]);
      expect(await u.run({ exercise: 'plank' }, { id: 'coach-1', role })).toMatchObject({
        ok: false,
        error_code: 'not_allowed',
        rows: 0,
      });
      expect(u.findMany).not.toHaveBeenCalled();
      expect(u.findUnique).not.toHaveBeenCalled();
    }
    expect(args.select).toEqual({ ...MAIN_SELECT, asked_unit: true });
  });

  it("U8: the description says what a session's unit means; the input schema and the other tools are main's", () => {
    const defs = world([]).box.definitions();
    const own = defs.find((d) => d.name === 'exercise_history');
    expect(own?.description).toBe(R5_DESCRIPTION);
    expect(JSON.stringify(own?.input_schema)).toBe(MAIN_EXERCISE_HISTORY_SCHEMA);
    expect(defs.map((d) => d.name)).toEqual([
      'read_history',
      'exercise_history',
      'food_day',
      'personal_baselines',
    ]);
    expect(JSON.stringify(defs.filter((d) => d.name !== 'exercise_history'))).toBe(
      MAIN_OTHER_DEFINITIONS,
    );
  });

  it('U9: the shared summary (GET /workouts/exercise-history) answers as main for a stored seconds row', () => {
    const held: ExerciseSetRow & { asked_unit: Unit } = {
      exercise_name: 'Wall Sit',
      sets_completed: 2,
      reps_per_set: [20, 20],
      weight_per_set: [25, 25],
      rpe: null,
      workout: { date: D('2026-10-02') },
      asked_unit: 'seconds',
    };
    const out = summarizeExerciseSet(held);
    expect('unit' in out).toBe(false);
    expect(JSON.stringify(out)).toBe(
      '{"date":"2026-10-02","exercise":"Wall Sit","sets":2,"reps_per_set":[20,20],"weight_per_set_lbs":[25,25],"rpe":null,"top_set":{"weight_lbs":25,"reps":20},"est_1rm_lbs":41.7,"volume_lbs":1000}',
    );
  });

  it('U10: 60 three-set sessions are clamped at 12,000 characters, newest kept, rows = sessions kept', async () => {
    const logged = Array.from(
      { length: 60 },
      (_, i): Logged => ({
        user: 'client-a',
        date: new Date(+D('2026-10-06') - i * 86_400_000).toISOString().slice(0, 10),
        name: 'Barbell Back Squat',
        lbs: [225, 227.5, 230],
        counts: [8, 8, 7],
        rpe: 8.5,
        unit: 'reps',
      }),
    );
    const t = world(logged);
    const { r, body } = await t.body({ exercise: 'squat' });
    expect(r.content.length).toBeLessThanOrEqual(12_000);
    expect(r.truncated).toBe(true);
    expect(body.truncated).toBe(true);
    expect(r.rows).toBe(body.sessions.length);
    expect(body.sessions.map((s) => s.date)).toEqual(logged.slice(0, r.rows).map((l) => l.date));
  });

  it('U11: everything else as main: bad input, range, callers, a failed read, an empty window, the 60-session cap', async () => {
    const t = world([PLANK]);
    for (const input of [
      { exercise: 'plank', user_id: 'client-b' },
      { exercise: 'plank', client_id: 'client-b' },
      { exercise: 'pl%nk' },
      { exercise: 'plank', from: '2026-10-05', to: '2026-10-01' },
    ]) {
      expect(await t.run(input)).toMatchObject({ ok: false, error_code: 'bad_input', rows: 0 });
    }
    expect(await t.run({ exercise: 'plank', from: '2026-01-01' })).toMatchObject({
      ok: false,
      error_code: 'range_too_large',
    });
    expect(t.findMany).not.toHaveBeenCalled();
    expect(
      await t.run({ exercise: 'plank' }, { id: 'client-gone', role: 'student' }),
    ).toMatchObject({ ok: false, error_code: 'not_allowed' });
    expect(t.findMany).not.toHaveBeenCalled();
    expect(await world([PLANK], { down: true }).run({ exercise: 'plank' })).toMatchObject({
      ok: false,
      error_code: 'unavailable',
      rows: 0,
    });
    const empty = await t.body({ exercise: 'plank', from: '2026-09-01', to: '2026-09-30' });
    expect(empty.r).toMatchObject({ ok: true, rows: 0, truncated: false });
    expect([empty.body.sessions, empty.body.changes]).toEqual([[], []]);
    // The 60-session cap alone: 61 one-set sessions short enough that all 60 fit under the 12,000-character clamp
    // at main and with the unit key (no unit stored, so unit null), so truncated comes from the 61st row.
    const many = world(
      Array.from(
        { length: 61 },
        (_, i): Logged => ({
          user: 'client-a',
          date: new Date(+D('2026-10-06') - i * 86_400_000).toISOString().slice(0, 10),
          name: 'Dip',
          lbs: [0],
          counts: [9],
        }),
      ),
    );
    const capped = await many.body({ exercise: 'dip' });
    expect(capped.r.content.length).toBeLessThan(11_800);
    expect(capped.r).toMatchObject({ ok: true, rows: 60, truncated: true });
    expect(capped.body.sessions).toHaveLength(60);
    expect(capped.body.changes).toEqual([
      expect.objectContaining({ exercise: 'Dip', sessions: 60 }),
    ]);
  });
});

// Main's literals (backend main 31b489c5).
const MAIN_SELECT = {
  exercise_name: true,
  sets_completed: true,
  reps_per_set: true,
  weight_per_set: true,
  rpe: true,
  workout: { select: { date: true } },
};
const R5_DESCRIPTION =
  "The client's own logged sets for one exercise (name contains, any case): per session the date, sets, reps per set, weights in lb, RPE, top set, estimated 1RM (Epley) and volume, and the first-vs-last change per exercise, computed by the app. Each session's unit says what its counts are: 'reps'; 'seconds' for a timed hold, where reps_per_set and top_set.reps are seconds held, never reps, with no estimated 1RM or volume; or null when the app stored no unit. A change carries the unit its sessions share, null when they differ. Default window the last 90 days, at most 180.";
const MAIN_EXERCISE_HISTORY_SCHEMA = String.raw`{"type":"object","properties":{"exercise":{"type":"string","minLength":2,"maxLength":60},"from":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$","description":"YYYY-MM-DD"},"to":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$","description":"YYYY-MM-DD"}},"required":["exercise"]}`;
const MAIN_OTHER_DEFINITIONS = String.raw`[{"name":"read_history","description":"The client's own logs between two dates in their time zone (inclusive, at most 31 days): daily food totals, workouts done and missed, weight, water, habits, check-ins, daily wearable totals, messages with their coach and coaching sessions; health_day is the rest of their connected-device data per day (sleep stages, bedtime and wake time, body weight and body fat, blood pressure, VO2 max, workout minutes and distance, strain, temperature, respiratory rate, SpO2); fasting windows; roman_chat is their own earlier chats with Roman; community_post is the posts they wrote. Numbers are computed by the app; quote them as given.","input_schema":{"type":"object","properties":{"kinds":{"type":"array","items":{"enum":["food_day","workout_done","workout_missed","weight","water","habit","check_in","wearable_day","message","booking","health_day","fasting","roman_chat","community_post"]}},"from":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$","description":"YYYY-MM-DD"},"to":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$","description":"YYYY-MM-DD"}},"required":["from","to"]}},{"name":"food_day","description":"Everything the client logged as food on one date within the last 365 days: each entry's kcal and macros and the day totals, computed the same way as client_data.","input_schema":{"type":"object","properties":{"date":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$","description":"YYYY-MM-DD"}},"required":["date"]}},{"name":"personal_baselines","description":"The client's own normal, computed by the app: for sleep minutes, HRV, resting heart rate, steps, active kcal, weight (lb), daily protein (g) and workouts per week, the median, average and range of the 28 days before the last 7 versus the last 7 days, the change, and a flag when it crosses the recovery lines the coach's adjustment suggestions use. not_enough_data when those 28 days hold fewer than 7 days of data. Quote the numbers as given.","input_schema":{"type":"object","properties":{}}}]`;
// U6: bench at 135 x 8 (reps), 205 x 5 (none stored), 145 x 5 (none stored), 185 x 5 (none stored), as main answers it.
const MAIN_U6 = String.raw`{"tool":"exercise_history","exercise":"bench","from":"2026-07-09","to":"2026-10-06","unit":"lb","changes":[{"exercise":"Bench Press","sessions":4,"first":{"date":"2026-09-02","top_set":{"weight_lbs":185,"reps":5},"est_1rm_lbs":215.8,"volume_lbs":2775},"last":{"date":"2026-10-03","top_set":{"weight_lbs":135,"reps":8},"est_1rm_lbs":171,"volume_lbs":3240},"change":{"top_weight_lbs":-50,"est_1rm_lbs":-44.8,"est_1rm_pct":-20.8,"volume_lbs":465}}],"sessions":[{"date":"2026-10-03","exercise":"Bench Press","sets":3,"reps_per_set":[8,8,8],"weight_per_set_lbs":[135,135,135],"rpe":null,"top_set":{"weight_lbs":135,"reps":8},"est_1rm_lbs":171,"volume_lbs":3240},{"date":"2026-09-30","exercise":"Bench Press","sets":3,"reps_per_set":[5,5,5],"weight_per_set_lbs":[205,205,205],"rpe":8,"top_set":{"weight_lbs":205,"reps":5},"est_1rm_lbs":239.2,"volume_lbs":3075},{"date":"2026-09-20","exercise":"Bench Press","sets":2,"reps_per_set":[5,5],"weight_per_set_lbs":[145,145],"rpe":null,"top_set":{"weight_lbs":145,"reps":5},"est_1rm_lbs":169.2,"volume_lbs":1450},{"date":"2026-09-02","exercise":"Bench Press","sets":3,"reps_per_set":[5,5,5],"weight_per_set_lbs":[185,185,185],"rpe":8,"top_set":{"weight_lbs":185,"reps":5},"est_1rm_lbs":215.8,"volume_lbs":2775}],"truncated":false}`;
