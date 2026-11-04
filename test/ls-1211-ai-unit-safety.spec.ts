import {
  emptyPlanSnapshot, type PlanSnapshot,
} from '../src/ai/gateway/materialisers/__shared/workout-diff.types';
import { validateProposedChanges } from '../src/ai/gateway/workout-builder/workout-diff.validator';

const library = new Map([['seed:core-001', {
  id: 'seed:core-001', name: 'Plank', category: 'core', muscle: 'core', thumbnail_url: null,
}]]);
const row = {
  client_ref: 'core', exercise_external_id: 'seed:core-001', order: 0, sets: 3,
  reps_or_duration_seconds: 12, weight_lbs: null, rest_seconds: 60,
  superset_group_id: null, notes: null,
};
const common = { library, injuries: [], screeningFlag: false, instruction: 'Progress my workout.' };

describe('LS-1211 AI checks the unit it will persist', () => {
  it('enforces the rep progression cap for an explicitly reps row with a timed-sounding name', () => {
    const baseline: PlanSnapshot = {
      ...emptyPlanSnapshot(), exercises: [{ ...row, unit: 'reps' }],
    };
    const result = validateProposedChanges({
      ...common, baseline, quickAction: 'progress',
      rawChanges: [{
        op: { kind: 'update_exercise', client_ref: 'core', reps_or_duration_seconds: 20 },
        reason: 'Progress the repetitions.',
      }],
    });
    expect(result.changes).toHaveLength(0);
    expect(result.dropped).toEqual([
      { reason: 'Rep increase is more than 2 in one step.' },
    ]);
  });

  it('rejects an omitted-unit AI add that would persist 120 reps, not 120 seconds', () => {
    const result = validateProposedChanges({
      ...common, baseline: emptyPlanSnapshot(),
      rawChanges: [{
        op: {
          kind: 'add_exercise', client_ref: 'core', exercise_external_id: 'seed:core-001',
          sets: 3, reps_or_duration_seconds: 120,
        },
        reason: 'Add a core exercise.',
      }],
    });
    expect(result.changes).toHaveLength(0);
    expect(result.dropped).toEqual([{ reason: 'Reps must be 1 to 30.' }]);
  });

  it('a unit-only edit cannot convert 120 seconds into 120 reps', () => {
    const baseline: PlanSnapshot = {
      ...emptyPlanSnapshot(),
      exercises: [{ ...row, unit: 'seconds', reps_or_duration_seconds: 120 }],
    };
    const result = validateProposedChanges({
      ...common, baseline,
      rawChanges: [{
        op: { kind: 'update_exercise', client_ref: 'core', unit: 'reps' },
        reason: 'Use repetitions.',
      }],
    });
    expect(result.changes).toHaveLength(0);
    expect(result.dropped).toEqual([{ reason: 'Reps must be 1 to 30.' }]);
  });
});
