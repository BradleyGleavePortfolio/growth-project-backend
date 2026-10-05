// AUD-OPUS-RADJ-121 probes (Claude Opus 5.5 lens, agent 121) for growth-project-backend#655 @ bf9120c1 (+ origin/main 5da537d6 merged).
// Each \`it\` asserts the behaviour the PR must have. A FAIL at the audited head is the proof of the finding named in
// the test title; a PASS marked (control) confirms behaviour the verdict relies on. Harness = the PR's own world()
// from test/roman-adjust/roman-adjust.service.spec.ts, copied verbatim. Lives only on audit/* branches; never merge.
/* eslint-disable */
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


const COACH2 = 'coach-2';
const LATER = (ms: number) => new Date(NOW.getTime() + ms);

async function pendingWorld() {
  const w = world();
  const { proposals } = await w.svc.listForCoach(COACH, NOW);
  if (proposals.length !== 1) throw new Error('harness: expected one pending proposal for Maya');
  return { w, id: proposals[0].id };
}

describe('B-655-2 tenancy: the coach-client link is re-checked on read and on every decision', () => {
  it.each([
    ['moved to another coach', COACH2],
    ['detached from the roster', null],
  ])('client %s: the old coach no longer lists her recovery metrics', async (_label, nextCoach) => {
    const { w } = await pendingWorld();
    (w as any).prisma.user.findUnique.mockClear();
    // Maya is no longer coach-1's client.
    const users = await (w as any).prisma.user.findMany({ where: {} });
    users.find((u: any) => u.id === MAYA).coach_id = nextCoach;
    const { proposals } = await w.svc.listForCoach(COACH, LATER(6 * 60_000));
    expect(proposals.map((p) => ({ client: p.client.id, signals: p.signals.map((s) => s.key) }))).toEqual([]);
  });

  it.each([
    ['moved to another coach', COACH2],
    ['detached from the roster', null],
  ])('client %s: the old coach cannot approve and the workout stays unchanged', async (_label, nextCoach) => {
    const { w, id } = await pendingWorld();
    const users = await (w as any).prisma.user.findMany({ where: {} });
    users.find((u: any) => u.id === MAYA).coach_id = nextCoach;
    let outcome = 'applied';
    try {
      await w.svc.approve(COACH, id, NOW);
    } catch (e: any) {
      outcome = e?.response?.code ?? String(e);
    }
    expect({ outcome, sets: w.setsOf('asg-maya') }).toEqual({ outcome: ADJUST_ERRORS.NOT_FOUND.code, sets: [5, 4, 3, 3, 3] });
  });
});

describe('B-655-4 copy truth: WORKOUT_CHANGED promises a new suggestion after refresh', () => {
  it('after the refusal, a refresh raises a new suggestion for the edited workout (as the copy says)', async () => {
    expect(ADJUST_ERRORS.WORKOUT_CHANGED.message).toMatch(/refresh for a new suggestion/);
    const { w, id } = await pendingWorld();
    w.snapshots[0].exercises_json = [
      ...((w.snapshots[0].exercises_json as unknown[]) ?? []),
    ].map((r: any, i: number) => (i === 0 ? { ...r, sets: 6 } : r));
    await expect(w.svc.approve(COACH, id, NOW)).rejects.toMatchObject({ response: { code: ADJUST_ERRORS.WORKOUT_CHANGED.code } });
    await w.svc.refreshForCoach(COACH, LATER(6 * 60_000), true);
    const open = w.proposals.filter((p) => p.assignment_id === 'asg-maya' && p.status === 'pending');
    expect(open.length).toBe(1);
  });
});

describe("B-655-5 copy truth: Roman's sentence names the right day when the coach reads it", () => {
  it("a Friday suggestion for Saturday's workout no longer says tomorrow's on Saturday morning", async () => {
    const { w } = await pendingWorld();
    expect(w.proposals[0].roman_text).toMatch(/tomorrow's Lower Body A/);
    // Saturday 2026-10-03 08:00 America/Los_Angeles: the workout is today's.
    const sat = new Date('2026-10-03T15:00:00Z');
    const { proposals } = await w.svc.listForCoach(COACH, sat);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].roman_text).not.toMatch(/tomorrow's/);
  });
});

describe('C-655 probes (not blocking)', () => {
  const saved = process.env[FEATURE_ROMAN_ADJUST_ENABLED_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[FEATURE_ROMAN_ADJUST_ENABLED_ENV];
    else process.env[FEATURE_ROMAN_ADJUST_ENABLED_ENV] = saved;
  });

  it("C-655-a kill switch: 'TRUE' stays off (PR body + .env.example: only the exact value true)", () => {
    process.env[FEATURE_ROMAN_ADJUST_ENABLED_ENV] = 'TRUE';
    expect(() => new RomanAdjustFeatureGuard().canActivate()).toThrow(NotFoundException);
  });

  it('C-655-b a database failure during approve is the coded ADJUSTMENTS_UNAVAILABLE reply, not a bare 500', async () => {
    const { w, id } = await pendingWorld();
    (w as any).prisma.workoutAdjustmentProposal.findUnique.mockRejectedValueOnce(new Error('connection reset'));
    await expect(w.svc.approve(COACH, id, NOW)).rejects.toMatchObject({ response: { code: ADJUST_ERRORS.UNAVAILABLE.code } });
  });

  it('C-655-c an Edit can never raise volume (card copy reads "N% less volume")', async () => {
    const { w, id } = await pendingWorld();
    let pct: number | null = null;
    try {
      const v = await w.svc.edit(COACH, id, { sets: [{ order: 0, sets: 8 }] }, NOW);
      pct = v.applied_change?.volume_pct ?? null;
    } catch {
      pct = 0;
    }
    expect(pct).toBeGreaterThanOrEqual(0);
  });
});

describe('controls (must PASS at head)', () => {
  it('(control) approve, approve again, dismiss, undo twice: one write, one undo, coded refusals', async () => {
    const { w, id } = await pendingWorld();
    await w.svc.approve(COACH, id, NOW);
    expect(w.setsOf('asg-maya')).toEqual([3, 3, 3, 3, 3]);
    await expect(w.svc.approve(COACH, id, NOW)).rejects.toMatchObject({ response: { code: ADJUST_ERRORS.ALREADY_DECIDED.code } });
    await expect(w.svc.edit(COACH, id, { volume_pct: 20 }, NOW)).rejects.toMatchObject({ response: { code: ADJUST_ERRORS.ALREADY_DECIDED.code } });
    await expect(w.svc.dismiss(COACH, id, 'not_now')).rejects.toMatchObject({ response: { code: ADJUST_ERRORS.ALREADY_DECIDED.code } });
    await w.svc.undo(COACH, id, LATER(60_000));
    await expect(w.svc.undo(COACH, id, LATER(61_000))).rejects.toMatchObject({ response: { code: ADJUST_ERRORS.ALREADY_DECIDED.code } });
    expect(w.setsOf('asg-maya')).toEqual([5, 4, 3, 3, 3]);
    expect(w.events.map((e) => e.action)).toEqual(['proposed', 'approved', 'undone']);
  });

  it('(control) audit action names carry no health label; detail of a decision carries set counts only', async () => {
    const { w, id } = await pendingWorld();
    await w.svc.approve(COACH, id, NOW);
    for (const e of w.events) expect(String(e.action)).not.toMatch(/hrv|heart|sleep|readiness|recovery|rpe|health/i);
    const approved = w.events.find((e) => e.action === 'approved') as any;
    expect(Object.keys(approved.detail).sort()).toEqual(['exercises', 'sets_after', 'sets_before', 'volume_pct']);
  });

  it('(control) an unconsented client is never scanned: no wearable read for Omar', async () => {
    const w = world();
    await w.svc.listForCoach(COACH, NOW);
    const calls = (w as any).prisma.wearableSample.findMany.mock.calls as Array<[{ where: { user_id: { in: string[] } } }]>;
    for (const [args] of calls) expect(args.where.user_id.in).not.toContain(OMAR);
  });

  it('(control) the coach view never carries client chat text, prompts or memory fields', async () => {
    const { w } = await pendingWorld();
    const { proposals } = await w.svc.listForCoach(COACH, LATER(6 * 60_000));
    expect(Object.keys(proposals[0]).sort()).toEqual([
      'applied_change', 'client', 'created_at', 'decided_at', 'exercise_names', 'id', 'proposed_change',
      'roman_text', 'severity', 'signals', 'status', 'undo_until', 'workout',
    ]);
  });
});
