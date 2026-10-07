import { PlanSnapshot } from '../src/ai/gateway/materialisers/__shared/workout-diff.types';
import { stripMedicalClaims } from '../src/ai/gateway/workout-builder/training-safety.constants';
import { validateProposedChanges, ValidateInput } from '../src/ai/gateway/workout-builder/workout-diff.validator';
import { LIBRARY } from '../src/ai/gateway/workout-builder/workout-builder-ai.service';

const row = { superset_group_id: null, notes: null };
const plan = (): PlanSnapshot => ({
  meta: { name: 'Upper', type: 'strength', duration_estimate_minutes: 60 },
  exercises: [
    { ...row, client_ref: 'r1', exercise_external_id: 'seed:push-001', order: 0, sets: 3, reps_or_duration_seconds: 8, weight_lbs: 135, rest_seconds: 120 },
    { ...row, client_ref: 'r2', exercise_external_id: 'seed:pull-004', order: 1, sets: 3, reps_or_duration_seconds: 10, weight_lbs: null, rest_seconds: 90 },
  ],
});
const run = (changes: unknown[], extra: Partial<ValidateInput> = {}) =>
  validateProposedChanges({ baseline: plan(), rawChanges: changes, library: LIBRARY, injuries: [], instruction: '', screeningFlag: false, ...extra });

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
  it('drops a workout rename that makes a medical claim', () => {
    const r = run([{ op: { kind: 'plan_meta', name: 'Knee rehab day' } }, { op: { kind: 'plan_meta', name: 'Upper strength' } }]);
    expect(r.dropped).toEqual([{ reason: 'Workout names cannot make medical claims.' }]);
    expect(r.changes.map((c) => c.op)).toEqual([{ kind: 'plan_meta', name: 'Upper strength' }]);
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
  describe('B-809-1: an existing exercise that loads a reported injury is not progressed', () => {
    const squatDay = (): PlanSnapshot => ({
      meta: { name: 'Legs', type: 'strength', duration_estimate_minutes: 60 },
      exercises: [{ ...row, client_ref: 's1', exercise_external_id: 'seed:legs-001', order: 0, sets: 3, reps_or_duration_seconds: 8, weight_lbs: 135, rest_seconds: 120 }],
    });
    const progress = (over: Record<string, unknown>) => ({ op: { kind: 'update_exercise', client_ref: 's1', ...over }, reason: 'Progress.' });
    it.each([{ reps_or_duration_seconds: 9 }, { sets: 4 }, { weight_lbs: 145 }])('drops %o on Back Squat for a knee client', (over) => {
      const r = run([progress(over)], { baseline: squatDay(), injuries: ['knee'], instruction: 'Progress the workout', quickAction: 'progress' });
      expect(r.changes).toHaveLength(0);
      expect(r.dropped).toEqual([{ reason: 'Back Squat loads the knee. The client reported knee issues.' }]);
    });
    it('keeps the same progression when the coach named the exercise, with a warning', () => {
      const r = run([progress({ reps_or_duration_seconds: 9 })], { baseline: squatDay(), injuries: ['knee'], instruction: 'Progress the back squat' });
      expect(r.changes).toHaveLength(1);
      expect(r.changes[0].warnings[0]).toMatch(/Loads the knee/);
    });
    it.each(['Progress the workout but avoid Back Squat', 'No back squat progression', 'Swap back squat for a knee-friendly option', 'Keep back squat out of this', 'Don\u2019t progress back squat', "She doesn't want back squat heavier"])(
      'B-809-3: negative or alternative wording never overrides the screen: %s', (instruction) => {
        const r = run([progress({ reps_or_duration_seconds: 9 })], { baseline: squatDay(), injuries: ['knee'], instruction });
        expect(r.changes).toHaveLength(0);
        expect(r.dropped).toEqual([{ reason: 'Back Squat loads the knee. The client reported knee issues.' }]);
        expect(run([add('seed:legs-001')], { injuries: ['knee'], instruction }).changes).toHaveLength(0);
      },
    );
    it('still allows lowering it, and progressing it when no injury loads it', () => {
      expect(run([progress({ sets: 2 })], { baseline: squatDay(), injuries: ['knee'] }).changes).toHaveLength(1);
      expect(run([progress({ reps_or_duration_seconds: 9 })], { baseline: squatDay(), injuries: ['shoulder'] }).changes).toHaveLength(1);
    });
  });

  describe('B-809-2: hard sets per muscle are capped across the program week', () => {
    // Bench Press (pectorals) 3 sets here; the week's other days already hold 13 pectoral sets -> 16, the beginner cap.
    const weekly = (cap: number) => ({ otherSetsByMuscle: new Map([['pectorals', 13]]), cap });
    const moreSets = { op: { kind: 'update_exercise', client_ref: 'r1', sets: 4 }, reason: 'More volume.' };
    it('drops More Volume that takes a beginner past 16 weekly pectoral sets', () => {
      const r = run([moreSets], { quickAction: 'more_volume', weekly: weekly(16) });
      expect(r.changes).toHaveLength(0);
      expect(r.dropped).toEqual([{ reason: 'More than 16 hard sets for one muscle in this program week.' }]);
    });
    it('drops an added chest exercise past the cap but keeps other muscles and the general 24 cap', () => {
      expect(run([add('seed:push-002', { sets: 2 })], { weekly: weekly(16) }).changes).toHaveLength(0);
      expect(run([add('seed:pull-002')], { weekly: weekly(16) }).changes).toHaveLength(1);
      expect(run([moreSets], { weekly: weekly(24) }).changes).toHaveLength(1);
    });
    it('never blocks a change that lowers or keeps a week that is already over', () => {
      const over = { otherSetsByMuscle: new Map([['pectorals', 20]]), cap: 16 };
      expect(run([{ op: { kind: 'update_exercise', client_ref: 'r1', sets: 2 }, reason: 'Less.' }], { weekly: over }).changes).toHaveLength(1);
      expect(run([{ op: { kind: 'update_exercise', client_ref: 'r1', rest_seconds: 90 }, reason: 'Rest.' }], { weekly: over }).changes).toHaveLength(1);
    });
  });
});
