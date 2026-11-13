/**
 * MEAL-PLAN-NOTICE-BE (agent 203, class-first; owner #203-E45): every coach or AI write that changes what the
 * client's meal plan shows for today (GET /me/meal-plan/today) tells that client once per burst, and a new
 * assignment tells them even when it starts later; nothing else does.
 *
 * Driven for real over in-memory tables: RealMealPlansService (updatePlan, updateTemplate, archivePlan,
 * endAssignment, assignPlan), AssignMealPlanMaterializer, the drip MealPlanAssetResolver, NotificationsService
 * (createNotification, sendPush, listNotifications, getUnreadCount) and the push outbox (PushDeliveryService
 * enqueue and drain, Expo mocked), as test/fu-worklog-126-assignment-push.spec.ts and
 * test/community/notifications/community-links-be.spec.ts drive theirs. Each case reads the stored Notification
 * row, the stored PushOutbox row and, for a student, the phone's own tap tables (test/utils/phone-link-routes.ts,
 * the one copy). Only Date is faked (the window and "today"). Made-up words only.
 *
 * Red at backend main 7f566a59: no coach write tells anyone, the AI assign writes one row and queues no push, and
 * meal_plan_updated does not exist. Green at both: 5, 13 and 14.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Expo } from 'expo-server-sdk';
import { Prisma, type AiActionDraft } from '@prisma/client';
import { RealMealPlansService } from '../src/real-meal-plans/real-meal-plans.service';
import type { UpdateDailyMealPlanDto } from '../src/real-meal-plans/real-meal-plans.dto';
import { AssignMealPlanMaterializer } from '../src/ai/gateway/materialisers/assign-meal-plan.materialiser';
import { MealPlanAssetResolver } from '../src/packages/asset-resolvers/meal-plan.resolver';
import type { ResolverSubCoachScope } from '../src/packages/asset-resolvers/sub-coach-scope.helper';
import { NotificationsService } from '../src/notifications/notifications.service';
import { MONEY_NOTIFICATION_KINDS } from '../src/notifications/notification-kind';
import { notificationPrefsPrefix } from '../src/notifications/push/push-preferences';
import { ANDROID_PUSH_CHANNELS, androidChannelFor } from '../src/notifications/push/push-channels';
import { lockScreenCopy } from '../src/notifications/push/lock-screen-copy';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import type { PrismaService } from '../src/prisma.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';
import { devicePushTap, rowTap } from './utils/phone-link-routes';

// The kinds by value: meal_plan_updated is new in this PR, so the spec compiles at main.
const UPDATED = 'meal_plan_updated';
const ASSIGNED = 'meal_plan_assigned';
/** MEAL_PLAN_NOTICE_WINDOW_MS (src/real-meal-plans/meal-plan-notice.ts), the planner's 10 minutes. */
const WINDOW_MS = 10 * 60_000;

// The row and push words (MPN-W1..W5; the assigned push words are lock-screen-copy.ts:101-102, unchanged).
const UPDATED_ROW = { title: 'Meal plan updated', body: 'Your coach updated your meal plan.' };
const UPDATED_PUSH = { title: 'Meal plan updated', body: 'Your coach updated your meal plan. Open the app to see it.' };
const ASSIGNED_ROW = { title: 'New meal plan', body: 'Your coach assigned a new meal plan.' };
const ASSIGNED_PUSH = { title: 'New meal plan', body: 'Your coach added a meal plan for you. Open the app to see it.' };

// Case 10: made-up words no push and no row payload may hold.
const PLAN_NAME = 'Saffron Lantern Supper';
const PLAN_NOTE = 'Marigold kettle at dusk';
const MEAL_NAME = 'Quillfeather Porridge';
const AI_BODY = 'Cobalt heron parade tonight';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const COACH = uid(1);
const OTHER = uid(2);
// The coach's clients
const A1 = uid(11);
const A2 = uid(12);
const ENDED = uid(13);
const LATER = uid(15);
const B1 = uid(16);
const DUO = uid(17);
const FRESH = uid(19);
const NIGHT = uid(20);
// Another coach's clients: MOVED left COACH with a plan of theirs; THEIRS never was COACH's.
const MOVED = uid(14);
const THEIRS = uid(18);
const P1 = uid(31);
const P2 = uid(32);
const P3 = uid(33);
const OATS = uid(41);
const EGGS = uid(42);
const RICE = uid(43);
const ASG = {
  A1: uid(51),
  A2: uid(52),
  ENDED: uid(53),
  MOVED: uid(54),
  LATER: uid(55),
  B1: uid(56),
  DUO1: uid(57),
  DUO2: uid(58),
  NIGHT: uid(59),
};

const T0 = new Date('2026-06-02T16:00:00Z'); // 16:00 UTC: outside quiet hours in UTC, 23:00 in Bangkok
const LAST_WEEK = new Date('2026-05-26T00:00:00Z');
const YESTERDAY = new Date('2026-06-01T00:00:00Z');
const TOMORROW = new Date('2026-06-03T00:00:00Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Table =
  | 'user'
  | 'dailyMealPlan'
  | 'dailyMealPlanSlot'
  | 'mealTemplate'
  | 'dailyMealPlanRevision'
  | 'dailyMealPlanAssignment'
  | 'notification'
  | 'loggedFoodEntry'
  | 'listItem';

const DEFAULTS: Partial<Record<Table, Row>> = {
  dailyMealPlan: { archived_at: null, notes: null },
  mealTemplate: { archived_at: null, description: null, fiber_g: null, items: null, swap_template_ids: [], recipe_id: null },
  dailyMealPlanSlot: { time_of_day: null },
  dailyMealPlanAssignment: { ends_on: null, ai_draft_id: null, drip_drop_id: null },
  notification: { payload: null, deep_link: null, read_at: null, inbox_hidden: false },
};

/** A filter value, read the way Postgres reads it (the subset these services use). */
function field(a: unknown, c: unknown): boolean {
  if (c === null) return a === null || a === undefined;
  if (c instanceof Date) return a instanceof Date && a.getTime() === c.getTime();
  if (typeof c !== 'object') return a === c;
  const o = c as Row;
  const n = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
  const set = a !== null && a !== undefined;
  return Object.entries(o).every(([op, v]) => {
    switch (op) {
      case 'equals':
        return 'path' in o || a === v;
      case 'path': {
        const at = (v as string[]).reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Row)[k] : undefined), a);
        return at === o.equals;
      }
      case 'not':
        return v === null ? set : !field(a, v);
      case 'in':
        return (v as unknown[]).includes(a);
      case 'notIn':
        return set && !(v as unknown[]).includes(a);
      case 'has':
        return Array.isArray(a) && a.includes(v);
      case 'startsWith':
        return typeof a === 'string' && a.startsWith(v as string);
      case 'gte':
        return set && n(a) >= n(v);
      case 'gt':
        return set && n(a) > n(v);
      case 'lte':
        return set && n(a) <= n(v);
      case 'lt':
        return set && n(a) < n(v);
      default:
        throw new Error(`meal-plan-notice fake: filter ${op} is not modelled`);
    }
  });
}

/** In-memory tables with the relations these services filter on. */
function tables() {
  const t: Record<Table, Row[]> = {
    user: [],
    dailyMealPlan: [],
    dailyMealPlanSlot: [],
    mealTemplate: [],
    dailyMealPlanRevision: [],
    dailyMealPlanAssignment: [],
    notification: [],
    loggedFoodEntry: [],
    listItem: [],
  };
  const byId = (table: Table, id: unknown) => t[table].find((r) => r.id === id) ?? null;
  const REL: Partial<Record<Table, Record<string, [Table, (r: Row) => Row | Row[] | null]>>> = {
    dailyMealPlanAssignment: {
      client: ['user', (r) => byId('user', r.client_id)],
      daily_meal_plan: ['dailyMealPlan', (r) => byId('dailyMealPlan', r.daily_meal_plan_id)],
    },
    dailyMealPlan: {
      slots: ['dailyMealPlanSlot', (r) => t.dailyMealPlanSlot.filter((s) => s.daily_meal_plan_id === r.id)],
      coach: ['user', (r) => byId('user', r.coach_id)],
    },
    dailyMealPlanSlot: { meal_template: ['mealTemplate', (r) => byId('mealTemplate', r.meal_template_id)] },
    user: { students: ['user', (r) => t.user.filter((u) => u.coach_id === r.id)] },
  };
  const list = (x: unknown) => (Array.isArray(x) ? x : [x]);
  const match = (table: Table, row: Row, where?: Row): boolean =>
    !where ||
    Object.entries(where).every(([k, c]) => {
      if (c === undefined) return true;
      if (k === 'AND') return list(c).every((w) => match(table, row, w));
      if (k === 'OR') return (c as Row[]).some((w) => match(table, row, w));
      if (k === 'NOT') return list(c).every((w) => !match(table, row, w));
      const rel = REL[table]?.[k];
      if (!rel) return field(row[k], c);
      const [to, get] = rel;
      const got = get(row);
      if (Array.isArray(got)) {
        if ('none' in c) return !got.some((x) => match(to, x, c.none));
        if ('some' in c) return got.some((x) => match(to, x, c.some));
        if ('every' in c) return got.every((x) => match(to, x, c.every));
        throw new Error(`meal-plan-notice fake: to-many filter on ${k} is not modelled`);
      }
      if (got === null) return c === null;
      return match(to, got, 'is' in c ? c.is : c);
    });
  const expand = (table: Table, row: Row, include?: Row): Row => {
    if (!include) return { ...row };
    const out: Row = { ...row };
    for (const [k, v] of Object.entries(include)) {
      const rel = REL[table]?.[k];
      if (!v || !rel) continue;
      const [to, get] = rel;
      const inner = typeof v === 'object' ? (v as Row).include : undefined;
      const got = get(row);
      out[k] = Array.isArray(got) ? got.map((x) => expand(to, x, inner)) : got && expand(to, got, inner);
    }
    return out;
  };
  const order = (rows: Row[], orderBy?: Row | Row[]) => {
    if (!orderBy || Array.isArray(orderBy)) return rows;
    const [[f, dir]] = Object.entries(orderBy);
    const v = (r: Row) => (r[f] instanceof Date ? r[f].getTime() : r[f]);
    return [...rows].sort((x, y) => (v(x) < v(y) ? -1 : v(x) > v(y) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
  };
  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'fake' });
  const unique: Partial<Record<Table, string[]>> = { dailyMealPlanAssignment: ['ai_draft_id', 'drip_drop_id'] };
  const build = (table: Table, data: Row): Row => {
    for (const k of unique[table] ?? []) {
      if (data[k] != null && t[table].some((r) => r[k] === data[k])) throw p2002();
    }
    return { id: randomUUID(), created_at: new Date(), ...DEFAULTS[table], ...data };
  };
  const delegate = (table: Table) => {
    const findMany = async (a: Row = {}) =>
      order(t[table].filter((r) => match(table, r, a.where)), a.orderBy)
        .slice(0, a.take ?? Infinity)
        .map((r) => expand(table, r, a.include));
    const findFirst = async (a: Row = {}) => (await findMany({ ...a, take: 1 }))[0] ?? null;
    return {
      findMany: jest.fn(findMany),
      findFirst: jest.fn(findFirst),
      findUnique: jest.fn(findFirst),
      count: jest.fn(async (a: Row = {}) => t[table].filter((r) => match(table, r, a.where)).length),
      create: jest.fn(async (a: Row) => {
        const row = build(table, a.data);
        t[table].push(row);
        return { ...row };
      }),
      createMany: jest.fn(async (a: Row) => {
        const rows = list(a.data).map((d) => build(table, d as Row));
        t[table].push(...rows);
        return { count: rows.length };
      }),
      update: jest.fn(async (a: Row) => {
        const row = t[table].find((r) => match(table, r, a.where));
        if (!row) throw new Error(`meal-plan-notice fake: no ${table} row to update`);
        Object.assign(row, a.data);
        return { ...row };
      }),
      updateMany: jest.fn(async (a: Row) => {
        const hit = t[table].filter((r) => match(table, r, a.where));
        hit.forEach((r) => Object.assign(r, a.data));
        return { count: hit.length };
      }),
      deleteMany: jest.fn(async (a: Row = {}) => {
        const keep = t[table].filter((r) => !match(table, r, a.where));
        const count = t[table].length - keep.length;
        t[table].splice(0, t[table].length, ...keep);
        return { count };
      }),
    };
  };
  const delegates = Object.fromEntries((Object.keys(t) as Table[]).map((k) => [k, delegate(k)])) as Record<
    Table,
    ReturnType<typeof delegate>
  >;
  return { t, delegates };
}

/** The real services over the tables: the coach routes, the AI assign, the inbox, the push outbox. */
function world() {
  const { t, delegates } = tables();
  const outbox = pushOutboxWorld({ now: () => new Date() });
  const db: Row = {
    ...outbox.db,
    ...delegates,
    userBlock: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    communityWorkspaceBan: { findMany: jest.fn(async () => []) },
    recipe: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  };
  db.$transaction = jest.fn(async (cb: (tx: Row) => Promise<unknown>) => cb(db));
  const prisma = stub<PrismaService>(db);
  const sent = jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok', id: `mpn-${i}` })));
  const transport = stub<ExpoPushClient>({ send: sent, getReceipts: jest.fn(async () => ({})) });
  const delivery = new PushDeliveryService(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), transport);
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined,
    undefined,
    delivery,
  );
  // Built with its notifier as the module wires it. Reflect.construct: at main the constructor takes Prisma only.
  const meals = Reflect.construct(RealMealPlansService, [prisma, notifications]) as RealMealPlansService;
  const ai = new AssignMealPlanMaterializer(prisma, notifications);

  const person = (id: string, role: 'coach' | 'student', coachId: string | null, zone = 'UTC') => {
    t.user.push({ id, role, coach_id: coachId, expo_push_token: `ExponentPushToken[${id.slice(-12)}]` });
    outbox.prefs[id] = { timezone: zone, timezone_updated_at: new Date('2026-01-01T00:00:00Z') };
  };
  person(COACH, 'coach', null);
  person(OTHER, 'coach', null);
  for (const id of [A1, A2, ENDED, LATER, B1, DUO, FRESH]) person(id, 'student', COACH);
  person(NIGHT, 'student', COACH, 'Asia/Bangkok');
  person(MOVED, 'student', OTHER);
  person(THEIRS, 'student', OTHER);
  const meal = (id: string, name: string) =>
    t.mealTemplate.push({ id, coach_id: COACH, name, calories_kcal: 400, protein_g: 20, carbs_g: 50, fats_g: 10, ...DEFAULTS.mealTemplate, created_at: LAST_WEEK });
  meal(OATS, 'Oats');
  meal(EGGS, 'Eggs');
  meal(RICE, 'Rice');
  const plan = (id: string, name: string) => t.dailyMealPlan.push({ id, coach_id: COACH, name, notes: null, archived_at: null, created_at: LAST_WEEK });
  plan(P1, 'Plan one');
  plan(P2, 'Plan two');
  plan(P3, 'Plan three');
  const slot = (planId: string, slot_label: string, meal_template_id: string) =>
    t.dailyMealPlanSlot.push({ id: randomUUID(), daily_meal_plan_id: planId, slot_label, order: 0, meal_template_id, time_of_day: null });
  slot(P1, 'breakfast', OATS);
  slot(P1, 'lunch', EGGS);
  slot(P2, 'breakfast', OATS);
  slot(P3, 'dinner', RICE);
  const assign = (id: string, planId: string, client: string, starts_on: Date, ends_on: Date | null = null) =>
    t.dailyMealPlanAssignment.push({ id, daily_meal_plan_id: planId, client_id: client, assigned_by_coach_id: COACH, starts_on, ends_on, ai_draft_id: null, drip_drop_id: null, created_at: LAST_WEEK });
  assign(ASG.A1, P1, A1, YESTERDAY);
  assign(ASG.A2, P1, A2, LAST_WEEK);
  assign(ASG.ENDED, P1, ENDED, LAST_WEEK, YESTERDAY);
  assign(ASG.MOVED, P1, MOVED, LAST_WEEK);
  assign(ASG.LATER, P1, LATER, TOMORROW);
  assign(ASG.B1, P2, B1, YESTERDAY);
  assign(ASG.DUO1, P1, DUO, YESTERDAY);
  assign(ASG.DUO2, P2, DUO, YESTERDAY);
  assign(ASG.NIGHT, P1, NIGHT, YESTERDAY);

  /** Let the notices the writes started finish (never awaited by the route), then send what is due. */
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    await delivery.drain();
  };
  const notes = (id: string) => t.notification.filter((n) => n.user_id === id && String(n.kind).startsWith('meal_plan'));
  const pushes = (id: string) => outbox.rows.filter((r) => r.user_id === id && r.kind.startsWith('meal_plan'));
  const draft = (clientId: string, planId: string, startsOn: string, notificationBody?: string) =>
    stub<AiActionDraft>({
      id: randomUUID(),
      capability: 'draft.assign_meal_plan',
      requester_id: COACH,
      tenant_coach_id: COACH,
      subject_user_id: clientId,
      payload: { dailyMealPlanId: planId, clientId, startsOn, ...(notificationBody ? { notificationBody } : {}) },
    });
  return { t, db, prisma, outbox, delivery, notifications, meals, ai, settle, notes, pushes, draft };
}

const P1_SLOTS = (breakfast: string): UpdateDailyMealPlanDto['slots'] => [
  { meal_template_id: breakfast, slot_label: 'breakfast', order: 0 },
  { meal_template_id: EGGS, slot_label: 'lunch', order: 0 },
];
const TAP_DAY = { root: 'MoreTab', screen: 'ClientDailyMealPlan' };
const tapOne = (assignmentId: string) => ({ ...TAP_DAY, params: { assignmentId } });

beforeEach(() => {
  jest.useFakeTimers({
    now: T0,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('MEAL-PLAN-NOTICE-BE: the client hears about a change to today\'s meal plan, once per burst', () => {
  it('1. a meal swapped in a plan in force today: one row, one push with exactly the tap data, both land on that plan', async () => {
    const w = world();
    await w.meals.updatePlan(COACH, P1, { slots: P1_SLOTS(RICE) });
    await w.settle();
    const link = `tgp://meal-plan/${ASG.A1}`;
    const rows = w.notes(A1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: UPDATED, channel: 'inapp', body: UPDATED_ROW.body, deep_link: link, payload: { title: UPDATED_ROW.title } });
    const push = w.pushes(A1);
    expect(push).toHaveLength(1);
    expect(push[0].data).toEqual({ actionScreen: 'NotificationCenter', deepLink: link, kind: UPDATED });
    expect({ title: push[0].title, body: push[0].body }).toEqual(UPDATED_PUSH);
    expect(devicePushTap('student', push[0].data)).toEqual(tapOne(ASG.A1));
    expect(rowTap('student', rows[0])).toEqual(tapOne(ASG.A1));
    // The plan the tap opens shows that assignment today, with the new meal.
    const today = await w.meals.getTodayForClient(A1);
    expect(today.assignments.map((a) => a.id)).toEqual([ASG.A1]);
    expect(today.assignments[0].daily_meal_plan.slots.map((s) => s.meal_template.name).sort()).toEqual(['Eggs', 'Rice']);
  });

  describe('2. a burst is one notice per client and link', () => {
    it('three edits inside the window tell once; one after the window tells again', async () => {
      const w = world();
      for (const [at, name] of [[0, 'Plan one b'], [3, 'Plan one c'], [9, 'Plan one d']] as const) {
        jest.setSystemTime(minutes(at));
        await w.meals.updatePlan(COACH, P1, { name });
        await w.settle();
      }
      expect(w.notes(A1)).toHaveLength(1);
      expect(w.pushes(A1)).toHaveLength(1);
      jest.setSystemTime(minutes(11));
      await w.meals.updatePlan(COACH, P1, { name: 'Plan one e' });
      await w.settle();
      expect(w.notes(A1)).toHaveLength(2);
      expect(w.pushes(A1)).toHaveLength(2);
    });

    it('an assign, then an edit of that plan inside the window: one (the assign)', async () => {
      const w = world();
      const created = await w.meals.assignPlan(COACH, P3, { client_id: FRESH, starts_on: '2026-06-02' });
      await w.settle();
      jest.setSystemTime(minutes(2));
      await w.meals.updatePlan(COACH, P3, { name: 'Plan three b' });
      await w.settle();
      expect(w.notes(FRESH).map((n) => [n.kind, n.deep_link])).toEqual([[ASSIGNED, `tgp://meal-plan/${created.id}`]]);
      expect(w.pushes(FRESH)).toHaveLength(1);
    });

    it('an edit of one plan, then an assign of another in force today, inside the window: two, one per link', async () => {
      const w = world();
      await w.meals.updatePlan(COACH, P1, { name: 'Plan one b' });
      await w.settle();
      jest.setSystemTime(minutes(2));
      const created = await w.meals.assignPlan(COACH, P3, { client_id: A1, starts_on: '2026-06-02' });
      await w.settle();
      expect(w.notes(A1).map((n) => [n.kind, n.deep_link])).toEqual([
        [UPDATED, `tgp://meal-plan/${ASG.A1}`],
        [ASSIGNED, `tgp://meal-plan/${created.id}`],
      ]);
      expect(w.pushes(A1)).toHaveLength(2);
    });

    it('an edit, then an archive of that plan inside the window: two', async () => {
      const w = world();
      await w.meals.updatePlan(COACH, P2, { name: 'Plan two b' });
      await w.settle();
      jest.setSystemTime(minutes(2));
      await w.meals.archivePlan(COACH, P2);
      await w.settle();
      expect(w.notes(B1).map((n) => n.deep_link)).toEqual([`tgp://meal-plan/${ASG.B1}`, 'tgp://plan']);
      expect(w.pushes(B1)).toHaveLength(2);
    });
  });

  it('3. recipients: the coach\'s clients with the plan in force today; never an ended, later, moved or other coach\'s client, never a coach', async () => {
    const w = world();
    await w.meals.updatePlan(COACH, P1, { name: 'Plan one b' });
    await w.ai.materialize(w.draft(THEIRS, P3, '2026-06-02'));
    await w.settle();
    for (const id of [A1, A2, NIGHT]) expect([id, w.notes(id).length]).toEqual([id, 1]);
    expect(w.notes(A1)[0].deep_link).toBe(`tgp://meal-plan/${ASG.A1}`);
    expect(w.notes(A2)[0].deep_link).toBe(`tgp://meal-plan/${ASG.A2}`);
    for (const id of [ENDED, LATER, MOVED, THEIRS, B1, FRESH, COACH, OTHER]) {
      expect([id, w.notes(id).length, w.pushes(id).length]).toEqual([id, 0, 0]);
    }
    // The moved client kept the plan as it was (owner 4): the freeze ran before the edit.
    const moved = w.t.dailyMealPlanAssignment.find((a) => a.id === ASG.MOVED);
    expect(moved?.daily_meal_plan_id).not.toBe(P1);
  });

  it('4. a meal used in two live plans edited: each in-force client of either plan hears once', async () => {
    const w = world();
    await w.meals.updateTemplate(COACH, OATS, { name: 'Oats b' });
    await w.settle();
    expect(w.notes(A1).map((n) => n.deep_link)).toEqual([`tgp://meal-plan/${ASG.A1}`]);
    expect(w.notes(A2).map((n) => n.deep_link)).toEqual([`tgp://meal-plan/${ASG.A2}`]);
    expect(w.notes(B1).map((n) => n.deep_link)).toEqual([`tgp://meal-plan/${ASG.B1}`]);
    // A client on both plans hears once, and the tap opens the whole day.
    expect(w.notes(DUO).map((n) => n.deep_link)).toEqual(['tgp://plan']);
    expect(w.pushes(DUO)).toHaveLength(1);
    expect(devicePushTap('student', w.pushes(DUO)[0].data)).toEqual(TAP_DAY);
    for (const id of [ENDED, LATER, MOVED, FRESH, COACH]) expect([id, w.notes(id).length]).toEqual([id, 0]);
  });

  it('5. an edit that changes nothing the client sees sends nothing', async () => {
    const w = world();
    await w.meals.updatePlan(COACH, P1, { name: 'Plan one', slots: P1_SLOTS(OATS) });
    await w.meals.updateTemplate(COACH, OATS, { name: 'Oats', fiber_g: 9 });
    await w.settle();
    expect(w.t.notification).toEqual([]);
    expect(w.outbox.rows).toEqual([]);
  });

  describe('6. the coach assigns a plan', () => {
    it('in force today: meal_plan_assigned row and push, the assigned lock-screen words, the new assignment\'s link', async () => {
      const w = world();
      const created = await w.meals.assignPlan(COACH, P3, { client_id: FRESH, starts_on: '2026-06-02' });
      await w.settle();
      const link = `tgp://meal-plan/${created.id}`;
      expect(w.notes(FRESH)).toEqual([
        expect.objectContaining({ kind: ASSIGNED, channel: 'inapp', body: ASSIGNED_ROW.body, deep_link: link, payload: { title: ASSIGNED_ROW.title } }),
      ]);
      const [push] = w.pushes(FRESH);
      expect({ title: push.title, body: push.body }).toEqual(ASSIGNED_PUSH);
      expect(push.data).toEqual({ actionScreen: 'NotificationCenter', deepLink: link, kind: ASSIGNED });
      expect(devicePushTap('student', push.data)).toEqual(tapOne(created.id));
      expect(rowTap('student', w.notes(FRESH)[0])).toEqual(tapOne(created.id));
    });

    it('starting tomorrow: told, and the tap opens the day (tgp://plan)', async () => {
      const w = world();
      await w.meals.assignPlan(COACH, P3, { client_id: FRESH, starts_on: '2026-06-03' });
      await w.settle();
      expect(w.notes(FRESH).map((n) => [n.kind, n.deep_link])).toEqual([[ASSIGNED, 'tgp://plan']]);
      expect(w.pushes(FRESH).map((p) => p.data)).toEqual([{ actionScreen: 'NotificationCenter', deepLink: 'tgp://plan', kind: ASSIGNED }]);
      expect(devicePushTap('student', w.pushes(FRESH)[0].data)).toEqual(TAP_DAY);
    });
  });

  it('7. the AI assign tells the same way (its row keeps the draft words); its replay sends nothing', async () => {
    const w = world();
    const d = w.draft(FRESH, P3, '2026-06-02', AI_BODY);
    const first = await w.ai.materialize(d);
    await w.settle();
    expect(first.status).toBe('sent');
    const link = `tgp://meal-plan/${first.ref}`;
    expect(w.notes(FRESH)).toEqual([
      expect.objectContaining({ kind: ASSIGNED, body: AI_BODY, deep_link: link, payload: expect.objectContaining({ title: ASSIGNED_ROW.title }) }),
    ]);
    expect(w.pushes(FRESH).map((p) => [p.title, p.body, p.data])).toEqual([
      [ASSIGNED_PUSH.title, ASSIGNED_PUSH.body, { actionScreen: 'NotificationCenter', deepLink: link, kind: ASSIGNED }],
    ]);
    jest.setSystemTime(minutes(30));
    const replay = await w.ai.materialize(d);
    await w.settle();
    expect(replay).toEqual({ status: 'already_materialised', ref: first.ref });
    expect(w.notes(FRESH)).toHaveLength(1);
    expect(w.pushes(FRESH)).toHaveLength(1);
  });

  describe('8. a write that takes the plan off today', () => {
    it('archive: every in-force client hears, the tap opens the day', async () => {
      const w = world();
      await w.meals.archivePlan(COACH, P2);
      await w.settle();
      for (const id of [B1, DUO]) {
        expect([id, w.notes(id).map((n) => [n.kind, n.deep_link])]).toEqual([id, [[UPDATED, 'tgp://plan']]]);
        expect(devicePushTap('student', w.pushes(id)[0].data)).toEqual(TAP_DAY);
      }
      expect(w.notes(A1)).toEqual([]);
    });

    it('end before today (the last day was yesterday) and end before the start (the row goes): told; a later last day: nothing', async () => {
      const w = world();
      await w.meals.endAssignment(COACH, P1, ASG.A1, { ends_on: '2026-06-01' });
      await w.meals.endAssignment(COACH, P1, ASG.A2, { ends_on: '2026-05-20' });
      await w.meals.endAssignment(COACH, P2, ASG.B1, { ends_on: '2026-06-09' });
      await w.settle();
      expect(w.t.dailyMealPlanAssignment.some((a) => a.id === ASG.A2)).toBe(false);
      for (const id of [A1, A2]) expect([id, w.notes(id).map((n) => [n.kind, n.deep_link])]).toEqual([id, [[UPDATED, 'tgp://plan']]]);
      expect(w.notes(B1)).toEqual([]);
      expect(w.pushes(B1)).toEqual([]);
    });
  });

  it('9. Mute all keeps the row and stops the push; quiet hours hold the push to 08:00 local, not urgent', async () => {
    const w = world();
    w.outbox.prefs[A1] = { ...w.outbox.prefs[A1], muted: true };
    await w.meals.updatePlan(COACH, P1, { name: 'Plan one b' });
    await w.settle();
    expect(w.notes(A1)).toHaveLength(1);
    expect(w.pushes(A1)).toEqual([]);
    // NIGHT is in Bangkok: 16:00 UTC is 23:00 there, so the push waits for 08:00 (01:00 UTC).
    expect(w.notes(NIGHT)).toHaveLength(1);
    expect(w.pushes(NIGHT)).toEqual([
      expect.objectContaining({ status: 'pending', urgent: false, deferred_reason: 'quiet_hours', not_before: new Date('2026-06-03T01:00:00Z') }),
    ]);
  });

  it('10. no user text in a push or a row payload; device data is exactly the three tap keys', async () => {
    const w = world();
    await w.meals.updatePlan(COACH, P1, { name: PLAN_NAME, notes: PLAN_NOTE });
    jest.setSystemTime(minutes(20));
    await w.meals.updateTemplate(COACH, OATS, { name: MEAL_NAME });
    await w.ai.materialize(w.draft(FRESH, P3, '2026-06-02', AI_BODY));
    await w.settle();
    const words = [PLAN_NAME, PLAN_NOTE, MEAL_NAME, AI_BODY];
    const pushes = w.outbox.rows.filter((r) => r.kind.startsWith('meal_plan'));
    const rows = w.t.notification.filter((n) => String(n.kind).startsWith('meal_plan'));
    expect(pushes.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
    for (const p of pushes) {
      const seen = JSON.stringify([p.title, p.body, p.data]);
      for (const word of words) expect([p.id, seen.includes(word)]).toEqual([p.id, false]);
      expect(Object.keys(p.data).sort()).toEqual(['actionScreen', 'deepLink', 'kind']);
    }
    for (const n of rows) {
      const seen = JSON.stringify(n.payload);
      for (const word of words) expect([n.id, seen.includes(word)]).toEqual([n.id, false]);
      // Only the AI path's row keeps its draft words, as its body (inside the app).
      if (n.body !== AI_BODY) for (const word of words) expect(n.body.includes(word)).toBe(false);
    }
    expect(rows.filter((n) => n.body === AI_BODY).map((n) => n.user_id)).toEqual([FRESH]);
  });

  it('11. both kinds: not money, no-column prefix (never the digest default), client-bot channel, fixed lock-screen words', () => {
    for (const [kind, words] of [[UPDATED, UPDATED_PUSH], [ASSIGNED, ASSIGNED_PUSH]] as const) {
      expect([kind, MONEY_NOTIFICATION_KINDS.has(kind)]).toEqual([kind, false]);
      expect([kind, notificationPrefsPrefix(kind)]).toEqual([kind, kind]);
      expect([kind, androidChannelFor(kind)]).toEqual([kind, ANDROID_PUSH_CHANNELS.CLIENT_BOT]);
      expect([kind, lockScreenCopy(kind, PLAN_NAME)]).toEqual([kind, words]);
    }
  });

  it('12. the client\'s GET /notifications lists the row and counts it unread', async () => {
    const w = world();
    await w.meals.updatePlan(COACH, P1, { name: 'Plan one b' });
    await w.settle();
    const page = await w.notifications.listNotifications(A1, {});
    expect(page.items.map((n) => [n.kind, n.deep_link])).toEqual([[UPDATED, `tgp://meal-plan/${ASG.A1}`]]);
    expect(page.unreadCount).toBe(1);
    expect(await w.notifications.getUnreadCount(A1)).toBe(1);
  });

  it('13. a meal plan delivered by a drip drop sends no meal plan notice (drip_released tells the buyer)', async () => {
    const w = world();
    const scope = stub<ResolverSubCoachScope>({ resolve: jest.fn(async () => ({ tenantCoachId: COACH })) });
    const resolver = new MealPlanAssetResolver(w.prisma, scope);
    const out = await resolver.materialise({ clientId: FRESH, coachId: COACH, assetId: P3, scheduledDropId: randomUUID() });
    await w.settle();
    expect(w.t.dailyMealPlanAssignment.some((a) => a.id === out.materialisedRef && a.client_id === FRESH)).toBe(true);
    expect(w.notes(FRESH)).toEqual([]);
    expect(w.pushes(FRESH)).toEqual([]);
  });

  it('14. a notice that fails never fails the coach\'s request or undoes the write', async () => {
    const w = world();
    jest.spyOn(w.notifications, 'createNotification').mockRejectedValue(new Error('inbox down'));
    jest.spyOn(w.notifications, 'sendPush').mockRejectedValue(new Error('outbox down'));
    w.db.notification.findFirst.mockRejectedValue(new Error('read down'));
    await expect(w.meals.updatePlan(COACH, P1, { name: 'Plan one b' })).resolves.toMatchObject({ id: P1, name: 'Plan one b' });
    await expect(w.meals.assignPlan(COACH, P3, { client_id: FRESH, starts_on: '2026-06-02' })).resolves.toMatchObject({ client_id: FRESH });
    await w.settle();
    expect(w.t.dailyMealPlan.find((p) => p.id === P1)?.name).toBe('Plan one b');
    expect(w.t.dailyMealPlanAssignment.filter((a) => a.client_id === FRESH)).toHaveLength(1);
  });
});
