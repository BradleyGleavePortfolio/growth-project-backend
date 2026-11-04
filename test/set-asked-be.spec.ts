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
import { CreateWorkoutDto, UpdateWorkoutDto } from '../src/workout/workout.dto';

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
  const exerciseSet = {
    findMany: jest.fn(async ({ where }: { where: { workout_id: string; plan_assignment_id?: { not: null } } }) => {
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
