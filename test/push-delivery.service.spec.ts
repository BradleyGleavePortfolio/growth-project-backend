/**
 * C-643-2: device delivery through the Expo Push API, with the Expo client
 * mocked (no network).
 *
 * Before this change no inbox notification (coach message, booking reminder,
 * check-in, milestone ...) was ever sent to a device: emitters stored a
 * `channel: 'push'` row that nothing read.
 */
import { Logger } from '@nestjs/common';
import type {
  ExpoPushErrorTicket,
  ExpoPushMessage,
  ExpoPushReceipt,
  ExpoPushTicket,
} from 'expo-server-sdk';
import {
  ExpoPushClient,
  PushDeliveryService,
  RECEIPT_MIN_AGE_MS,
  USER_WINDOW_MAX,
} from '../src/notifications/push/push-delivery.service';
import { lockScreenCopy } from '../src/notifications/push/lock-screen-copy';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const T0 = new Date('2026-06-01T12:00:00Z');

function client(tickets: () => ExpoPushTicket[] | Promise<ExpoPushTicket[]>) {
  const c = {
    chunkPushNotifications: jest.fn((m: ExpoPushMessage[]) => [m]),
    sendPushNotificationsAsync: jest.fn(async (messages: ExpoPushMessage[]) =>
      messages.length > 0 ? tickets() : [],
    ),
    chunkPushNotificationReceiptIds: jest.fn((ids: string[]) => [ids]),
    getPushNotificationReceiptsAsync: jest.fn(
      async (): Promise<Record<string, ExpoPushReceipt>> => ({}),
    ),
  };
  return c as typeof c & ExpoPushClient;
}

function prisma(token: string | null = TOKEN) {
  return {
    user: {
      findUnique: jest.fn(async () => ({ expo_push_token: token })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
}

const ok = (id = 'r-1'): ExpoPushTicket[] => [{ status: 'ok', id }];
type ExpoErrorCode = NonNullable<NonNullable<ExpoPushErrorTicket['details']>['error']>;
const err = (error: ExpoErrorCode): ExpoPushTicket[] => [
  { status: 'error', message: 'x', details: { error } },
];

const push = (kind: string = NotificationKind.BOOKING_REMINDER_1H) => ({
  userId: 'u-1',
  kind,
  title: 'Session starting soon',
  body: 'Starting soon: your session with Coach K is at 5:30 PM PDT.',
  data: { actionScreen: 'NotificationCenter' },
});

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers({ now: T0, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('PushDeliveryService', () => {
  it('sends one message to the stored Expo token with the given copy and tap data', async () => {
    const c = client(() => ok());
    const svc = new PushDeliveryService(Object.create(prisma()), c);
    await expect(svc.deliver(push())).resolves.toEqual({ sent: true, code: 'sent' });
    expect(c.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    const [msg] = c.sendPushNotificationsAsync.mock.calls[0][0];
    expect(msg).toMatchObject({
      to: TOKEN,
      title: 'Session starting soon',
      body: 'Starting soon: your session with Coach K is at 5:30 PM PDT.',
      data: { actionScreen: 'NotificationCenter', kind: NotificationKind.BOOKING_REMINDER_1H },
      channelId: 'default',
    });
  });

  it('no token or a non-Expo token: nothing is sent', async () => {
    const c = client(() => ok());
    expect(await new PushDeliveryService(Object.create(prisma(null)), c).deliver(push())).toEqual({
      sent: false,
      code: 'no-token',
    });
    expect(
      await new PushDeliveryService(Object.create(prisma('fcm:raw')), c).deliver(push()),
    ).toEqual({
      sent: false,
      code: 'invalid-token',
    });
    expect(c.sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('DeviceNotRegistered on the ticket clears exactly that token, never a newer one', async () => {
    const db = prisma();
    const svc = new PushDeliveryService(
      Object.create(db),
      client(() => err('DeviceNotRegistered')),
    );
    expect(await svc.deliver(push())).toEqual({ sent: false, code: 'device-not-registered' });
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u-1', expo_push_token: TOKEN },
      data: { expo_push_token: null },
    });
  });

  it('Android without the FCM key (InvalidCredentials): keeps the token, no throw, one operator alert per hour', async () => {
    const db = prisma();
    const c = client(() => err('InvalidCredentials'));
    const svc = new PushDeliveryService(Object.create(db), c);
    const kinds = [
      NotificationKind.MESSAGE_RECEIVED,
      NotificationKind.MILESTONE_REACHED,
      NotificationKind.COACH_ALERT,
    ];
    for (const k of kinds) {
      await expect(svc.deliver(push(k))).resolves.toEqual({
        sent: false,
        code: 'provider-not-configured',
      });
    }
    expect(db.user.updateMany).not.toHaveBeenCalled();
    const alerts = errorSpy.mock.calls.filter((a) =>
      String(a[0]).startsWith('PUSH_PROVIDER_NOT_CONFIGURED'),
    );
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0][0])).toContain('FCM V1');
    // An hour later the operator is reminded once more.
    jest.setSystemTime(new Date(T0.getTime() + 61 * 60_000));
    await svc.deliver(push(NotificationKind.BOOKING_CONFIRMED));
    expect(
      errorSpy.mock.calls.filter((a) => String(a[0]).startsWith('PUSH_PROVIDER_NOT_CONFIGURED')),
    ).toHaveLength(2);
    // Each push was attempted once: no retries.
    expect(c.sendPushNotificationsAsync).toHaveBeenCalledTimes(4);
  });

  it('a transport failure is one attempt, a warning and a typed result, never a throw or a retry', async () => {
    const c = client(() => {
      throw new TypeError('fetch failed');
    });
    const svc = new PushDeliveryService(Object.create(prisma()), c);
    await expect(svc.deliver(push())).resolves.toEqual({ sent: false, code: 'transport-error' });
    expect(c.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rate limits: one per user per kind per minute, and at most USER_WINDOW_MAX per user per 10 minutes', async () => {
    const c = client(() => ok());
    const svc = new PushDeliveryService(Object.create(prisma()), c);
    expect((await svc.deliver(push())).code).toBe('sent');
    expect((await svc.deliver(push())).code).toBe('rate-limited');
    jest.setSystemTime(new Date(T0.getTime() + 61_000));
    expect((await svc.deliver(push())).code).toBe('sent');

    const other = new PushDeliveryService(
      Object.create(prisma()),
      client(() => ok()),
    );
    const results: string[] = [];
    for (let i = 0; i < USER_WINDOW_MAX + 2; i += 1)
      results.push((await other.deliver(push(`kind_${i}`))).code);
    expect(results.filter((r) => r === 'sent')).toHaveLength(USER_WINDOW_MAX);
    expect(results.slice(USER_WINDOW_MAX)).toEqual(['rate-limited', 'rate-limited']);
  });

  it('receipts: checked after a delay; DeviceNotRegistered on a receipt clears the token; fetch failure retries next sweep', async () => {
    const db = prisma();
    const c = client(() => ok('r-9'));
    const svc = new PushDeliveryService(Object.create(db), c);
    await svc.deliver(push());

    // Too early: Expo has not published the receipt yet.
    expect(await svc.checkReceipts()).toEqual({ checked: 0, remaining: 1 });
    expect(c.getPushNotificationReceiptsAsync).not.toHaveBeenCalled();

    jest.setSystemTime(new Date(T0.getTime() + RECEIPT_MIN_AGE_MS + 1_000));
    c.getPushNotificationReceiptsAsync.mockRejectedValueOnce(new Error('503'));
    expect(await svc.checkReceipts()).toEqual({ checked: 0, remaining: 1 });

    c.getPushNotificationReceiptsAsync.mockResolvedValueOnce({
      'r-9': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    });
    expect(await svc.checkReceipts()).toEqual({ checked: 1, remaining: 0 });
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u-1', expo_push_token: TOKEN },
      data: { expo_push_token: null },
    });
  });
});

describe('lockScreenCopy', () => {
  it('never puts health detail or message text on the lock screen', () => {
    const weight = lockScreenCopy(
      NotificationKind.WEIGHT_TREND_ALERT,
      'Weight has trended away from your goal over 14 days.',
    );
    expect(weight.body).not.toMatch(/weight|goal|14/i);
    const milestone = lockScreenCopy(
      NotificationKind.MILESTONE_REACHED,
      'Milestone reached: body fat — 18',
    );
    expect(milestone.body).not.toMatch(/body fat|18/);
    const checkin = lockScreenCopy(
      NotificationKind.CHECKIN_SUBMITTED,
      "Jamie submitted today's check-in. Streak: 9 days.",
    );
    expect(checkin.body).not.toMatch(/Jamie|Streak|9/);
    const alert = lockScreenCopy(NotificationKind.COACH_ALERT, 'Jamie weight up 4 lbs this week');
    expect(alert.body).not.toMatch(/Jamie|weight|4/);
    const unknown = lockScreenCopy('some_new_kind', 'private detail');
    expect(unknown.body).not.toContain('private');
  });

  it('booking and message copy keep the name and local time, and follow house style', () => {
    const r = lockScreenCopy(
      NotificationKind.BOOKING_REMINDER_24H,
      'Reminder: your session with Coach K is tomorrow at 5:30 PM PDT.',
    );
    expect(r).toEqual({
      title: 'Session reminder',
      body: 'Reminder: your session with Coach K is tomorrow at 5:30 PM PDT.',
    });
    expect(
      lockScreenCopy(NotificationKind.MESSAGE_RECEIVED, 'New message from Coach K').title,
    ).toBe('New message');
    for (const k of Object.values(NotificationKind)) {
      const c = lockScreenCopy(k, 'x');
      expect([k, /!/.test(c.title + c.body)]).toEqual([k, false]);
    }
  });
});

describe('NotificationsService.sendPush', () => {
  function svc(prefs: Record<string, unknown> | null) {
    const deliver = jest.fn(async () => ({ sent: true, code: 'sent' as const }));
    const db = { notificationPreferences: { findUnique: jest.fn(async () => prefs) } };
    const n = new NotificationsService(
      Object.create(db),
      undefined,
      undefined,
      Object.create({ deliver }),
    );
    return { n, deliver };
  }

  it('sends quiet lock-screen copy with tap routing only, and writes no inbox row', async () => {
    const { n, deliver } = svc(null);
    await n.sendPush({
      user_id: 'u-1',
      kind: NotificationKind.WEIGHT_TREND_ALERT,
      body: 'Weight has trended away from your goal over 14 days.',
      deep_link: 'tgp://weight',
    });
    expect(deliver).toHaveBeenCalledWith({
      userId: 'u-1',
      kind: NotificationKind.WEIGHT_TREND_ALERT,
      title: 'Your progress',
      body: 'There is a new update on your progress. Open the app to see it.',
      data: { actionScreen: 'NotificationCenter', deepLink: 'tgp://weight' },
    });
  });

  it('messages open the Messages screen', async () => {
    const { n, deliver } = svc(null);
    await n.sendPush({
      user_id: 'u-1',
      kind: NotificationKind.MESSAGE_RECEIVED,
      body: 'New message from Coach K',
    });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ data: { actionScreen: 'Messages' } }),
    );
  });

  it('respects mute and the per-kind push preference', async () => {
    const muted = svc({ muted: true });
    expect(
      await muted.n.sendPush({
        user_id: 'u',
        kind: NotificationKind.BOOKING_REMINDER_1H,
        body: 'x',
      }),
    ).toBeNull();
    expect(muted.deliver).not.toHaveBeenCalled();
    const off = svc({ muted: false, booking_push: false });
    expect(
      await off.n.sendPush({ user_id: 'u', kind: NotificationKind.BOOKING_REMINDER_1H, body: 'x' }),
    ).toBeNull();
    expect(off.deliver).not.toHaveBeenCalled();
  });

  it('is a no-op without the delivery service (thin unit tests)', async () => {
    const n = new NotificationsService(Object.create(null));
    expect(
      await n.sendPush({ user_id: 'u', kind: NotificationKind.MESSAGE_RECEIVED, body: 'x' }),
    ).toBeNull();
  });
});

describe('end to end: booking emitter -> NotificationsService -> Expo (mocked)', () => {
  type Row = {
    id: string;
    user_id: string;
    kind: string;
    channel: string;
    read_at: Date | null;
    created_at: Date;
  };

  function world(prefs: Record<string, Record<string, unknown>>) {
    const rows: Row[] = [];
    const tokens: Record<string, string> = {
      'client-1': 'ExponentPushToken[client1client1client1x]',
      'coach-1': 'ExponentPushToken[coach1coach1coach1coac]',
    };
    const db = {
      user: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
          expo_push_token: tokens[where.id] ?? null,
        })),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      notificationPreferences: {
        findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) =>
          prefs[where.user_id] ? { user_id: where.user_id, ...prefs[where.user_id] } : null,
        ),
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
        // Honors the inbox's `NOT: { channel, kind: { in } }` twin filter.
        findMany: jest.fn(async ({ where }: { where: InboxWhere }) =>
          rows.filter((r) => visible(r, where)),
        ),
        findUnique: jest.fn(async () => null),
        count: jest.fn(
          async ({ where }: { where: InboxWhere }) => rows.filter((r) => visible(r, where)).length,
        ),
      },
    };
    const expo = client(() => ok());
    const delivery = new PushDeliveryService(Object.create(db), expo);
    const notifications = new NotificationsService(
      Object.create(db),
      undefined,
      undefined,
      delivery,
    );
    const emitter = new BookingEmitter(notifications);
    return { rows, expo, emitter, notifications };
  }

  type InboxWhere = {
    user_id: string;
    read_at?: null;
    NOT?: { channel: string; kind: { in: string[] } };
  };
  function visible(r: Row, where: InboxWhere): boolean {
    if (r.user_id !== where.user_id) return false;
    if (where.read_at === null && r.read_at !== null) return false;
    if (where.NOT && r.channel === where.NOT.channel && where.NOT.kind.in.includes(r.kind))
      return false;
    return true;
  }

  const reminder = (recipientUserId: string) => ({
    recipientUserId,
    otherPartyDisplayName: 'Coach K',
    sessionId: 'sess-1',
    scheduledAt: new Date('2026-06-02T00:30:00Z'),
  });

  it('one push to each eligible participant, one inbox item each', async () => {
    const w = world({});
    await w.emitter.emitReminder24h(reminder('client-1'));
    await w.emitter.emitReminder24h(reminder('coach-1'));
    const sent = w.expo.sendPushNotificationsAsync.mock.calls.map((c) => c[0][0].to);
    expect(sent).toEqual([
      'ExponentPushToken[client1client1client1x]',
      'ExponentPushToken[coach1coach1coach1coac]',
    ]);
    expect(w.rows.map((r) => [r.user_id, r.channel])).toEqual([
      ['client-1', 'inapp'],
      ['coach-1', 'inapp'],
    ]);
    expect(await w.notifications.getUnreadCount('client-1')).toBe(1);
  });

  it('zero pushes when the recipient opted out of booking pushes or muted everything', async () => {
    const w = world({
      'client-1': { muted: true },
      'coach-1': { muted: false, booking_push: false },
    });
    await w.emitter.emitReminder1h(reminder('client-1'));
    await w.emitter.emitReminder1h(reminder('coach-1'));
    expect(w.expo.sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('the inbox and unread count hide stored push twins (rows already in the database), but not push-only kinds', async () => {
    const w = world({});
    const at = new Date();
    w.rows.push(
      {
        id: 'a',
        user_id: 'client-1',
        kind: NotificationKind.MESSAGE_RECEIVED,
        channel: 'inapp',
        read_at: null,
        created_at: at,
      },
      {
        id: 'b',
        user_id: 'client-1',
        kind: NotificationKind.MESSAGE_RECEIVED,
        channel: 'push',
        read_at: null,
        created_at: at,
      },
      {
        id: 'c',
        user_id: 'client-1',
        kind: NotificationKind.WORKOUT_ASSIGNED,
        channel: 'push',
        read_at: null,
        created_at: at,
      },
    );
    const page = await w.notifications.listNotifications('client-1', {});
    expect(page.items.map((i: { id: string }) => i.id)).toEqual(['a', 'c']);
    expect(page.unreadCount).toBe(2);
    expect(await w.notifications.getUnreadCount('client-1')).toBe(2);
  });
});
