/**
 * B-643-1: booking reminders, end to end through the real reminder job, the
 * real BookingEmitter and the real NotificationsService over an in-memory
 * Prisma fake.
 *
 *   - the time is written in the recipient's own zone, with the zone named,
 *     and never in UTC;
 *   - with no usable stored zone the copy has no clock time at all;
 *   - each reminder is exactly one inbox item and one unread, also when the
 *     sweep runs again or on two machines at once.
 *
 * Before the fix, the body read "tomorrow at 00:30 UTC" and every reminder
 * was two inbox items (an inapp row plus a push row) and two unread.
 */

import { SessionReminderJob } from '../src/scheduling/jobs/reminder.job';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import type { PrismaService } from '../src/prisma.service';

interface Row {
  id: string;
  user_id: string;
  kind: string;
  body: string;
  channel: string;
  payload: Record<string, unknown> | undefined;
  read_at: Date | null;
  created_at: Date;
}

const NOW = new Date('2026-06-02T00:30:00Z'); // Jun 1, 5:30 PM in Los Angeles
const START = new Date('2026-06-03T00:30:00Z'); // Jun 2, 5:30 PM PDT / 8:30 PM EDT

function buildWorld(opts: {
  prefsZones?: Record<string, string>;
  coachProfileZones?: Record<string, string | null>;
}) {
  const rows: Row[] = [];
  const claims: Array<{ session_id: string; user_id: string; kind: string }> = [];
  const session = {
    id: 'sess-1',
    coach_id: 'coach-1',
    client_id: 'client-1',
    status: 'scheduled',
    start_at: START,
    end_at: new Date(START.getTime() + 30 * 60_000),
  };
  const names: Record<string, string> = { 'coach-1': 'Coach K', 'client-1': 'Jamie' };
  const prisma = {
    coachingSession: {
      findMany: jest.fn(async ({ where }: { where: { start_at: { gte: Date; lte: Date } } }) =>
        session.start_at >= where.start_at.gte && session.start_at <= where.start_at.lte
          ? [session]
          : [],
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === session.id ? { coach_id: session.coach_id } : null,
      ),
    },
    notificationDeliveryLog: {
      create: jest.fn(
        async ({ data }: { data: { session_id: string; user_id: string; kind: string } }) => {
          if (
            claims.some(
              (c) =>
                c.session_id === data.session_id &&
                c.user_id === data.user_id &&
                c.kind === data.kind,
            )
          ) {
            throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          }
          claims.push(data);
          return { id: `claim-${claims.length}` };
        },
      ),
    },
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        names[where.id] ? { name: names[where.id] } : null,
      ),
    },
    notificationPreferences: {
      findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) => {
        const tz = opts.prefsZones?.[where.user_id];
        return tz === undefined ? null : { user_id: where.user_id, timezone: tz, muted: false };
      }),
    },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) => {
        const zones = opts.coachProfileZones ?? {};
        return where.user_id in zones ? { timezone: zones[where.user_id] } : null;
      }),
    },
    notification: {
      create: jest.fn(async ({ data }: { data: Omit<Row, 'id' | 'read_at' | 'created_at'> }) => {
        const row: Row = {
          ...data,
          id: `n-${rows.length + 1}`,
          read_at: null,
          created_at: new Date(),
        };
        rows.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: { where: { user_id: string; read_at?: null } }) =>
        rows.filter(
          (r) => r.user_id === where.user_id && (where.read_at !== null || r.read_at === null),
        ),
      ),
      findUnique: jest.fn(async () => null),
      count: jest.fn(
        async ({ where }: { where: { user_id: string; read_at?: null } }) =>
          rows.filter((r) => r.user_id === where.user_id && r.read_at === null).length,
      ),
    },
  };
  const db: PrismaService = Object.create(prisma);
  const notifications = new NotificationsService(db);
  const emitter = new BookingEmitter(notifications, db);
  const job = new SessionReminderJob(db, emitter);
  return { job, notifications, rows };
}

const ORIGINAL_FLAG = process.env.BOOKING_REMINDERS_ENABLED;

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  process.env.BOOKING_REMINDERS_ENABLED = 'on';
});

afterEach(() => {
  jest.useRealTimers();
  if (ORIGINAL_FLAG === undefined) delete process.env.BOOKING_REMINDERS_ENABLED;
  else process.env.BOOKING_REMINDERS_ENABLED = ORIGINAL_FLAG;
});

describe('booking reminders: local time, shown once (B-643-1)', () => {
  it('writes the 24 h reminder in each recipient’s own zone, never UTC', async () => {
    const w = buildWorld({
      prefsZones: { 'client-1': 'America/Los_Angeles' },
      // The coach has no preferences row; their CoachProfile zone applies.
      coachProfileZones: { 'coach-1': 'America/New_York' },
    });
    await w.job.runTwentyFourHourReminderSweep();

    const client = await w.notifications.listNotifications('client-1', {});
    const coach = await w.notifications.listNotifications('coach-1', {});
    expect(client.items.map((r) => r.body)).toEqual([
      'Reminder: your session with Coach K is tomorrow at 5:30 PM PDT.',
    ]);
    expect(coach.items.map((r) => r.body)).toEqual([
      'Reminder: your session with Jamie is tomorrow at 8:30 PM EDT.',
    ]);
    for (const r of w.rows) {
      expect(r.body).not.toMatch(/UTC|GMT/);
      expect(r.kind).toBe(NotificationKind.BOOKING_REMINDER_24H);
    }
    expect(client.items[0].payload).toMatchObject({
      scheduledAt: START.toISOString(),
      timeZone: 'America/Los_Angeles',
    });
  });

  it('the 1 h reminder names the local clock time', async () => {
    jest.setSystemTime(new Date(START.getTime() - 60 * 60_000));
    const w = buildWorld({
      prefsZones: { 'client-1': 'America/Los_Angeles', 'coach-1': 'America/Los_Angeles' },
    });
    await w.job.runOneHourReminderSweep();
    const client = await w.notifications.listNotifications('client-1', {});
    expect(client.items.map((r) => r.body)).toEqual([
      'Starting soon: your session with Coach K is at 5:30 PM PDT.',
    ]);
  });

  it('a client without a stored zone gets the booking’s zone (the coach’s)', async () => {
    const w = buildWorld({ coachProfileZones: { 'coach-1': 'America/Chicago' } });
    await w.job.runTwentyFourHourReminderSweep();
    const client = await w.notifications.listNotifications('client-1', {});
    expect(client.items.map((r) => r.body)).toEqual([
      'Reminder: your session with Coach K is tomorrow at 7:30 PM CDT.',
    ]);
  });

  it('with no usable zone (none stored, or a stored UTC fallback) the copy has no clock time', async () => {
    const w = buildWorld({ prefsZones: { 'client-1': 'UTC', 'coach-1': 'Etc/UTC' } });
    await w.job.runTwentyFourHourReminderSweep();
    const bodies = w.rows.map((r) => r.body).sort();
    expect(bodies).toEqual([
      'Reminder: your session with Coach K is in about 24 hours.',
      'Reminder: your session with Jamie is in about 24 hours.',
    ]);
  });

  it('each reminder is exactly one inbox item and one unread, across re-runs and two machines', async () => {
    // Ten minutes later than the other cases (still inside the 24 h window),
    // so NotificationsService's per-process 60 s push throttle, primed by the
    // earlier cases, cannot hide a duplicate row.
    jest.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    const w = buildWorld({
      prefsZones: { 'client-1': 'America/Los_Angeles', 'coach-1': 'America/Los_Angeles' },
    });
    // Two machines tick at the same moment, then the next tick runs again.
    await Promise.all([
      w.job.runTwentyFourHourReminderSweep(),
      w.job.runTwentyFourHourReminderSweep(),
    ]);
    await w.job.runTwentyFourHourReminderSweep();

    for (const user of ['client-1', 'coach-1']) {
      const page = await w.notifications.listNotifications(user, {});
      expect([user, page.items.length, page.unreadCount]).toEqual([user, 1, 1]);
      expect([user, await w.notifications.getUnreadCount(user)]).toEqual([user, 1]);
    }
    expect(w.rows.every((r) => r.channel === 'inapp')).toBe(true);
  });
});
