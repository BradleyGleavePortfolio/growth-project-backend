import { Logger } from '@nestjs/common';
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
import { DripDispatcherCron } from '../src/packages/drip-dispatcher.cron';
import {
  PushDeliveryService,
  RECEIPT_MIN_AGE_MS,
  LEASE_MS,
} from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const CLOCK = new Date('2026-06-02T18:00:00Z');
const NY = 'America/New_York';

class Clocked extends PushDeliveryService {
  clock = CLOCK;
  protected now(): Date {
    return new Date(this.clock);
  }
}

function world() {
  let clock = CLOCK;
  const w = pushOutboxWorld({
    now: () => clock,
    tokens: { 'client-1': TOKEN },
    prefs: {
      'client-1': { timezone: NY, timezone_updated_at: CLOCK, muted: false, message_push: true },
    },
  });
  let seq = 0;
  const client = {
    send: jest.fn(async (_messages: ExpoPushMessage[], _signal: AbortSignal): Promise<ExpoPushTicket[]> =>
      [{ status: 'ok', id: `t-${++seq}` }],
    ),
    getReceipts: jest.fn(async (_ids: string[], _signal: AbortSignal): Promise<Record<string, ExpoPushReceipt>> =>
      ({}),
    ),
  };
  const inbox: Array<Record<string, unknown>> = [];
  const db = {
    ...w.db,
    notification: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `n-${inbox.length + 1}`, inbox_hidden: false, ...data };
        inbox.push(row);
        return row;
      }),
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        inbox.filter((row) =>
          Object.entries(where).every(([k, v]) =>
            k === 'read_at' ? row[k] == null : row[k] === v,
          ),
        ).length,
      ),
    },
    coachingSession: {
      findUnique: jest.fn(async () => ({
        client_id: 'client-1',
        coach_id: 'coach-1',
        start_at: new Date('2026-06-06T18:00:00Z'),
        status: 'scheduled',
      })),
    },
  };
  const delivery = new Clocked(Object.create(db), client);
  Object.defineProperty(delivery, 'clock', {
    get: () => clock,
    set: (value: Date) => { clock = value; },
  });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(Object.create(db), undefined, undefined, delivery);
  const booking = new BookingEmitter(notifications, Object.create(db));
  return { ...w, db, client, inbox, delivery, notifications, booking };
}

const message = {
  userId: 'client-1',
  kind: NotificationKind.MESSAGE_RECEIVED,
  title: 'New message',
  body: 'New message from Coach K',
  data: { actionScreen: 'Messages' },
  collapseKey: 'message:thread-1',
  timeZone: NY,
};

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('AUD-SOL-PUSH3-120: post-handoff await boundaries', () => {
  it('a final token read outlasting the renewed lease cannot send a sweep-closed row', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    const original = w.db.user.findUnique.getMockImplementation();
    let reads = 0;
    const replicaClient = {
      ...w.client,
      send: jest.fn(async (_messages: ExpoPushMessage[], _signal: AbortSignal): Promise<ExpoPushTicket[]> => [
        { status: 'ok', id: 'replica-ticket' },
      ]),
    };
    const replica = new Clocked(Object.create(w.db), replicaClient);
    Object.defineProperty(replica, 'clock', {
      get: () => w.delivery.clock,
      set: (d: Date) => { w.delivery.clock = d; },
    });
    replica.autoDrain = false;
    w.db.user.findUnique.mockImplementation(async (args) => {
      const captured = original ? await original(args) : { expo_push_token: TOKEN };
      reads += 1;
      if (reads === 2) {
        w.delivery.clock = new Date(CLOCK.getTime() + LEASE_MS + 1_000);
        // A future fix may move handOff after these reads: then B can
        // release and send this unstarted row. Either way A lost authority.
        expect((await replica.sweep()).expired).toBe(1);
      }
      return captured;
    });
    await w.delivery.drain();
    expect(reads).toBe(2);
    expect(w.client.send).not.toHaveBeenCalled();
  });

  it('erasure during the final token read prevents sending the deleted outbox row', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    const original = w.db.user.findUnique.getMockImplementation();
    let reads = 0;
    w.db.user.findUnique.mockImplementation(async (args) => {
      const captured = original ? await original(args) : { expo_push_token: TOKEN };
      reads += 1;
      if (reads === 2) {
        w.tokens['client-1'] = null;
        await w.db.pushOutbox.deleteMany({ where: { user_id: 'client-1' } });
        expect(w.rows).toHaveLength(0);
      }
      return captured;
    });
    expect(await w.delivery.drain()).toBe(0);
    expect(reads).toBe(2);
    expect(w.client.send).not.toHaveBeenCalled();
  });

  it('control: erasure returns no current user in the final read, so nothing is sent', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    const original = w.db.user.findUnique.getMockImplementation();
    let reads = 0;
    w.db.user.findUnique.mockImplementation(async (args) => {
      reads += 1;
      if (reads === 2) {
        w.tokens['client-1'] = null;
        await w.db.pushOutbox.deleteMany({ where: { user_id: 'client-1' } });
      }
      return original ? original(args) : { expo_push_token: null };
    });
    expect(await w.delivery.drain()).toBe(0);
    expect(w.client.send).not.toHaveBeenCalled();
  });

  it('control: a 70-second final token read that keeps its lease sends once', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    const original = w.db.user.findUnique.getMockImplementation();
    let reads = 0;
    w.db.user.findUnique.mockImplementation(async (args) => {
      const captured = original ? await original(args) : { expo_push_token: TOKEN };
      reads += 1;
      if (reads === 2) w.delivery.clock = new Date(CLOCK.getTime() + 70_000);
      return captured;
    });
    expect(await w.delivery.drain()).toBe(1);
    expect(w.client.send).toHaveBeenCalledTimes(1);
  });
});

describe('AUD-SOL-PUSH-120 P2 independent boundaries', () => {
  it('distinct reschedules A -> B -> C -> B each reach the recipient once', async () => {
    const w = world();
    const times = ['2026-06-06T18:00:00Z', '2026-06-06T19:00:00Z', '2026-06-06T20:00:00Z'];
    for (const [from, to] of [[0, 1], [1, 2], [2, 1]]) {
      await w.booking.emitRescheduled({
        recipientUserId: 'client-1',
        reschedulerDisplayName: 'Coach K',
        sessionId: 'session-1',
        oldScheduledAt: new Date(times[from]),
        newScheduledAt: new Date(times[to]),
      });
      await w.delivery.drain();
      w.delivery.clock = new Date(w.delivery.clock.getTime() + 5 * 60_000);
    }
    expect(w.inbox).toHaveLength(3);
    expect(w.client.send).toHaveBeenCalledTimes(3);
    expect(w.rows).toHaveLength(3);
  });

  it('a suppressed inapp write is not proof that the sole push row is a twin', async () => {
    const w = world();
    w.prefs['client-1'] = {
      muted: false,
      coach_new_purchase_inapp: false,
      coach_new_purchase_push: true,
    };
    const input = {
      user_id: 'client-1',
      kind: NotificationKind.COACH_NEW_PURCHASE,
      body: 'New purchase',
      deep_link: 'tgp://coach/purchases/p-1',
    };
    expect(await w.notifications.createNotification({ ...input, channel: 'inapp' })).toBeNull();
    await w.notifications.createNotification({ ...input, channel: 'push', push_twin: true });
    expect(w.inbox).toHaveLength(1);
    expect(await w.notifications.getUnreadCount('client-1')).toBe(1);
  });

  it('the real drip writer preserves its sole push row when the inapp DB write fails', async () => {
    const w = world();
    w.db.notification.create.mockRejectedValueOnce(new Error('synthetic inapp DB outage'));
    jest.spyOn(w.notifications, 'pushToUser').mockResolvedValue({
      delivered: false,
      code: 'no-token',
    });
    const db = {
      ...w.db,
      scheduledDrop: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const cron = new DripDispatcherCron(Object.create(db), undefined, w.notifications);
    const dispatch = Reflect.get(cron, 'dispatchBuyerAlert') as (
      drop: Record<string, unknown>,
      userId: string,
      now: Date,
    ) => Promise<void>;
    await dispatch.call(cron, {
      id: 'drop-1',
      display_title: 'New content',
      client_purchase_id: 'purchase-1',
      asset_type: 'meal_plan',
      asset_id: 'asset-1',
      content_id: 'content-1',
    }, 'client-1', CLOCK);
    expect(w.inbox).toHaveLength(1);
    expect(w.inbox[0].channel).toBe('push');
    expect(await w.notifications.getUnreadCount('client-1')).toBe(1);
  });

  it('a transient token-clear failure does not permanently settle a dead-device receipt', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    await w.delivery.drain();
    w.delivery.clock = new Date(CLOCK.getTime() + RECEIPT_MIN_AGE_MS);
    w.client.getReceipts.mockResolvedValue({
      't-1': { status: 'error', message: 'synthetic', details: { error: 'DeviceNotRegistered' } },
    });
    w.db.user.updateMany.mockRejectedValueOnce(new Error('synthetic transient DB outage'));
    const first = await w.delivery.checkReceipts();
    const second = await w.delivery.checkReceipts();
    expect([first.checked, second.checked]).toEqual([0, 1]);
    expect(w.tokens['client-1']).toBeNull();
  });

  it('mute committed during slow send preparation suppresses the external call', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    const original = w.db.user.findUnique.getMockImplementation();
    w.db.user.findUnique.mockImplementation(async (args) => {
      w.prefs['client-1'] = { timezone: NY, timezone_updated_at: CLOCK, muted: true };
      w.delivery.clock = new Date(CLOCK.getTime() + 70_000);
      return original ? original(args) : { expo_push_token: TOKEN };
    });
    await w.delivery.drain();
    expect(w.client.send).not.toHaveBeenCalled();
  });

  it('the real message emitter does not expose private profile display-name text', async () => {
    const w = world();
    const emitter = new MessageReceivedEmitter(w.notifications);
    await emitter.emit('client-1', {
      senderName: 'Jamie jamie@example.test diagnosis: diabetes',
      threadId: 'thread-1',
    });
    expect(await w.delivery.drain()).toBe(1);
    expect(w.client.send.mock.calls[0][0][0].body).not.toMatch(/@|diabetes|diagnosis/i);
  });

  it('control: deleting outbox rows before the handoff prevents a stale send', async () => {
    const w = world();
    await w.delivery.enqueue(message);
    const original = w.db.user.findUnique.getMockImplementation();
    w.db.user.findUnique.mockImplementation(async (args) => {
      const user = original ? await original(args) : { expo_push_token: TOKEN };
      await w.db.pushOutbox.deleteMany({ where: { user_id: 'client-1' } });
      return user;
    });
    expect(await w.delivery.drain()).toBe(0);
    expect(w.client.send).not.toHaveBeenCalled();
  });
});
