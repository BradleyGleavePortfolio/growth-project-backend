/**
 * C1V2-C1: workout data for the Coach's page logging screens.
 *   1. PATCH /assignments/:id: who may move, skip or note a day (own client,
 *      other client, current coach, delegated sub-coach, former coach,
 *      unrelated coach, coachless client), the move window, one field a call;
 *      and GET /assignments/:id: only the client reads them back.
 *      A coach's note write replies with the note only, never the day's
 *      logged results (Workouts sharing on or off). C2-C0: the coach's planned
 *      time for the day (scheduled_time) follows the note's callers and reply.
 *   2. The agreed request shapes: swaps on a saved row (ExerciseDB and seed:
 *      ids, as the builder's library hands them back), completion_payload
 *      exercises[].swap_reason / skip_note (older payloads still accepted).
 *   3. Every copy of a planned exercise carries the coach's swaps: one test
 *      walks every copier in src/ (the PR's path list), plus the shared ones
 *      run on real rows.
 */
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PrismaService } from '../src/prisma.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { CompleteAssignmentDto, UpdateAssignmentDto, UpsertExerciseRowsDto } from '../src/workout-builder/workout-builder.dto';
import { WorkoutBuilderService, parseAssignmentRows } from '../src/workout-builder/workout-builder.service';
import { applyWorkoutDiff } from '../src/ai/gateway/materialisers/__shared/workout-diff.applier';
import { serialiseSnapshotExercises, snapshotFromRevisionJson, toPersistableRows } from '../src/ai/gateway/materialisers/__shared/workout-diff.types';
import { fakeOf } from './ai-egress/ai-egress.fakes';

const NOW = new Date('2026-10-15T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
type Row = Record<string, unknown>;

// Client A moved from coach F to coach K; S is K's delegated sub-coach for A;
// L coaches client C; Z has no coach. day-A is A's day, day-Z is Z's. `shares`:
// A's Workouts sharing with K (the consent row the coach's reads check).
function world(day: Row = {}, shares = true) {
  const users: Record<string, Row> = { A: { id: 'A', coach_id: 'K' }, C: { id: 'C', coach_id: 'L' }, Z: { id: 'Z', coach_id: null } };
  const days: Record<string, Row> = {
    'day-A': { id: 'day-A', client_id: 'A', completed_at: null, skipped_at: null, scheduled_for: NOW, client_note: null, ...day },
    'day-Z': { id: 'day-Z', client_id: 'Z', completed_at: null, skipped_at: null, scheduled_for: NOW, client_note: null },
  };
  const hit = (where: Row) => {
    const r = days[where.id as string];
    return r && Object.entries(where).every(([k, v]) => r[k] === v) ? r : undefined;
  };
  const grant = { client_id: 'A', coach_id: 'K', scope: 'fitness.workouts', granted_at: NOW, revoked_at: shares ? null : NOW };
  const prisma = {
    user: { findUnique: jest.fn(async ({ where }: { where: Row }) => users[where.id as string] ?? null) },
    clientCoachConsent: { findMany: jest.fn(async () => [grant]), findFirst: jest.fn(async () => grant) },
    clientWorkoutAssignment: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => (days[where.id as string] ? { ...days[where.id as string] } : null)),
      update: jest.fn(async ({ where, data, select }: { where: Row; data: Row; select?: Row }) => {
        const r = Object.assign(days[where.id as string], data);
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const r = hit(where);
        if (r) Object.assign(r, data);
        return { count: r ? 1 : 0 };
      }),
    },
  };
  const scope = { canAccessClient: jest.fn(async (who: string, client: string) => who === 'S' && client === 'A') };
  const svc = new WorkoutBuilderService(fakeOf<PrismaService>(prisma), undefined, fakeOf<SubCoachScopeService>(scope));
  return { svc, days };
}

describe('PATCH /assignments/:id: who moves, skips and notes a day', () => {
  const MOVE = { scheduled_for: '2026-10-17' };
  const ACTIONS: Array<[string, UpdateAssignmentDto, Row]> = [
    ['move', MOVE, { scheduled_for: new Date('2026-10-17T00:00:00Z') }],
    ['skip', { skip: true }, { skipped_at: NOW }],
    ['note', { client_note: ' Easy pace today ' }, { client_note: 'Easy pace today' }],
    ['time', { scheduled_time: '17:30' }, { scheduled_time: '17:30' }],
  ];
  // [action, caller, day]: allowed. Every other caller below is refused.
  const ALLOWED = new Set(['move A day-A', 'move Z day-Z', 'skip A day-A', 'skip Z day-Z', 'note K day-A', 'note S day-A', 'time K day-A', 'time S day-A']);
  const CALLERS: Array<[string, string, string]> = [
    ['A', 'day-A', 'own client'], ['C', 'day-A', 'other client'], ['K', 'day-A', 'current coach'], ['S', 'day-A', 'delegated sub-coach'],
    ['F', 'day-A', 'former coach'], ['L', 'day-A', 'unrelated coach'], ['Z', 'day-Z', 'coachless client, own day'],
  ];
  const table = ACTIONS.flatMap(([action, dto, written]) => CALLERS.map(([who, day, label]) => ({ action, dto, written, who, day, label })));

  it.each(table)('$action by $label ($who)', async ({ action, dto, written, who, day }) => {
    const w = world();
    const before = { ...w.days[day] };
    if (ALLOWED.has(`${action} ${who} ${day}`)) {
      await expect(w.svc.updateAssignment(who, day, dto, NOW)).resolves.toMatchObject(written);
    } else {
      await expect(w.svc.updateAssignment(who, day, dto, NOW)).rejects.toThrow(ForbiddenException);
      expect(w.days[day]).toEqual(before);
    }
  });

  it.each(CALLERS)('read by %s of %s (%s): only the client reads their day, its note, skip and swaps', async (who, day) => {
    const snapshot = { exercises_json: [{ order: 0, exercise_external_id: 'bench', alternative_external_ids: ['db-bench'] }] };
    const w = world({ skipped_at: NOW, client_note: 'Easy pace', snapshot, adjustment_proposals: [] });
    const read = w.svc.getMyAssignment(who, day);
    if (who === 'A') await expect(read).resolves.toMatchObject({ skipped_at: NOW, client_note: 'Easy pace', exercises: snapshot.exercises_json });
    else if (who === 'Z') await expect(read).resolves.toMatchObject({ id: 'day-Z', client_note: null });
    else await expect(read).rejects.toThrow(ForbiddenException);
  });

  it('a move lands from 2 days back (today in every time zone) to 7 days ahead', async () => {
    const at = (ms: number) => ({ scheduled_for: new Date(NOW.getTime() + ms).toISOString() });
    await expect(world().svc.updateAssignment('A', 'day-A', at(-2 * DAY), NOW)).resolves.toBeTruthy();
    await expect(world().svc.updateAssignment('A', 'day-A', at(7 * DAY), NOW)).resolves.toBeTruthy();
    await expect(world().svc.updateAssignment('A', 'day-A', { scheduled_for: '2026-10-15' }, NOW)).resolves.toBeTruthy();
    await expect(world().svc.updateAssignment('A', 'day-A', at(-2 * DAY - 1), NOW)).rejects.toThrow(BadRequestException);
    await expect(world().svc.updateAssignment('A', 'day-A', at(7 * DAY + 1), NOW)).rejects.toThrow(BadRequestException);
  });

  it('a completed or skipped day is not moved or skipped; the coach note still lands; one field a call', async () => {
    for (const day of [{ completed_at: NOW }, { skipped_at: NOW }]) {
      const w = world(day);
      await expect(w.svc.updateAssignment('A', 'day-A', MOVE, NOW)).rejects.toThrow(ConflictException);
      await expect(w.svc.updateAssignment('A', 'day-A', { skip: true }, NOW)).rejects.toThrow(ConflictException);
      await expect(w.svc.updateAssignment('K', 'day-A', { client_note: 'Nice' }, NOW)).resolves.toMatchObject({ client_note: 'Nice' });
    }
    const w = world({ client_note: 'Old' });
    await expect(w.svc.updateAssignment('K', 'day-A', { client_note: '  ' }, NOW)).resolves.toMatchObject({ client_note: null });
    await expect(w.svc.updateAssignment('A', 'day-A', {}, NOW)).rejects.toThrow(BadRequestException);
    await expect(w.svc.updateAssignment('A', 'day-A', { skip: true, ...MOVE }, NOW)).rejects.toThrow(BadRequestException);
    await expect(w.svc.updateAssignment('K', 'day-A', { client_note: 'Hi', scheduled_time: '07:00' }, NOW)).rejects.toThrow(BadRequestException);
  });
});

describe("a coach's note or time write never returns the day's logged results", () => {
  // Everything a coach reads only while the client shares Workouts.
  const RESULTS = {
    started_at: NOW, completed_at: NOW, skipped_at: NOW, post_rpe: 8, post_notes: 'Felt strong', completion_payload: { exercises: [{ sets: [{ reps: 8 }] }] },
  };
  const WRITES: Array<[string, UpdateAssignmentDto, Row]> = [
    ['note set', { client_note: ' Easy pace ' }, { client_note: 'Easy pace' }], ['note clear', { client_note: '  ' }, { client_note: null }],
    ['time set', { scheduled_time: '06:30' }, { scheduled_time: '06:30' }], ['time clear', { scheduled_time: null }, { scheduled_time: null }],
  ];
  const table = ['K', 'S'].flatMap((who) => [false, true].flatMap((shares) => WRITES.map(([action, dto, kept]) => ({ who, shares, action, dto, kept }))));

  it.each(table)('$action by $who, A shares Workouts: $shares -> { id, <that field> } only', async ({ who, shares, dto, kept }) => {
    const w = world({ ...RESULTS, scheduled_time: '17:30' }, shares);
    await expect(w.svc.updateAssignment(who, 'day-A', dto, NOW)).resolves.toEqual({ id: 'day-A', ...kept });
    expect(w.days['day-A']).toMatchObject({ ...RESULTS, ...kept });
  });
});

describe('agreed request shapes', () => {
  const errors = <T extends object>(cls: new () => T, body: object) => validateSync(plainToInstance(cls, body)).map((e) => e.property);
  const complete = (completion_payload: unknown) =>
    errors(CompleteAssignmentDto, { idempotency_key: '00000000-0000-4000-8000-000000000001', completion_payload });

  it('completion_payload: swap_reason and skip_note are text up to 500; older payloads still pass', () => {
    expect(complete({ exercises: [{ exerciseName: 'Bench', sets: [{ reps: 8 }] }] })).toEqual([]);
    expect(complete({ notes: 'no exercises key' })).toEqual([]);
    expect(complete({ exercises: [{ swap_reason: 'Bench was taken', skip_note: null }, { skip_note: 'x'.repeat(500) }] })).toEqual([]);
    expect(complete({ exercises: 'Bench' })).toEqual(['completion_payload']);
    expect(complete({ exercises: [{ swap_reason: 3 }] })).toEqual(['completion_payload']);
    expect(complete({ exercises: [{ skip_note: 'x'.repeat(501) }] })).toEqual(['completion_payload']);
  });

  it('PATCH body and swaps on a saved row are validated', () => {
    expect(errors(UpdateAssignmentDto, { skip: false })).toEqual(['skip']);
    expect(errors(UpdateAssignmentDto, { scheduled_for: 'Thursday' })).toEqual(['scheduled_for']);
    expect(errors(UpdateAssignmentDto, { client_note: 'x'.repeat(501) })).toEqual(['client_note']);
    const row = (alternative_external_ids: unknown) =>
      validateSync(plainToInstance(UpsertExerciseRowsDto, { rows: [{ exercise_external_id: 'bench', order: 1, sets: 3, reps_or_duration_seconds: 8, alternative_external_ids }] })).length;
    expect(row(['db-bench', 'pushup'])).toBe(0);
    expect(row(['0289', 'seed:push-004'])).toBe(0);
    expect(row(['a', 'b', 'c', 'd', 'e', 'f'])).toBe(1);
    expect(row(['a', 'a'])).toBe(1);
    expect(row([7])).toBe(1);
  });

  it("Save keeps swaps named as the builder's library names exercises: ExerciseDB ids and seed: ids", async () => {
    const swaps = ['0289', 'seed:push-004'];
    const plan = { id: 'plan-K', coach_id: 'K', program_id: null, name: 'Push', type: 'strength', duration_estimate_minutes: null, week_index: null, day_index: null };
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const revision = jest.fn().mockResolvedValue({ id: 'rev-1' });
    const tx = {
      $queryRaw: jest.fn(async () => [{ id: plan.id }]),
      workoutPlan: { findUnique: jest.fn(async () => plan), update: jest.fn(async () => ({})) },
      workoutPlanRevision: { findFirst: jest.fn(async () => null), create: revision },
      workoutPlanExercise: { updateMany: jest.fn(async () => ({ count: 0 })), createMany, findMany: jest.fn(async () => []) },
    };
    const prisma = { ...tx, user: { findUnique: jest.fn(async () => ({ role: 'coach' })) }, $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const svc = new WorkoutBuilderService(fakeOf<PrismaService>(prisma));
    await svc.setExercises('K', plan.id, [{ exercise_external_id: '0025', order: 1, sets: 3, reps_or_duration_seconds: 8, alternative_external_ids: swaps }]);
    expect(createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ exercise_external_id: '0025', alternative_external_ids: swaps })] });
    expect(revision).toHaveBeenCalledWith({ data: expect.objectContaining({ exercises_json: [expect.objectContaining({ alternative_external_ids: swaps })] }) });
  });
});

describe('every copy of a planned exercise carries the coach swaps', () => {
  const swaps = ['db-bench', 'pushup'];
  const row = { exercise_external_id: 'bench', order: 0, sets: 3, reps_or_duration_seconds: 8, weight_lbs: null, rest_seconds: null, superset_group_id: null, notes: null };

  it('the shared copiers keep them on real rows and read an older row as none', () => {
    const svc = new WorkoutBuilderService(fakeOf<PrismaService>({}));
    const json = svc['serialiseExerciseRows']([{ ...row, alternative_external_ids: swaps }]);
    const snap = snapshotFromRevisionJson(json, {});
    const edited = applyWorkoutDiff(snap, [{ kind: 'update_exercise', client_ref: snap.exercises[0].client_ref, sets: 4 }]);
    expect(parseAssignmentRows(json)[0].alternative_external_ids).toEqual(swaps);
    expect(toPersistableRows(edited)[0]).toMatchObject({ sets: 4, alternative_external_ids: swaps });
    expect(serialiseSnapshotExercises(edited)[0].alternative_external_ids).toEqual(swaps);
    expect(parseAssignmentRows([row])[0].alternative_external_ids).toBeUndefined();
  });

  // Every object in src/ that copies a planned exercise's fields from a
  // stored row also copies its swaps, and every select feeding one reads them.
  // Excluded: rows built from input that has no swaps (a new or AI-added row,
  // an import) and readers that copy nothing.
  const EXCLUDED: Record<string, string> = {
    'src/workout-builder/workout-builder-autosave.service.ts:input': 'an autosave row from the request (the swaps are kept from the live row)',
    'src/ai/coach/coach-ai.service.ts:row': 'the older AI program write: rows from the model',
    'src/ai/gateway/materialisers/__shared/workout-diff.applier.ts:op': 'an exercise the AI adds',
    'src/scout/reconstruct/native/native-writers.ts:r': 'an imported program (the source has no swaps)',
    'src/roman/context/roman-client-context.service.ts:e': 'Roman reads the day; copies nothing',
    'src/community/plan-context/plan-context.service.ts:row': 'a community plan read; copies nothing',
    'src/roman/context/roman-client-context.service.ts:select': 'Roman reads the day; copies nothing',
    'src/ai/context/workout-context.service.ts:select': 'AI context reads the plan; copies nothing',
  };
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));

  it('walks every copier in src/', () => {
    const root = join(__dirname, '..');
    const copiers: string[] = [];
    for (const file of files(join(root, 'src'))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /reps_or_duration_seconds: (?:(\w+)\.reps_or_duration_seconds|true),/.exec(line);
        if (!m) return;
        const at = `${relative(root, file)}:${m[1] ?? 'select'}`;
        const carries = m[1] ? `alternative_external_ids: alternativesOf(${m[1]})` : 'alternative_external_ids: true';
        if (!(at in EXCLUDED)) copiers.push(`${at}:${lines.slice(i, i + 8).some((l) => l.includes(carries))}`);
      });
    }
    expect(copiers.length).toBeGreaterThanOrEqual(21);
    expect(copiers.filter((c) => c.endsWith(':false'))).toEqual([]);
  });
});
