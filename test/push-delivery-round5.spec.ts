/**
 * Push P2 fix round (B-PUSH2-120): regressions for both lenses' findings at
 * 13417e7b. Each case fails on that head.
 *   - Sol B-693-1: a reschedule back to an earlier time was deduped away.
 *   - Sol B-648-7: a declared push twin hid the only stored row.
 *   - Sol B-693-2: a failed DeviceNotRegistered token clear was settled.
 *   - Sol B-648-9: a mute or sign-out during send preparation did not stop it.
 *   - Opus B-693-1: Android channel 'default' does not exist in the app.
 *   - Sol B-692-1 (P1): the worker sends only the kind's template.
 */
import { Logger } from '@nestjs/common';
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { DripDispatcherCron } from '../src/packages/drip-dispatcher.cron';
import { PurchaseFanoutService } from '../src/packages/purchase-fanout.service';
import { PushDeliveryService, RECEIPT_MIN_AGE_MS } from '../src/notifications/push/push-delivery.service';
import { ANDROID_PUSH_CHANNELS, androidChannelFor } from '../src/notifications/push/push-channels';
import { pushOutboxWorld } from './utils/push-outbox-fake';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const NEW_TOKEN = 'ExponentPushToken[zyxwvutsrqponmlkjihgfe]';
const CLOCK = new Date('2026-06-02T18:00:00Z'); // 14:00 New York
const NY = 'America/New_York';

class Clocked extends PushDeliveryService {
  clock = CLOCK;
  protected now(): Date {
    return new Date(this.clock);
  }
}

type NRow = Record<string, unknown> & { id: string; created_at: Date; inbox_hidden: boolean };

function world(prefs: Record<string, unknown> = {}) {
  let seq = 0;
  const w = pushOutboxWorld({
    now: () => delivery.clock,
    tokens: { 'u-1': TOKEN },
    prefs: { 'u-1': { timezone: NY, timezone_updated_at: CLOCK, muted: false, ...prefs } },
  });
  const client = {
    send: jest.fn(async (_m: ExpoPushMessage[], _s: AbortSignal): Promise<ExpoPushTicket[]> => [
      { status: 'ok', id: `t-${++seq}` },
    ]),
    getReceipts: jest.fn(async (_i: string[], _s: AbortSignal): Promise<Record<string, ExpoPushReceipt>> => ({})),
  };
  const inbox: NRow[] = [];
  const hit = (row: NRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'created_at') return row.created_at >= (v as { gte: Date }).gte;
      if (k === 'read_at') return row.read_at == null;
      return (row[k] ?? null) === v;
    });
  const db = {
    ...w.db,
    notification: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: NRow = { id: `n-${inbox.length + 1}`, created_at: new Date(Date.now()), inbox_hidden: false, ...data };
        inbox.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => inbox.find((r) => hit(r, where)) ?? null),
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => inbox.filter((r) => hit(r, where)).length),
    },
    coachingSession: { findUnique: jest.fn(async () => ({ client_id: 'u-1', coach_id: 'coach-1', status: 'scheduled' })) },
    scheduledDrop: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const delivery = new Clocked(Object.create(db), client);
  delivery.autoDrain = false;
  const notifications = new NotificationsService(Object.create(db), undefined, undefined, delivery);
  jest.spyOn(notifications, 'pushToUser').mockResolvedValue({ delivered: false, code: 'no-token' });
  return { ...w, db, client, inbox, delivery, notifications };
}

const message = (over: Record<string, unknown> = {}) => ({
  userId: 'u-1',
  kind: NotificationKind.MESSAGE_RECEIVED,
  title: 'New message',
  body: 'New message from Jamie jamie@example.test',
  data: { actionScreen: 'Messages' },
  collapseKey: 'message_received:tgp://messages/t-1',
  timeZone: NY,
  ...over,
});

/** Run `change` while the worker's first token read is in flight. */
function duringPreparation(w: ReturnType<typeof world>, change: () => void) {
  const original = w.db.user.findUnique.getMockImplementation();
  let done = false;
  w.db.user.findUnique.mockImplementation(async (args) => {
    const out = original ? await original(args) : { expo_push_token: TOKEN };
    if (!done) {
      done = true;
      change();
      w.delivery.clock = new Date(CLOCK.getTime() + 70_000);
    }
    return out;
  });
}

// NotificationsService's in-process push limiter (one push row per user and
// kind per minute) reads Date.now(); each case starts ten minutes later.
let wall = Date.parse('2026-06-02T18:00:00Z');
const tick = (ms = 10 * 60_000) => (wall += ms);
beforeAll(() => {
  for (const level of ['warn', 'error', 'log'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
  jest.spyOn(Date, 'now').mockImplementation(() => wall);
});
beforeEach(() => tick());

describe('Sol B-693-1: one push per reschedule', () => {
  const T = ['2026-06-06T18:00:00Z', '2026-06-06T19:00:00Z', '2026-06-06T20:00:00Z'].map((t) => new Date(t));
  async function moves(w: ReturnType<typeof world>, path: Array<[number, number, string?]>) {
    const booking = new BookingEmitter(w.notifications, Object.create(w.db));
    for (const [from, to, id] of path) {
      await booking.emitRescheduled({
        recipientUserId: 'u-1',
        reschedulerDisplayName: 'Coach K',
        sessionId: 's-1',
        oldScheduledAt: T[from],
        newScheduledAt: T[to],
        rescheduleEventId: id,
      });
      await w.delivery.drain();
      w.delivery.clock = new Date(w.delivery.clock.getTime() + 5 * 60_000);
    }
  }

  it('A -> B -> C -> B: three moves, three pushes', async () => {
    const w = world();
    await moves(w, [[0, 1], [1, 2], [2, 1]]);
    expect(w.client.send).toHaveBeenCalledTimes(3);
  });

  it('A -> B -> A -> B with each move identified: four pushes; the same move twice: one', async () => {
    const w = world();
    await moves(w, [[0, 1, 'e1'], [1, 0, 'e2'], [0, 1, 'e3'], [1, 0, 'e4'], [1, 0, 'e4']]);
    expect(w.client.send).toHaveBeenCalledTimes(4);
    expect(w.rows).toHaveLength(4);
  });
});

describe('Sol B-648-7: a declared twin is hidden only behind a stored inapp row', () => {
  const input = {
    user_id: 'u-1',
    kind: NotificationKind.COACH_NEW_PURCHASE,
    body: 'New purchase',
    deep_link: 'tgp://coach/purchases/p-1',
  };

  it('inapp switched off: the push row is the only copy and stays visible', async () => {
    const w = world({ coach_new_purchase_inapp: false });
    expect(await w.notifications.createNotification({ ...input, channel: 'inapp' })).toBeNull();
    await w.notifications.createNotification({ ...input, channel: 'push', push_twin: true });
    expect(w.inbox.map((r) => r.inbox_hidden)).toEqual([false]);
    expect(await w.notifications.getUnreadCount('u-1')).toBe(1);
  });

  it('a stored inapp row with the same text and link: the twin is hidden; a different link is not a twin', async () => {
    const w = world();
    await w.notifications.createNotification({ ...input, channel: 'inapp' });
    await w.notifications.createNotification({ ...input, channel: 'push', push_twin: true });
    tick(2 * 60_000);
    await w.notifications.createNotification({ ...input, deep_link: 'tgp://coach/purchases/p-2', channel: 'push', push_twin: true });
    expect(w.inbox.map((r) => r.inbox_hidden)).toEqual([false, true, false]);
    expect(await w.notifications.getUnreadCount('u-1')).toBe(2);
  });

  it('Opus C-693-2 (main refresh): throttle_key and push_twin together, one inbox item per payout notice', async () => {
    const w = world();
    const notice = { ...input, kind: NotificationKind.COACH_ALERT, deep_link: 'tgp://coach/payouts' };
    for (const id of ['pn-1', 'pn-2']) {
      const n = { ...notice, body: `Payout notice ${id}` };
      await w.notifications.createNotification({ ...n, channel: 'inapp' });
      expect(await w.notifications.createNotification({ ...n, channel: 'push', throttle_key: id, push_twin: true })).not.toBeNull();
    }
    expect(w.inbox.map((r) => r.inbox_hidden)).toEqual([false, true, false, true]);
    expect(await w.notifications.getUnreadCount('u-1')).toBe(2);
  });

  it('the drip writer: an inapp DB failure leaves its push row visible; a stored inapp hides the twin', async () => {
    const drop = { id: 'd-1', display_title: 'Week 2', client_purchase_id: 'cp-1', asset_type: 'meal_plan', asset_id: 'a-1' };
    for (const fail of [true, false]) {
      tick();
      const w = world();
      if (fail) w.db.notification.create.mockRejectedValueOnce(new Error('synthetic outage'));
      const cron = new DripDispatcherCron(Object.create(w.db), undefined, w.notifications);
      const dispatch = Reflect.get(cron, 'dispatchBuyerAlert') as (...a: unknown[]) => Promise<void>;
      await dispatch.call(cron, drop, 'u-1', CLOCK);
      const expected = fail ? [['push', false]] : [['inapp', false], ['push', true]];
      expect(w.inbox.map((r) => [r.channel, r.inbox_hidden])).toEqual(expected);
      expect(await w.notifications.getUnreadCount('u-1')).toBe(1);
    }
  });

  it('the purchase writer: an inapp DB failure leaves its push row visible', async () => {
    const w = world();
    w.db.notification.create.mockRejectedValueOnce(new Error('synthetic outage'));
    const svc = new PurchaseFanoutService(undefined, undefined, w.notifications, undefined);
    const alert = { coachId: 'u-1', buyerId: 'b-1', buyerDisplayName: 'Sam', purchaseId: 'p-1', packageName: 'Plan' };
    Reflect.get(svc, 'pendingCoachNewPurchaseAlerts').set('p-1', { ...alert, amountCents: 4900, currency: 'usd' });
    svc.flushCoachNewPurchaseAlert('p-1');
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    expect(w.inbox.map((r) => [r.channel, r.inbox_hidden])).toEqual([['push', false]]);
  });
});

describe('Sol B-693-2: a failed token clear is retried, never settled', () => {
  const dead = { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } as const;

  it('receipt stage: [0, 1] across two sweeps, the token cleared, no second push', async () => {
    const w = world();
    await w.delivery.enqueue(message());
    await w.delivery.drain();
    w.delivery.clock = new Date(CLOCK.getTime() + RECEIPT_MIN_AGE_MS);
    w.client.getReceipts.mockResolvedValue({ 't-1': dead });
    w.db.user.updateMany.mockRejectedValueOnce(new Error('synthetic outage'));
    expect((await w.delivery.checkReceipts()).checked).toBe(0);
    expect(w.rows[0].result_code).toBe('token-cleanup-pending');
    expect((await w.delivery.checkReceipts()).checked).toBe(1);
    expect(w.tokens['u-1']).toBeNull();
    expect(w.rows[0].result_code).toBe('device-not-registered');
    expect(w.client.send).toHaveBeenCalledTimes(1);
  });

  it('ticket stage: the clear is retried by the sweep until it succeeds; a newer token is kept', async () => {
    const w = world();
    w.client.send.mockResolvedValueOnce([dead]);
    w.db.user.updateMany.mockRejectedValueOnce(new Error('one')).mockRejectedValueOnce(new Error('two'));
    await w.delivery.enqueue(message());
    await w.delivery.drain();
    expect(w.rows[0]).toMatchObject({ status: 'dropped', result_code: 'token-cleanup-pending', token: TOKEN });
    expect((await w.delivery.checkReceipts()).checked).toBe(0); // second failure: still owed
    w.tokens['u-1'] = NEW_TOKEN; // the device registered again meanwhile
    expect((await w.delivery.checkReceipts()).checked).toBe(1);
    expect(w.tokens['u-1']).toBe(NEW_TOKEN);
    expect(w.rows[0].result_code).toBe('device-not-registered');
    expect(w.client.send).toHaveBeenCalledTimes(1);
  });
});

describe('Sol B-648-9: consent is read again after the handoff', () => {
  type W = ReturnType<typeof world>;
  it.each([
    ['master mute', (w: W) => Object.assign(w.prefs['u-1'], { muted: true }), 'preference-off'],
    ['message switch off', (w: W) => Object.assign(w.prefs['u-1'], { message_push: false }), 'preference-off'],
    ['sign-out (token cleared)', (w: W) => void (w.tokens['u-1'] = null), 'no-token'],
  ])('%s during a 70 s preparation read: nothing is sent', async (_name, change, code) => {
    const w = world();
    await w.notifications.createNotification({ user_id: 'u-1', kind: NotificationKind.MESSAGE_RECEIVED, body: 'x' });
    await w.delivery.enqueue(message());
    duringPreparation(w, () => change(w));
    expect(await w.delivery.drain()).toBe(0);
    expect(w.client.send).not.toHaveBeenCalled();
    expect(w.rows[0]).toMatchObject({ status: 'dropped', result_code: code });
    expect(w.inbox).toHaveLength(1); // inbox history kept
  });

  it('controls: a booking push still goes when only messages are switched off; no change sends once', async () => {
    for (const kind of [NotificationKind.BOOKING_CONFIRMED, NotificationKind.MESSAGE_RECEIVED]) {
      const w = world();
      await w.delivery.enqueue(message({ kind, collapseKey: `${kind}:x` }));
      duringPreparation(w, () => {
        if (kind !== NotificationKind.MESSAGE_RECEIVED) Object.assign(w.prefs['u-1'], { message_push: false });
      });
      expect(await w.delivery.drain()).toBe(1);
    }
  });
});

describe('Opus B-693-1: every push names a channel the app creates', () => {
  it('the channel list is the mobile PUSH_CHANNEL list, and every kind maps into it', () => {
    expect(Object.values(ANDROID_PUSH_CHANNELS).sort()).toEqual(['client-bot', 'coach-messages', 'milestones', 'system']);
    const allowed = new Set<string>(Object.values(ANDROID_PUSH_CHANNELS));
    for (const kind of [...Object.values(NotificationKind), 'unknown_kind']) {
      expect(allowed.has(androidChannelFor(kind))).toBe(true);
    }
    expect(androidChannelFor(NotificationKind.MESSAGE_RECEIVED)).toBe('coach-messages');
    expect(androidChannelFor(NotificationKind.BOOKING_REMINDER_1H)).toBe('system');
    expect(androidChannelFor(NotificationKind.COACH_ALERT)).toBe('system');
    expect(androidChannelFor(NotificationKind.MILESTONE_REACHED)).toBe('milestones');
    expect(androidChannelFor(NotificationKind.NUDGE_INACTIVE)).toBe('client-bot');
  });

  it('the worker sends that channel and only the template copy, whatever the row holds', async () => {
    const w = world();
    await w.delivery.enqueue(message());
    await w.delivery.enqueue(message({ kind: NotificationKind.MILESTONE_REACHED, collapseKey: 'm:1', body: 'Down 2.4 kg' }));
    expect(await w.delivery.drain()).toBe(2);
    const sent = w.client.send.mock.calls.map((c) => c[0][0]);
    expect(sent.map((m) => m.channelId)).toEqual(['coach-messages', 'milestones']);
    expect(sent.map((m) => m.body)).toEqual([
      'You have a new message. Open the app to read it.',
      'You reached a milestone. Open the app to see it.',
    ]);
  });
});
