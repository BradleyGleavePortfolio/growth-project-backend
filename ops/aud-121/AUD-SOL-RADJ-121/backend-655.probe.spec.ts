import 'reflect-metadata';
import {
  WorkoutBuilderService,
  fingerprintAssignmentRows,
  type AssignmentExerciseRow,
} from '../../src/workout-builder/workout-builder.service';
import { RomanAdjustService } from '../../src/roman-adjust/roman-adjust.service';
import { cutVolume, evaluateSignals, romanProposalText } from '../../src/roman-adjust/roman-adjust.rules';
import { FakeConsentReader, fakeOf } from '../ai-egress/ai-egress.fakes';

const NOW = new Date('2026-10-02T16:00:00Z');
const COACH = 'coach-original';
const CLIENT = 'client-1';

function exercises(sets = [5, 4, 3, 3, 3]): AssignmentExerciseRow[] {
  return sets.map((count, order) => ({
    exercise_external_id: `ex-${order}`, order, sets: count,
    reps_or_duration_seconds: 8, weight_lbs: 95, rest_seconds: 90,
    superset_group_id: null, notes: null,
  }));
}

function fixture() {
  const user = { id: CLIENT, name: 'Client Name', coach_id: COACH, role: 'student', deleted_at: null };
  const assignment = {
    id: 'assignment-1', client_id: CLIENT, workout_plan_id: 'plan-1',
    scheduled_for: new Date('2026-10-03T16:00:00Z'),
    started_at: null as Date | null, completed_at: null as Date | null,
  };
  const snapshot = { plan_name: 'Lower A', exercises_json: exercises() };
  const change = cutVolume(snapshot.exercises_json, 15);
  const p = {
    id: 'proposal-1', coach_id: COACH, client_id: CLIENT,
    assignment_id: assignment.id, status: 'pending', severity: 'moderate',
    signals: [], proposed_change: change, applied_change: null as unknown,
    base_fingerprint: fingerprintAssignmentRows(snapshot.exercises_json),
    applied_fingerprint: null as string | null, before_exercises: null as unknown,
    roman_text: 'Roman proposes fewer sets.', created_at: NOW,
    decided_at: null as Date | null, undo_until: null as Date | null,
  };
  const proposalView = () => ({
    ...p, assignment: { ...assignment, snapshot: { plan_name: snapshot.plan_name } },
  });
  const events: unknown[] = [];
  const tx = {
    user: {
      findUnique: jest.fn(async () => ({ ...user })),
      findMany: jest.fn(async () => [{ ...user }]),
    },
    clientWorkoutAssignment: {
      findUnique: jest.fn(async () => ({
        ...assignment,
        snapshot: { ...snapshot, exercises_json: snapshot.exercises_json.map((e) => ({ ...e })) },
      })),
    },
    clientWorkoutAssignmentSnapshot: {
      update: jest.fn(async ({ data }: { data: { exercises_json: AssignmentExerciseRow[] } }) => {
        snapshot.exercises_json = data.exercises_json;
        return snapshot;
      }),
    },
    workoutAdjustmentProposal: {
      findUnique: jest.fn(async () => proposalView()),
      updateMany: jest.fn(async ({ where, data }: { where: { status?: string }; data: object }) => {
        if (where.status && where.status !== p.status) return { count: 0 };
        Object.assign(p, data);
        return { count: 1 };
      }),
    },
    workoutAdjustmentEvent: {
      create: jest.fn(async ({ data }: { data: object }) => {
        events.push(data);
        return data;
      }),
    },
    exerciseCatalogItem: { findMany: jest.fn(async () => []) },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const consent = new FakeConsentReader([CLIENT]);
  const builder = new WorkoutBuilderService(fakeOf(prisma));
  const service = new RomanAdjustService(fakeOf(prisma), builder, consent);
  return { user, assignment, snapshot, p, tx, prisma, consent, builder, service, events };
}

describe('AUD-SOL-RADJ-121 safety invariants at b655 exact head', () => {
  it('B tenancy: original coach cannot approve after the client moves to a different coach', async () => {
    const w = fixture();
    w.user.coach_id = 'coach-new';
    await expect(w.service.approve(COACH, w.p.id, NOW)).rejects.toMatchObject({
      response: { code: 'ADJUSTMENT_NOT_FOUND' },
    });
    expect(w.tx.clientWorkoutAssignmentSnapshot.update).not.toHaveBeenCalled();
  });

  it('B consent: undo does not read or mutate a withdrawn clients prescription', async () => {
    const w = fixture();
    await w.service.approve(COACH, w.p.id, NOW);
    w.consent.revoke(CLIENT);
    w.tx.clientWorkoutAssignmentSnapshot.update.mockClear();
    await expect(w.service.undo(COACH, w.p.id, new Date(NOW.getTime() + 1000))).rejects.toMatchObject({
      response: { code: 'ADJUSTMENT_CONSENT_WITHDRAWN' },
    });
    expect(w.tx.clientWorkoutAssignmentSnapshot.update).not.toHaveBeenCalled();
  });

  it('B concurrency: completion committed between the final read and write fences adjustment', async () => {
    const w = fixture();
    const original = w.tx.clientWorkoutAssignmentSnapshot.update.getMockImplementation()!;
    w.tx.clientWorkoutAssignmentSnapshot.update.mockImplementation(async (args) => {
      // Separate ClientWorkoutAssignment update commits before the snapshot UPDATE.
      w.assignment.completed_at = NOW;
      return original(args);
    });
    const result = await w.builder.replaceAssignmentSets(fakeOf(w.tx), w.assignment.id, {
      expectedFingerprint: w.p.base_fingerprint, sets: new Map([[0, 3]]),
    });
    expect(result).toEqual({ ok: false, reason: 'started' });
    expect(w.snapshot.exercises_json[0].sets).toBe(5);
  });

  it('B concurrency: snapshot edit committed after final fingerprint read is not overwritten', async () => {
    const w = fixture();
    const original = w.tx.clientWorkoutAssignmentSnapshot.update.getMockImplementation()!;
    w.tx.clientWorkoutAssignmentSnapshot.update.mockImplementation(async (args) => {
      // Other snapshot writer commits its newer prescription before this UPDATE.
      w.snapshot.exercises_json = exercises([6, 4, 3, 3, 3]);
      return original(args);
    });
    const result = await w.builder.replaceAssignmentSets(fakeOf(w.tx), w.assignment.id, {
      expectedFingerprint: w.p.base_fingerprint, sets: new Map([[0, 3]]),
    });
    expect(result).toEqual({ ok: false, reason: 'changed' });
    expect(w.snapshot.exercises_json[0].sets).toBe(6);
  });

  it('B freshness: an unlisted old pending proposal cannot change a passed workout', async () => {
    const w = fixture();
    w.assignment.scheduled_for = new Date(NOW.getTime() - 7 * 86400000);
    await expect(w.service.approve(COACH, w.p.id, NOW)).rejects.toMatchObject({
      response: { code: 'ADJUSTMENT_WORKOUT_CHANGED' },
    });
    expect(w.tx.clientWorkoutAssignmentSnapshot.update).not.toHaveBeenCalled();
  });

  it('B rule truth: one very short night and one normal night do not count as two short nights', () => {
    const samples = [
      { metric: 'SLEEP_TOTAL_MIN', value: 60, start_at: new Date('2026-10-01T03:00:00Z'), end_at: new Date('2026-10-01T04:00:00Z') },
      { metric: 'SLEEP_TOTAL_MIN', value: 480, start_at: new Date('2026-10-01T23:00:00Z'), end_at: new Date('2026-10-02T07:00:00Z') },
    ];
    const signals = evaluateSignals({ samples, completions: [], now: NOW, timeZone: 'UTC' });
    expect(signals.find((s) => s.key === 'short_sleep')).toBeUndefined();
  });

  it('B numeric truth: minimum-one-set floor reports the actual reduction not the requested percentage', () => {
    const change = cutVolume(exercises([1, 1, 2]), 50);
    expect(change).toMatchObject({ sets_before: 4, sets_after: 3, volume_pct: 25 });
  });

  it('B house voice: coach proposal has no first person', () => {
    const text = romanProposalText({
      clientFirstName: 'Client', signals: [],
      change: cutVolume(exercises(), 15), planName: 'Lower A', when: "tomorrow's",
    });
    expect(text).not.toMatch(/\b(?:I|me|my|we|us|our)\b/i);
  });
});
