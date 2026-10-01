import { WorkoutReminderService } from '../../src/engagement/workout-reminder.service';
import { FIRST_DAY_BODY, REMINDER_TITLE } from '../../src/engagement/workout-reminder.policy';
import { NotificationsService } from '../../src/notifications/notifications.service';
import type { PrismaService } from '../../src/prisma.service';
import { cast, FakeTable } from './_fake-db';

// C05 item 7 — workout reminders: once per local day, skip if logged,
// client opt-out, client-local timezone.

const CLIENT = 'client-1';
const C1 = '2026-10-05';

function harness(prefs: Record<string, unknown> | null = null) {
  const users = new FakeTable([['id']]);
  const intakes = new FakeTable([['client_id']]);
  const assignments = new FakeTable();
  const sessions = new FakeTable();
  const deliveries = new FakeTable([['client_id', 'local_date']]);
  const notifRows = new FakeTable();
  const prefRows = new FakeTable([['user_id']]);
  intakes.relations.client = (row, f) => {
    const u = users.rows.find((x) => x.id === row.client_id);
    const filter = f as { deleted_at?: null; deletion_scheduled_at?: null; role?: string };
    return !!u && !u.deleted_at && !u.deletion_scheduled_at && u.role === filter.role;
  };
  const prisma = {
    user: users,
    clientOnboardingIntake: intakes,
    clientWorkoutAssignment: assignments,
    workoutSession: sessions,
    workoutReminderDelivery: deliveries,
    notification: notifRows,
    notificationPreferences: prefRows,
  };
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
    pushToUser,
    svc,
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
      cast<PrismaService>({
        clientOnboardingIntake: h.intakes,
        clientWorkoutAssignment: h.assignments,
        workoutSession: h.sessions,
        workoutReminderDelivery: h.deliveries,
      }),
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

  it('opt-out: workout_reminder_push=false sends nothing', async () => {
    const h = harness({ workout_reminder_push: false, workout_reminder_inapp: true, muted: false });
    await seed(h);
    const s = await h.svc.runOnce(new Date('2026-10-05T14:00:00Z'));
    expect(s.opted_out).toBe(1);
    expect(h.pushToUser).not.toHaveBeenCalled();
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
