import { Expo } from 'expo-server-sdk';
import { WorkoutReminderService } from '../src/engagement/workout-reminder.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import {
  PushDeliveryService,
  USER_WINDOW_MAX,
  USER_WINDOW_MS,
} from '../src/notifications/push/push-delivery.service';
import type { PrismaService } from '../src/prisma.service';
import { FakeTable, cast } from './engagement/_fake-db';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const CLIENT = 'client-workout';
const LOCAL_DAY = '2026-10-07';
const NOW = new Date('2026-10-07T19:00:00Z'); // noon PDT, inside the midday slot
const C1 = '2026-10-05';

async function rig() {
  const clock = { at: NOW };
  const world = pushOutboxWorld({
    now: () => clock.at,
    tokens: { [CLIENT]: 'ExponentPushToken[workout-proof]' },
    prefs: {
      [CLIENT]: {
        timezone: 'America/Los_Angeles',
        timezone_updated_at: NOW,
        muted: false,
        workout_reminder_push: true,
        workout_reminder_inapp: false,
      },
    },
  });
  const users = new FakeTable([['id']]);
  const assignments = new FakeTable();
  const sessions = new FakeTable();
  const deliveries = new FakeTable([['client_id', 'local_date']]);
  await users.create({
    data: {
      id: CLIENT, role: 'student', deleted_at: null, deletion_scheduled_at: null,
      expo_push_token: world.tokens[CLIENT],
    },
  });
  await assignments.create({
    data: {
      client_id: CLIENT,
      scheduled_for: new Date(`${LOCAL_DAY}T00:00:00Z`),
      completed_at: null,
    },
  });
  const db: Record<string, unknown> = {
    ...world.db,
    user: users,
    clientWorkoutAssignment: assignments,
    workoutSession: sessions,
    workoutReminderDelivery: deliveries,
    dunningState: { findFirst: jest.fn(async () => null) },
    notification: new FakeTable(),
  };
  db.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join('').includes('FOR SHARE')) {
      return users.findMany({
        where: { id: values[0], role: 'student', deleted_at: null, deletion_scheduled_at: null },
      });
    }
    return Reflect.apply(world.db.$queryRaw, world.db, [strings, ...values]);
  };
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  class Clocked extends PushDeliveryService {
    protected now(): Date { return clock.at; }
  }
  const send = jest.fn(async (messages: unknown[]) =>
    messages.map((_m, i) => ({ status: 'ok', id: `workout-ticket-${i}` })));
  const delivery = new Clocked(cast<PrismaService>(db), stub<ExpoPushClient>({
    send, getReceipts: jest.fn(async () => ({})),
  }));
  delivery.autoDrain = false;
  const notifications = new NotificationsService(cast<PrismaService>(db), undefined, undefined, delivery);
  const service = new WorkoutReminderService(cast<PrismaService>(db), notifications);

  // A real busy-device window, not a mocked cap result: all eight preceding
  // booking notifications pass through enqueue, claim, handoff and transport.
  for (let i = 0; i < USER_WINDOW_MAX; i += 1) {
    await notifications.pushToUser(CLIENT, 'Booking update', 'Your appointment changed.', {
      kind: 'booking_created', deep_link: `tgp://sessions/booking-${i}`,
    }, undefined, { kind: 'booking_created', dedupeKey: `booking-proof:${i}` });
  }
  await delivery.drain();
  expect(world.rows.filter((r) => r.status === 'sent')).toHaveLength(USER_WINDOW_MAX);
  send.mockClear();
  expect(await service.processClient(CLIENT, C1, 'midday', clock.at)).toBe('sent');
  await delivery.drain();
  const row = world.rows.find((r) => r.kind === 'workout_reminder');
  expect(row).toMatchObject({ status: 'pending', deferred_reason: 'burst_cap' });
  expect(send).not.toHaveBeenCalled();
  return { clock, world, assignments, sessions, delivery, send, service };
}

describe('LS-1192R3: workout source eligibility after a burst-cap wait', () => {
  beforeEach(() => jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true));
  afterEach(() => jest.restoreAllMocks());

  it.each(['assignment completed', 'workout logged'] as const)(
    '%s: a cap-held reminder is not sent after the workout is already done',
    async (change) => {
      const r = await rig();
      r.clock.at = new Date(NOW.getTime() + 2 * 60_000);
      if (change === 'assignment completed') {
        r.assignments.rows[0].completed_at = r.clock.at;
      } else {
        await r.sessions.create({ data: {
          user_id: CLIENT, date: new Date(`${LOCAL_DAY}T00:00:00Z`),
        } });
      }
      // The real sender now says this reminder must not go. Its deferred row
      // must apply that same predicate, rather than merely keeping old copy.
      expect(await r.service.processClient(CLIENT, C1, 'midday', r.clock.at)).toBe('already_logged');
      r.clock.at = new Date(NOW.getTime() + USER_WINDOW_MS + 1);
      await r.delivery.drain();
      expect(r.send).not.toHaveBeenCalled();
      expect(r.world.rows.find((row) => row.kind === 'workout_reminder'))
        .toMatchObject({ status: 'dropped', result_code: 'obsolete' });
    },
  );

  it('still-due control: the same cap-held reminder sends once after capacity returns', async () => {
    const r = await rig();
    r.clock.at = new Date(NOW.getTime() + USER_WINDOW_MS + 1);
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.world.rows.find((row) => row.kind === 'workout_reminder')).toMatchObject({ status: 'sent' });
  });
});
