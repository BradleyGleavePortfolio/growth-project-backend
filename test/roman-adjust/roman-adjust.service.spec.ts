// Roman approve-to-adjust: service + guard behaviour over an in-memory Prisma
// double, the REAL WorkoutBuilderService snapshot methods and a fake box-2
// consent reader. Deterministic: fixed clock, no network, no model.
import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { RomanAdjustService } from '../../src/roman-adjust/roman-adjust.service';
import { RomanAdjustFeatureGuard } from '../../src/roman-adjust/roman-adjust.guard';
import {
  ADJUST_ERRORS,
  ADJUST_UNDO_WINDOW_MS,
  FEATURE_ROMAN_ADJUST_ENABLED_ENV,
} from '../../src/roman-adjust/roman-adjust.constants';
import {
  WorkoutBuilderService,
  parseAssignmentRows,
} from '../../src/workout-builder/workout-builder.service';
import { FakeConsentReader, fakeOf } from '../ai-egress/ai-egress.fakes';

const NOW = new Date('2026-10-02T16:00:00Z'); // Fri 09:00 Los Angeles
const COACH = 'coach-1';
const MAYA = 'client-maya';
const OMAR = 'client-omar';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[k];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
    } else if (cond instanceof Date) {
      if (!(v instanceof Date) || v.getTime() !== cond.getTime()) return false;
    } else if (typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Row;
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
      const t = v instanceof Date ? v.getTime() : (v as number);
      const n = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ('gte' in c && !(v !== null && v !== undefined && t >= n(c.gte))) return false;
      if ('lte' in c && !(v !== null && v !== undefined && t <= n(c.lte))) return false;
      if ('gt' in c && !(v !== null && v !== undefined && t > n(c.gt))) return false;
    } else if (v !== cond) return false;
  }
  return true;
}

function exercises(sets: number[]) {
  return sets.map((s, i) => ({
    exercise_external_id: `ex-${i}`,
    order: i,
    sets: s,
    reps_or_duration_seconds: 8,
    weight_lbs: 95,
    rest_seconds: 90,
    superset_group_id: null,
    notes: null,
  }));
}

function world() {
  let seq = 0;
  const id = (p: string) => `${p}-${String(++seq).padStart(4, '0')}-0000-0000-000000000000`;
  const users: Row[] = [
    { id: MAYA, name: 'Maya Chen', coach_id: COACH, role: 'student', deleted_at: null, notification_prefs: { timezone: 'America/Los_Angeles' } },
    { id: OMAR, name: 'Omar Haddad', coach_id: COACH, role: 'student', deleted_at: null, notification_prefs: { timezone: 'America/Los_Angeles' } },
  ];
  const assignments: Row[] = [
    // Tomorrow's workout for each client.
    { id: 'asg-maya', client_id: MAYA, workout_plan_id: 'plan-1', scheduled_for: new Date('2026-10-03T16:00:00Z'), started_at: null, completed_at: null, post_rpe: null },
    { id: 'asg-omar', client_id: OMAR, workout_plan_id: 'plan-1', scheduled_for: new Date('2026-10-03T16:00:00Z'), started_at: null, completed_at: null, post_rpe: null },
  ];
  const snapshots: Row[] = [
    { assignment_id: 'asg-maya', plan_name: 'Lower Body A', exercises_json: exercises([5, 4, 3, 3, 3]) },
    { assignment_id: 'asg-omar', plan_name: 'Lower Body A', exercises_json: exercises([5, 4, 3, 3, 3]) },
  ];
  const samples: Row[] = [];
  for (const uid of [MAYA, OMAR]) {
    for (let d = 0; d < 30; d += 1) {
      const at = new Date(Date.UTC(2026, 9, 2 - d, 15));
      samples.push({ user_id: uid, metric: 'HRV_MS', value: d < 3 ? 46 : 60, start_at: at, end_at: at });
      samples.push({ user_id: uid, metric: 'RESTING_HEART_RATE_BPM', value: d < 3 ? 61 : 55, start_at: at, end_at: at });
    }
  }
  const proposals: Row[] = [];
  const events: Row[] = [];
  const withAssignment = (p: Row) => {
    const a = assignments.find((x) => x.id === p.assignment_id) as Row;
    const s = snapshots.find((x) => x.assignment_id === p.assignment_id);
    return { ...p, assignment: { ...a, snapshot: s ? { plan_name: s.plan_name } : null } };
  };
  const prisma = {
    user: {
      findMany: jest.fn(async ({ where }: { where: Row }) => users.filter((u) => matches(u, where))),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => users.find((u) => u.id === where.id) ?? null),
    },
    clientWorkoutAssignment: {
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        assignments.filter((a) => matches(a, where)).sort((x, y) => (x.scheduled_for as Date).getTime() - (y.scheduled_for as Date).getTime()),
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const a = assignments.find((x) => x.id === where.id);
        if (!a) return null;
        const s = snapshots.find((x) => x.assignment_id === a.id);
        return { ...a, snapshot: s ? { plan_name: s.plan_name, exercises_json: s.exercises_json } : null };
      }),
    },
    clientWorkoutAssignmentSnapshot: {
      findUnique: jest.fn(async ({ where }: { where: { assignment_id: string } }) => snapshots.find((s) => s.assignment_id === where.assignment_id) ?? null),
      update: jest.fn(async ({ where, data }: { where: { assignment_id: string }; data: Row }) => {
        const s = snapshots.find((x) => x.assignment_id === where.assignment_id) as Row;
        Object.assign(s, data);
        return s;
      }),
    },
    wearableSample: {
      findMany: jest.fn(async ({ where }: { where: Row }) => samples.filter((s) => matches(s, where))),
    },
    workoutAdjustmentProposal: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => {
        const key = where.assignment_id_rule_key as Row | undefined;
        const p = key
          ? proposals.find((x) => x.assignment_id === key.assignment_id && x.rule_key === key.rule_key)
          : proposals.find((x) => x.id === where.id);
        return p ? withAssignment(p) : null;
      }),
      findMany: jest.fn(async ({ where }: { where: Row }) => proposals.filter((p) => matches(p, where)).map(withAssignment)),
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (proposals.some((p) => p.assignment_id === data.assignment_id && p.rule_key === data.rule_key)) throw new Error('P2002');
        const row = { id: id('prop'), status: 'pending', applied_change: null, applied_fingerprint: null, before_exercises: null, decided_by_id: null, decided_at: null, dismiss_reason: null, undo_until: null, created_at: NOW, updated_at: NOW, ...data };
        proposals.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = proposals.filter((p) => matches(p, where));
        hit.forEach((p) => Object.assign(p, data));
        return { count: hit.length };
      }),
    },
    exerciseCatalogItem: {
      findMany: jest.fn(async () => [{ id: 'ex-0', slug: 'back-squat', name: 'Back squat' }]),
    },
    workoutAdjustmentEvent: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        events.push({ ...data });
        return data;
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const reader = new FakeConsentReader([MAYA]);
  const builder = new WorkoutBuilderService(fakeOf(prisma));
  const svc = new RomanAdjustService(fakeOf(prisma), builder, reader);
  const setsOf = (asg: string) =>
    parseAssignmentRows(snapshots.find((s) => s.assignment_id === asg)?.exercises_json).map((e) => e.sets);
  return { prisma, svc, reader, proposals, events, assignments, snapshots, setsOf };
}

function codeOf(key: keyof typeof ADJUST_ERRORS) {
  return { response: { code: ADJUST_ERRORS[key].code, message: ADJUST_ERRORS[key].message } };
}

describe('kill switch', () => {
  const saved = process.env[FEATURE_ROMAN_ADJUST_ENABLED_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[FEATURE_ROMAN_ADJUST_ENABLED_ENV];
    else process.env[FEATURE_ROMAN_ADJUST_ENABLED_ENV] = saved;
  });
  it.each([undefined, '', 'false', '1', 'yes'])('%s -> every route 404s', (v) => {
    if (v === undefined) delete process.env[FEATURE_ROMAN_ADJUST_ENABLED_ENV];
    else process.env[FEATURE_ROMAN_ADJUST_ENABLED_ENV] = v;
    expect(() => new RomanAdjustFeatureGuard().canActivate()).toThrow(NotFoundException);
  });
  it("'true' -> on", () => {
    process.env[FEATURE_ROMAN_ADJUST_ENABLED_ENV] = 'true';
    expect(new RomanAdjustFeatureGuard().canActivate()).toBe(true);
  });
});

describe('scan', () => {
  it('proposes for the consented client only; box 2 missing means no proposal', async () => {
    const w = world();
    const { proposals } = await w.svc.listForCoach(COACH, NOW);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      status: 'pending',
      severity: 'moderate',
      client: { id: MAYA, first_name: 'Maya' },
      workout: { assignment_id: 'asg-maya', plan_name: 'Lower Body A' },
      proposed_change: { volume_pct: 15, sets_before: 18, sets_after: 15 },
      exercise_names: { 'ex-0': 'Back squat' },
    });
    expect(proposals[0].roman_text).toMatch(/^Maya's recovery has dipped\. Heart-rate variability is 23% below the usual and resting heart rate is up 6 bpm\. I suggest trimming tomorrow's Lower Body A by 15%, from 18 to 15 sets\./);
    expect(w.proposals.some((p) => p.client_id === OMAR)).toBe(false);
    expect(w.events.map((e) => e.action)).toEqual(['proposed']);
    // A proposal changes nothing by itself.
    expect(w.setsOf('asg-maya')).toEqual([5, 4, 3, 3, 3]);
  });

  it('re-scanning is idempotent: one proposal per workout and rule', async () => {
    const w = world();
    await w.svc.refreshForCoach(COACH, NOW, true);
    await w.svc.refreshForCoach(COACH, NOW, true);
    expect(w.proposals).toHaveLength(1);
  });

  it('a client who withdraws box 2 after the scan drops out of the list (withdrawn + audit row)', async () => {
    const w = world();
    await w.svc.listForCoach(COACH, NOW);
    w.reader.revoke(MAYA);
    const { proposals } = await w.svc.listForCoach(COACH, new Date(NOW.getTime() + 1000));
    expect(proposals).toEqual([]);
    expect(w.proposals[0].status).toBe('withdrawn');
    expect(w.events.map((e) => e.action)).toEqual(['proposed', 'withdrawn']);
  });

  it('a started workout expires its pending proposal', async () => {
    const w = world();
    await w.svc.listForCoach(COACH, NOW);
    w.assignments[0].started_at = NOW;
    await w.svc.refreshForCoach(COACH, NOW, true);
    const { proposals } = await w.svc.listForCoach(COACH, new Date(NOW.getTime() + 6 * 60_000));
    expect(proposals).toEqual([]);
    expect(w.proposals[0].status).toBe('expired');
  });
});

describe('approve / edit / dismiss / undo', () => {
  async function pending() {
    const w = world();
    const { proposals } = await w.svc.listForCoach(COACH, NOW);
    return { w, id: proposals[0].id };
  }

  it('approve writes the new set counts to that one assignment only, with an audit row', async () => {
    const { w, id } = await pending();
    const v = await w.svc.approve(COACH, id, NOW);
    expect(v.status).toBe('approved');
    expect(v.undo_until).toBe(new Date(NOW.getTime() + ADJUST_UNDO_WINDOW_MS).toISOString());
    expect(w.setsOf('asg-maya')).toEqual([3, 3, 3, 3, 3]);
    expect(w.setsOf('asg-omar')).toEqual([5, 4, 3, 3, 3]);
    const ev = w.events.find((e) => e.action === 'approved');
    expect(ev).toMatchObject({ actor_id: COACH, detail: { sets_before: 18, sets_after: 15 } });
  });

  it('undo inside the window restores the previous counts; after the window it is refused', async () => {
    const { w, id } = await pending();
    await w.svc.approve(COACH, id, NOW);
    const v = await w.svc.undo(COACH, id, new Date(NOW.getTime() + 60_000));
    expect(v.status).toBe('undone');
    expect(w.setsOf('asg-maya')).toEqual([5, 4, 3, 3, 3]);

    const second = await pending();
    await second.w.svc.approve(COACH, second.id, NOW);
    await expect(second.w.svc.undo(COACH, second.id, new Date(NOW.getTime() + ADJUST_UNDO_WINDOW_MS + 1))).rejects.toMatchObject(codeOf('UNDO_EXPIRED'));
  });

  it('undo never overwrites a newer edit', async () => {
    const { w, id } = await pending();
    await w.svc.approve(COACH, id, NOW);
    w.snapshots[0].exercises_json = exercises([2, 2, 2, 2, 2]);
    await expect(w.svc.undo(COACH, id, NOW)).rejects.toMatchObject(codeOf('UNDO_BLOCKED'));
    expect(w.setsOf('asg-maya')).toEqual([2, 2, 2, 2, 2]);
  });

  it('edit with explicit set counts applies the coach numbers', async () => {
    const { w, id } = await pending();
    const v = await w.svc.edit(COACH, id, { sets: [{ order: 0, sets: 4 }] }, NOW);
    expect(v.status).toBe('edited');
    expect(v.applied_change).toMatchObject({ sets_before: 18, sets_after: 17, volume_pct: 6 });
    expect(w.setsOf('asg-maya')).toEqual([4, 4, 3, 3, 3]);
  });

  it('edit with a percentage applies that percentage', async () => {
    const { w, id } = await pending();
    await w.svc.edit(COACH, id, { volume_pct: 30 }, NOW);
    expect(w.setsOf('asg-maya').reduce((a, b) => a + b, 0)).toBe(13);
  });

  it.each([
    [{}],
    [{ volume_pct: 3 }],
    [{ volume_pct: 20, sets: [{ order: 0, sets: 2 }] }],
    [{ sets: [{ order: 9, sets: 2 }] }],
    [{ sets: [{ order: 0, sets: 0 }] }],
  ])('invalid edit %j is refused with specific copy and changes nothing', async (input) => {
    const { w, id } = await pending();
    await expect(w.svc.edit(COACH, id, input, NOW)).rejects.toMatchObject(codeOf('EDIT_INVALID'));
    expect(w.setsOf('asg-maya')).toEqual([5, 4, 3, 3, 3]);
  });

  it('the client started the workout: refused, unchanged, audit rows apply_refused + expired', async () => {
    const { w, id } = await pending();
    w.assignments[0].started_at = NOW;
    await expect(w.svc.approve(COACH, id, NOW)).rejects.toMatchObject(codeOf('WORKOUT_STARTED'));
    expect(w.setsOf('asg-maya')).toEqual([5, 4, 3, 3, 3]);
    expect(w.events.map((e) => e.action)).toEqual(['proposed', 'apply_refused', 'expired']);
  });

  it('the workout was edited after the suggestion: refused with WORKOUT_CHANGED', async () => {
    const { w, id } = await pending();
    w.snapshots[0].exercises_json = exercises([6, 4, 3, 3, 3]);
    await expect(w.svc.approve(COACH, id, NOW)).rejects.toMatchObject(codeOf('WORKOUT_CHANGED'));
    expect(w.setsOf('asg-maya')).toEqual([6, 4, 3, 3, 3]);
  });

  it('box 2 withdrawn before approve: refused, unchanged, proposal withdrawn', async () => {
    const { w, id } = await pending();
    w.reader.revoke(MAYA);
    await expect(w.svc.approve(COACH, id, NOW)).rejects.toMatchObject(codeOf('CONSENT_WITHDRAWN'));
    expect(w.setsOf('asg-maya')).toEqual([5, 4, 3, 3, 3]);
    expect(w.proposals[0].status).toBe('withdrawn');
  });

  it("another coach's proposal is a 404, never a 403", async () => {
    const { w, id } = await pending();
    await expect(w.svc.approve('coach-2', id, NOW)).rejects.toMatchObject(codeOf('NOT_FOUND'));
    await expect(w.svc.dismiss('coach-2', id, null)).rejects.toMatchObject(codeOf('NOT_FOUND'));
  });

  it('a second decision is ALREADY_DECIDED', async () => {
    const { w, id } = await pending();
    await w.svc.approve(COACH, id, NOW);
    await expect(w.svc.approve(COACH, id, NOW)).rejects.toMatchObject(codeOf('ALREADY_DECIDED'));
    await expect(w.svc.dismiss(COACH, id, 'not_now')).rejects.toMatchObject(codeOf('ALREADY_DECIDED'));
  });

  it('dismiss leaves the workout as it is and the rule never re-raises it', async () => {
    const { w, id } = await pending();
    const v = await w.svc.dismiss(COACH, id, 'client_feels_fine');
    expect(v.status).toBe('dismissed');
    expect(w.proposals[0].dismiss_reason).toBe('client_feels_fine');
    await w.svc.refreshForCoach(COACH, NOW, true);
    expect(w.proposals).toHaveLength(1);
    expect(w.setsOf('asg-maya')).toEqual([5, 4, 3, 3, 3]);
  });

  it('an unexpected database failure on list is the specific unavailable copy', async () => {
    const w = world();
    w.prisma.user.findMany.mockRejectedValueOnce(new Error('connection reset for maya@example.com'));
    await expect(w.svc.listForCoach(COACH, NOW)).rejects.toMatchObject(codeOf('UNAVAILABLE'));
  });
});

describe('copy rules', () => {
  it.each(Object.entries(ADJUST_ERRORS))('%s says what happened and what to do, in the house voice', (_k, e) => {
    expect(e.message).not.toMatch(/!|\bwe\b|\bus\b|something went wrong|error occurred/i);
    expect(e.message.split('. ').length).toBeGreaterThanOrEqual(2);
  });
});
