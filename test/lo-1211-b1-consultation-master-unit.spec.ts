/**
 * LO-1211 B1 (b#1211 @ 1600cac1): a consultation master's unit must reach the client's copy.
 *
 * A coach (or the house account) edits a day of their consultation master: a row
 * becomes timed (unit seconds, its "REPS." note kept) or a "SECONDS." row becomes
 * reps. When a new client finishes onboarding, the clone of that master must keep
 * the unit the coach set. At the reviewed head the clone reads the unit from the
 * note only (onboarding.service.ts drops unit when it reads the master rows, and
 * program-writer.ts / consultationUnit ignore a stated unit), so the client gets
 * "45 reps" of a plank the coach set to 45 seconds, and seconds where the coach
 * meant reps.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { OnboardingService } from '../src/onboarding/onboarding.service';
import { parseFixture } from '../src/onboarding/consultation-programs';

type Row = Record<string, unknown>;

describe('LO-1211 B1: a consultation master row keeps the unit the coach set in the client copy', () => {
  const seedDir = join(__dirname, '..', 'seed');
  const fx = parseFixture(readFileSync(join(seedDir, readdirSync(seedDir).find((f) => /-programs\.v1\.json$/.test(f))!), 'utf8'));
  const masterPlans = fx.programs.find((p) => p.fixture_key === 'considered-strength')!.plans;

  it('onboarding clone: a REPS.-noted row set to seconds stays seconds, a SECONDS.-noted row set to reps stays reps', async () => {
    // The master's live rows, as tx.workoutPlan.findMany returns them, after the coach's two edits on day 1.
    const live = masterPlans.map((p, pi) => ({
      id: `master-plan-${pi}`,
      name: p.data.name,
      type: p.data.type,
      duration_estimate_minutes: p.data.duration_estimate_minutes ?? null,
      week_index: p.data.week_index,
      day_index: p.data.day_index,
      exercises: p.exercises.map((e, ei) => ({
        id: `ex-${pi}-${ei}`,
        ...e,
        alternative_external_ids: [],
        unit: String(e.notes ?? '').startsWith('SECONDS.') ? 'seconds' : 'reps',
      })),
    }));
    const day = live[0];
    const repsRow = day.exercises.find((e) => String(e.notes ?? '').startsWith('REPS.'))!;
    const secondsRow = live.flatMap((p) => p.exercises).find((e) => String(e.notes ?? '').startsWith('SECONDS.'))!;
    expect(repsRow).toBeDefined();
    expect(secondsRow).toBeDefined();
    repsRow.unit = 'seconds'; // the coach made it a 45-second hold
    repsRow.reps_or_duration_seconds = 45;
    secondsRow.unit = 'reps'; // the coach made it a counted exercise

    const written: Row[] = [];
    const tx = {
      workoutProgram: {
        findUnique: jest.fn(async () => ({ id: 'master', owner_user_id: 'K', is_template: true, archived_at: null, name: 'Considered strength', description: null, weeks: 4, goal_tag: null })),
        create: jest.fn(async () => ({ id: 'clone' })),
        update: jest.fn(async () => ({})),
      },
      workoutPlan: {
        findMany: jest.fn(async () => live),
        create: jest.fn(async () => ({ id: `plan-${written.length}` })),
        update: jest.fn(async () => ({})),
      },
      workoutPlanExercise: { createMany: jest.fn(async ({ data }: { data: Row[] }) => (written.push(...data), { count: data.length })) },
      workoutPlanRevision: { create: jest.fn(async () => ({ id: 'rev' })) },
      workoutProgramRevision: { create: jest.fn(async () => ({ id: 'prog-rev' })) },
    };
    const svc = Object.create(OnboardingService.prototype) as Record<string, unknown>;
    svc.workoutBuilder = { writeProgramAssignmentsInTx: jest.fn(async () => []) };
    const sel = { program_key: 'considered-strength', rule_priority: 1, requested_days: 3, selected_days: 3, equipment_variant: 'gym', overlay: null, coach_review_required: false, inputs: {} };
    await (svc.materialiseAndAssignInTx as (...a: unknown[]) => Promise<unknown>).call(
      svc, tx, { id: 'K', tenant_id: 'K' }, 'K', 'client-1', 'master', sel, fx.materialisation, '2026-11-09',
    );

    const copyOf = (src: { exercise_external_id: string; order: number; notes: string | null }) =>
      written.find((r) => r.exercise_external_id === src.exercise_external_id && r.order === src.order && r.notes === src.notes);
    expect(copyOf(repsRow)).toMatchObject({ reps_or_duration_seconds: 45, unit: 'seconds' });
    expect(copyOf(secondsRow)).toMatchObject({ unit: 'reps' });
  });
});
