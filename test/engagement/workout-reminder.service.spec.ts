import {
  WORKOUT_REMINDER_CRON,
  WorkoutReminderService,
} from '../../src/engagement/workout-reminder.service';
import { FIRST_DAY_BODY, REMINDER_TITLE } from '../../src/engagement/workout-reminder.policy';
import { NotificationsService } from '../../src/notifications/notifications.service';
import type { PrismaService } from '../../src/prisma.service';
import { cast, FakeTable, matches } from './_fake-db';

// C05 item 7 — workout reminders: once per local day, skip if logged,
// client opt-out, client-local timezone.

const CLIENT = 'client-1';
const C1 = '2026-10-05';

/**
 * Adds the two Prisma entry points the claim uses (B-609-4): an interactive
 * $transaction (the fake runs the callback on the same tables) and the
 * `SELECT ... FOR SHARE` eligibility lock, evaluated against the users table
 * at the instant it runs. Every lock statement is recorded in `locks`.
 */
function withTx<T extends Record<string, unknown>>(base: T, users: FakeTable) {
  const locks: Array<{ sql: string; values: unknown[] }> = [];
  const hooks: { afterCommit?: () => void } = {};
  const db: Record<string, unknown> = { ...base, user: base.user ?? users };
  db.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    locks.push({ sql: strings.join('$'), values });
    const u = users.rows.find((x) => x.id === values[0]);
    const ok = !!u && !u.deleted_at && !u.deletion_scheduled_at && u.role === 'student';
    return ok ? [{ id: values[0] }] : [];
  };
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const out = await fn(db);
    hooks.afterCommit?.();
    return out;
  };
  return { db, locks, hooks };
}

function harness(prefs: Record<string, unknown> | null = null) {
  const users = new FakeTable([['id']]);
  const intakes = new FakeTable([['client_id']]);
  const assignments = new FakeTable();
  const sessions = new FakeTable();
  const deliveries = new FakeTable([['client_id', 'local_date']]);
  const notifRows = new FakeTable();
  const prefRows = new FakeTable([['user_id']]);
  const dunning = new FakeTable();
  const purchases = new FakeTable([['id']]);
  deliveries.relations.client = (row, f) => {
    const u = users.rows.find((x) => x.id === row.client_id);
    return !!u && matches(u, f as Record<string, unknown>);
  };
  dunning.relations.purchase = (row, f) => {
    const p = purchases.rows.find((x) => x.id === row.purchase_id);
    return !!p && matches(p, f as Record<string, unknown>);
  };
  intakes.relations.client = (row, f) => {
    const u = users.rows.find((x) => x.id === row.client_id);
    const filter = f as { deleted_at?: null; deletion_scheduled_at?: null; role?: string };
    return !!u && !u.deleted_at && !u.deletion_scheduled_at && u.role === filter.role;
  };
  const { db: prisma, locks, hooks } = withTx(
    {
      user: users,
      clientOnboardingIntake: intakes,
      clientWorkoutAssignment: assignments,
      workoutSession: sessions,
      workoutReminderDelivery: deliveries,
      notification: notifRows,
      notificationPreferences: prefRows,
      dunningState: dunning,
    },
    users,
  );
  // Real NotificationsService on the fake DB, so preference gating and the
  // workout_reminder prefs prefix are exercised for real; only the Expo
  // transport is stubbed.
  const notifications = new NotificationsService(cast<PrismaService>(prisma));
  const pushToUser = jest
    .spyOn(notifications, 'pushToUser')
    .mockResolvedValue({ delivered: true, code: 'delivered' });
  if (prefs) void prefRows.create({ data: { user_id: CLIENT, ...prefs } });
  const svc = new WorkoutReminderService(cast<PrismaService>(prisma), notifications);
  return {
    users,
    intakes,
    assignments,
    sessions,
    deliveries,
    notifRows,
    prefRows,
    dunning,
    purchases,
    pushToUser,
    svc,
    locks,
    hooks,
  };
}

async function seed(h: ReturnType<typeof harness>, preferred: string | null = 'morning') {
  await h.users.create({
    data: { id: CLIENT, role: 'student', deleted_at: null, deletion_scheduled_at: null },
  });
  await h.intakes.create({
    data: {
      client_id: CLIENT,
      completed_at: new Date('2026-10-04T18:00:00Z'),
      first_session_date: new Date(`${C1}T00:00:00Z`),
      preferred_training_time: preferred,
    },
  });
  for (const d of ['2026-10-05', '2026-10-07', '2026-10-09']) {
    await h.assignments.create({
      data: { client_id: CLIENT, scheduled_for: new Date(`${d}T00:00:00Z`), completed_at: null },
    });
  }
}

describe('WorkoutReminderService', () => {
  it('first session day: one push at 07:00 local with the first-day copy and an in-app row', async () => {
    const h = harness();
    await seed(h);
    const early = await h.svc.runOnce(new Date('2026-10-05T13:55:00Z')); // 06:55 PDT
    expect(early.sent).toBe(0);
    const s = await h.svc.runOnce(new Date('2026-10-05T14:00:00Z'));
    expect(s.sent).toBe(1);
    expect(h.pushToUser).toHaveBeenCalledWith(
      CLIENT,
      REMINDER_TITLE,
      FIRST_DAY_BODY,
      expect.objectContaining({ kind: 'workout_reminder', local_date: C1, first_day: true }),
    );
    expect(h.notifRows.rows).toHaveLength(1);
    expect(h.notifRows.rows[0]).toMatchObject({ kind: 'workout_reminder', channel: 'inapp' });
    expect(h.deliveries.rows[0]).toMatchObject({
      status: 'sent',
      slot: 'morning',
      first_day: true,
    });
  });

  it('at most one per day: repeated ticks, a second instance and the catch-up window send nothing more', async () => {
    const h = harness();
    await seed(h);
    await h.svc.runOnce(new Date('2026-10-07T14:00:00Z'));
    await h.svc.runOnce(new Date('2026-10-07T14:05:00Z'));
    const other = new WorkoutReminderService(
      cast<PrismaService>(
        withTx(
          {
            clientOnboardingIntake: h.intakes,
            clientWorkoutAssignment: h.assignments,
            workoutSession: h.sessions,
            workoutReminderDelivery: h.deliveries,
          },
          h.users,
        ).db,
      ),
      cast<NotificationsService>({
        getPreferences: async () => ({}),
        createNotification: jest.fn(),
        pushToUser: h.pushToUser,
      }),
    );
    const s = await other.runOnce(new Date('2026-10-07T16:00:00Z'));
    expect(s.already_sent).toBe(1);
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
  });

  it('then again on the next plan day, and never on non-plan days', async () => {
    const h = harness();
    await seed(h);
    await h.svc.runOnce(new Date('2026-10-05T14:00:00Z'));
    await h.svc.runOnce(new Date('2026-10-06T14:00:00Z')); // rest day
    await h.svc.runOnce(new Date('2026-10-07T14:00:00Z'));
    await h.svc.runOnce(new Date('2026-10-08T14:00:00Z')); // rest day
    expect(h.pushToUser).toHaveBeenCalledTimes(2);
    expect(h.deliveries.rows.map((r) => (r.local_date as Date).toISOString().slice(0, 10))).toEqual(
      ['2026-10-05', '2026-10-07'],
    );
  });

  it('C-609-4: outside the local send window no plan or workout-log query runs', async () => {
    const h = harness();
    await seed(h);
    const plan = jest.spyOn(h.assignments, 'findMany');
    const logs = jest.spyOn(h.sessions, 'findFirst');
    const out = await h.svc.runOnce(new Date('2026-10-07T20:00:00Z')); // 13:00 PDT, morning slot closed
    expect(out.not_due).toBe(1);
    expect(plan).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
    expect(h.pushToUser).not.toHaveBeenCalled();
    const inside = await h.svc.runOnce(new Date('2026-10-07T14:05:00Z')); // 07:05 PDT
    expect(inside.sent).toBe(1);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('skips the day when the assigned session is already completed', async () => {
    const h = harness();
    await seed(h);
    h.assignments.rows[1].completed_at = new Date('2026-10-07T13:00:00Z');
    const s = await h.svc.runOnce(new Date('2026-10-07T14:00:00Z'));
    expect(s.already_logged).toBe(1);
    expect(h.pushToUser).not.toHaveBeenCalled();
    expect(h.deliveries.rows).toHaveLength(0);
  });

  it('skips the day when a workout session was logged that date', async () => {
    const h = harness();
    await seed(h, 'evening');
    await h.sessions.create({ data: { user_id: CLIENT, date: new Date('2026-10-07T00:00:00Z') } });
    const s = await h.svc.runOnce(new Date('2026-10-08T00:30:00Z')); // 17:30 PDT on the 7th
    expect(s.already_logged).toBe(1);
    expect(h.pushToUser).not.toHaveBeenCalled();
  });

  it('opt-out: workout_reminder_push=false and workout_reminder_inapp=false sends nothing', async () => {
    const h = harness({ workout_reminder_push: false, workout_reminder_inapp: false, muted: false });
    await seed(h);
    const s = await h.svc.runOnce(new Date('2026-10-05T14:00:00Z'));
    expect(s.opted_out).toBe(1);
    expect(h.pushToUser).not.toHaveBeenCalled();
    expect(h.notifRows.rows).toHaveLength(0);
    expect(h.deliveries.rows).toHaveLength(0);
    expect(h.notifRows.rows).toHaveLength(0);
  });

  it('opt-out: global mute sends nothing', async () => {
    const h = harness({ muted: true });
    await seed(h);
    expect((await h.svc.runOnce(new Date('2026-10-05T14:00:00Z'))).opted_out).toBe(1);
  });

  it('default (no preferences row) is ON', async () => {
    const h = harness(null);
    await seed(h);
    expect((await h.svc.runOnce(new Date('2026-10-05T14:00:00Z'))).sent).toBe(1);
  });

  it('uses the client timezone from preferences (Tokyo 07:00 = 22:00 UTC the day before)', async () => {
    const h = harness({ timezone: 'Asia/Tokyo' });
    await seed(h);
    const s = await h.svc.runOnce(new Date('2026-10-06T22:00:00Z'));
    expect(s.sent).toBe(1);
    expect((h.deliveries.rows[0].local_date as Date).toISOString().slice(0, 10)).toBe('2026-10-07');
    expect(h.deliveries.rows[0].timezone).toBe('Asia/Tokyo');
  });

  it('DST: on the fall-back day 07:00 PST is 15:00 UTC', async () => {
    const h = harness();
    await seed(h);
    await h.assignments.create({
      data: {
        client_id: CLIENT,
        scheduled_for: new Date('2026-11-01T00:00:00Z'),
        completed_at: null,
      },
    });
    await h.svc.runOnce(new Date('2026-11-01T14:30:00Z'));
    expect(h.pushToUser).not.toHaveBeenCalled();
    await h.svc.runOnce(new Date('2026-11-01T15:00:00Z'));
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
  });

  it('deleted or deletion-scheduled clients are not reminded', async () => {
    const h = harness();
    await seed(h);
    h.users.rows[0].deletion_scheduled_at = new Date('2026-10-04T00:00:00Z');
    const s = await h.svc.runOnce(new Date('2026-10-05T14:00:00Z'));
    expect(s.considered).toBe(0);
    expect(h.pushToUser).not.toHaveBeenCalled();
  });

  it('a failed push is recorded and not retried the same day (at most one attempt per day)', async () => {
    const h = harness();
    await seed(h);
    h.pushToUser.mockResolvedValueOnce({ delivered: false, code: 'no-token' });
    await h.svc.runOnce(new Date('2026-10-05T14:00:00Z'));
    await h.svc.runOnce(new Date('2026-10-05T14:05:00Z'));
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
    // The in-app row still reached the client, so the day counts as sent.
    expect(h.notifRows.rows).toHaveLength(1);
    expect(h.deliveries.rows[0].status).toBe('sent');
  });

  it('a failed push with the in-app channel off is recorded as failed and not retried the same day', async () => {
    const h = harness({ workout_reminder_inapp: false });
    await seed(h);
    h.pushToUser.mockResolvedValueOnce({ delivered: false, code: 'no-token' });
    const s = await h.svc.runOnce(new Date('2026-10-05T14:00:00Z'));
    await h.svc.runOnce(new Date('2026-10-05T14:05:00Z'));
    expect(s.failed).toBe(1);
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
    expect(h.deliveries.rows[0].status).toBe('failed');
  });

  it('workout_reminder_inapp=false suppresses only the in-app row', async () => {
    const h = harness({ workout_reminder_inapp: false });
    await seed(h);
    await h.svc.runOnce(new Date('2026-10-05T14:00:00Z'));
    expect(h.notifRows.rows).toHaveLength(0);
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
  });
});

describe('WorkoutReminderService — dunning lockout and erasure (B-JOURNEY fix round)', () => {
  const C1_0700 = new Date('2026-10-05T14:00:00Z'); // 07:00 PDT on C1
  const prevDunning = process.env.FEATURE_DUNNING_V2;
  afterEach(() => {
    if (prevDunning === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = prevDunning;
  });

  async function lockOut(h: ReturnType<typeof harness>) {
    await h.purchases.create({
      data: { id: 'purchase-1', client_user_id: CLIENT, entitlement_active: false },
    });
    await h.dunning.create({
      data: { purchase_id: 'purchase-1', status: 'active', locked_out_at: new Date('2026-10-04') },
    });
  }

  it('Day-10 dunning lockout (FEATURE_DUNNING_V2 on): no reminder, no ledger row, so it can go out once the card is fixed', async () => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    const h = harness();
    await seed(h);
    await lockOut(h);
    const s = await h.svc.runOnce(C1_0700);
    expect(s.locked_out).toBe(1);
    expect(h.pushToUser).not.toHaveBeenCalled();
    expect(h.deliveries.rows).toHaveLength(0);
    // card updated: entitlement back on -> the same day's reminder goes out
    h.purchases.rows[0].entitlement_active = true;
    const s2 = await h.svc.runOnce(new Date('2026-10-05T14:05:00Z'));
    expect(s2.sent).toBe(1);
  });

  it('a lockout row is ignored while FEATURE_DUNNING_V2 is off (the guard is a no-op then)', async () => {
    delete process.env.FEATURE_DUNNING_V2;
    const h = harness();
    await seed(h);
    await lockOut(h);
    const s = await h.svc.runOnce(C1_0700);
    expect(s.sent).toBe(1);
  });

  it('an inactive or not-yet-locked dunning state does not block the reminder', async () => {
    process.env.FEATURE_DUNNING_V2 = 'true';
    const h = harness();
    await seed(h);
    await h.purchases.create({
      data: { id: 'purchase-1', client_user_id: CLIENT, entitlement_active: false },
    });
    await h.dunning.create({
      data: { purchase_id: 'purchase-1', status: 'active', locked_out_at: null },
    });
    expect((await h.svc.runOnce(C1_0700)).sent).toBe(1);
  });

  it('erasure: the reminder ledger of a tombstoned client is deleted on the next tick', async () => {
    const h = harness();
    await seed(h);
    await h.svc.runOnce(C1_0700);
    expect(h.deliveries.rows).toHaveLength(1);
    h.users.rows[0].deleted_at = new Date('2026-10-06T00:00:00Z');
    await h.svc.runOnce(new Date('2026-10-07T14:00:00Z'));
    expect(h.deliveries.rows).toHaveLength(0);
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
  });

  it('erasure: live clients keep their ledger', async () => {
    const h = harness();
    await seed(h);
    await h.svc.runOnce(C1_0700);
    expect(await h.svc.purgeErased()).toBe(0);
    expect(h.deliveries.rows).toHaveLength(1);
  });

  it('kill switch off (WORKOUT_REMINDERS_ENABLED=false): the cron still runs the erasure sweep and sends nothing', async () => {
    const h = harness();
    await seed(h);
    await h.svc.runOnce(C1_0700);
    expect(h.deliveries.rows).toHaveLength(1);
    h.users.rows[0].deleted_at = new Date('2026-10-06T00:00:00Z');
    const run = jest.spyOn(h.svc, 'runOnce');
    const prev = { env: process.env.NODE_ENV, flag: process.env.WORKOUT_REMINDERS_ENABLED };
    process.env.NODE_ENV = 'production';
    process.env.WORKOUT_REMINDERS_ENABLED = 'false';
    try {
      await h.svc.tick();
    } finally {
      process.env.NODE_ENV = prev.env;
      if (prev.flag === undefined) delete process.env.WORKOUT_REMINDERS_ENABLED;
      else process.env.WORKOUT_REMINDERS_ENABLED = prev.flag;
    }
    expect(h.deliveries.rows).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
  });

  it('a failed erasure sweep is logged and never blocks reminders', async () => {
    const h = harness();
    await seed(h);
    jest.spyOn(h.deliveries, 'deleteMany').mockRejectedValue(new Error('db unavailable'));
    expect(await h.svc.purgeErasedSafely()).toBe(0);
    expect((await h.svc.runOnce(C1_0700)).sent).toBe(1);
  });

  it('the cadence is fixed at every 5 minutes (no env override)', () => {
    expect(WORKOUT_REMINDER_CRON).toBe('*/5 * * * *');
  });
});

describe('WorkoutReminderService — channel independence (C-609-6)', () => {
  const C1_0700 = new Date('2026-10-05T14:00:00Z');

  it('push off, in-app on: the in-app row is written and no push goes out', async () => {
    const h = harness({ workout_reminder_push: false, workout_reminder_inapp: true, muted: false });
    await seed(h);
    const s = await h.svc.runOnce(C1_0700);
    expect(s.sent).toBe(1);
    expect(h.pushToUser).not.toHaveBeenCalled();
    expect(h.notifRows.rows).toHaveLength(1);
    expect(h.notifRows.rows[0]).toMatchObject({ kind: 'workout_reminder', channel: 'inapp' });
    expect(h.deliveries.rows[0]).toMatchObject({ status: 'sent' });
  });

  it('push on, in-app off: only the push goes out', async () => {
    const h = harness({ workout_reminder_push: true, workout_reminder_inapp: false });
    await seed(h);
    await h.svc.runOnce(C1_0700);
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
    expect(h.notifRows.rows).toHaveLength(0);
  });

  it('global mute wins over both channels', async () => {
    const h = harness({ muted: true, workout_reminder_push: true, workout_reminder_inapp: true });
    await seed(h);
    const s = await h.svc.runOnce(C1_0700);
    expect(s.opted_out).toBe(1);
    expect(h.pushToUser).not.toHaveBeenCalled();
    expect(h.notifRows.rows).toHaveLength(0);
  });
});

describe('WorkoutReminderService — send-time eligibility and the erasure path (B-609-4)', () => {
  const C1_0700 = new Date('2026-10-05T14:00:00Z');

  async function selectedThen(
    h: ReturnType<typeof harness>,
    change: Record<string, unknown>,
    at: Date = C1_0700,
  ) {
    // The page query selects the client, then the change commits before the
    // client is processed (deletion between selection and send).
    const realFindMany = h.intakes.findMany.bind(h.intakes);
    jest.spyOn(h.intakes, 'findMany').mockImplementationOnce(async (args) => {
      const page = await realFindMany(args);
      Object.assign(h.users.rows[0], change);
      return page;
    });
    return h.svc.runOnce(at);
  }

  it.each([
    ['deletion requested', { deletion_scheduled_at: new Date('2026-10-05T13:59:00Z') }],
    ['account tombstoned', { deleted_at: new Date('2026-10-05T13:59:00Z') }],
    ['no longer a client', { role: 'coach' }],
  ])('%s after page selection: no ledger row, no in-app row, no push', async (_label, change) => {
    const h = harness();
    await seed(h);
    const s = await selectedThen(h, change);
    expect(s.considered).toBe(1);
    expect(s.ineligible).toBe(1);
    expect(h.deliveries.rows).toHaveLength(0);
    expect(h.notifRows.rows).toHaveLength(0);
    expect(h.pushToUser).not.toHaveBeenCalled();
  });

  it('erasure overlap: a client tombstoned mid-tick gets no new ledger row, and the sweep then removes the old one', async () => {
    const h = harness();
    await seed(h);
    await h.svc.runOnce(C1_0700); // C1 reminder sent
    expect(h.deliveries.rows).toHaveLength(1);
    const day3 = new Date('2026-10-07T14:00:00Z');
    const s = await selectedThen(h, { deleted_at: new Date('2026-10-07T13:59:00Z') }, day3);
    expect(s.ineligible).toBe(1);
    expect(h.deliveries.rows).toHaveLength(1); // nothing recreated for day 3
    await h.svc.runOnce(new Date('2026-10-07T14:05:00Z'));
    expect(h.deliveries.rows).toHaveLength(0);
    expect(h.pushToUser).toHaveBeenCalledTimes(1);
  });

  it('a deletion request that commits after the claim and before the push stops the push (ledger cancelled)', async () => {
    const h = harness();
    await seed(h);
    h.hooks.afterCommit = () => {
      h.users.rows[0].deletion_scheduled_at = new Date('2026-10-05T14:00:01Z');
    };
    const s = await h.svc.runOnce(C1_0700);
    expect(s.ineligible).toBe(1);
    expect(h.pushToUser).not.toHaveBeenCalled();
    expect(h.deliveries.rows[0]).toMatchObject({ status: 'cancelled' });
  });

  it('the claim takes the FOR SHARE eligibility lock on the client row inside the transaction', async () => {
    const h = harness();
    await seed(h);
    await h.svc.runOnce(C1_0700);
    expect(h.locks).toHaveLength(1);
    const sql = h.locks[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('FROM "User"');
    expect(sql).toContain('"deleted_at" IS NULL');
    expect(sql).toContain('"deletion_scheduled_at" IS NULL');
    expect(sql).toContain(`"role" = 'student'`);
    expect(sql).toMatch(/FOR SHARE\s*$/);
    expect(h.locks[0].values).toEqual([CLIENT]);
  });
});
