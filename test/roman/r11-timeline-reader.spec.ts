// test/roman/r11-timeline-reader.spec.ts
//
// Roman v1.1 slice R11-M2: the internal client timeline reader and the
// extracted coach-scope rule. In-memory Prisma double (no DB, no network):
// tenancy per kind, former coach after reassignment, select shapes,
// order and cursor.

import 'reflect-metadata';
import { RomanTimelineReader } from '../../src/roman/memory/roman-timeline.reader';
import {
  ROMAN_TIMELINE_KINDS,
  RomanTimelineError,
  RomanTimelineEvent,
  RomanTimelineKind,
} from '../../src/roman/memory/roman-timeline.types';
import {
  RomanCoachRow,
  RomanSubCoachOverlay,
  resolveRomanCoachScope,
} from '../../src/roman/context/roman-coach-scope';
import { localDayStart } from '../../src/roman/context/roman-client-context.service';
import { matches } from './fixtures/roman-personas';
import type { PrismaService } from '../../src/prisma.service';

type Row = Record<string, any>;
const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-10-06T19:00:00.000Z'); // 12:00 PT, local 2026-10-06
const FROM = localDayStart('2026-10-01', TZ);
const TO = localDayStart('2026-10-06', TZ);
const A = 'client-a';
const B = 'client-b';
const D = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const T = (iso: string) => new Date(iso);
// prettier-ignore
const CANARIES = ['B-CANARY', 'NOTES-CANARY', 'DISMISS-CANARY', 'ROMANTEXT-CANARY', 'SUMMARY-CANARY', 'PAYLOAD-CANARY', 'VIDEO-CANARY'];
const coach = (id: string, deleted_at: Date | null = null) => ({ id, role: 'coach', deleted_at });

// One row (or two) per source for client `user`; `canary` marks client B's words.
// prettier-ignore
function ownRows(p: string, user: string, canary = ''): Record<string, Row[]> {
  return {
    loggedFoodEntry: [
      { id: `${p}-f1`, user_id: user, date: D('2026-10-02'), meal_type: 'breakfast', quantity_multiplier: 2, food_item: { calories: 100, protein_g: 10, carbs_g: 5, fat_g: 2 } },
      { id: `${p}-f2`, user_id: user, date: D('2026-10-02'), meal_type: 'lunch', quantity_multiplier: 1, food_item: { calories: 450, protein_g: 30, carbs_g: 40, fat_g: 12 } },
    ],
    workoutSession: [{ id: `${p}-ws1`, user_id: user, date: D('2026-10-05'), workout_name: `Run ${canary}`, workout_type: 'cardio', duration_minutes: 30, intensity: 'moderate', notes: `Easy pace ${canary}`, _count: { exercises: 0 } }],
    weightLog: [{ id: `${p}-w1`, user_id: user, date: D('2026-10-02'), weight_lbs: 170.04 }],
    waterLog: [{ id: `${p}-h2o`, user_id: user, logged_at: T('2026-10-02T20:00:00Z'), amount_ml: 500 }],
    habitLog: [{ id: `${p}-hb1`, habit_id: `${p}-habit`, habit: { user_id: user, name: `Walk ${canary}`, category: 'movement', unit: 'min', target_value: 30 }, date: D('2026-10-03'), value: 35, completed: true }],
    checkIn: [{ id: `${p}-ci1`, user_id: user, date: D('2026-10-02'), type: 'morning', mood: 4, energy: 3, soreness: 2, sleep_hours: 7.5, weight_kg: null, notes: `Felt good ${canary}` }],
    wearableSample: [
      { id: `${p}-s1`, user_id: user, metric: 'STEPS', provider: 'APPLE_HEALTH', value: 5000, start_at: T('2026-10-02T18:00:00Z'), end_at: T('2026-10-02T19:00:00Z'), recorded_at: T('2026-10-02T19:05:00Z'), source_tz: TZ },
      { id: `${p}-s2`, user_id: user, metric: 'SLEEP_TOTAL_MIN', provider: 'APPLE_HEALTH', value: 480, start_at: T('2026-10-02T06:00:00Z'), end_at: T('2026-10-02T14:00:00Z'), recorded_at: T('2026-10-02T14:05:00Z'), source_tz: TZ },
    ],
    clientWorkoutAssignment: [
      { id: `${p}-as-missed`, client_id: user, assigned_by_coach_id: 'coach-1', scheduled_for: T('2026-10-03T16:00:00Z'), completed_at: null, post_rpe: null, post_notes: null, snapshot: { plan_name: 'Upper A' }, workout_plan: { name: 'Upper A' } },
      { id: `${p}-as-done`, client_id: user, assigned_by_coach_id: 'sub-1', scheduled_for: T('2026-10-04T16:00:00Z'), completed_at: T('2026-10-04T17:00:00Z'), post_rpe: 8, post_notes: `Heavy ${canary}`, snapshot: { plan_name: 'Lower A' }, workout_plan: { name: 'Lower A' } },
    ],
    coachMessage: [
      { id: `${p}-m1`, coach_id: 'coach-1', client_id: user, sender_id: user, body: `Knee is fine ${canary}`, deleted_at: null, created_at: T('2026-10-03T15:00:00Z') },
      { id: `${p}-m2`, coach_id: 'coach-1', client_id: user, sender_id: 'coach-1', body: `Great work ${canary}`, deleted_at: null, created_at: T('2026-10-03T16:00:00Z') },
      { id: `${p}-m-del`, coach_id: 'coach-1', client_id: user, sender_id: user, body: 'deleted words', deleted_at: T('2026-10-03T17:00:00Z'), created_at: T('2026-10-03T16:30:00Z') },
      { id: `${p}-m-voice`, coach_id: 'coach-1', client_id: user, sender_id: 'coach-1', body: null, deleted_at: null, created_at: T('2026-10-03T16:40:00Z') },
    ],
    coachingSession: [{ id: `${p}-bk1`, client_id: user, coach_id: 'coach-1', title: `Check-in call ${canary}`, start_at: T('2026-10-03T17:00:00Z'), end_at: T('2026-10-03T17:45:00Z'), status: 'scheduled', coach_notes_md: 'NOTES-CANARY', client_recap_md: `Deload next week ${canary}`, video_url: 'https://VIDEO-CANARY' }],
    workoutAdjustmentProposal: [
      { id: `${p}-adj1`, client_id: user, coach_id: 'coach-1', status: 'approved', rule_key: 'high_rpe', severity: 'medium', decided_at: T('2026-10-04T18:00:00Z'), applied_change: { volume_pct: -20, sets_before: 10, sets_after: 8 }, dismiss_reason: 'DISMISS-CANARY', roman_text: 'ROMANTEXT-CANARY' },
      { id: `${p}-adj-dismissed`, client_id: user, coach_id: 'coach-1', status: 'dismissed', rule_key: 'x', severity: 'low', decided_at: T('2026-10-04T18:30:00Z'), applied_change: null, dismiss_reason: 'DISMISS-CANARY', roman_text: 'x' },
    ],
    activityEvent: [
      { id: `${p}-ae1`, client_id: user, coach_id: 'coach-1', type: 'coach.message_sent', summary: 'SUMMARY-CANARY', payload: { x: 'PAYLOAD-CANARY' }, created_at: T('2026-10-03T16:00:01Z') },
      { id: `${p}-ae-other`, client_id: user, coach_id: 'coach-1', type: 'other.type', summary: 'SUMMARY-CANARY', payload: null, created_at: T('2026-10-03T16:00:02Z') },
    ],
  };
}

// prettier-ignore
function seed() {
  const user = (id: string) => ({ id, role: 'student', deleted_at: null, coach: coach('coach-1'), notification_prefs: { timezone: TZ }, wearable_metric_preferences: [] });
  const users: Row[] = [user(A), user(B)];
  const a = ownRows('a', A);
  const b = ownRows('b', B, 'B-CANARY');
  const tables: Record<string, Row[]> = {};
  for (const k of Object.keys(a)) tables[k] = [...a[k], ...b[k]];
  // A former coach's rows for A.
  tables.clientWorkoutAssignment.push({ id: 'a-as-old', client_id: A, assigned_by_coach_id: 'coach-old', scheduled_for: T('2026-10-02T16:00:00Z'), completed_at: T('2026-10-02T17:00:00Z'), post_rpe: 6, post_notes: null, snapshot: { plan_name: 'Old plan' }, workout_plan: { name: 'Old plan' } });
  tables.coachMessage.push({ id: 'a-m-old', coach_id: 'coach-old', client_id: A, sender_id: 'coach-old', body: 'Old coach note', deleted_at: null, created_at: T('2026-10-02T15:00:00Z') });
  tables.subCoachAssignment = [{ client_id: A, head_coach_id: 'coach-1', sub_coach_id: 'sub-1', unassigned_at: null, assigned_at: T('2026-09-01T00:00:00Z') }];
  return { users, tables };
}

function project(row: Row | null | undefined, select: Row | undefined): any {
  if (row == null || !select) return row ?? null;
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    const val = row[k];
    if (v === true) out[k] = val;
    else if (Array.isArray(val)) out[k] = val.map((x) => project(x, v.select));
    else out[k] = val == null ? null : project(val, v.select);
  }
  return out;
}

function makeDb() {
  const { users, tables } = seed();
  const log: { table: string; where: Row; select: Row }[] = [];
  const many = (name: string) => ({
    findMany: jest.fn(async (args: { where: Row; select: Row; orderBy?: Row; take?: number }) => {
      log.push({ table: name, where: args.where, select: args.select });
      let rows = tables[name].filter((r) => matches(r, args.where));
      if (args.orderBy) {
        const [[key, dir]] = Object.entries(args.orderBy) as [string, 'asc' | 'desc'][];
        const v = (r: Row) => (r[key] instanceof Date ? r[key].getTime() : r[key]);
        rows = [...rows].sort(
          (x, y) => (v(x) < v(y) ? -1 : v(x) > v(y) ? 1 : 0) * (dir === 'asc' ? 1 : -1),
        );
      }
      if (args.take != null) rows = rows.slice(0, args.take);
      return rows.map((r) => project(r, args.select));
    }),
  });
  const prisma: Row = {
    user: {
      findUnique: jest.fn(async (args: { where: { id: string }; select: Row }) =>
        project(
          users.find((u) => u.id === args.where.id),
          args.select,
        ),
      ),
    },
    subCoachAssignment: {
      findFirst: jest.fn(async (args: { where: Row; select: Row }) =>
        project(
          tables.subCoachAssignment.find((r) => matches(r, args.where)),
          args.select,
        ),
      ),
    },
  };
  for (const name of Object.keys(tables))
    if (name !== 'subCoachAssignment') prisma[name] = many(name);
  // Tables the reader must never touch.
  for (const name of [
    'wearableConnection',
    'bloodworkResult',
    'purchase',
    'payment',
    'romanMessage',
  ]) {
    prisma[name] = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error(`forbidden table ${name}`);
        },
      },
    );
  }
  const reader = new RomanTimelineReader(prisma as unknown as PrismaService);
  return { reader, users, tables, log };
}

const ids = (events: RomanTimelineEvent[]) => events.map((e) => e.source.id);
const kindsOf = (events: RomanTimelineEvent[]) => new Set(events.map((e) => e.kind));
const COACH_KINDS: RomanTimelineKind[] = [
  'workout_missed',
  'message',
  'booking',
  'adjustment',
  'activity',
];

describe('R11-M2 timeline reader — tenancy per kind', () => {
  it('reads every kind for A and none of B (same coach), and every query is scoped to A', async () => {
    const { reader, log } = makeDb();
    const page = await reader.read(A, { from: FROM, to: TO, now: NOW });
    expect(kindsOf(page.events)).toEqual(new Set(ROMAN_TIMELINE_KINDS));
    expect(
      ids(page.events).every((id) => id.startsWith('a-') || /^\d{4}-\d{2}-\d{2}$/.test(id)),
    ).toBe(true);
    const json = JSON.stringify(page);
    for (const c of CANARIES) expect(json).not.toContain(c);
    for (const q of log) {
      const w = q.where;
      expect(w.user_id === A || w.client_id === A || w.habit?.user_id === A).toBe(true);
    }
    expect(page).toMatchObject({ client_id: A, timezone: TZ, next_cursor: null, truncated: [] });
  });

  it('builds facts from the right rows (food totals, done vs missed, sleep by end day, message direction)', async () => {
    const { reader } = makeDb();
    const { events } = await reader.read(A, { from: FROM, to: TO, now: NOW });
    const by = (id: string) => events.find((e) => e.source.id === id);
    expect(events.find((e) => e.kind === 'food_day')).toEqual({
      at: '2026-10-02T07:00:00.000Z',
      local_date: '2026-10-02',
      kind: 'food_day',
      source: { table: 'LoggedFoodEntry', id: '2026-10-02' },
      facts: { kcal: 650, protein_g: 50, carbs_g: 50, fat_g: 16, entries: 2, meals: 2 },
    });
    expect(by('a-as-missed')).toMatchObject({
      kind: 'workout_missed',
      facts: { plan_name: 'Upper A' },
    });
    expect(by('a-as-done')).toMatchObject({
      kind: 'workout_done',
      at: '2026-10-04T17:00:00.000Z',
      facts: { post_rpe: 8 },
      text: 'Heavy',
    });
    expect(events.find((e) => e.kind === 'wearable_day')).toMatchObject({
      local_date: '2026-10-02',
      facts: { steps: 5000, sleep_hours: 8 },
    });
    expect(by('a-m1')).toMatchObject({ facts: { from: 'client' }, text: 'Knee is fine' });
    expect(by('a-m2')).toMatchObject({ facts: { from: 'coach' } });
    expect(by('a-m-del')).toBeUndefined();
    expect(by('a-m-voice')).toBeUndefined();
    expect(by('a-adj1')).toMatchObject({
      facts: { status: 'approved', volume_pct: -20, sets_before: 10, sets_after: 8 },
    });
    expect(by('a-adj-dismissed')).toBeUndefined();
    expect(by('a-ae-other')).toBeUndefined();
    expect(by('a-bk1')).toMatchObject({
      facts: { status: 'scheduled', duration_minutes: 45 },
      text: 'Deload next week',
    });
    expect(by('a-w1')).toMatchObject({
      at: '2026-10-02T07:00:00.000Z',
      facts: { weight_lbs: 170 },
    });
  });

  it("drops a former coach's assignments and messages, and the old coach's rows after reassignment", async () => {
    const db = makeDb();
    const before = await db.reader.read(A, { from: FROM, to: TO, now: NOW });
    expect(ids(before.events)).not.toContain('a-as-old');
    expect(ids(before.events)).not.toContain('a-m-old');
    expect(ids(before.events)).toContain('a-as-done'); // open sub-coach delegation of the current coach
    // Reassign A to a new coach: every coach-1 row drops, A's own logs stay.
    db.users[0].coach = coach('coach-2');
    const after = await db.reader.read(A, { from: FROM, to: TO, now: NOW });
    for (const k of COACH_KINDS) expect(kindsOf(after.events).has(k)).toBe(false);
    expect(ids(after.events)).not.toContain('a-as-done');
    for (const k of ['food_day', 'weight', 'water', 'habit', 'check_in', 'wearable_day'] as const) {
      expect(kindsOf(after.events).has(k)).toBe(true);
    }
  });

  it('a soft-deleted coach or a non-student gets no coach-owned rows; a deleted client reads nothing', async () => {
    const db = makeDb();
    db.users[0].coach = coach('coach-1', T('2026-10-01T00:00:00Z'));
    expect(
      [...kindsOf((await db.reader.read(A, { from: FROM, to: TO, now: NOW })).events)].some((k) =>
        COACH_KINDS.includes(k),
      ),
    ).toBe(false);
    db.users[0].coach = coach('coach-1');
    db.users[0].role = 'coach';
    expect(
      [...kindsOf((await db.reader.read(A, { from: FROM, to: TO, now: NOW })).events)].some((k) =>
        COACH_KINDS.includes(k),
      ),
    ).toBe(false);
    db.users[0].role = 'student';
    db.users[0].deleted_at = T('2026-10-05T00:00:00Z');
    expect((await db.reader.read(A, { from: FROM, to: TO, now: NOW })).events).toEqual([]);
    expect((await db.reader.read('nobody', { from: FROM, to: TO, now: NOW })).events).toEqual([]);
  });
});

describe('R11-M2 timeline reader — select shapes', () => {
  it('never selects coach notes, dismiss reasons, Roman text, activity payloads, links or contact data', async () => {
    const { reader, log } = makeDb();
    await reader.read(A, { from: FROM, to: TO, now: NOW });
    const keys = new Set<string>();
    const walk = (s: Row | undefined) => {
      for (const [k, v] of Object.entries(s ?? {})) {
        keys.add(k);
        if (v && typeof v === 'object') walk((v as Row).select);
      }
    };
    for (const q of log) walk(q.select);
    for (const k of [
      'coach_notes_md',
      'dismiss_reason',
      'roman_text',
      'summary',
      'payload',
      'video_url',
      'video_meeting_id',
      'email',
      'phone',
      'last_name',
      'access_token',
      'refresh_token',
    ]) {
      expect(keys.has(k)).toBe(false);
    }
    expect(new Set(log.map((q) => q.table))).toEqual(
      new Set([
        'loggedFoodEntry',
        'clientWorkoutAssignment',
        'workoutSession',
        'weightLog',
        'waterLog',
        'habitLog',
        'checkIn',
        'wearableSample',
        'coachMessage',
        'coachingSession',
        'workoutAdjustmentProposal',
        'activityEvent',
      ]),
    );
  });

  it('a kinds filter reads only the matching sources', async () => {
    const { reader, log } = makeDb();
    const page = await reader.read(A, {
      from: FROM,
      to: TO,
      now: NOW,
      kinds: ['weight', 'message'],
    });
    expect(kindsOf(page.events)).toEqual(new Set(['weight', 'message']));
    expect(log.map((q) => q.table).sort()).toEqual(['coachMessage', 'weightLog']);
  });
});

describe('R11-M2 timeline reader — order and cursor', () => {
  const pos = (e: RomanTimelineEvent) => `${e.at}|${e.kind}|${e.source.table}|${e.source.id}`;

  it('is ascending by (at, kind, table, id), repeatable, and pages without repeats or gaps', async () => {
    const { reader } = makeDb();
    const full = await reader.read(A, { from: FROM, to: TO, now: NOW });
    const again = await reader.read(A, { from: FROM, to: TO, now: NOW });
    expect(again).toEqual(full);
    const keys = full.events.map(pos);
    expect([...keys].sort()).toEqual(keys);
    const paged: RomanTimelineEvent[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const pg = await reader.read(A, { from: FROM, to: TO, now: NOW, limit: 3, cursor });
      expect(pg.events.length).toBeLessThanOrEqual(3);
      paged.push(...pg.events);
      cursor = pg.next_cursor;
      pages += 1;
    } while (cursor && pages < 50);
    expect(paged).toEqual(full.events);
    expect(pages).toBe(Math.ceil(full.events.length / 3));
  });

  it('a source over its read cap is flagged and the next pages pick up the rest', async () => {
    const db = makeDb();
    const start = T('2026-10-02T08:00:00Z').getTime();
    for (let i = 0; i < 1003; i++) {
      db.tables.waterLog.push({
        id: `a-bulk-${String(i).padStart(4, '0')}`,
        user_id: A,
        logged_at: new Date(start + i * 60_000),
        amount_ml: 100,
      });
    }
    const first = await db.reader.read(A, {
      from: FROM,
      to: TO,
      now: NOW,
      kinds: ['water', 'weight'],
      limit: 500,
    });
    expect(first.truncated).toEqual(['water']);
    expect(first.next_cursor).not.toBeNull();
    const all = [...first.events];
    let cursor = first.next_cursor;
    for (let i = 0; cursor && i < 20; i++) {
      const pg = await db.reader.read(A, {
        from: FROM,
        to: TO,
        now: NOW,
        kinds: ['water', 'weight'],
        limit: 500,
        cursor,
      });
      all.push(...pg.events);
      cursor = pg.next_cursor;
    }
    expect(all.filter((e) => e.kind === 'water')).toHaveLength(1004);
    expect(all.filter((e) => e.kind === 'weight')).toHaveLength(1);
    expect(new Set(all.map(pos)).size).toBe(all.length);
  });

  it('rejects a bad range, a range over 31 days, a bad cursor and an unknown kind', async () => {
    const { reader } = makeDb();
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: RomanTimelineError) => e.code,
      );
    await expect(code(reader.read(A, { from: TO, to: FROM }))).resolves.toBe('bad_range');
    await expect(
      code(reader.read(A, { from: FROM, to: new Date(FROM.getTime() + 32 * 86_400_000) })),
    ).resolves.toBe('range_too_large');
    await expect(
      code(reader.read(A, { from: FROM, to: TO, cursor: 'not-a-cursor' })),
    ).resolves.toBe('bad_cursor');
    await expect(
      code(
        reader.read(A, {
          from: FROM,
          to: TO,
          kinds: ['bloodwork' as unknown as RomanTimelineKind],
        }),
      ),
    ).resolves.toBe('bad_kind');
  });
});

describe('R11-M2 coach scope (extracted from the per-turn context, identical behaviour)', () => {
  const live = coach('coach-1');
  const overlay = { head_coach_id: 'coach-1', sub_coach_id: 'sub-1' };
  const cases: Array<
    [string, string, string, RomanCoachRow | null, RomanSubCoachOverlay | null, string[]]
  > = [
    [
      'student, live coach, open delegation',
      'student',
      'student',
      live,
      overlay,
      ['coach-1', 'sub-1'],
    ],
    ['student, live coach, no delegation', 'student', 'student', live, null, ['coach-1']],
    [
      'delegation from another head coach',
      'student',
      'student',
      live,
      { head_coach_id: 'coach-9', sub_coach_id: 'sub-9' },
      ['coach-1'],
    ],
    ['caller role is not student', 'student', 'coach', live, overlay, []],
    ['DB role is not student', 'sub_coach', 'student', live, overlay, []],
    [
      'soft-deleted coach',
      'student',
      'student',
      coach('coach-1', T('2026-10-01T00:00:00Z')),
      overlay,
      [],
    ],
    [
      'coach relation is not a coach account',
      'student',
      'student',
      { id: 'x', role: 'student', deleted_at: null },
      overlay,
      [],
    ],
    ['no coach', 'student', 'student', null, overlay, []],
  ];
  it.each(cases)('%s', (_name, userRole, callerRole, c, ov, side) => {
    const s = resolveRomanCoachScope({ userRole, callerRole, coach: c, overlay: ov });
    expect(s.coachSide).toEqual(side);
    expect(s.coachId).toBe(side[0] ?? null);
    expect(s.subCoachId).toBe(side[1] ?? null);
  });
});
