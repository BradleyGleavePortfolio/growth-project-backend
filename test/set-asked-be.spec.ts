/**
 * SET-ASKED-BE (agent 195): each logged set keeps what her plan asked that day.
 * A set logged from a plan row carries the row's reference (her assignment's id and the
 * row's order, as the phone holds both); the server copies the sets, count, unit and weight
 * she was shown into the set. The copy is the record: a later plan edit changes nothing.
 *
 * The fake store keeps the shapes the service reads: assignments (frozen snapshot rows or
 * live plan rows, approved Roman decisions), sessions and their sets. The real controller,
 * service and the app's ValidationPipe options (main.ts) run on top of it. The live
 * Postgres twin of these rows is test/rls/set-asked-rls.spec.ts.
 */
import 'reflect-metadata';
import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import type { PrismaService } from '../src/prisma.service';
import type { PtmService } from '../src/ptm/ptm.service';
import type { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { WorkoutController } from '../src/workout/workout.controller';
import { WorkoutService } from '../src/workout/workout.service';
import type { AuthedRequest } from '../src/auth/auth-request';
import { CreateWorkoutDto, ExerciseHistoryQueryDto, UpdateWorkoutDto } from '../src/workout/workout.dto';

// R75: the repo's typed test double, in place of inline casts.
function stub<T>(value: unknown): T {
  return value as T;
}

type SetRow = Record<string, unknown> & { id: string; workout_id: string };
type Session = Record<string, unknown> & { id: string; user_id: string; client_key: string | null };
type Assignment = {
  id: string;
  client_id: string;
  snapshot: { exercises_json: unknown } | null;
  workout_plan: { exercises: Record<string, unknown>[] };
  adjustment_proposals: { status: string; applied_change: unknown; decided_at: Date | null }[];
};

const ASKED = ['plan_assignment_id', 'plan_order', 'asked_sets', 'asked_count', 'asked_unit', 'asked_weight_lbs'] as const;
const NO_ASK = Object.fromEntries(ASKED.map((k) => [k, null]));

function fakeStore() {
  const sessions: Session[] = [];
  const sets: SetRow[] = [];
  const assignments: Assignment[] = [];
  const reads: string[] = [];
  let n = 0;
  // A row as Postgres returns it: every column, the new ones null unless written.
  const setRow = (workout_id: string, e: Record<string, unknown>): SetRow => {
    n += 1;
    return { ...NO_ASK, rpe: null, notes: null, video_url: null, exercise_external_id: null, ...e, id: `set-${n}`, workout_id };
  };
  const withSets = (s: Session | undefined) => (s ? { ...s, exercises: sets.filter((x) => x.workout_id === s.id) } : null);
  // EXERCISE-HISTORY-UNIT-BE: GET /workouts/exercise-history's read (its where holds workout.user_id), as
  // getExerciseHistory writes it. The where and orderBy are applied; only the keys the select names come back
  // (a column left unwritten reads null, as Postgres returns it; the workout as { id, date, comments: [] });
  // a where, orderBy, select or argument this fake does not model throws, so a column left out of the select
  // is missing from the answer.
  const unmodelled = (what: string): never => {
    throw new Error(`fakeStore exerciseSet.findMany (history read): ${what} is not modelled`);
  };
  const HISTORY_ORDER = [{ workout: { date: 'asc' } }, { workout: { created_at: 'asc' } }, { id: 'asc' }];
  const sessionOf = (x: SetRow) => sessions.find((s) => s.id === x.workout_id) ?? unmodelled(`a set of no workout (${x.id})`);
  const historyMatch = (x: SetRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'OR' && Array.isArray(value)) return value.some((w) => historyMatch(x, stub<Record<string, unknown>>(w)));
      if (key === 'exercise_external_id' && (value === null || typeof value === 'string')) return (x.exercise_external_id ?? null) === value;
      if (key === 'exercise_name') {
        const { equals, mode, ...more } = stub<{ equals?: unknown; mode?: unknown }>(value);
        if (typeof equals !== 'string' || mode !== 'insensitive' || Object.keys(more).length > 0) return unmodelled('where.exercise_name');
        return String(x.exercise_name).toLowerCase() === equals.toLowerCase();
      }
      if (key === 'workout') {
        const { user_id, ...more } = stub<{ user_id?: unknown }>(value);
        if (typeof user_id !== 'string' || Object.keys(more).length > 0) return unmodelled('where.workout');
        return sessionOf(x).user_id === user_id;
      }
      return unmodelled(`where.${key}`);
    });
  const historyRead = (args: Record<string, unknown>) => {
    const { where, orderBy, select, ...more } = args;
    if (Object.keys(more).length > 0) unmodelled(Object.keys(more).join(', '));
    if (JSON.stringify(orderBy) !== JSON.stringify(HISTORY_ORDER)) unmodelled('this orderBy');
    const { workout: workoutSelect, ...columns } = stub<Record<string, unknown> | undefined>(select) ?? unmodelled('a read with no select');
    const workoutKeys = stub<{ select?: Record<string, unknown> } | undefined>(workoutSelect)?.select ?? unmodelled('a select with no workout');
    const position = (x: SetRow) => [stub<Date>(sessionOf(x).date).getTime(), sessions.indexOf(sessionOf(x)), sets.indexOf(x)];
    return sets
      .filter((x) => historyMatch(x, stub<Record<string, unknown>>(where)))
      .sort((a, b) => {
        const [pa, pb] = [position(a), position(b)];
        return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
      })
      .map((x) => {
        const row: Record<string, unknown> = {};
        for (const [key, on] of Object.entries(columns)) {
          if (on !== true || !(key in x)) unmodelled(`select.${key}`);
          row[key] = x[key] ?? null;
        }
        const s = sessionOf(x);
        const workout: Record<string, unknown> = {};
        for (const key of Object.keys(workoutKeys)) {
          if (key === 'id') workout.id = s.id;
          else if (key === 'date') workout.date = s.date;
          else if (key === 'comments') workout.comments = [];
          else unmodelled(`select.workout.${key}`);
        }
        return { ...row, workout };
      });
  };
  const exerciseSet = {
    findMany: jest.fn(async (args: { where: { workout_id: string; plan_assignment_id?: { not: null } } }) => {
      if ('workout' in args.where) return historyRead(args);
      const { where } = args;
      reads.push('exerciseSet.findMany');
      return sets
        .filter((x) => x.workout_id === where.workout_id && (!where.plan_assignment_id || x.plan_assignment_id !== null))
        .map((x) => ({ ...x }));
    }),
    deleteMany: jest.fn(async ({ where }: { where: { workout_id: string } }) => {
      for (let i = sets.length - 1; i >= 0; i--) if (sets[i].workout_id === where.workout_id) sets.splice(i, 1);
      return { count: 0 };
    }),
    createMany: jest.fn(async ({ data }: { data: (Record<string, unknown> & { workout_id: string })[] }) => {
      for (const d of data) sets.push(setRow(d.workout_id, d));
      return { count: data.length };
    }),
  };
  const workoutSession = {
    findUnique: jest.fn(async ({ where }: { where: { id?: string; user_id_client_key?: { user_id: string; client_key: string } } }) => {
      const k = where.user_id_client_key;
      return withSets(sessions.find((s) => (k ? s.user_id === k.user_id && s.client_key === k.client_key : s.id === where.id)));
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> & { user_id: string; client_key?: string } }) => {
      const { exercises, ...rest } = data as { exercises?: { create: Record<string, unknown>[] } };
      n += 1;
      const s: Session = { ...rest, id: `workout-${n}`, user_id: data.user_id, client_key: data.client_key ?? null, duration_minutes: null };
      sessions.push(s);
      for (const e of exercises?.create ?? []) sets.push(setRow(s.id, e));
      return withSets(s);
    }),
    update: jest.fn(async ({ where }: { where: { id: string } }) => sessions.find((s) => s.id === where.id)),
  };
  const clientWorkoutAssignment = {
    findMany: jest.fn(async ({ where }: { where: { id: { in: string[] }; client_id: string } }) => {
      reads.push('clientWorkoutAssignment.findMany');
      return assignments
        .filter((a) => where.id.in.includes(a.id) && a.client_id === where.client_id)
        .map((a) => ({
          ...a,
          workout_plan: { exercises: a.workout_plan.exercises.filter((e) => e.archived_at == null) },
          adjustment_proposals: a.adjustment_proposals.filter((p) => ['approved', 'edited'].includes(p.status)),
        }));
    }),
  };
  const tables = { workoutSession, exerciseSet, clientWorkoutAssignment };
  const prisma = { ...tables, $transaction: jest.fn(async (fn: (tx: typeof tables) => Promise<unknown>) => fn(tables)) };
  return { sessions, sets, assignments, reads, prisma };
}

const HER = 'user-her';
const OTHER = 'user-other';
const A_FROZEN = '11111111-1111-4111-8111-111111111111';
const A_LEGACY = '22222222-2222-4222-8222-222222222222';
const A_ROMAN = '33333333-3333-4333-8333-333333333333';
const A_OTHERS = '44444444-4444-4444-8444-444444444444';
const A_GONE = '55555555-5555-4555-8555-555555555555';

const snapRow = (order: number, sets: number, count: number, weight: number | null, extra: Record<string, unknown> = {}) => ({
  exercise_external_id: `ex-${order}`, order, sets, reps_or_duration_seconds: count, weight_lbs: weight,
  rest_seconds: 90, superset_group_id: null, notes: null, alternative_external_ids: [], ...extra,
});
const liveRow = (order: number, sets: number, count: number, weight: number | null, unit = 'reps') => ({
  order, sets, reps_or_duration_seconds: count, weight_lbs: weight, unit, archived_at: null,
});

function seed(assignments: Assignment[]) {
  assignments.push(
    {
      // A frozen day (MWB-1 snapshot): the live plan row says something else; the snapshot is what she saw.
      id: A_FROZEN, client_id: HER,
      snapshot: { exercises_json: [snapRow(0, 4, 8, 135), snapRow(1, 3, 45, null, { notes: 'SECONDS. Hold.' })] },
      workout_plan: { exercises: [liveRow(0, 9, 99, 999)] },
      adjustment_proposals: [],
    },
    {
      // A day assigned before snapshots: the live plan rows.
      id: A_LEGACY, client_id: HER, snapshot: null,
      workout_plan: { exercises: [liveRow(0, 5, 5, 225), liveRow(1, 2, 60, null, 'seconds'), { ...liveRow(2, 3, 10, 50), archived_at: new Date() }] },
      adjustment_proposals: [],
    },
    {
      // A day where the coach approved Roman's lighter set count for order 0 (and dismissed one for order 1).
      id: A_ROMAN, client_id: HER,
      snapshot: { exercises_json: [snapRow(0, 4, 10, 95), snapRow(1, 4, 12, 40)] },
      workout_plan: { exercises: [] },
      adjustment_proposals: [
        { status: 'approved', decided_at: new Date('2026-11-01T10:00:00Z'), applied_change: { exercises: [{ order: 0, sets_before: 4, sets_after: 3 }] } },
        { status: 'dismissed', decided_at: new Date('2026-11-01T11:00:00Z'), applied_change: { exercises: [{ order: 1, sets_before: 4, sets_after: 2 }] } },
      ],
    },
    {
      id: A_OTHERS, client_id: OTHER,
      snapshot: { exercises_json: [snapRow(0, 6, 6, 300)] },
      workout_plan: { exercises: [] },
      adjustment_proposals: [],
    },
  );
}

const set = (name: string, ref: Record<string, unknown> = {}) => ({
  exercise_name: name, muscle_group: 'chest', sets_completed: 3, reps_per_set: [8, 8, 8], weight_per_set: [135, 135, 135], ...ref,
});
const ref = (plan_assignment_id: unknown, plan_order: unknown) => ({ plan_assignment_id, plan_order });
const asks = (rows: Record<string, unknown>[]) =>
  rows.map((r) => Object.fromEntries(ASKED.map((k) => [k, r[k]])));
const ask = (id: string, order: number, s: number, count: number, unit: string, lbs: number | null) => ({
  plan_assignment_id: id, plan_order: order, asked_sets: s, asked_count: count, asked_unit: unit, asked_weight_lbs: lbs,
});

function setup() {
  const store = fakeStore();
  seed(store.assignments);
  const service = new WorkoutService(
    stub<PrismaService>(store.prisma),
    stub<PtmService>({ emit: jest.fn() }),
    stub<ClientAIContextService>({ invalidateForUser: jest.fn() }),
  );
  const controller = new WorkoutController(service);
  // The app's global pipe (main.ts): a body it refuses is a 400 before the service runs.
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const body = async <T>(metatype: new () => T, plain: object): Promise<T> =>
    pipe.transform(plain, stub<ArgumentMetadata>({ type: 'body', metatype }));
  const req = (userId: string) => stub<AuthedRequest>({ user: { id: userId } });
  const post = async (userId: string, plain: object, key?: string) =>
    stub<{ id: string; exercises: Record<string, unknown>[] }>(
      await controller.createWorkout(req(userId), await body(CreateWorkoutDto, plain), key),
    );
  const put = async (userId: string, id: string, plain: object) =>
    stub<{ id: string; exercises: Record<string, unknown>[] }>(
      await controller.updateWorkout(req(userId), id, await body(UpdateWorkoutDto, plain)),
    );
  const stored = (workoutId: string) => store.sets.filter((s) => s.workout_id === workoutId);
  return { store, post, put, stored };
}

const day = (exercises: object[]) => ({ workout_name: 'Push', workout_type: 'strength', exercises });

describe('SET-ASKED-BE: each logged set keeps what the plan asked that day', () => {
  it('frozen day: copies from the snapshot she was shown, not the live plan row; a seconds row copies seconds', async () => {
    const { post, stored } = setup();
    const w = await post(HER, day([set('Bench', ref(A_FROZEN, 0)), set('Plank', ref(A_FROZEN, 1))]));
    expect(asks(w.exercises)).toEqual([ask(A_FROZEN, 0, 4, 8, 'reps', 135), ask(A_FROZEN, 1, 3, 45, 'seconds', null)]);
    expect(asks(stored(w.id))).toEqual(asks(w.exercises));
  });

  it('legacy day (no snapshot): copies from the live plan row; a seconds row copies seconds; an archived row gives none', async () => {
    const { post } = setup();
    const w = await post(HER, day([set('Squat', ref(A_LEGACY, 0)), set('Wall sit', ref(A_LEGACY, 1)), set('Fly', ref(A_LEGACY, 2))]));
    expect(asks(w.exercises)).toEqual([ask(A_LEGACY, 0, 5, 5, 'reps', 225), ask(A_LEGACY, 1, 2, 60, 'seconds', null), NO_ASK]);
  });

  it('Roman-adjusted day: the coach-approved set count for that order; a dismissed one changes nothing', async () => {
    const { post } = setup();
    const w = await post(HER, day([set('Row', ref(A_ROMAN, 0)), set('Curl', ref(A_ROMAN, 1))]));
    expect(asks(w.exercises)).toEqual([ask(A_ROMAN, 0, 3, 10, 'reps', 95), ask(A_ROMAN, 1, 4, 12, 'reps', 40)]);
  });

  it('the coach edits the plan after: the stored ask stays as copied', async () => {
    const { store, post, stored } = setup();
    const w = await post(HER, day([set('Bench', ref(A_FROZEN, 0)), set('Squat', ref(A_LEGACY, 0))]));
    const frozen = store.assignments.find((a) => a.id === A_FROZEN)!;
    frozen.snapshot = { exercises_json: [snapRow(0, 1, 1, 1)] };
    store.assignments.find((a) => a.id === A_LEGACY)!.workout_plan.exercises[0].sets = 1;
    expect(asks(stored(w.id))).toEqual([ask(A_FROZEN, 0, 4, 8, 'reps', 135), ask(A_LEGACY, 0, 5, 5, 'reps', 225)]);
  });

  it('PUT keeps the first ask after the plan changed; a set added in the edit gets a fresh ask; no reference stores none', async () => {
    const { store, post, put, stored } = setup();
    const w = await post(HER, day([set('Bench', ref(A_FROZEN, 0))]));
    store.assignments.find((a) => a.id === A_FROZEN)!.snapshot = { exercises_json: [snapRow(0, 1, 1, 1), snapRow(1, 2, 30, null, { unit: 'seconds' })] };
    const u = await put(HER, w.id, day([set('Bench', ref(A_FROZEN, 0)), set('Plank', ref(A_FROZEN, 1)), set('Extra')]));
    expect(asks(u.exercises)).toEqual([ask(A_FROZEN, 0, 4, 8, 'reps', 135), ask(A_FROZEN, 1, 2, 30, 'seconds', null), NO_ASK]);
    expect(asks(stored(w.id))).toEqual(asks(u.exercises));
    // A second PUT that drops the reference stores no ask for that set.
    const v = await put(HER, w.id, day([set('Bench')]));
    expect(asks(v.exercises)).toEqual([NO_ASK]);
  });

  it("another member's assignment, an order with no row, a deleted assignment: saved, no ask", async () => {
    const { store, post } = setup();
    const w = await post(HER, day([set('A', ref(A_OTHERS, 0)), set('B', ref(A_FROZEN, 7)), set('C', ref(A_GONE, 0))]));
    expect(w.exercises.map((e) => e.exercise_name)).toEqual(['A', 'B', 'C']);
    expect(asks(w.exercises)).toEqual([NO_ASK, NO_ASK, NO_ASK]);
    // Deleting an assignment after the log changes nothing either (no foreign key; the copy is the record).
    const x = await post(HER, day([set('Bench', ref(A_FROZEN, 0))]));
    store.assignments.splice(store.assignments.findIndex((a) => a.id === A_FROZEN), 1);
    expect(asks(store.sets.filter((s) => s.workout_id === x.id))).toEqual([ask(A_FROZEN, 0, 4, 8, 'reps', 135)]);
  });

  it('a malformed reference: the body passes the pipe (no 400), the set is saved with no ask', async () => {
    const { post } = setup();
    const bad = [ref(42, 0), ref('not-a-uuid', 0), ref(A_FROZEN, -1), ref(A_FROZEN, 1.5), ref(A_FROZEN, '0'), ref({ id: A_FROZEN }, [0]), ref(A_FROZEN, undefined), ref(null, null)];
    const w = await post(HER, day(bad.map((r, i) => set(`S${i}`, r))));
    expect(w.exercises).toHaveLength(bad.length);
    expect(asks(w.exercises)).toEqual(bad.map(() => NO_ASK));
  });

  it('no reference: exactly today (no plan read, no ask)', async () => {
    const { store, post, put } = setup();
    const w = await post(HER, day([set('Bench'), set('Squat')]));
    const u = await put(HER, w.id, day([set('Bench')]));
    expect(store.reads).toEqual([]);
    expect([...asks(w.exercises), ...asks(u.exercises)]).toEqual([NO_ASK, NO_ASK, NO_ASK]);
  });

  it('one read of her assignments per workout, however many sets carry a reference', async () => {
    const { store, post } = setup();
    await post(HER, day([set('A', ref(A_FROZEN, 0)), set('B', ref(A_FROZEN, 1)), set('C', ref(A_LEGACY, 0)), set('D', ref(A_ROMAN, 0))]));
    expect(store.reads).toEqual(['clientWorkoutAssignment.findMany']);
    expect(store.prisma.clientWorkoutAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [A_FROZEN, A_LEGACY, A_ROMAN] }, client_id: HER } }),
    );
  });

  it('keyed resend: the stored row comes back unchanged and nothing is copied again', async () => {
    const { store, post } = setup();
    const first = await post(HER, day([set('Bench', ref(A_FROZEN, 0))]), 'u1:1800000000000');
    store.assignments.find((a) => a.id === A_FROZEN)!.snapshot = { exercises_json: [snapRow(0, 1, 1, 1)] };
    const reads = store.reads.length;
    const again = await post(HER, day([set('Bench', ref(A_FROZEN, 0))]), 'u1:1800000000000');
    expect(again.id).toBe(first.id);
    expect(asks(again.exercises)).toEqual([ask(A_FROZEN, 0, 4, 8, 'reps', 135)]);
    expect(store.reads.length).toBe(reads);
    expect(store.sessions).toHaveLength(1);
  });
});

/**
 * EXERCISE-HISTORY-UNIT-BE (agent 203): GET /workouts/exercise-history sends, on each session and inside each top
 * set, the unit the server stored for that set ('reps' or 'seconds', ExerciseSet.asked_unit), or null where it stored
 * none: never a guessed unit. Every key and value the answer sent before stays as it was. Each set is logged by the
 * real POST and PUT above and read back by the real GET, through the real controller and service on the same store.
 */
type Unit = 'reps' | 'seconds' | null;
type TopSetOut = { weight_lbs: number; reps: number; unit?: Unit };
type PointOut = { date: string; top_set: TopSetOut | null };
type SessionOut = Record<string, unknown> & { workout_id: string; date: string; top_set: TopSetOut | null; unit?: Unit };
type HistoryOut = { best: PointOut | null; first: PointOut | null; sessions: SessionOut[] };

describe('EXERCISE-HISTORY-UNIT-BE', () => {
  function withHistory() {
    const s = setup();
    const controller = new WorkoutController(new WorkoutService(
      stub<PrismaService>(s.store.prisma),
      stub<PtmService>({ emit: jest.fn() }),
      stub<ClientAIContextService>({ invalidateForUser: jest.fn() }),
    ));
    // The app's global pipe (main.ts) on the query, as GET runs it.
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const history = async (userId: string, name: string): Promise<HistoryOut> => {
      const q = await pipe.transform({ name }, stub<ArgumentMetadata>({ type: 'query', metatype: ExerciseHistoryQueryDto }));
      return stub<HistoryOut>(await controller.getExerciseHistory(stub<AuthedRequest>({ user: { id: userId } }), q));
    };
    return { ...s, history };
  }
  type Logs = ReturnType<typeof withHistory>;

  const on = (date: string, exercises: object[]) => ({ ...day(exercises), date });
  const logged = (name: string, group: string, reps: number[], lbs: number[], r: Record<string, unknown> = {}) => ({
    exercise_name: name, muscle_group: group, sets_completed: reps.length, reps_per_set: reps, weight_per_set: lbs, ...r,
  });
  /** One session as the code at f47013f4 builds it (its top set: the heaviest set of count 1 or more, more count on a tie). */
  const session = (workout_id: string, date: string, reps: number[], lbs: number[], est_1rm_lbs: number | null, volume_lbs: number) => {
    const counted = reps.map((r, i) => ({ weight_lbs: lbs[i], reps: r })).filter((t) => t.reps >= 1);
    const top_set = counted.reduce<{ weight_lbs: number; reps: number } | null>(
      (t, x) => (!t || x.weight_lbs > t.weight_lbs || (x.weight_lbs === t.weight_lbs && x.reps > t.reps) ? x : t), null);
    return { workout_id, date, sets: reps.length, reps_per_set: reps, weight_per_set_lbs: lbs, rpe: null, top_set, est_1rm_lbs, volume_lbs, coach_comments: [] };
  };
  /** The answer with every unit key deleted. */
  const withoutUnit = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(withoutUnit)
      : v !== null && typeof v === 'object' && !(v instanceof Date)
        ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'unit').map(([k, x]) => [k, withoutUnit(x)]))
        : v;
  const units = (h: HistoryOut) => h.sessions.map((x) => [x.date, x.unit, x.top_set?.unit]);

  // Each scenario logs her sets and reads them back; `before` is the answer the code at f47013f4 builds.
  const scenarios: Record<string, () => Promise<{ h: HistoryOut; before: object; logs: Logs }>> = {
    // A_LEGACY order 1 is a live plan row in seconds.
    async U1() {
      const logs = withHistory();
      const w = await logs.post(HER, on('2026-11-02', [logged('Wall sit', 'legs', [60, 60], [0, 0], ref(A_LEGACY, 1))]));
      const s = session(w.id, '2026-11-02', [60, 60], [0, 0], null, 0);
      return { logs, h: await logs.history(HER, 'Wall sit'), before: { best: { date: s.date, top_set: s.top_set }, first: { date: s.date, top_set: s.top_set }, sessions: [s] } };
    },
    // A_FROZEN order 1 is a snapshot row whose note starts "SECONDS."; the live plan gets a reps row at that order.
    async U2() {
      const logs = withHistory();
      logs.store.assignments.find((a) => a.id === A_FROZEN)!.workout_plan.exercises.push(liveRow(1, 3, 45, null, 'reps'));
      const w = await logs.post(HER, on('2026-11-03', [logged('Plank', 'core', [45, 45, 45], [0, 0, 0], ref(A_FROZEN, 1))]));
      const s = session(w.id, '2026-11-03', [45, 45, 45], [0, 0, 0], null, 0);
      return { logs, h: await logs.history(HER, 'Plank'), before: { best: { date: s.date, top_set: s.top_set }, first: { date: s.date, top_set: s.top_set }, sessions: [s] } };
    },
    async U3() {
      const logs = withHistory();
      const w = await logs.post(HER, on('2026-11-04', [logged('Bench press', 'chest', [8, 8, 8], [135, 135, 135], ref(A_FROZEN, 0))]));
      const s = session(w.id, '2026-11-04', [8, 8, 8], [135, 135, 135], 171, 3240);
      return { logs, h: await logs.history(HER, 'Bench press'), before: { best: { date: s.date, top_set: s.top_set }, first: { date: s.date, top_set: s.top_set }, sessions: [s] } };
    },
    // No reference, a malformed one, another member's assignment, an order with no row.
    async U4() {
      const logs = withHistory();
      const refs = [{}, ref('not-a-uuid', 0), ref(A_OTHERS, 0), ref(A_FROZEN, 7)];
      const ids: string[] = [];
      for (const [i, r] of refs.entries()) {
        ids.push((await logs.post(HER, on(`2026-11-0${5 + i}`, [logged('Push-up', 'chest', [12, 10], [0, 0], r)]))).id);
      }
      const s = ids.map((id, i) => session(id, `2026-11-0${5 + i}`, [12, 10], [0, 0], null, 0));
      return { logs, h: await logs.history(HER, 'Push-up'), before: { best: { date: s[0].date, top_set: s[0].top_set }, first: { date: s[0].date, top_set: s[0].top_set }, sessions: [...s].reverse() } };
    },
    // One name, oldest to newest: no reference, a plan row (the heaviest), no reference.
    async U5() {
      const logs = withHistory();
      const a = await logs.post(HER, on('2026-11-09', [logged('Bench press', 'chest', [8, 8, 8], [135, 135, 135])]));
      const b = await logs.post(HER, on('2026-11-10', [logged('Bench press', 'chest', [8, 8, 8], [145, 145, 145], ref(A_FROZEN, 0))]));
      const c = await logs.post(HER, on('2026-11-11', [logged('Bench press', 'chest', [8, 8, 8], [135, 135, 135])]));
      const [sa, sb, sc] = [
        session(a.id, '2026-11-09', [8, 8, 8], [135, 135, 135], 171, 3240),
        session(b.id, '2026-11-10', [8, 8, 8], [145, 145, 145], 183.7, 3480),
        session(c.id, '2026-11-11', [8, 8, 8], [135, 135, 135], 171, 3240),
      ];
      return { logs, h: await logs.history(HER, 'bench PRESS'), before: { best: { date: sb.date, top_set: sb.top_set }, first: { date: sa.date, top_set: sa.top_set }, sessions: [sc, sb, sa] } };
    },
  };

  it('U1: a wall sit from a live plan row in seconds reads seconds on its session, its top set, best and first', async () => {
    const { h } = await scenarios.U1();
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].unit).toBe('seconds');
    expect(h.sessions[0].top_set).toEqual({ weight_lbs: 0, reps: 60, unit: 'seconds' });
    expect([h.best?.top_set?.unit, h.first?.top_set?.unit]).toEqual(['seconds', 'seconds']);
  });

  it('U2: a plank from a frozen day reads seconds from the snapshot she was shown, not the live plan row', async () => {
    const { h } = await scenarios.U2();
    expect(units(h)).toEqual([['2026-11-03', 'seconds', 'seconds']]);
    expect([h.best?.top_set?.unit, h.first?.top_set?.unit]).toEqual(['seconds', 'seconds']);
  });

  it('U3: a bench from a reps plan row reads reps on its session and top set', async () => {
    const { h } = await scenarios.U3();
    expect(units(h)).toEqual([['2026-11-04', 'reps', 'reps']]);
    expect(h.sessions[0].top_set).toEqual({ weight_lbs: 135, reps: 8, unit: 'reps' });
  });

  it('U4: a set with no stored unit (no, malformed or foreign reference, no row at that order) sends unit null, never reps', async () => {
    const { h } = await scenarios.U4();
    expect(h.sessions).toHaveLength(4);
    for (const s of h.sessions) {
      expect(s).toHaveProperty('unit');
      expect(s.unit).toBeNull();
      expect(s.top_set).toHaveProperty('unit');
      expect(s.top_set?.unit).toBeNull();
    }
    expect([h.best?.top_set?.unit, h.first?.top_set?.unit]).toEqual([null, null]);
  });

  it("U5: one name with mixed rows: each session carries its own row's unit; best the best row's; first the first row's", async () => {
    const { h } = await scenarios.U5();
    expect(units(h)).toEqual([['2026-11-11', null, null], ['2026-11-10', 'reps', 'reps'], ['2026-11-09', null, null]]);
    expect(h.best).toEqual({ date: '2026-11-10', top_set: { weight_lbs: 145, reps: 8, unit: 'reps' } });
    expect(h.first).toEqual({ date: '2026-11-09', top_set: { weight_lbs: 135, reps: 8, unit: null } });
  });

  it('U6: PUT keeps the stored seconds after the plan changed; a PUT dropping the reference reads null', async () => {
    const logs = withHistory();
    const w = await logs.post(HER, on('2026-11-12', [logged('Plank', 'core', [45, 45, 45], [0, 0, 0], ref(A_FROZEN, 1))]));
    // The coach changes the plan: order 1 is now a reps row.
    logs.store.assignments.find((a) => a.id === A_FROZEN)!.snapshot = { exercises_json: [snapRow(0, 4, 8, 135), snapRow(1, 3, 20, null)] };
    await logs.put(HER, w.id, day([logged('Plank', 'core', [50, 50, 50], [0, 0, 0], ref(A_FROZEN, 1))]));
    expect(units(await logs.history(HER, 'Plank'))).toEqual([['2026-11-12', 'seconds', 'seconds']]);
    await logs.put(HER, w.id, day([logged('Plank', 'core', [50, 50, 50], [0, 0, 0])]));
    const h = await logs.history(HER, 'Plank');
    expect(h.sessions[0]).toHaveProperty('unit');
    expect(units(h)).toEqual([['2026-11-12', null, null]]);
  });

  it('U7: additive: with every unit key deleted, U1 to U5 answer exactly as before (keys, values, key order, session order)', async () => {
    for (const name of ['U1', 'U2', 'U3', 'U4', 'U5']) {
      const { h, before } = await scenarios[name]();
      expect(withoutUnit(h)).toStrictEqual(before);
      expect(JSON.stringify(withoutUnit(h))).toBe(JSON.stringify(before));
    }
  });

  it("U8: tenancy and query unchanged: another member's plank never appears; the where and orderBy are as before", async () => {
    const logs = withHistory();
    await logs.post(OTHER, on('2026-11-01', [logged('Plank', 'core', [90], [0], ref(A_OTHERS, 0))]));
    const w = await logs.post(HER, on('2026-11-02', [logged('Plank', 'core', [45], [0], ref(A_FROZEN, 1))]));
    const h = await logs.history(HER, 'PLANK');
    expect(h.sessions.map((s) => s.workout_id)).toEqual([w.id]);
    expect(logs.store.prisma.exerciseSet.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { exercise_name: { equals: 'PLANK', mode: 'insensitive' }, workout: { user_id: HER } },
      orderBy: [{ workout: { date: 'asc' } }, { workout: { created_at: 'asc' } }, { id: 'asc' }],
    }));
    expect((await logs.history(OTHER, 'Plank')).sessions.map((s) => s.reps_per_set)).toEqual([[90]]);
  });

  it('U9: a row with no set of count 1 or more: the session carries its stored unit (null here), top set and best stay null', async () => {
    const logs = withHistory();
    await logs.post(HER, on('2026-11-13', [logged('Dead hang', 'back', [0], [0])]));
    const h = await logs.history(HER, 'Dead hang');
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]).toHaveProperty('unit');
    expect(h.sessions[0].unit).toBeNull();
    expect(h.sessions[0].top_set).toBeNull();
    expect([h.best, h.first]).toEqual([null, { date: '2026-11-13', top_set: null }]);
  });
});
