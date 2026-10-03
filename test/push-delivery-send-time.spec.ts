/**
 * B-NOTIF-6 (#648 fix round 3): authority and policy at the moment a push is
 * SENT, not only when it was queued. Expo is mocked (no network); the outbox
 * is the in-memory fake.
 *
 * What fails on the previous head (16294f44):
 *   - Sol B-648-8: a serial batch outlived its lease; another worker's sweep
 *     closed still-unsent rows while the live batch sent them anyway, and a
 *     lost compare-and-set was still counted as sent.
 *   - Sol B-648-9: a queued push ignored preferences switched off after it
 *     was queued (master mute, per-kind toggle).
 *   - Sol B-648-10: quiet hours were checked only at enqueue; a backlog, a
 *     retry or a changed zone could put a push on the lock screen at night.
 *   - Opus/Sol C-648-3: a booking push opened the notification list, not the
 *     session.
 * Round 4 (fails on ab607b34), Sol B-648-10 partial: the window was judged
 * on the clock read when the send began; a slow read or the handoff write
 * could carry a non-urgent push past 21:00 onto the lock screen.
 * Verification (passes before and after): a coach message, the welcome
 * included, reaches the client's lock screen with quiet copy.
 */
import { Logger } from '@nestjs/common';
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import {
  ExpoPushClient,
  PushDeliveryService,
  RECEIPT_MIN_AGE_MS,
} from '../src/notifications/push/push-delivery.service';
import { ExpoHttpError } from '../src/notifications/push/expo-push-client';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { pushOutboxWorld } from './utils/push-outbox-fake';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
// 2026-06-02 18:00 UTC = 14:00 EDT.
const NY_AFTERNOON = new Date('2026-06-02T18:00:00Z');
// 2026-06-03 00:59 UTC = 20:59 EDT (Jun 2).
const NY_2059 = new Date('2026-06-03T00:59:00Z');
// 2026-06-03 03:00 UTC = 23:00 EDT (Jun 2).
const NY_2300 = new Date('2026-06-03T03:00:00Z');
// 2026-06-03 12:00 UTC = 08:00 EDT = 05:00 PDT.
const NY_0800 = new Date('2026-06-03T12:00:00Z');
// 2026-06-03 15:00 UTC = 08:00 PDT.
const LA_0800 = new Date('2026-06-03T15:00:00Z');

class Clocked extends PushDeliveryService {
  clock = NY_AFTERNOON;
  protected now(): Date {
    return new Date(this.clock.getTime());
  }
}

type SendImpl = (messages: ExpoPushMessage[], signal: AbortSignal) => Promise<ExpoPushTicket[]>;

function expo(send: SendImpl = async (m) => m.map(() => ({ status: 'ok', id: 'x' }))) {
  let n = 0;
  return {
    send: jest.fn<Promise<ExpoPushTicket[]>, [ExpoPushMessage[], AbortSignal]>(async (m, s) => {
      const out = await send(m, s);
      return out.map((t) => (t.status === 'ok' ? { ...t, id: `ticket-${++n}` } : t));
    }),
    getReceipts: jest.fn<Promise<Record<string, ExpoPushReceipt>>, [string[], AbortSignal]>(
      async () => ({}),
    ),
  } satisfies ExpoPushClient;
}

/** One shared outbox and clock; any number of workers (replicas). */
function world(opts: { clock?: Date; prefs?: Record<string, Record<string, unknown>> } = {}) {
  const clock = { at: opts.clock ?? NY_AFTERNOON };
  const w = pushOutboxWorld({
    now: () => clock.at,
    tokens: { 'client-1': TOKEN, 'u-1': TOKEN },
    prefs: opts.prefs,
  });
  const worker = (client = expo()) => {
    const svc = new Clocked(Object.create(w.db), client);
    Object.defineProperty(svc, 'clock', {
      get: () => clock.at,
      set: (d: Date) => {
        clock.at = d;
      },
    });
    svc.autoDrain = false;
    return { svc, client };
  };
  return { ...w, clock, worker };
}

const message = (over: Partial<Parameters<PushDeliveryService['enqueue']>[0]> = {}) => ({
  userId: 'u-1',
  kind: NotificationKind.MESSAGE_RECEIVED,
  title: 'New message',
  body: 'New message from Coach K',
  data: { actionScreen: 'Messages', deepLink: 'tgp://messages/u-1' },
  collapseKey: `${NotificationKind.MESSAGE_RECEIVED}:tgp://messages/u-1`,
  timeZone: NY,
  ...over,
});

const at = (d: Date, ms: number) => new Date(d.getTime() + ms);

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('B-648-8: lease authority is proven right before every send', () => {
  it("Sol's probe: 15 rows, 9 s per provider reply, a second worker sweeps at 126 s; every row is sent once and recorded", async () => {
    const w = world();
    // Fifteen distinct conversations, so nothing collapses.
    for (let i = 1; i <= 15; i += 1) {
      await w
        .worker()
        .svc.enqueue(
          message({ collapseKey: `message_received:tgp://messages/t-${i}`, userId: `u-${i}` }),
        );
      w.tokens[`u-${i}`] = TOKEN;
    }
    const b = w.worker();
    let bDrained = 0;
    let replies = 0;
    const a = w.worker(
      expo(async (m) => {
        // Each reply takes 9 s of clock time: below the 10 s send deadline.
        w.clock.at = at(w.clock.at, 9_000);
        replies += 1;
        if (replies === 14) {
          // 126 s after the start: the other replica's minute sweep.
          const swept = await b.svc.sweep();
          bDrained += swept.sent;
        }
        return m.map(() => ({ status: 'ok', id: 'x' }) as ExpoPushTicket);
      }),
    );
    const aDrained = await a.svc.drain();

    const sends = a.client.send.mock.calls.length + b.client.send.mock.calls.length;
    const sentRows = w.rows.filter((r) => r.status === 'sent' && r.ticket_id);
    expect(sends).toBe(15);
    expect(sentRows).toHaveLength(15);
    expect(aDrained + bDrained).toBe(15);
    expect(w.rows.filter((r) => r.result_code === 'lease-expired')).toHaveLength(0);
    // No device got two pushes.
    const recipients = [...a.client.send.mock.calls, ...b.client.send.mock.calls].map(
      (c) => c[0][0].to,
    );
    expect(recipients).toHaveLength(15);
  });

  it('a claim that lapses before the handoff goes back to the queue; the stalled worker does not send it, the other sends it once', async () => {
    const w = world();
    const a = w.worker();
    const b = w.worker();
    await a.svc.enqueue(message());
    // Worker A stalls after its claim, before it reaches Expo (for example a
    // long GC pause). Meanwhile its lease lapses and B sweeps.
    const userFind = w.db.user.findUnique;
    let paused = false;
    w.db.user.findUnique = jest.fn(async (args: { where: { id: string } }) => {
      if (!paused) {
        paused = true;
        w.clock.at = at(w.clock.at, 3 * 60_000);
        await b.svc.sweep();
      }
      return userFind(args);
    }) as typeof userFind;

    const aDrained = await a.svc.drain();
    expect(a.client.send).not.toHaveBeenCalled();
    expect(aDrained).toBe(0);
    expect(b.client.send).toHaveBeenCalledTimes(1);
    expect(w.rows[0]).toMatchObject({ status: 'sent', result_code: 'sent' });
    expect(w.rows[0].ticket_id).toBe('ticket-1');
  });

  it('a row handed to Expo whose lease lapsed is closed, never sent twice', async () => {
    const w = world();
    const a = w.worker();
    await a.svc.enqueue(message());
    w.rows[0].status = 'sending';
    w.rows[0].lease_token = 'dead-worker';
    w.rows[0].handed_off_at = at(w.clock.at, -3 * 60_000);
    w.rows[0].lease_until = at(w.clock.at, -1);
    expect(await a.svc.sweep()).toEqual({ sent: 0, expired: 1 });
    expect(w.rows[0]).toMatchObject({ status: 'dropped', result_code: 'lease-expired' });
    expect(a.client.send).not.toHaveBeenCalled();
  });

  it('two replicas reading the same receipts count each receipt once', async () => {
    const w = world();
    const a = w.worker();
    const b = w.worker();
    await a.svc.enqueue(message());
    await a.svc.drain();
    w.clock.at = at(w.clock.at, RECEIPT_MIN_AGE_MS);
    for (const c of [a.client, b.client]) {
      c.getReceipts.mockImplementation(async (ids) =>
        Object.fromEntries(ids.map((id) => [id, { status: 'ok' } as ExpoPushReceipt])),
      );
    }
    const [ra, rb] = await Promise.all([a.svc.checkReceipts(), b.svc.checkReceipts()]);
    expect(ra.checked + rb.checked).toBe(1);
  });
});

describe('B-648-9: a queued push obeys the preferences at the moment it is sent', () => {
  it('"mute all" turned on while a night message waits: nothing reaches the phone at 08:00', async () => {
    const w = world({ clock: NY_2300 });
    const a = w.worker();
    expect((await a.svc.enqueue(message())).code).toBe('deferred');
    w.prefs['u-1'] = { muted: true };
    w.clock.at = NY_0800;
    expect(await a.svc.drain()).toBe(0);
    expect(a.client.send).not.toHaveBeenCalled();
    expect(w.rows[0]).toMatchObject({ status: 'dropped', result_code: 'preference-off' });
  });

  it('the message switch turned off while a push waits suppresses it; booking pushes still go', async () => {
    const w = world({ clock: NY_2300 });
    const a = w.worker();
    await a.svc.enqueue(message());
    w.prefs['u-1'] = { muted: false, message_push: false };
    w.clock.at = NY_0800;
    expect(await a.svc.drain()).toBe(0);
    expect(w.rows[0].result_code).toBe('preference-off');

    // The same person still gets a booking push (only messages were turned off).
    const startsAt = at(NY_0800, 60 * 60_000);
    w.sessions['sess-1'] = { status: 'scheduled', start_at: startsAt };
    await a.svc.enqueue(
      message({
        kind: NotificationKind.BOOKING_REMINDER_1H,
        dedupeKey: `booking_reminder_1h:sess-1:${startsAt.toISOString()}`,
        collapseKey: 'booking_reminder_1h:tgp://sessions/sess-1',
        context: { sessionId: 'sess-1', scheduledAt: startsAt.toISOString(), timeZone: NY },
      }),
    );
    expect(await a.svc.drain()).toBe(1);
  });
});

describe('B-648-10: quiet hours are decided again at the moment of sending', () => {
  it('queued at 20:59 New York, the worker reaches it at 23:00: it waits until 08:00, then is sent', async () => {
    const w = world({ clock: NY_2059 });
    const a = w.worker();
    expect((await a.svc.enqueue(message())).code).toBe('queued');
    w.clock.at = NY_2300; // worker downtime / backlog
    expect(await a.svc.drain()).toBe(0);
    expect(a.client.send).not.toHaveBeenCalled();
    expect(w.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'quiet_hours' });
    expect(w.rows[0].not_before.toISOString()).toBe(NY_0800.toISOString());
    // Waiting for the morning is not a delivery attempt.
    expect(w.rows[0].attempts).toBe(0);
    w.clock.at = NY_0800;
    expect(await a.svc.drain()).toBe(1);
  });

  it('a provider retry that lands after 21:00 waits for the morning without spending an attempt', async () => {
    let calls = 0;
    const flaky = expo(async (m) => {
      calls += 1;
      if (calls === 1) throw new ExpoHttpError(503, true, null);
      return m.map(() => ({ status: 'ok', id: 'x' }) as ExpoPushTicket);
    });
    const w = world({ clock: new Date('2026-06-03T00:59:45Z') }); // 20:59:45 EDT
    const a = w.worker(flaky);
    await a.svc.enqueue(message());
    expect(await a.svc.drain()).toBe(0); // 503: retry in 30 s (21:00:15)
    w.clock.at = new Date('2026-06-03T01:00:15Z');
    expect(await a.svc.drain()).toBe(0);
    expect(flaky.send).toHaveBeenCalledTimes(1);
    expect(w.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'quiet_hours' });
    expect(w.rows[0].attempts).toBe(1);
    w.clock.at = NY_0800;
    expect(await a.svc.drain()).toBe(1);
  });

  it('the recipient moved to Los Angeles while the push waited: 08:00 New York is 05:00 there, so it waits for 08:00 Los Angeles', async () => {
    const w = world({ clock: NY_2300 });
    const a = w.worker();
    await a.svc.enqueue(message());
    expect(w.rows[0].not_before.toISOString()).toBe(NY_0800.toISOString());
    // The device reported its new zone (PUT /notifications/timezone).
    w.prefs['u-1'] = { timezone: LA, timezone_updated_at: at(NY_2300, 60_000) };
    w.clock.at = NY_0800;
    expect(await a.svc.drain()).toBe(0);
    expect(w.rows[0].not_before.toISOString()).toBe(LA_0800.toISOString());
    w.clock.at = LA_0800;
    expect(await a.svc.drain()).toBe(1);
  });

  it('urgency still bypasses the window at send time: a 1 h reminder at 23:00 goes now', async () => {
    const w = world({ clock: NY_2300 });
    const a = w.worker();
    const startsAt = at(NY_2300, 60 * 60_000);
    w.sessions['sess-9'] = { status: 'scheduled', start_at: startsAt };
    await a.svc.enqueue(
      message({
        kind: NotificationKind.BOOKING_REMINDER_1H,
        dedupeKey: `booking_reminder_1h:sess-9:${startsAt.toISOString()}`,
        collapseKey: 'booking_reminder_1h:tgp://sessions/sess-9',
        context: { sessionId: 'sess-9', scheduledAt: startsAt.toISOString(), timeZone: NY },
      }),
    );
    expect(await a.svc.drain()).toBe(1);
  });

  it('a booking confirmation for a session days away, queued at 20:59 and reached at 23:00, waits for the morning', async () => {
    const w = world({ clock: NY_2059 });
    const a = w.worker();
    const startsAt = at(NY_2059, 3 * 24 * 60 * 60_000);
    await a.svc.enqueue(
      message({
        kind: NotificationKind.BOOKING_CONFIRMED,
        dedupeKey: `booking_confirmed:sess-2:${startsAt.toISOString()}`,
        collapseKey: 'booking_confirmed:tgp://sessions/sess-2',
        context: { sessionId: 'sess-2', scheduledAt: startsAt.toISOString(), timeZone: NY },
      }),
    );
    w.clock.at = NY_2300;
    expect(await a.svc.drain()).toBe(0);
    expect(w.rows[0].deferred_reason).toBe('quiet_hours');
  });
});

describe('B-648-10 (round 4): the window is checked on the clock at the Expo handoff', () => {
  // 20:59:00 EDT; a read or write that takes 70 s ends at 21:00:10, inside
  // the 120 s lease and before any provider call.
  const CROSSED = new Date('2026-06-03T01:00:10Z');

  /** Advance the shared clock while one awaited database call is in flight. */
  function slowTokenRead(w: ReturnType<typeof world>, to: Date) {
    const original = w.db.user.findUnique.getMockImplementation();
    w.db.user.findUnique.mockImplementation(async (args) => {
      w.clock.at = to;
      return original ? original(args) : { expo_push_token: TOKEN };
    });
  }

  it("Sol's probe: the token read ends at 21:00:10, so nothing is sent; it waits for 08:00 without spending an attempt", async () => {
    const w = world({ clock: NY_2059 });
    const a = w.worker();
    await a.svc.enqueue(message());
    slowTokenRead(w, CROSSED);
    expect(await a.svc.drain()).toBe(0);
    expect(a.client.send).not.toHaveBeenCalled();
    expect(w.rows[0]).toMatchObject({
      status: 'pending',
      deferred_reason: 'quiet_hours',
      result_code: 'quiet-deferred',
      attempts: 0,
      handed_off_at: null,
    });
    expect(w.rows[0].not_before.toISOString()).toBe(NY_0800.toISOString());
  });

  it('the handoff write itself ends after 21:00: the row never reached Expo, so it goes back for 08:00', async () => {
    const w = world({ clock: NY_2059 });
    const a = w.worker();
    await a.svc.enqueue(message());
    const original = w.db.pushOutbox.updateMany.getMockImplementation();
    w.db.pushOutbox.updateMany.mockImplementation(async (args) => {
      const out = original ? await original(args) : { count: 0 };
      if (args.data && args.data.handed_off_at instanceof Date) w.clock.at = CROSSED;
      return out;
    });
    expect(await a.svc.drain()).toBe(0);
    expect(a.client.send).not.toHaveBeenCalled();
    expect(w.rows[0]).toMatchObject({
      status: 'pending',
      deferred_reason: 'quiet_hours',
      attempts: 0,
      handed_off_at: null,
      lease_token: null,
    });
    w.clock.at = NY_0800;
    expect(await a.svc.drain()).toBe(1);
    expect(a.client.send).toHaveBeenCalledTimes(1);
  });

  it('urgent control: a 1 h reminder whose reads cross 21:00 is still sent', async () => {
    const w = world({ clock: NY_2059 });
    const a = w.worker();
    const startsAt = at(NY_2059, 50 * 60_000);
    w.sessions['sess-4'] = { status: 'scheduled', start_at: startsAt };
    await a.svc.enqueue(
      message({
        kind: NotificationKind.BOOKING_REMINDER_1H,
        dedupeKey: `booking_reminder_1h:sess-4:${startsAt.toISOString()}`,
        collapseKey: 'booking_reminder_1h:tgp://sessions/sess-4',
        context: { sessionId: 'sess-4', scheduledAt: startsAt.toISOString(), timeZone: NY },
      }),
    );
    slowTokenRead(w, CROSSED);
    expect(await a.svc.drain()).toBe(1);
    expect(a.client.send).toHaveBeenCalledTimes(1);
  });

  it('daytime control: a 70 s read at 14:00 still sends, and the row records the handoff time', async () => {
    const w = world({ clock: NY_AFTERNOON });
    const a = w.worker();
    await a.svc.enqueue(message());
    const later = at(NY_AFTERNOON, 70_000);
    slowTokenRead(w, later);
    expect(await a.svc.drain()).toBe(1);
    expect(a.client.send).toHaveBeenCalledTimes(1);
    expect(w.rows[0].status).toBe('sent');
    expect(w.rows[0].sent_at?.toISOString()).toBe(later.toISOString());
  });
});

// ── Real emitters + NotificationsService + PushDeliveryService ──────────────

function serviceWorld(clock: Date) {
  const w = world({
    clock,
    prefs: { 'client-1': { timezone: NY, timezone_updated_at: new Date('2026-06-01T00:00:00Z') } },
  });
  const inbox: Array<Record<string, unknown>> = [];
  const db = {
    ...w.db,
    notification: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `n-${inbox.length + 1}`, ...data };
        inbox.push(row);
        return row;
      }),
    },
    coachingSession: {
      findUnique: jest.fn(async () => ({
        coach_id: 'coach-1',
        client_id: 'client-1',
        status: 'scheduled',
        start_at: new Date('2026-06-04T15:00:00Z'),
      })),
    },
  };
  const client = expo();
  const delivery = new Clocked(Object.create(db), client);
  Object.defineProperty(delivery, 'clock', {
    get: () => w.clock.at,
    set: (d: Date) => {
      w.clock.at = d;
    },
  });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(Object.create(db), undefined, undefined, delivery);
  return { ...w, serviceDb: db, inbox, client, delivery, notifications };
}

describe('coach messages reach the lock screen (verification)', () => {
  it('a coach message (the welcome is one) is pushed to the client with quiet copy that opens Messages', async () => {
    const w = serviceWorld(NY_AFTERNOON);
    const emitter = new MessageReceivedEmitter(w.notifications);
    await emitter.emit('client-1', { senderName: 'Coach K', threadId: 'client-1' });
    expect(await w.delivery.drain()).toBe(1);
    const sent = w.client.send.mock.calls[0][0][0];
    expect(sent).toMatchObject({
      to: TOKEN,
      title: 'New message',
      body: 'New message from Coach K',
      sound: 'default',
      priority: 'high',
      channelId: 'default',
    });
    expect(sent.data).toMatchObject({
      actionScreen: 'Messages',
      deepLink: 'tgp://messages/client-1',
      kind: NotificationKind.MESSAGE_RECEIVED,
    });
    expect(w.inbox).toHaveLength(1);
  });

  it("a welcome sent at 21:30 the client's time waits and reaches the lock screen at 08:00", async () => {
    const w = serviceWorld(new Date('2026-06-03T01:30:00Z')); // 21:30 EDT
    const emitter = new MessageReceivedEmitter(w.notifications);
    await emitter.emit('client-1', { senderName: 'Coach K', threadId: 'client-1' });
    expect(await w.delivery.drain()).toBe(0);
    w.clock.at = NY_0800;
    expect(await w.delivery.drain()).toBe(1);
    expect(w.client.send.mock.calls[0][0][0].body).toBe('New message from Coach K');
  });
});

describe('C-648-3: a booking push opens the session', () => {
  it("the client's push opens CalendarSession and the coach's opens CoachBookingInbox, both with the session id", async () => {
    const w = serviceWorld(NY_AFTERNOON);
    w.tokens['coach-1'] = TOKEN;
    const booking = new BookingEmitter(w.notifications, Object.create(w.serviceDb));
    await booking.emitConfirmed({
      clientUserId: 'client-1',
      coachDisplayName: 'Coach K',
      sessionId: 'sess-7',
      scheduledAt: new Date('2026-06-04T15:00:00Z'),
    });
    await booking.emitRequested({
      coachUserId: 'coach-1',
      clientDisplayName: 'Jamie',
      sessionId: 'sess-7',
      requestedAt: new Date('2026-06-04T15:00:00Z'),
      notes: null,
    });
    expect(await w.delivery.drain()).toBe(2);
    expect(w.client.send.mock.calls.map((c) => c[0][0].data?.actionScreen)).toEqual([
      'CalendarSession',
      'CoachBookingInbox',
    ]);
    const data = w.rows.map((r) => [r.user_id, r.data]);
    expect(data).toEqual([
      [
        'client-1',
        expect.objectContaining({
          actionScreen: 'CalendarSession',
          actionParams: { sessionId: 'sess-7' },
          sessionId: 'sess-7',
        }),
      ],
      [
        'coach-1',
        expect.objectContaining({
          actionScreen: 'CoachBookingInbox',
          actionParams: { sessionId: 'sess-7' },
        }),
      ],
    ]);
  });
});
