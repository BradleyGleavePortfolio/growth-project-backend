import { PlanSnapshot } from '../src/ai/gateway/materialisers/__shared/workout-diff.types';
import { stripMedicalClaims } from '../src/ai/gateway/workout-builder/training-safety.constants';
import { validateProposedChanges, ValidateInput } from '../src/ai/gateway/workout-builder/workout-diff.validator';
import { LIBRARY } from '../src/ai/gateway/workout-builder/workout-builder-ai.service';

function plan(): PlanSnapshot {
  return {
    meta: { name: 'Upper', type: 'strength', duration_estimate_minutes: 60 },
    exercises: [
      { client_ref: 'r1', exercise_external_id: 'seed:push-001', order: 0, sets: 3, reps_or_duration_seconds: 8, weight_lbs: 135, rest_seconds: 120, superset_group_id: null, notes: null },
      { client_ref: 'r2', exercise_external_id: 'seed:pull-004', order: 1, sets: 3, reps_or_duration_seconds: 10, weight_lbs: null, rest_seconds: 90, superset_group_id: null, notes: null },
    ],
  };
}

function run(changes: unknown[], extra: Partial<ValidateInput> = {}) {
  return validateProposedChanges({
    baseline: plan(),
    rawChanges: changes,
    library: LIBRARY,
    injuries: [],
    instruction: '',
    screeningFlag: false,
    ...extra,
  });
}

const add = (id: string, over: Record<string, unknown> = {}) => ({
  op: { kind: 'add_exercise', client_ref: 'ai-1', exercise_external_id: id, sets: 3, reps_or_duration_seconds: 10, ...over },
  reason: 'Adds pulling volume.',
});

describe('validateProposedChanges (B-AIB2-126)', () => {
  it('keeps a valid library add and reports before/after', () => {
    const r = run([add('seed:pull-002')]);
    expect(r.dropped).toEqual([]);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ change_id: 'c0', kind: 'added', exercise: { id: 'seed:pull-002', name: 'Lat Pulldown' } });
    expect(r.changes[0].after?.sets).toBe(3);
  });

  it('drops an invented exercise id', () => {
    const r = run([add('seed:made-up-999')]);
    expect(r.changes).toHaveLength(0);
    expect(r.dropped).toEqual([{ reason: 'Not in your exercise library.' }]);
  });

  it('rejects sets 40 and reps 50', () => {
    expect(run([add('seed:pull-002', { sets: 40 })]).changes).toHaveLength(0);
    const reps = run([{ op: { kind: 'update_exercise', client_ref: 'r2', reps_or_duration_seconds: 50 }, reason: 'x' }]);
    expect(reps.changes).toHaveLength(0);
    expect(reps.dropped[0].reason).toMatch(/Reps must be 1 to 30/);
  });

  it('drops a knee-loading add for a client with knee issues, with a reason', () => {
    const r = run([add('seed:legs-001')], { injuries: ['knee'] });
    expect(r.changes).toHaveLength(0);
    expect(r.dropped[0].reason).toBe('Back Squat loads the knee. The client reported knee issues.');
  });

  it('keeps a contraindicated exercise the coach named, with a warning', () => {
    const r = run([add('seed:legs-001')], { injuries: ['knee'], instruction: 'Add back squat anyway' });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].warnings[0]).toMatch(/Loads the knee/);
  });

  it('removes medical-claim sentences from the reason', () => {
    const r = run([{ ...add('seed:pull-002'), reason: 'This will heal the shoulder. Builds the lats.' }]);
    expect(r.changes[0].reason).toBe('Builds the lats.');
    expect(stripMedicalClaims('Cures back pain.', 200)).toBe('');
  });

  it('never invents a load on a new row and caps a load step at 10 percent', () => {
    expect(run([add('seed:pull-002', { weight_lbs: 300 })]).changes[0].after?.weight_lbs).toBeNull();
    const big = run([{ op: { kind: 'update_exercise', client_ref: 'r1', weight_lbs: 175 }, reason: 'x' }]);
    expect(big.changes).toHaveLength(0);
    const ok = run([{ op: { kind: 'update_exercise', client_ref: 'r1', weight_lbs: 145 }, reason: 'x' }]);
    expect(ok.changes[0].after?.weight_lbs).toBe(145);
  });

  it('blocks intensity increases under a screening flag and in a deload', () => {
    const inc = [{ op: { kind: 'update_exercise', client_ref: 'r1', sets: 4 }, reason: 'x' }];
    expect(run(inc, { screeningFlag: true }).changes).toHaveLength(0);
    expect(run(inc, { quickAction: 'deload' }).changes).toHaveLength(0);
    expect(run([{ op: { kind: 'update_exercise', client_ref: 'r1', sets: 2 }, reason: 'x' }], { quickAction: 'deload' }).changes).toHaveLength(1);
  });

  it('drops an op that does not apply to the current workout', () => {
    const r = run([{ op: { kind: 'remove_exercise', client_ref: 'nope' }, reason: 'x' }]);
    expect(r.changes).toHaveLength(0);
  });

  it('every change names a card: removals the removed exercise, reorders the order', () => {
    const r = run([{ op: { kind: 'remove_exercise', client_ref: 'r2' } }, { op: { kind: 'reorder', ordered_client_refs: ['r1'] } }]);
    expect(r.changes.map((c) => c.exercise)).toEqual([
      { id: 'seed:pull-004', name: LIBRARY.get('seed:pull-004')?.name, thumbnail_url: LIBRARY.get('seed:pull-004')?.thumbnail_url },
      { id: '', name: 'Exercise order', thumbnail_url: null },
    ]);
  });
});
