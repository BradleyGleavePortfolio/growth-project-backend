/**
 * TIMED-SETS-BE (agent 193): each plan exercise says whether its number
 * (reps_or_duration_seconds, still the count) is reps or seconds.
 *   1. A row with no unit (an older row, snapshot or request) reads reps.
 *   2. A timed exercise keeps "seconds" through the builder's Save (PUT) and
 *      autosave, both AI writers (the workout builder's diff ops and the older
 *      AI program), every plan copy, and the consultation program writer
 *      (which reads it from the program's own "SECONDS." note).
 *   3. One test walks every copier in src/ so a new copy cannot drop it.
 *   4. The migration: one column, reps for every row unless the program note
 *      says SECONDS.; down drops only the column and its type.
 *   5. The data export.
 * The live forward / down / forward run is test/rls/timed-sets-unit-migration-rls.spec.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PrismaService } from '../src/prisma.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { UpsertExerciseRowsDto } from '../src/workout-builder/workout-builder.dto';
import { AutosaveBatchSchema } from '../src/workout-builder/workout-builder-autosave.dto';
import { WorkoutBuilderService, parseAssignmentRows } from '../src/workout-builder/workout-builder.service';
import { WorkoutBuilderAutosaveService } from '../src/workout-builder/workout-builder-autosave.service';
import { unitOf } from '../src/workout-builder/plan-exercise-fields';
import { visibleAssignmentExercises } from '../src/workout-builder/assignment-exercises';
import { summariseRevision } from '../src/workout-builder/workout-plan-revision-summary';
import { applyWorkoutDiff } from '../src/ai/gateway/materialisers/__shared/workout-diff.applier';
import {
  AddExerciseOpSchema,
  emptyPlanSnapshot,
  serialiseSnapshotExercises,
  snapshotFromRevisionJson,
  toPersistableRows,
} from '../src/ai/gateway/materialisers/__shared/workout-diff.types';
import { WorkoutProgramPrompt } from '../src/ai/prompts/workout-program.prompt';
import { consultationUnit, materialiseClientPlans, parseFixture } from '../src/onboarding/consultation-programs';
import { writeProgramTree } from '../src/onboarding/program-writer';
import { fakeOf } from './ai-egress/ai-egress.fakes';

type Row = Record<string, unknown>;
const plank = { exercise_external_id: 'plank', order: 1, sets: 3, reps_or_duration_seconds: 45, weight_lbs: null, rest_seconds: 60, superset_group_id: null, notes: null };
const squat = { exercise_external_id: 'squat', order: 2, sets: 3, reps_or_duration_seconds: 8, weight_lbs: 95, rest_seconds: 90, superset_group_id: null, notes: null };

describe('a row with no unit reads reps', () => {
  it('unitOf: only an explicit "seconds" is seconds', () => {
    expect(unitOf({})).toBe('reps');
    expect(unitOf(null)).toBe('reps');
    expect(unitOf({ unit: 'minutes' })).toBe('reps');
    expect(unitOf({ unit: 'reps' })).toBe('reps');
    expect(unitOf({ unit: 'seconds' })).toBe('seconds');
  });

  it('an older revision, assignment snapshot or frozen day without a unit reads reps; seconds stays seconds', () => {
    expect(parseAssignmentRows([squat])[0].unit).toBe('reps');
    expect(parseAssignmentRows([{ ...plank, unit: 'seconds' }])[0].unit).toBe('seconds');
    expect(snapshotFromRevisionJson([squat], {}).exercises[0].unit).toBe('reps');
    expect(snapshotFromRevisionJson([{ ...plank, unit: 'seconds' }], {}).exercises[0].unit).toBe('seconds');
    const frozen = visibleAssignmentExercises({ snapshot: { exercises_json: [squat, { ...plank, unit: 'seconds' }] } }) as Row[];
    expect(frozen.map((r) => r.unit)).toEqual(['reps', 'seconds']);
    expect(frozen[0]).toMatchObject(squat);
  });

  it('a unit change counts as a changed row in the revision list; an older row without one does not', () => {
    expect(summariseRevision('manual_edit', [plank], [{ ...plank, unit: 'seconds' }])).toContain('1 changed');
    expect(summariseRevision('manual_edit', [plank], [{ ...plank, unit: 'reps' }])).not.toContain('changed');
  });
});

describe('the builder keeps seconds', () => {
  const plan = { id: 'plan-K', coach_id: 'K', program_id: null, name: 'Core', type: 'strength', duration_estimate_minutes: null, week_index: null, day_index: null };

  it('Save (PUT /exercises) takes the unit from the phone; a row sent without one saves reps; the revision keeps it', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 2 });
    const revision = jest.fn().mockResolvedValue({ id: 'rev-1' });
    const tx = {
      $queryRaw: jest.fn(async () => [{ id: plan.id }]),
      workoutPlan: { findUnique: jest.fn(async () => plan), update: jest.fn(async () => ({})) },
      workoutPlanRevision: { findFirst: jest.fn(async () => null), create: revision },
      workoutPlanExercise: { updateMany: jest.fn(async () => ({ count: 0 })), createMany, findMany: jest.fn(async () => []) },
    };
    const prisma = { ...tx, user: { findUnique: jest.fn(async () => ({ role: 'coach' })) }, $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const svc = new WorkoutBuilderService(fakeOf<PrismaService>(prisma));
    await svc.setExercises('K', plan.id, [
      { exercise_external_id: 'plank', order: 1, sets: 3, reps_or_duration_seconds: 45, unit: 'seconds' },
      { exercise_external_id: 'squat', order: 2, sets: 3, reps_or_duration_seconds: 8 },
    ]);
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ exercise_external_id: 'plank', unit: 'seconds' }), expect.objectContaining({ exercise_external_id: 'squat', unit: 'reps' })],
    });
    expect(revision).toHaveBeenCalledWith({
      data: expect.objectContaining({ exercises_json: [expect.objectContaining({ unit: 'seconds' }), expect.objectContaining({ unit: 'reps' })] }),
    });
  });

  it('the Save body takes reps or seconds, or no unit; anything else is refused', () => {
    const errors = (unit: unknown) =>
      validateSync(plainToInstance(UpsertExerciseRowsDto, { rows: [{ exercise_external_id: 'plank', order: 1, sets: 3, reps_or_duration_seconds: 45, ...(unit === undefined ? {} : { unit }) }] }), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
    expect(errors('seconds')).toHaveLength(0);
    expect(errors('reps')).toHaveLength(0);
    expect(errors(undefined)).toHaveLength(0);
    expect(errors('minutes')).not.toHaveLength(0);
  });

  it('autosave: a new row takes the unit from the phone (reps when absent); an edit without one keeps the saved unit', async () => {
    const live = [{ ...plank, id: '11111111-1111-4111-8111-111111111111', workout_plan_id: plan.id, unit: 'seconds', alternative_external_ids: null, created_at: new Date(0), archived_at: null }];
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx = {
      workoutPlan: { findUnique: jest.fn(async () => plan), findUniqueOrThrow: jest.fn(async () => plan), update: jest.fn(async () => plan) },
      workoutPlanExercise: { findMany: jest.fn(async () => live), updateMany: jest.fn(async () => ({ count: 1 })), createMany },
    };
    const svc = new WorkoutBuilderAutosaveService(fakeOf<PrismaService>({}), new WorkoutBuilderService(fakeOf<PrismaService>({})), fakeOf<AnalyticsService>({}), fakeOf<SubCoachScopeService>({}));
    const batch = AutosaveBatchSchema.parse({
      base_revision_index: 0,
      lock_token: '0123456789abcdef',
      cause: 'manual_edit',
      ops: [
        { op: 'upsert_exercise', row_id: live[0].id, payload: { exercise_external_id: 'plank', order: 1, sets: 4, reps_or_duration_seconds: 60 } },
        { op: 'upsert_exercise', payload: { exercise_external_id: 'wall-sit', order: 2, sets: 2, reps_or_duration_seconds: 30, unit: 'seconds' } },
        { op: 'upsert_exercise', payload: { exercise_external_id: 'squat', order: 3, sets: 3, reps_or_duration_seconds: 8 } },
      ],
    });
    const { snapshot } = await svc['applyOps'](fakeOf(tx), plan.id, batch.ops);
    expect(snapshot.map((r: Row) => [r.exercise_external_id, r.unit])).toEqual([['plank', 'seconds'], ['wall-sit', 'seconds'], ['squat', 'reps']]);
    expect(createMany.mock.calls[0][0].data.map((r: Row) => r.unit)).toEqual(['seconds', 'seconds', 'reps']);
    expect(() => AutosaveBatchSchema.parse({ ...batch, ops: [{ op: 'upsert_exercise', payload: { exercise_external_id: 'x', order: 1, sets: 1, reps_or_duration_seconds: 1, unit: 'minutes' } }] })).toThrow();
  });
});

describe('the AI writers keep seconds', () => {
  it("the workout builder's diff ops: an added or edited timed row stays seconds through persist and the revision", () => {
    const added = applyWorkoutDiff(emptyPlanSnapshot(), [
      { kind: 'add_exercise', client_ref: 'ai-1', exercise_external_id: 'plank', sets: 3, reps_or_duration_seconds: 45, rest_seconds: 60, notes: null, unit: 'seconds' },
      { kind: 'add_exercise', client_ref: 'ai-2', exercise_external_id: 'squat', sets: 3, reps_or_duration_seconds: 8, rest_seconds: 90, notes: null },
    ]);
    expect(toPersistableRows(added).map((r) => r.unit)).toEqual(['seconds', 'reps']);
    expect(serialiseSnapshotExercises(added).map((r) => r.unit)).toEqual(['seconds', 'reps']);
    const edited = applyWorkoutDiff(added, [{ kind: 'update_exercise', client_ref: 'ai-1', sets: 4 }, { kind: 'update_exercise', client_ref: 'ai-2', unit: 'seconds' }]);
    expect(toPersistableRows(edited).map((r) => r.unit)).toEqual(['seconds', 'seconds']);
    expect(() => AddExerciseOpSchema.parse({ kind: 'add_exercise', client_ref: 'ai-3', exercise_external_id: 'x', sets: 1, reps_or_duration_seconds: 5, rest_seconds: null, notes: null, unit: 'minutes' })).toThrow();
  });

  it('the AI program: a row the model marks seconds keeps it; no unit or any other reads reps', () => {
    const day = (unit?: unknown) => ({
      weeks: 1,
      days_per_week: 1,
      days: [{ week: 1, day: 1, name: 'Core', type: 'strength', duration_estimate_minutes: 30, exercises: [{ exercise_external_id: 'plank', name: 'Plank', order: 1, sets: 3, reps_or_duration_seconds: 45, ...(unit === undefined ? {} : { unit }) }] }],
      coach_notes: '',
    });
    const unitIn = (raw: unknown) => WorkoutProgramPrompt.validate(raw).days[0].exercises[0].unit;
    expect(unitIn(day('seconds'))).toBe('seconds');
    expect(unitIn(day())).toBe('reps');
    expect(unitIn(day('minutes'))).toBe('reps');
    expect(WorkoutProgramPrompt.system).toContain('"unit": "reps" | "seconds"');
  });
});

describe('every plan copy keeps seconds', () => {
  it('a program copy (fork, clone to a client) keeps it on the new rows and the new revision', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 2 });
    const revision = jest.fn().mockResolvedValue({ id: 'rev-0' });
    const src = { id: 'p1', name: 'Core', type: 'strength', duration_estimate_minutes: 30, week_index: 0, day_index: 0, exercises: [{ ...plank, unit: 'seconds' }, { ...squat, unit: 'reps' }] };
    const tx = {
      workoutPlan: { findMany: jest.fn(async () => [src]), create: jest.fn(async ({ data }: { data: Row }) => ({ id: 'p2', ...data })), update: jest.fn(async () => ({})) },
      workoutPlanExercise: { createMany },
      workoutPlanRevision: { create: revision },
    };
    const svc = new WorkoutBuilderService(fakeOf<PrismaService>({}));
    await svc['copyProgramPlans'](fakeOf(tx), { id: 'prog', coach_id: 'K' }, 'prog-2', { isTemplate: false, actingUserId: 'K', authorKind: 'coach', cause: 'clone', coachId: 'K' });
    expect(createMany.mock.calls[0][0].data.map((r: Row) => r.unit)).toEqual(['seconds', 'reps']);
    expect(revision.mock.calls[0][0].data.exercises_json.map((r: Row) => r.unit)).toEqual(['seconds', 'reps']);
  });

  // Every object in src/ that copies a planned exercise's count from a stored
  // row, a request or the AI also copies its unit, and every select feeding
  // one reads it. Excluded: readers that copy nothing to a plan or the phone.
  const EXCLUDED: Record<string, string> = {
    'src/scout/reconstruct/native/native-writers.ts:r': 'the importer (v1.1): writes reps, the column default',
    'src/roman/context/roman-client-context.service.ts:e': "Roman's context (AI only): found, not fixed",
    'src/roman/context/roman-client-context.service.ts:select': "Roman's context (AI only): found, not fixed",
    'src/ai/context/workout-context.service.ts:select': 'AI context reads the plan: found, not fixed',
    'src/onboarding/onboarding.service.ts:e': 'consultation rows: program-writer.ts reads the unit from the program note',
  };
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
  const root = join(__dirname, '..');

  it('walks every copier in src/', () => {
    const missing: string[] = [];
    for (const file of files(join(root, 'src')).filter((f) => !f.endsWith('.spec.ts'))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /reps_or_duration_seconds: (?:(\w+)\.reps_or_duration_seconds|(true)),/.exec(line);
        if (!m) return;
        const key = `${relative(root, file)}:${m[2] ? 'select' : m[1]}`;
        if (EXCLUDED[key]) return;
        const window = lines.slice(Math.max(0, i - 10), i + 12).join('\n');
        if (!/\bunit: /.test(window)) missing.push(`${key} (line ${i + 1})`);
      });
    }
    expect(missing).toEqual([]);
  });
});

describe('the consultation programs keep seconds', () => {
  const fx = parseFixture(readFileSync(join(__dirname, '..', 'seed', readdirSync(join(__dirname, '..', 'seed')).find((f) => /-programs\.v1\.json$/.test(f))!), 'utf8'));
  const masters = (key: string) => fx.programs.find((p) => p.fixture_key === key)!.plans;

  it('the unit is the program note: SECONDS. is seconds, anything else reps', () => {
    expect(consultationUnit({ notes: 'SECONDS. WORK. RPE 3. Plank.' })).toBe('seconds');
    expect(consultationUnit({ notes: 'REPS. WORK. RPE 3.' })).toBe('reps');
    expect(consultationUnit({ notes: null })).toBe('reps');
  });

  it('the writer stores it on every row and the first revision, after the home equipment swap', async () => {
    const plans = materialiseClientPlans(masters('considered-strength'), 'considered-strength', { selected_days: 3, equipment_variant: 'home-dumbbells', overlay: null }, fx.materialisation);
    const rows: Row[] = [];
    const revisions: Row[] = [];
    const tx = {
      workoutProgram: { create: jest.fn(async () => ({ id: 'prog' })), update: jest.fn(async () => ({})) },
      workoutPlan: { create: jest.fn(async () => ({ id: `plan-${revisions.length}` })), update: jest.fn(async () => ({})) },
      workoutPlanExercise: { createMany: jest.fn(async ({ data }: { data: Row[] }) => (rows.push(...data), { count: data.length })) },
      workoutPlanRevision: { create: jest.fn(async ({ data }: { data: Row }) => (revisions.push(data), { id: `rev-${revisions.length}` })) },
      workoutProgramRevision: { create: jest.fn(async () => ({ id: 'prog-rev' })) },
    };
    await writeProgramTree(fakeOf(tx), { tenantCoachId: 'K', ownerUserId: 'K', name: 'P', description: null, weeks: 4, daysPerWeek: 3, goalTag: null, isTemplate: false, plans, clonedFromId: null, revisionMeta: {} });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.unit).toBe(String(r.notes).startsWith('SECONDS.') ? 'seconds' : 'reps');
    expect(rows.some((r) => r.unit === 'seconds')).toBe(true);
    const frozen = revisions.flatMap((r) => r.exercises_json as Row[]);
    expect(frozen.map((r) => r.unit)).toEqual(rows.map((r) => r.unit));
  });
});

describe('the migration', () => {
  const dir = join(__dirname, '..', 'prisma', 'migrations');
  const name = readdirSync(dir).find((d) => d.endsWith('_plan_exercise_unit'));
  const sql = (f: string) => (name && existsSync(join(dir, name, f)) ? readFileSync(join(dir, name, f), 'utf8') : '');
  const strip = (s: string) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();

  it('is the newest migration and adds only the unit (enum, default reps, seconds only where the program note says so)', () => {
    expect(name).toBeDefined();
    expect(readdirSync(dir).filter((d) => /^\d{14}_/.test(d)).sort().pop()).toBe(name);
    const up = strip(sql('migration.sql'));
    expect(up).toContain(`CREATE TYPE "PlanExerciseUnit" AS ENUM ('reps', 'seconds');`);
    expect(up).toContain(`ALTER TABLE "WorkoutPlanExercise" ADD COLUMN IF NOT EXISTS "unit" "PlanExerciseUnit" NOT NULL DEFAULT 'reps';`);
    expect(up).toContain(`UPDATE "WorkoutPlanExercise" SET "unit" = 'seconds' WHERE "notes" LIKE 'SECONDS.%';`);
    expect(up.match(/ALTER TABLE|UPDATE|CREATE|DROP|DELETE|INSERT/g)).toEqual(['CREATE', 'ALTER TABLE', 'UPDATE']);
  });

  it('down drops only the column and the type', () => {
    const down = strip(sql('down.sql'));
    expect(down).toContain('ALTER TABLE "WorkoutPlanExercise" DROP COLUMN IF EXISTS "unit";');
    expect(down).toContain('DROP TYPE IF EXISTS "PlanExerciseUnit";');
    expect(down.match(/ALTER TABLE|UPDATE|CREATE|DROP|DELETE|INSERT/g)).toEqual(['ALTER TABLE', 'DROP']);
  });

  it('the schema declares it', () => {
    const schema = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).toMatch(/enum PlanExerciseUnit \{\s*reps\s*seconds\s*\}/);
    const model = /model WorkoutPlanExercise \{[\s\S]*?\n\}/.exec(schema)![0];
    expect(model).toMatch(/\n\s+unit\s+PlanExerciseUnit\s+@default\(reps\)/);
  });
});

describe('the data export', () => {
  // The export has no plan exercise today: assigned_workouts carries the plan
  // id, schedule and the logged results (completion_payload, stored as sent),
  // never the planned count. So no count can leave without its unit.
  it('no export select reads a planned count without its unit', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'data-export', 'data-export.service.ts'), 'utf8');
    const counts = src.match(/reps_or_duration_seconds/g) ?? [];
    const units = src.match(/\bunit: true/g) ?? [];
    expect(units.length).toBeGreaterThanOrEqual(counts.length);
    expect(src).not.toMatch(/workoutPlanExercise/);
  });
});
