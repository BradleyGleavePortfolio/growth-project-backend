import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { OnboardingService } from '../src/onboarding/onboarding.service';
import { parseFixture } from '../src/onboarding/consultation-programs';
import { selectProgram, type ProgramSelection } from '../src/onboarding/program-rules';
import { fakeOf } from './ai-egress/ai-egress.fakes';

const seed = join(__dirname, '..', 'seed');
const file = readdirSync(seed).find((name) => name.endsWith('-programs.v1.json'));
if (!file) throw new Error('Program fixture missing');
const fixture = parseFixture(readFileSync(join(seed, file), 'utf8'));

describe('LS-1211 explicit units through onboarding', () => {
  it.each([
    { unit: 'seconds', notes: null, count: 45 },
    { unit: 'reps', notes: 'SECONDS. Original note retained after coach edit.', count: 12 },
  ] as const)('preserves an edited consultation master $unit row', async ({ unit, notes, count }) => {
    const master = {
      id: 'master', name: 'Edited starter', description: null, weeks: 1,
      owner_user_id: 'coach', is_template: true, archived_at: null, goal_tag: null,
    };
    const createMany = jest.fn(async (_args: unknown) => ({ count: 1 }));
    const revision = jest.fn(async (_args: unknown) => ({ id: 'revision' }));
    const tx = {
      workoutProgram: {
        findUnique: jest.fn(async () => master),
        create: jest.fn(async () => ({ id: 'client-copy', name: master.name })),
        update: jest.fn(async () => ({})),
      },
      workoutPlan: {
        findMany: jest.fn(async () => [{
          id: 'master-day', name: 'Day 1', type: 'strength',
          duration_estimate_minutes: 30, week_index: 0, day_index: 0,
          exercises: [{
            exercise_external_id: 'seed:core-001', order: 0, sets: 3,
            reps_or_duration_seconds: count, unit, notes, rest_seconds: 60,
            weight_lbs: null, superset_group_id: null,
          }],
        }]),
        create: jest.fn(async () => ({ id: 'client-day' })),
        update: jest.fn(async () => ({})),
      },
      workoutPlanExercise: { createMany },
      workoutPlanRevision: { create: revision },
      workoutProgramRevision: { create: jest.fn(async () => ({})) },
    };
    const builder = {
      writeProgramAssignmentsInTx: jest.fn(async () => ({
        assignments: [{ id: 'assignment' }], first_plan_id: 'client-day',
      })),
    };
    const sel: ProgramSelection = {
      ...selectProgram({}), program_key: 'considered-strength',
      selected_days: 3, equipment_variant: 'gym', overlay: null,
    };
    const svc = new OnboardingService(fakeOf({}), fakeOf(builder));
    await svc['materialiseAndAssignInTx'](
      fakeOf(tx), { id: 'coach', tenant_id: 'coach' }, 'coach', 'client', 'master',
      sel, fixture.materialisation, '2026-11-04T12:00:00.000Z',
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ unit, reps_or_duration_seconds: count })],
    });
    expect(revision).toHaveBeenCalledWith({
      data: expect.objectContaining({
        exercises_json: [expect.objectContaining({ unit, reps_or_duration_seconds: count })],
      }),
    });
    expect(builder.writeProgramAssignmentsInTx).toHaveBeenCalled();
  });
});
