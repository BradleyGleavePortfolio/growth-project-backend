/**
 * B-714-1 / B-653-1 (B-SCHED2-121): a booking push never puts a display name
 * or coach-written text on the lock screen, and every booking push goes
 * through the push stack's one sender (NotificationsService.sendPush). Every
 * BookingEmitter method is driven with canary names, a canary session type
 * name and canary notes and reasons. Two layers: (1) through the REAL
 * NotificationsService.sendPush and PushDeliveryService.enqueue into outbox
 * rows (what the worker sends); (2) the sendPush input itself (context holds
 * ids, instants and the zone only; one exactly-once key per event). The
 * in-app row keeps the full detail.
 */
import { Logger } from '@nestjs/common';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import {
  NotificationsService,
  type CreateNotificationInput,
} from '../src/notifications/notifications.service';
import { lockScreenCopy } from '../src/notifications/push/lock-screen-copy';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { PrismaService } from '../src/prisma.service';
import {
  QUEUED,
  recordPush,
  type RecordedPush,
  type SendPushInput,
} from './utils/booking-push-fake';
import { pushOutboxWorld } from './utils/push-outbox-fake';

const NAME = 'Jamie Canary-Person';
const TYPE = 'Canary Type Name';
const NOTE = 'canary private note';
const AT = new Date('2026-10-06T17:00:00Z'); // Tue Oct 6, 10:00 AM PDT
const LATER = new Date('2026-10-07T18:30:00Z');
const NOW = new Date('2026-10-05T16:00:00Z'); // Mon Oct 5, 9:00 AM PDT
const LA = 'America/Los_Angeles';
const CANARIES = [NAME, TYPE, NOTE, 'Jamie', 'Canary'];

class Clocked extends PushDeliveryService {
  protected now(): Date {
    return new Date(NOW);
  }
}

beforeAll(() => {
  for (const level of ['warn', 'error', 'log'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
  // Pin only the Date clock to NOW: the copy builder's "today/tomorrow" falls back to the real clock, so this spec
  // started failing once the real date reached AT. Timers, microtasks and nextTick stay real.
  jest.useFakeTimers({
    now: NOW,
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
});

afterAll(() => {
  jest.useRealTimers();
});

/** The real sender: NotificationsService.sendPush -> PushDeliveryService.enqueue -> outbox rows. */
function realSender(timeZone: string | null = LA) {
  const zone = timeZone
    ? { timezone: timeZone, timezone_updated_at: new Date('2026-09-01T00:00:00Z') }
    : {};
  const w = pushOutboxWorld({
    now: () => NOW,
    tokens: {
      client: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
      coach: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]',
    },
    prefs: { client: { muted: false, ...zone }, coach: { muted: false, ...zone } },
  });
  const rows: CreateNotificationInput[] = [];
  const db = {
    ...w.db,
    notification: {
      create: jest.fn(async ({ data }: { data: CreateNotificationInput }) => {
        rows.push(data);
        return { id: `n-${rows.length}`, ...data };
      }),
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
    },
    coachingSession: {
      findUnique: jest.fn(async () => ({
        client_id: 'client',
        coach_id: 'coach',
        status: 'requested',
      })),
    },
    coachProfile: { findUnique: jest.fn(async () => null) },
  };
  const send = jest.fn(async (_messages: Array<{ title?: string; body?: string }>) => []);
  const delivery = new Clocked(Object.create(db), {
    send,
    getReceipts: jest.fn(async () => ({})),
  });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(Object.create(db), undefined, undefined, delivery);
  const legacy = jest.spyOn(notifications, 'pushToUser');
  const emitter = new BookingEmitter(notifications, Object.create(db) as PrismaService);
  return { emitter, outbox: w.rows, rows, legacy, delivery, send };
}

/** A sendPush fake that records the input and the copy the real sender stores. */
function fakeSender() {
  const rows: CreateNotificationInput[] = [];
  const pushes: RecordedPush[] = [];
  const inputs: SendPushInput[] = [];
  const fake = {
    createNotification: jest.fn(async (input: CreateNotificationInput) => {
      rows.push(input);
      return { id: `n-${rows.length}` };
    }),
    getPreferences: jest.fn(async (user_id: string) => ({
      user_id,
      booking_push: true,
      muted: false,
    })),
    sendPush: jest.fn(async (input: SendPushInput) => {
      inputs.push(input);
      recordPush(pushes, input, NOW);
      return QUEUED;
    }),
    pushToUser: jest.fn(),
  };
  const prisma = Object.assign(Object.create(PrismaService.prototype) as PrismaService, {
    notificationPreferences: {
      findUnique: async () => ({
        timezone: LA,
        timezone_source: 'device',
        timezone_updated_at: new Date('2026-09-01T00:00:00Z'),
      }),
    },
    coachProfile: { findUnique: async () => null },
    coachingSession: { findUnique: async () => null },
    user: { findUnique: async () => null },
  });
  const emitter = new BookingEmitter(
    Object.assign(Object.create(NotificationsService.prototype) as NotificationsService, fake),
    prisma,
  );
  return { emitter, rows, pushes, inputs, fake };
}

async function emitAll(emitter: BookingEmitter): Promise<void> {
  const base = { sessionId: 's-1', sessionTypeName: TYPE };
  await emitter.emitRequested({
    ...base,
    coachUserId: 'coach',
    clientDisplayName: NAME,
    requestedAt: AT,
    scheduledAt: AT,
    notes: NOTE,
  });
  await emitter.emitBooked({
    ...base,
    coachUserId: 'coach',
    clientDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitConfirmed({
    ...base,
    clientUserId: 'client',
    coachDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitConfirmed({
    ...base,
    sessionId: 's-2',
    clientUserId: 'client',
    coachDisplayName: NAME,
    scheduledAt: AT,
    instant: true,
  });
  await emitter.emitDeclined({
    ...base,
    clientUserId: 'client',
    coachDisplayName: NAME,
    requestedAt: AT,
    scheduledAt: AT,
    declineReason: NOTE,
  });
  await emitter.emitCancelled({
    ...base,
    recipientUserId: 'client',
    recipientRole: 'client',
    cancellingPartyDisplayName: NAME,
    scheduledAt: AT,
    cancelReason: NOTE,
  });
  await emitter.emitRescheduled({
    ...base,
    recipientUserId: 'coach',
    recipientRole: 'coach',
    reschedulerDisplayName: NAME,
    oldScheduledAt: AT,
    newScheduledAt: LATER,
  });
  await emitter.emitMoveRequested({
    ...base,
    sessionId: 's-3',
    coachUserId: 'coach',
    clientDisplayName: NAME,
    oldScheduledAt: AT,
    newScheduledAt: LATER,
  });
  await emitter.emitReminder24h({
    ...base,
    recipientUserId: 'client',
    recipientRole: 'client',
    otherPartyDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitReminder1h({
    ...base,
    recipientUserId: 'coach',
    recipientRole: 'coach',
    otherPartyDisplayName: NAME,
    scheduledAt: AT,
    hasMeetingLink: false,
  });
  await emitter.emitLinkNeeded({
    ...base,
    coachUserId: 'coach',
    clientDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitLinkReady({
    ...base,
    clientUserId: 'client',
    coachDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitRequestExpired({
    ...base,
    recipientUserId: 'client',
    recipientRole: 'client',
    otherPartyDisplayName: NAME,
    scheduledAt: AT,
  });
  await emitter.emitRequestExpired({
    ...base,
    recipientUserId: 'coach',
    recipientRole: 'coach',
    otherPartyDisplayName: NAME,
    scheduledAt: AT,
  });
}

const K = NotificationKind;
const fixed = (kind: string) => lockScreenCopy(kind, '');
const KINDS = [
  K.BOOKING_REQUESTED,
  K.BOOKING_CONFIRMED,
  K.BOOKING_CONFIRMED,
  K.BOOKING_CONFIRMED,
  K.BOOKING_DECLINED,
  K.BOOKING_CANCELLED,
  K.BOOKING_RESCHEDULED,
  K.BOOKING_RESCHEDULED,
  K.BOOKING_REMINDER_24H,
  K.BOOKING_REMINDER_1H,
  K.BOOKING_LINK_NEEDED,
  K.BOOKING_LINK_READY,
  K.BOOKING_REQUEST_EXPIRED,
  K.BOOKING_REQUEST_EXPIRED,
];
const MOVE_REQUESTED = {
  title: 'Time change requested',
  body: 'A client asked to move a session. Open the app to review.',
};
const EXPECTED = KINDS.map((kind, i) =>
  // B-653-4: the 8th call is the client's move request (emitMoveRequested).
  i === 7
    ? { kind, ...MOVE_REQUESTED }
    : kind === K.BOOKING_REMINDER_24H
      ? { kind, title: 'Session reminder', body: 'Your session is tomorrow at 10:00 AM PDT.' }
      : kind === K.BOOKING_REMINDER_1H
        ? { kind, title: 'Session starting soon', body: 'Your session starts at 10:00 AM PDT.' }
        : { kind, ...fixed(kind) },
);

describe('B-714-1 / B-653-1 booking pushes keep names and coach text off the lock screen', () => {
  it('through the real sender: 14 outbox rows, fixed per-kind lines, no canary anywhere in the row', async () => {
    const { emitter, outbox, rows, legacy } = realSender();
    await emitAll(emitter);
    expect(legacy).not.toHaveBeenCalled(); // one sender: never the legacy pushToUser
    expect(outbox.map((r) => ({ kind: r.kind, title: r.title, body: r.body }))).toEqual(EXPECTED);
    for (const r of outbox) {
      const stored = JSON.stringify(r);
      for (const c of CANARIES) expect(stored).not.toContain(c);
      expect(`${r.title} ${r.body}`).not.toMatch(/!|\b(I|me|my|we|our)\b/);
    }
    // The three scheduling kinds have their own lines, not the generic one.
    for (const kind of [K.BOOKING_LINK_NEEDED, K.BOOKING_LINK_READY, K.BOOKING_REQUEST_EXPIRED]) {
      expect(fixed(kind).title).not.toBe('The Growth Project');
    }
    // The inbox rows (inside the app) keep the full detail.
    expect(rows).toHaveLength(14);
    expect(rows[0].body).toContain(NAME);
    expect(rows[0].body).toContain(TYPE);
  });

  it('through the real sender with no usable zone: no clock time on any lock screen', async () => {
    const { emitter, outbox } = realSender(null);
    await emitAll(emitter);
    expect(outbox).toHaveLength(14);
    for (const r of outbox) {
      expect(`${r.title} ${r.body}`).not.toMatch(/AM|PM|UTC|\d:\d{2}/);
      for (const c of CANARIES) expect(JSON.stringify(r)).not.toContain(c);
    }
    expect(outbox.find((r) => r.kind === K.BOOKING_REMINDER_24H)?.body).toBe(
      fixed(K.BOOKING_REMINDER_24H).body,
    );
  });

  it('sendPush input: ids, instants and zone only; one exactly-once key per event', async () => {
    const { emitter, inputs, pushes, fake } = fakeSender();
    await emitAll(emitter);
    expect(fake.pushToUser).not.toHaveBeenCalled();
    expect(inputs).toHaveLength(14);
    expect(inputs.filter((i) => i.context?.moveRequested === true)).toHaveLength(1);
    for (const i of inputs) {
      // B-653-4: only the client's move request carries the request-state flag.
      const flag = i.context?.moveRequested === true ? ['moveRequested'] : [];
      expect(Object.keys(i.context ?? {}).sort()).toEqual(
        [
          'newScheduledAt',
          'oldScheduledAt',
          'scheduledAt',
          'sessionId',
          'timeZone',
          ...flag,
        ].sort(),
      );
      for (const c of CANARIES) expect(JSON.stringify(i.context)).not.toContain(c);
      expect(i.dedupe_key).toMatch(new RegExp(`^${i.kind}:s-[123]:`));
    }
    expect(new Set(inputs.map((i) => `${i.user_id}|${i.dedupe_key}`)).size).toBe(14);
    expect(pushes.map((p) => ({ kind: p.kind, title: p.title, body: p.body }))).toEqual(EXPECTED);
  });
});

describe('B-653-4 a client move request is not shown as a moved session', () => {
  it('the coach is told a time change is requested, at enqueue and at send; a real move still says moved', async () => {
    const { emitter, outbox, delivery, send } = realSender();
    await emitter.emitMoveRequested({
      coachUserId: 'coach',
      clientDisplayName: NAME,
      sessionId: 's-1',
      sessionTypeName: TYPE,
      oldScheduledAt: AT,
      newScheduledAt: LATER,
    });
    await emitter.emitRescheduled({
      recipientUserId: 'client',
      recipientRole: 'client',
      reschedulerDisplayName: NAME,
      sessionId: 's-2',
      sessionTypeName: TYPE,
      oldScheduledAt: AT,
      newScheduledAt: LATER,
    });
    expect(outbox.map((r) => ({ kind: r.kind, title: r.title, body: r.body }))).toEqual([
      { kind: K.BOOKING_RESCHEDULED, ...MOVE_REQUESTED },
      { kind: K.BOOKING_RESCHEDULED, ...fixed(K.BOOKING_RESCHEDULED) },
    ]);
    await delivery.drain();
    const sent = send.mock.calls
      .flatMap((c) => c[0])
      .map((m) => ({ title: m.title, body: m.body }));
    expect(sent).toEqual([MOVE_REQUESTED, fixed(K.BOOKING_RESCHEDULED)]);
    for (const m of sent) {
      for (const c of CANARIES) expect(`${m.title} ${m.body}`).not.toContain(c);
      expect(`${m.title} ${m.body}`).not.toMatch(/!|\b(I|me|my|we|our)\b/);
    }
  });
});
