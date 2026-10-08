/**
 * S-SCHED-2: booking reminders through the real push transport.
 *
 * Runs SessionReminderJob with the real BookingEmitter (so the push call,
 * payload and wording are the production ones) over the scheduling Prisma
 * double. Asserts the 24h / 1h window edges, eligible statuses, per-side
 * wording and tap routing, the missing-link prompt, idempotency across
 * sweeps, re-arming after a reschedule, and the explicit launch switch.
 */
import { AuditService } from '../src/audit/audit.service';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  NotificationsService,
  type CreateNotificationInput,
} from '../src/notifications/notifications.service';
import { SessionReminderJob } from '../src/scheduling/jobs/reminder.job';
import { GoogleCalendarAdapter } from '../src/scheduling/providers/google-calendar.adapter';
import { GoogleMeetAdapter } from '../src/scheduling/providers/google-meet.adapter';
import { SchedulingProviderRegistry } from '../src/scheduling/providers/scheduling-provider.registry';
import { StubCalendarAdapter } from '../src/scheduling/providers/stub-calendar.adapter';
import { StubVideoAdapter } from '../src/scheduling/providers/stub-video.adapter';
import { ZoomVideoAdapter } from '../src/scheduling/providers/zoom-video.adapter';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import type { ActorContext } from '../src/scheduling/scheduling.types';
import { SchedulingFakeDb, asPrisma } from './utils/scheduling-fake-db';
import {
  QUEUED,
  recordPush,
  type RecordedPush,
  type SendPushInput,
} from './utils/booking-push-fake';

const NOW = new Date('2026-10-05T15:00:00.000Z');
const MIN = 60_000;

class FakeNotifications {
  rows: CreateNotificationInput[] = [];
  pushes: RecordedPush[] = [];
  createNotification = jest.fn(async (input: CreateNotificationInput) => {
    this.rows.push(input);
    return { id: `notif-${this.rows.length}` };
  });
  getPreferences = jest.fn(async (userId: string) => ({
    user_id: userId,
    timezone: 'America/Los_Angeles',
    booking_push: true,
    muted: false,
  }));
  // B-SCHED2-121: the push stack's one sender; records the stored lock-screen copy.
  sendPush = jest.fn(async (input: SendPushInput) => {
    recordPush(this.pushes, input);
    return QUEUED;
  });
}

function build() {
  const db = new SchedulingFakeDb();
  db.addUser({ id: 'coach-1', name: 'Coach Kim', role: 'coach' });
  db.addUser({ id: 'client-1', name: 'Jamie', role: 'student', coach_id: 'coach-1' });
  db.addSessionType({
    id: 'st-q',
    coach_id: 'coach-1',
    name: 'Quick Q/A Call',
    duration_minutes: 30,
    auto_approve: true,
  });
  for (let d = 0; d <= 6; d++) db.addWindow('coach-1', d, 0, 24 * 60);
  const fake = new FakeNotifications();
  const prisma = asPrisma(db);
  const emitter = new BookingEmitter(
    Object.assign(Object.create(NotificationsService.prototype) as NotificationsService, fake),
    prisma,
  );
  const job = new SessionReminderJob(prisma, emitter);
  const audit = Object.assign(Object.create(AuditService.prototype) as AuditService, {
    write: jest.fn(async () => undefined),
  });
  const registry = new SchedulingProviderRegistry(
    new StubCalendarAdapter(),
    new GoogleCalendarAdapter(),
    new StubVideoAdapter(),
    new GoogleMeetAdapter(),
    new ZoomVideoAdapter(),
  );
  const svc = new SchedulingService(prisma, audit, registry, emitter);
  return { db, fake, job, svc };
}

function addSession(
  db: SchedulingFakeDb,
  id: string,
  startsInMinutes: number,
  status = 'scheduled',
  videoUrl: string | null = 'https://meet.example.com/kim',
) {
  const start = new Date(NOW.getTime() + startsInMinutes * MIN);
  return db.addSession({
    id,
    coach_id: 'coach-1',
    client_id: 'client-1',
    session_type_id: 'st-q',
    status,
    start_at: start,
    end_at: new Date(start.getTime() + 30 * MIN),
    video_url: videoUrl,
  });
}

const COACH: ActorContext = { id: 'coach-1', role: 'coach', email: null, coach_id: null };

const ORIGINAL_SWITCH = process.env.BOOKING_REMINDERS_ENABLED;

// Drive the real cron handlers (their real dispatch closures) with the
// launch switch on.
async function sweep24h(job: SessionReminderJob): Promise<void> {
  process.env.BOOKING_REMINDERS_ENABLED = 'on';
  await job.runTwentyFourHourReminderSweep();
}

async function sweep1h(job: SessionReminderJob): Promise<void> {
  process.env.BOOKING_REMINDERS_ENABLED = 'on';
  await job.runOneHourReminderSweep();
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
  if (ORIGINAL_SWITCH === undefined) delete process.env.BOOKING_REMINDERS_ENABLED;
  else process.env.BOOKING_REMINDERS_ENABLED = ORIGINAL_SWITCH;
});

describe('24h reminder', () => {
  it.each([
    [23 * 60 + 44, 0],
    [23 * 60 + 45, 2],
    [24 * 60, 2],
    [24 * 60 + 15, 2],
    [24 * 60 + 16, 0],
  ])('session starting in %i minutes -> %i deliveries', async (minutes, expected) => {
    const { db, fake, job } = build();
    addSession(db, 's1', minutes);
    await sweep24h(job);
    expect(fake.pushes).toHaveLength(expected);
  });

  it('pushes both sides with their own wording and tap target', async () => {
    const { db, fake, job } = build();
    addSession(db, 's1', 24 * 60);
    await sweep24h(job);
    const byUser = Object.fromEntries(fake.pushes.map((p) => [p.userId, p]));
    // B-714-1: the lock screen keeps the time and drops the name and type;
    // the tap target is set by the sender from the session (pushTapData).
    expect(byUser['client-1']).toMatchObject({
      title: 'Session reminder',
      body: 'Your session is tomorrow at 8:00 AM PDT.',
      dedupeKey: `${NotificationKind.BOOKING_REMINDER_24H}:s1:${byUser['client-1'].context?.scheduledAt}`,
      data: { kind: NotificationKind.BOOKING_REMINDER_24H, sessionId: 's1' },
    });
    expect(byUser['coach-1']).toMatchObject({
      body: 'Your session is tomorrow at 8:00 AM PDT.',
      data: { sessionId: 's1' },
    });
    expect(fake.rows.map((r) => r.payload?.actionScreen).sort()).toEqual([
      'CalendarSession',
      'CoachBookingInbox',
    ]);
    expect(fake.rows.map((r) => r.channel)).toEqual(['inapp', 'inapp']);
  });

  it('missing call link: the coach is asked to add one, the client sees its current status', async () => {
    const { db, fake, job } = build();
    addSession(db, 's1', 24 * 60, 'pending_provider', null);
    await sweep24h(job);
    // The call-link detail lives in the inbox row (B-714-1: not on the lock screen).
    const coach = fake.rows.find((r) => r.user_id === 'coach-1');
    const client = fake.rows.find((r) => r.user_id === 'client-1');
    expect(coach?.body).toContain('It has no call link yet. Add one so they can join.');
    expect(client?.body).toContain('It has no call link yet.');
    expect(client?.body).not.toContain('will add');
  });
});

describe('1h reminder', () => {
  it.each([
    [54, 0],
    [55, 2],
    [60, 2],
    [65, 2],
    [66, 0],
  ])('session starting in %i minutes -> %i deliveries', async (minutes, expected) => {
    const { db, fake, job } = build();
    addSession(db, 's1', minutes);
    await sweep1h(job);
    expect(fake.pushes).toHaveLength(expected);
    if (expected > 0) expect(fake.pushes[0].title).toBe('Session starting soon');
  });

  it('only confirmed sessions are reminded', async () => {
    const { db, fake, job } = build();
    for (const [i, status] of [
      'requested',
      'declined',
      'canceled',
      'completed',
      'no_show',
    ].entries()) {
      addSession(db, `x${i}`, 60, status);
    }
    addSession(db, 'ok', 60, 'pending_provider');
    await sweep1h(job);
    expect(fake.pushes).toHaveLength(2);
    expect(fake.pushes.map((p) => p.data.sessionId)).toEqual(['ok', 'ok']);
  });

  it('is idempotent across sweeps and replicas', async () => {
    const { db, fake, job } = build();
    addSession(db, 's1', 60);
    await Promise.all([sweep1h(job), sweep1h(job)]);
    await sweep1h(job);
    expect(fake.pushes).toHaveLength(2);
    expect(db.deliveryLogs).toHaveLength(2);
  });
});

describe('re-arming after a move', () => {
  it('a reminder already sent for the old time is sent again for the new time', async () => {
    const { db, fake, job, svc } = build();
    addSession(db, 's1', 24 * 60);
    await sweep24h(job);
    expect(fake.pushes).toHaveLength(2);
    const start = new Date(NOW.getTime() + (24 * 60 + 10) * MIN);
    await svc.rescheduleSession(COACH, 's1', {
      start_at: start.toISOString(),
      end_at: new Date(start.getTime() + 30 * MIN).toISOString(),
    });
    fake.pushes = [];
    await sweep24h(job);
    expect(fake.pushes.map((p) => p.userId).sort()).toEqual(['client-1', 'coach-1']);
  });
});

describe('explicit launch switch BOOKING_REMINDERS_ENABLED', () => {
  it.each([undefined, '', 'off', 'true', 'ON'])('%s: no sweep, no push', async (value) => {
    if (value === undefined) delete process.env.BOOKING_REMINDERS_ENABLED;
    else process.env.BOOKING_REMINDERS_ENABLED = value;
    const { db, fake, job } = build();
    addSession(db, 'one-hour', 60);
    addSession(db, 'one-day', 24 * 60);
    await job.runOneHourReminderSweep();
    await job.runTwentyFourHourReminderSweep();
    expect(fake.pushes).toHaveLength(0);
  });

  it('on: both sweeps push', async () => {
    process.env.BOOKING_REMINDERS_ENABLED = 'on';
    const { db, fake, job } = build();
    addSession(db, 'one-hour', 60);
    addSession(db, 'one-day', 24 * 60);
    await job.runOneHourReminderSweep();
    await job.runTwentyFourHourReminderSweep();
    expect(fake.pushes).toHaveLength(4);
  });
});
