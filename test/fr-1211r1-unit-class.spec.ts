/**
 * FR-1211R1 (agent 194): the unit a row states is the unit every copy and every
 * AI check reads. One table per class.
 *   1. Consultation clone (LS-1211 B1, LO-1211 B1): a master row's stated unit
 *      survives materialiseClientPlans + writeProgramTree (rows and revision);
 *      a home swap that re-prescribes the count follows its patched note; the
 *      extra-care cap reads the stated unit.
 *   2. AI validator (LS-1211 B2): bounds, the rep cap and the increase read the
 *      row the applier will write, and the applier writes that same row.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { materialiseClientPlans, parseFixture, type PlanContent } from '../src/onboarding/consultation-programs';
import { writeProgramTree } from '../src/onboarding/program-writer';
import { fakeOf } from './ai-egress/ai-egress.fakes';
import { emptyPlanSnapshot, type PlanSnapshot } from '../src/ai/gateway/materialisers/__shared/workout-diff.types';
import { validateProposedChanges, type QuickAction } from '../src/ai/gateway/workout-builder/workout-diff.validator';
import { unitOf } from '../src/workout-builder/plan-exercise-fields';

type Row = Record<string, unknown>;
const seedDir = join(__dirname, '..', 'seed');
const fx = parseFixture(readFileSync(join(seedDir, readdirSync(seedDir).find((f) => /-programs\.v1\.json$/.test(f))!), 'utf8'));

/** The master as the database holds it: every row states a unit (the migration backfilled it from the note). */
function master(key: string): PlanContent[] {
  return fx.programs.find((p) => p.fixture_key === key)!.plans.map((p) => ({
    ...p,
    exercises: p.exercises.map((e) => ({ ...e, unit: String(e.notes ?? '').startsWith('SECONDS.') ? 'seconds' : 'reps' }) as typeof e),
  }));
}

async function write(plans: PlanContent[]): Promise<{ rows: Row[]; frozen: Row[] }> {
  const rows: Row[] = [];
  const frozen: Row[] = [];
  const tx = {
    workoutProgram: { create: jest.fn(async () => ({ id: 'prog' })), update: jest.fn(async () => ({})) },
    workoutPlan: { create: jest.fn(async () => ({ id: `plan-${frozen.length}` })), update: jest.fn(async () => ({})) },
    workoutPlanExercise: { createMany: jest.fn(async ({ data }: { data: Row[] }) => (rows.push(...data), { count: data.length })) },
    workoutPlanRevision: { create: jest.fn(async ({ data }: { data: Row }) => (frozen.push(...(data.exercises_json as Row[])), { id: 'rev' })) },
    workoutProgramRevision: { create: jest.fn(async () => ({ id: 'prog-rev' })) },
  };
  await writeProgramTree(fakeOf(tx), {
    tenantCoachId: 'K', ownerUserId: 'K', name: 'P', description: null, weeks: 4, daysPerWeek: 3, goalTag: null,
    isTemplate: false, plans, clonedFromId: null, revisionMeta: {},
  });
  return { rows, frozen };
}

describe('FR-1211R1 class 1: the consultation clone keeps the unit the master row states', () => {
  type Case = {
    name: string; program: string; equipment: string; overlay: 'extra-care' | null;
    /** The master row (week 0, day 0) the coach edited, by its catalog id and phase word. */
    pick: { id: string; phase: string }; edit: { unit: 'reps' | 'seconds'; count?: number };
    /** What the client's copy holds for that row. */
    want: { unit: 'reps' | 'seconds'; count: number };
  };
  const CASES: Case[] = [
    { name: 'gym, no swap: a REPS. row the coach set to seconds stays seconds', program: 'considered-strength', equipment: 'gym', overlay: null,
      pick: { id: 'leg-press', phase: 'WORK.' }, edit: { unit: 'seconds', count: 45 }, want: { unit: 'seconds', count: 45 } },
    { name: 'gym, no swap: a SECONDS. row the coach set to reps stays reps', program: 'considered-strength', equipment: 'gym', overlay: null,
      pick: { id: 'stationary-bike', phase: 'WARM-UP.' }, edit: { unit: 'reps', count: 12 }, want: { unit: 'reps', count: 12 } },
    { name: 'home swap that only changes the exercise and note keeps the stated unit', program: 'considered-strength', equipment: 'home-dumbbells', overlay: null,
      pick: { id: 'leg-press', phase: 'WORK.' }, edit: { unit: 'seconds', count: 40 }, want: { unit: 'seconds', count: 40 } },
    { name: 'home swap that sets the count follows its patched REPS. note', program: 'considered-strength', equipment: 'home-dumbbells', overlay: null,
      pick: { id: 'stationary-bike', phase: 'WARM-UP.' }, edit: { unit: 'seconds' }, want: { unit: 'reps', count: 6 } },
    { name: 'extra-care caps a stated-seconds row at the seconds cap, not the reps cap', program: 'steady-foundations', equipment: 'gym', overlay: 'extra-care',
      pick: { id: 'back-squat', phase: 'WORK.' }, edit: { unit: 'seconds', count: 30 }, want: { unit: 'seconds', count: 10 } },
    { name: 'extra-care on an unedited reps row keeps the reps cap', program: 'steady-foundations', equipment: 'gym', overlay: 'extra-care',
      pick: { id: 'back-squat', phase: 'WORK.' }, edit: { unit: 'reps', count: 30 }, want: { unit: 'reps', count: 6 } },
  ];

  it.each(CASES)('$name', async (c) => {
    const plans = master(c.program);
    const day = plans.find((p) => p.data.week_index === 0 && p.data.day_index === 0)!;
    const row = day.exercises.find((e) => e.exercise_external_id === c.pick.id && String(e.notes).includes(c.pick.phase))!;
    expect(row).toBeDefined();
    (row as { unit?: string }).unit = c.edit.unit;
    if (c.edit.count !== undefined) row.reps_or_duration_seconds = c.edit.count;
    const order = row.order;
    const days = fx.programs.find((p) => p.fixture_key === c.program)!.data.days_per_week;
    const out = materialiseClientPlans(plans, c.program as never, { selected_days: days, equipment_variant: c.equipment as never, overlay: c.overlay }, fx.materialisation);
    const outDay = out.find((p) => p.data.week_index === 0 && p.data.day_index === 0)!;
    const { rows, frozen } = await write([outDay]);
    expect(rows.find((r) => r.order === order)).toMatchObject({ unit: c.want.unit, reps_or_duration_seconds: c.want.count });
    expect(frozen.find((r) => r.order === order)).toMatchObject({ unit: c.want.unit, reps_or_duration_seconds: c.want.count });
  });
});

describe('FR-1211R1 class 2: the AI validator checks the row the applier will write', () => {
  const library = new Map([['seed:core-001', { id: 'seed:core-001', name: 'Plank', category: 'core', muscle: 'core', thumbnail_url: null }]]);
  const base = {
    client_ref: 'core', exercise_external_id: 'seed:core-001', order: 0, sets: 3, reps_or_duration_seconds: 12,
    weight_lbs: null, rest_seconds: 60, superset_group_id: null, notes: null,
  };
  type Case = {
    name: string; row?: Record<string, unknown>; op: Record<string, unknown>; quickAction?: QuickAction;
    /** A drop reason, or the unit and count the applied row holds. */
    want: { dropped: string } | { unit: 'reps' | 'seconds'; count: number };
  };
  const CASES: Case[] = [
    { name: 'add, no unit, 120: persists reps, so the reps bound drops it',
      op: { kind: 'add_exercise', client_ref: 'core', exercise_external_id: 'seed:core-001', sets: 3, reps_or_duration_seconds: 120 },
      want: { dropped: 'Reps must be 1 to 30.' } },
    { name: 'add, no unit, 20: persists 20 reps',
      op: { kind: 'add_exercise', client_ref: 'core', exercise_external_id: 'seed:core-001', sets: 3, reps_or_duration_seconds: 20 },
      want: { unit: 'reps', count: 20 } },
    { name: 'add, unit seconds, 120: persists 120 seconds',
      op: { kind: 'add_exercise', client_ref: 'core', exercise_external_id: 'seed:core-001', sets: 3, reps_or_duration_seconds: 120, unit: 'seconds' },
      want: { unit: 'seconds', count: 120 } },
    { name: 'add, no unit, SECONDS. note, 120: persists 120 seconds',
      op: { kind: 'add_exercise', client_ref: 'core', exercise_external_id: 'seed:core-001', sets: 3, reps_or_duration_seconds: 120, notes: 'SECONDS. Hold.' },
      want: { unit: 'seconds', count: 120 } },
    { name: 'count-only edit on an explicit reps row: the rep cap applies', row: { unit: 'reps' }, quickAction: 'progress',
      op: { kind: 'update_exercise', client_ref: 'core', reps_or_duration_seconds: 20 },
      want: { dropped: 'Rep increase is more than 2 in one step.' } },
    { name: 'count-only edit on an explicit seconds row: the seconds bound, no rep cap', row: { unit: 'seconds', reps_or_duration_seconds: 30 }, quickAction: 'progress',
      op: { kind: 'update_exercise', client_ref: 'core', reps_or_duration_seconds: 45 },
      want: { unit: 'seconds', count: 45 } },
    { name: 'unit-only edit, 120 seconds to reps: the reps bound drops it', row: { unit: 'seconds', reps_or_duration_seconds: 120 },
      op: { kind: 'update_exercise', client_ref: 'core', unit: 'reps' },
      want: { dropped: 'Reps must be 1 to 30.' } },
    { name: 'unit-only edit, 12 reps to seconds: the seconds bound', row: { unit: 'reps' },
      op: { kind: 'update_exercise', client_ref: 'core', unit: 'seconds' },
      want: { unit: 'seconds', count: 12 } },
    { name: 'a unit change counts as an increase under a deload', row: { unit: 'reps' }, quickAction: 'deload',
      op: { kind: 'update_exercise', client_ref: 'core', unit: 'seconds' },
      want: { dropped: 'A deload does not increase sets, reps or load.' } },
    { name: 'a rest-only edit leaves an untouched count unchecked', row: { unit: 'reps', reps_or_duration_seconds: 40 },
      op: { kind: 'update_exercise', client_ref: 'core', rest_seconds: 90 },
      want: { unit: 'reps', count: 40 } },
    { name: 'a note edit on a unitless row that makes it SECONDS.: the seconds bound reads the new note', row: { reps_or_duration_seconds: 120 },
      op: { kind: 'update_exercise', client_ref: 'core', notes: 'SECONDS. Hold.' },
      want: { unit: 'seconds', count: 120 } },
  ];

  it.each(CASES)('$name', (c) => {
    const baseline: PlanSnapshot = c.row ? { ...emptyPlanSnapshot(), exercises: [{ ...base, ...c.row }] } : emptyPlanSnapshot();
    const result = validateProposedChanges({
      library, injuries: [], screeningFlag: false, instruction: 'Adjust my workout.', baseline, quickAction: c.quickAction,
      rawChanges: [{ op: c.op, reason: 'A reason.' }],
    });
    if ('dropped' in c.want) {
      expect(result.changes).toHaveLength(0);
      expect(result.dropped).toEqual([{ reason: c.want.dropped }]);
      return;
    }
    expect(result.dropped).toEqual([]);
    expect(result.changes).toHaveLength(1);
    const written = result.snapshot.exercises.find((e) => e.client_ref === 'core')!;
    expect({ unit: unitOf(written), count: written.reps_or_duration_seconds }).toEqual(c.want);
    expect(result.changes[0].after).toMatchObject({ reps_or_duration_seconds: c.want.count });
  });
});
