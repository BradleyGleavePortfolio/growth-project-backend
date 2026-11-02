// FR-1192R3 (agent 190): own proofs for operator ruling R4 and the workout
// source. A failed source read is neither yes nor no: the row waits (no
// provider retry spent) and is asked again; a cap-held workout reminder goes
// only while its sender's own checks still say it is due.
import { Expo } from 'expo-server-sdk';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Dispatcher } from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { dunningCycleKey } from '../src/checkout/dunning-v2/dunning-v2.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
import {
  PushDeliveryService,
  USER_WINDOW_MAX,
  USER_WINDOW_MS,
} from '../src/notifications/push/push-delivery.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { TrialNoticeService } from '../src/packages/trials/trial-notice.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { makeTable, makeTrialNoticeTable, stub } from './utils/trial-fakes';
import { FakeTable, cast } from './engagement/_fake-db';
import { WorkoutReminderService } from '../src/engagement/workout-reminder.service';
import type { PrismaService } from '../src/prisma.service';

/** The next pass of the minute sweep (SOURCE_RECHECK_MS). */
const SOURCE_RECHECK_MS = 60_000;
const NIGHT = new Date('2026-10-06T06:00:00Z');
const MORNING = new Date('2026-10-06T15:00:00Z');
const ENTERED = new Date('2026-10-05T06:00:00Z');
const END = new Date('2026-10-08T06:00:00Z');
type Source = 'client reminder' | 'coach Day 7' | 'trial notice read' | 'trial purchase read';
const SOURCES: Source[] = ['client reminder', 'coach Day 7', 'trial notice read', 'trial purchase read'];

async function moneyRig(source: Source) {
  const clock = { at: NIGHT };
  const world = pushOutboxWorld({
    now: () => clock.at,
    prefs: {
      client: { muted: true, timezone: 'America/Los_Angeles', timezone_updated_at: NIGHT },
      coach: { muted: true, timezone: 'America/Los_Angeles', timezone_updated_at: NIGHT },
    },
    tokens: { client: 'client-device', coach: 'coach-device' },
  });
  const state = {
    id: 'cycle',
    status: 'active',
    locked_out_at: null,
    last_failure_reason: 'card_declined',
    client_canceled_at: null,
    entered_at: ENTERED,
  };
  const dunningRead = jest.fn(async () => ({ ...state }));
  const purchases = makeTable([['id']], () => ({}));
  purchases.rows.push({
    id: 'purchase', client_user_id: 'client', coach_user_id: 'coach',
    package_id: 'package', amount_cents: 4900, currency: 'usd',
    status: 'trialing', entitlement_active: true, trial_ends_at: END,
    card_on_file: true, cancel_at_period_end: false,
  });
  const purchase = purchases.rows[0] as Record<string, unknown>;
  const purchaseRead = jest.fn(async () => ({
    ...purchase,
    package: { name: 'Monthly', interval: 'month', interval_count: 1 },
    coach: { name: 'Coach' },
    client: { name: 'Client', email: null },
  }));
  const notices = makeTrialNoticeTable();
  const noticeRead = jest.fn(notices.findUnique);
  const db: Record<string, unknown> = {
    ...world.db,
    dunningState: { findUnique: dunningRead },
    packageTrialNotice: { ...notices, findUnique: noticeRead },
    clientPurchase: { findUnique: purchaseRead, findMany: purchases.findMany },
    connectCustomer: { findUnique: jest.fn(async () => ({ default_payment_method_id: 'card' })) },
  };
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const send = jest.fn(async (messages: unknown[]) =>
    messages.map((_message, i) => ({ status: 'ok' as const, id: `ticket-${i}` })),
  );
  class Clocked extends PushDeliveryService {
    protected now(): Date { return new Date(clock.at.getTime()); }
  }
  const delivery = new Clocked(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
    stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined, undefined, delivery,
  );
  if (source === 'client reminder' || source === 'coach Day 7') {
    const dispatcher = new DunningV2Dispatcher(
      new DunningEscalationClassifier(), new DunningV2Renderer(),
      stub<ConstructorParameters<typeof DunningV2Dispatcher>[2]>({
        attemptFailed: jest.fn(), notifySent: jest.fn(), coachNotified: jest.fn(),
      }),
      notifications, undefined, new CoachAlertEmitter(notifications),
    );
    await dispatcher.dispatchStepDetailed({
      dunningStateId: state.id, cycleKey: dunningCycleKey(ENTERED),
      stepIndex: source === 'coach Day 7' ? 3 : 1,
      isLateReversalCycle: false, clientUserId: 'client', coachUserId: 'coach',
      clientEmail: null, coachEmail: null,
      tokens: {
        firstName: 'Avery', clientName: 'Avery', coachName: 'Morgan',
        amount: 'USD 100.00', lockoutDate: 'October 15',
      },
      dunningDetailDeeplink: 'tgp://coach/clients/client',
    }, undefined, { channels: [source === 'coach Day 7' ? 'coach_push' : 'client_push'] });
  } else {
    await notices.createMany({
      data: [{
        id: 'notice', purchase_id: 'purchase', client_user_id: 'client',
        trial_ends_at: END, amount_cents: 4900, currency: 'usd',
        created_at: new Date(NIGHT.getTime() - 60_000),
      }],
      skipDuplicates: true,
    });
    const trial = new TrialNoticeService(
      stub<ConstructorParameters<typeof TrialNoticeService>[0]>(db), notifications,
    );
    await trial.deliver('notice', NIGHT);
  }
  expect(world.rows).toHaveLength(1);
  expect(world.rows[0]).toMatchObject({ status: 'pending', not_before: MORNING });
  expect(send).not.toHaveBeenCalled();
  const read = source === 'trial notice read'
    ? noticeRead
    : source === 'trial purchase read' ? purchaseRead : dunningRead;
  return {
    clock, world, send, delivery, read, state, purchase,
    end() {
      state.status = 'resolved';
      purchase.status = 'active';
    },
  };
}


const CLIENT = 'client-workout';
const LOCAL_DAY = '2026-10-07';
const NOW = new Date('2026-10-07T19:00:00Z'); // noon PDT, inside the midday slot
const C1 = '2026-10-05';

async function workoutRig() {
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
  const lockRead = jest.fn(async (): Promise<{ id: string } | null> => null);
  const db: Record<string, unknown> = {
    ...world.db,
    user: users,
    clientWorkoutAssignment: assignments,
    workoutSession: sessions,
    workoutReminderDelivery: deliveries,
    dunningState: { findFirst: lockRead },
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
  return { clock, world, users, assignments, sessions, delivery, send, service, lockRead, row };
}

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.FEATURE_DUNNING_V2;
});

describe('FR-1192R3: a money source read that fails twice in a row', () => {
  it.each(SOURCES)('%s: stays pending without spending an attempt, then sends once', async (source) => {
    const r = await moneyRig(source);
    r.clock.at = MORNING;
    r.read.mockRejectedValueOnce(new Error('timeout one')).mockRejectedValueOnce(new Error('timeout two'));
    await r.delivery.drain();
    expect(r.world.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'source_unread', attempts: 0 });
    r.clock.at = new Date(MORNING.getTime() + SOURCE_RECHECK_MS);
    await r.delivery.drain();
    expect(r.world.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'source_unread', attempts: 0 });
    expect(r.send).not.toHaveBeenCalled();
    r.clock.at = new Date(MORNING.getTime() + 2 * SOURCE_RECHECK_MS);
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
  });

  it.each(SOURCES)('%s: retires as obsolete once a read succeeds and says it ended', async (source) => {
    const r = await moneyRig(source);
    r.clock.at = MORNING;
    r.read.mockRejectedValueOnce(new Error('timeout one')).mockRejectedValueOnce(new Error('timeout two'));
    await r.delivery.drain();
    r.clock.at = new Date(MORNING.getTime() + SOURCE_RECHECK_MS);
    await r.delivery.drain();
    expect(r.world.rows[0].status).toBe('pending');
    r.end();
    r.clock.at = new Date(MORNING.getTime() + 2 * SOURCE_RECHECK_MS);
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0]).toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  });
});

describe('FR-1192R3: a cap-held workout reminder asks its sender again', () => {
  beforeEach(() => jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true));

  const AFTER_CAP = new Date(NOW.getTime() + USER_WINDOW_MS + 1);

  it('keeps its day and plan workout with it', async () => {
    const r = await workoutRig();
    expect(r.row?.context).toMatchObject({
      workoutReminder: { localDate: LOCAL_DAY, assignmentId: r.assignments.rows[0].id },
    });
  });

  it.each([
    ['the client is deleted', (r: Awaited<ReturnType<typeof workoutRig>>) => {
      r.users.rows[0].deletion_scheduled_at = NOW;
    }],
    ['the client is locked at Day 10', (r: Awaited<ReturnType<typeof workoutRig>>) => {
      process.env.FEATURE_DUNNING_V2 = 'true';
      r.lockRead.mockResolvedValue({ id: 'locked-cycle' });
    }],
    ['the workout is no longer assigned (skipped)', (r: Awaited<ReturnType<typeof workoutRig>>) => {
      r.assignments.rows[0].skipped_at = NOW;
    }],
    ['the workout is no longer assigned (moved to another day)', (r: Awaited<ReturnType<typeof workoutRig>>) => {
      r.assignments.rows[0].scheduled_for = new Date('2026-10-09T00:00:00Z');
    }],
    ['the workout is no longer assigned (removed)', (r: Awaited<ReturnType<typeof workoutRig>>) => {
      r.assignments.rows.splice(0, 1);
    }],
  ])('%s: not sent after the cap', async (_label, change) => {
    const r = await workoutRig();
    change(r);
    r.clock.at = AFTER_CAP;
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows.find((row) => row.kind === 'workout_reminder'))
      .toMatchObject({ status: 'dropped', result_code: 'obsolete' });
  });

  it('a failed workout source read waits, then the still-due reminder sends once', async () => {
    const r = await workoutRig();
    r.clock.at = AFTER_CAP;
    jest.spyOn(r.assignments, 'findMany').mockRejectedValueOnce(new Error('timeout'));
    await r.delivery.drain();
    const held = r.world.rows.find((row) => row.kind === 'workout_reminder');
    expect(held).toMatchObject({ status: 'pending', deferred_reason: 'source_unread' });
    expect(r.send).not.toHaveBeenCalled();
    r.clock.at = new Date(AFTER_CAP.getTime() + SOURCE_RECHECK_MS);
    await r.delivery.drain();
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(held?.status).toBe('sent');
  });
});
