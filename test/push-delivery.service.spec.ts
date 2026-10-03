/**
 * B-NOTIF-5 (#648): device delivery through the durable PushOutbox, with
 * the Expo transport mocked (no network) and an in-memory outbox.
 *
 * What fails on the previous head (81c52a12, in-memory per-kind throttle,
 * direct awaited Expo send, kind-only twin filter):
 *   - B-648-1: a second session's reminder or a second thread's message to
 *     the same person within 60 s was dropped; a ninth push in 10 minutes
 *     was dropped.
 *   - B-648-6: the emitter awaited Expo; a stalled request held the booking
 *     call and the receipt latch open.
 *   - B-648-7: a sole push row of a listed kind vanished from the inbox.
 *   - OR-113-5 / C-648-4: no quiet hours.
 *   - C-648-5: receipts lived in memory.
 */
import { Logger } from '@nestjs/common';
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import {
  ExpoPushClient,
  MAX_ATTEMPTS,
  PushDeliveryService,
  RECEIPT_MIN_AGE_MS,
  USER_WINDOW_MAX,
  USER_WINDOW_MS,
} from '../src/notifications/push/push-delivery.service';
import { ExpoHttpError, FetchExpoPushClient } from '../src/notifications/push/expo-push-client';
import { lockScreenCopy } from '../src/notifications/push/lock-screen-copy';
import { quietHoursFor } from '../src/notifications/push/push-quiet-hours';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import { BookingEmitter } from '../src/notifications/emitters/booking.emitter';
import { pushOutboxWorld } from './utils/push-outbox-fake';

const TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';
const COACH_TOKEN = 'ExponentPushToken[coach1coach1coach1coac]';
// 12:00 UTC = 08:00 EDT = 05:00 PDT = 21:00 JST.
const NOON_UTC = new Date('2026-06-02T12:00:00Z');
// 03:00 UTC = 23:00 EDT (Jun 1) = 20:00 PDT = 12:00 JST.
const NY_LATE = new Date('2026-06-02T03:00:00Z');
const NY = 'America/New_York';

class Clocked extends PushDeliveryService {
  clock = NOON_UTC;
  protected now(): Date {
    return new Date(this.clock.getTime());
  }
}

type SendImpl = (messages: ExpoPushMessage[], signal: AbortSignal) => Promise<ExpoPushTicket[]>;

function expo(send: SendImpl = async (m) => m.map((_, i) => ({ status: 'ok', id: `t-${i}` }))) {
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

function setup(opts: {
  client?: ReturnType<typeof expo>;
  tokens?: Record<string, string | null>;
  sessions?: Record<string, { status: string; start_at: Date }>;
  clock?: Date;
}) {
  let svc: Clocked | null = null;
  const world = pushOutboxWorld({
    now: () => (svc ? svc.clock : (opts.clock ?? NOON_UTC)),
    tokens: opts.tokens ?? { 'u-1': TOKEN, 'coach-1': COACH_TOKEN },
    sessions: opts.sessions,
  });
  const client = opts.client ?? expo();
  svc = new Clocked(Object.create(world.db), client);
  svc.clock = opts.clock ?? NOON_UTC;
  svc.autoDrain = false;
  return { svc, client, ...world };
}

const base = (over: Partial<Parameters<PushDeliveryService['enqueue']>[0]> = {}) => ({
  userId: 'u-1',
  kind: NotificationKind.MESSAGE_RECEIVED,
  title: 'New message',
  body: 'New message from Coach K',
  data: { actionScreen: 'Messages', deepLink: 'tgp://messages/thread-1' },
  collapseKey: `${NotificationKind.MESSAGE_RECEIVED}:tgp://messages/thread-1`,
  timeZone: NY,
  ...over,
});

const reminder1h = (sessionId: string, startsAt: Date) =>
  base({
    userId: 'coach-1',
    kind: NotificationKind.BOOKING_REMINDER_1H,
    title: 'Session starting soon',
    body: 'Starting soon',
    data: { actionScreen: 'NotificationCenter', deepLink: `tgp://sessions/${sessionId}` },
    collapseKey: `${NotificationKind.BOOKING_REMINDER_1H}:tgp://sessions/${sessionId}`,
    dedupeKey: `${NotificationKind.BOOKING_REMINDER_1H}:${sessionId}:${startsAt.toISOString()}`,
    context: {
      sessionId,
      scheduledAt: startsAt.toISOString(),
      timeZone: NY,
      otherPartyDisplayName: 'Jamie',
    },
  });

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('B-648-1: distinct events are never dropped', () => {
  it('two 1 h reminders for different sessions to one coach in the same minute are both pushed', async () => {
    const s1 = new Date(NOON_UTC.getTime() + 60 * 60_000);
    const s2 = new Date(NOON_UTC.getTime() + 65 * 60_000);
    const w = setup({
      sessions: {
        'sess-1': { status: 'scheduled', start_at: s1 },
        'sess-2': { status: 'scheduled', start_at: s2 },
      },
    });
    await w.svc.enqueue(reminder1h('sess-1', s1));
    await w.svc.enqueue(reminder1h('sess-2', s2));
    expect(await w.svc.drain()).toBe(2);
    expect(w.client.send).toHaveBeenCalledTimes(2);
    expect(w.client.send.mock.calls.map((c) => c[0][0].body)).toEqual([
      'Your session with Jamie starts at 9:00 AM EDT.',
      'Your session with Jamie starts at 9:05 AM EDT.',
    ]);
  });

  it('the same reminder enqueued twice (two replicas) is pushed once', async () => {
    const s1 = new Date(NOON_UTC.getTime() + 60 * 60_000);
    const w = setup({ sessions: { 'sess-1': { status: 'scheduled', start_at: s1 } } });
    expect((await w.svc.enqueue(reminder1h('sess-1', s1))).code).toBe('queued');
    expect((await w.svc.enqueue(reminder1h('sess-1', s1))).code).toBe('duplicate');
    expect(await w.svc.drain()).toBe(1);
  });

  it('two messages in the same thread within 60 s give one push; two threads give two', async () => {
    const w = setup({});
    await w.svc.enqueue(base());
    expect(await w.svc.drain()).toBe(1);
    w.svc.clock = new Date(NOON_UTC.getTime() + 20_000);
    expect((await w.svc.enqueue(base())).code).toBe('collapsed');
    await w.svc.enqueue(
      base({
        data: { actionScreen: 'Messages', deepLink: 'tgp://messages/thread-2' },
        collapseKey: `${NotificationKind.MESSAGE_RECEIVED}:tgp://messages/thread-2`,
        body: 'New message from Sam',
      }),
    );
    expect(await w.svc.drain()).toBe(1);
    expect(w.client.send.mock.calls.map((c) => c[0][0].body)).toEqual([
      'New message from Coach K',
      'New message from Sam',
    ]);
  });

  it('an unsent push in a thread takes the newest copy instead of queueing a second one', async () => {
    const w = setup({});
    await w.svc.enqueue(base({ body: 'New message from Coach K' }));
    expect((await w.svc.enqueue(base({ body: 'New message from Coach K (2)' }))).code).toBe(
      'collapsed',
    );
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0].body).toBe('New message from Coach K (2)');
  });

  it('past the burst cap a non-urgent push is deferred until the window has room, then sent', async () => {
    const w = setup({});
    for (let i = 0; i < USER_WINDOW_MAX + 1; i += 1) {
      await w.svc.enqueue(
        base({
          collapseKey: `${NotificationKind.MESSAGE_RECEIVED}:tgp://messages/t-${i}`,
          data: { deepLink: `tgp://messages/t-${i}` },
        }),
      );
    }
    expect(await w.svc.drain()).toBe(USER_WINDOW_MAX);
    const waiting = w.rows.filter((r) => r.status === 'pending');
    expect(waiting).toHaveLength(1);
    expect(waiting[0].deferred_reason).toBe('burst_cap');
    expect(waiting[0].not_before.getTime()).toBe(NOON_UTC.getTime() + USER_WINDOW_MS);
    w.svc.clock = new Date(NOON_UTC.getTime() + USER_WINDOW_MS);
    expect(await w.svc.drain()).toBe(1);
    expect(w.rows.every((r) => r.status === 'sent')).toBe(true);
  });

  it('urgent reminders are exempt from the burst cap', async () => {
    const sessions: Record<string, { status: string; start_at: Date }> = {};
    const w0 = Array.from({ length: USER_WINDOW_MAX + 2 }, (_, i) => {
      const at = new Date(NOON_UTC.getTime() + (60 + i) * 60_000);
      sessions[`s-${i}`] = { status: 'scheduled', start_at: at };
      return reminder1h(`s-${i}`, at);
    });
    const w = setup({ sessions });
    for (const r of w0) await w.svc.enqueue(r);
    expect(await w.svc.drain()).toBe(USER_WINDOW_MAX + 2);
  });
});

describe('B-648-6: no request waits on Expo, and every Expo call has a cancelling deadline', () => {
  it('sendPush returns while the Expo send never settles; the stalled send is aborted at the deadline', async () => {
    let seenSignal: AbortSignal | null = null;
    const stalled = expo(
      (_m, signal) =>
        new Promise((_resolve, reject) => {
          seenSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const w = setup({ client: stalled });
    w.svc.sendDeadlineMs = 25;
    const s1 = new Date(NOON_UTC.getTime() + 60 * 60_000);
    w.sessions['sess-1'] = { status: 'scheduled', start_at: s1 };
    w.sessions['sess-2'] = { status: 'scheduled', start_at: s1 };

    // The enqueue (what an emitter awaits) never touches Expo.
    await w.svc.enqueue(reminder1h('sess-1', s1));
    await w.svc.enqueue(reminder1h('sess-2', s1));
    expect(stalled.send).not.toHaveBeenCalled();

    const started = Date.now();
    await w.svc.drain();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(seenSignal).not.toBeNull();
    expect(seenSignal!.aborted).toBe(true);
    // Both rows were attempted (the second was not held by the first) and
    // neither is retried: Expo may have accepted a timed-out request.
    expect(stalled.send).toHaveBeenCalledTimes(2);
    expect(w.rows.map((r) => [r.status, r.result_code])).toEqual([
      ['dropped', 'transport-timeout'],
      ['dropped', 'transport-timeout'],
    ]);
  });

  it('a stalled receipt fetch is aborted and releases the sweep latch', async () => {
    const c = expo();
    c.getReceipts.mockImplementationOnce(
      (_ids, signal) =>
        new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    );
    const w = setup({ client: c });
    w.svc.receiptDeadlineMs = 25;
    await w.svc.enqueue(base());
    await w.svc.drain();
    w.svc.clock = new Date(NOON_UTC.getTime() + RECEIPT_MIN_AGE_MS);
    expect(await w.svc.checkReceipts()).toEqual({ checked: 0, remaining: 1 });
    // The latch is free: the next sweep runs and settles the receipt.
    c.getReceipts.mockResolvedValueOnce({ 'ticket-1': { status: 'ok' } });
    expect(await w.svc.checkReceipts()).toEqual({ checked: 1, remaining: 0 });
  });

  it('HTTP 503 (Expo did not accept) is retried with backoff, then dropped after MAX_ATTEMPTS', async () => {
    const c = expo(async () => {
      throw new ExpoHttpError(503, true, null);
    });
    const w = setup({ client: c });
    await w.svc.enqueue(base());
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await w.svc.drain();
      w.svc.clock = new Date(w.svc.clock.getTime() + 60 * 60_000);
    }
    expect(c.send).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(w.rows[0].status).toBe('dropped');
    expect(w.rows[0].result_code).toBe('provider-unavailable');
  });

  it('the fetch transport passes the signal and classifies HTTP errors', async () => {
    const calls: Array<{ url: string; signal: AbortSignal }> = [];
    const ok = new FetchExpoPushClient(async (url, init) => {
      calls.push({ url, signal: init.signal });
      return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok', id: 'x' }] }) };
    });
    const ctrl = new AbortController();
    await expect(ok.send([{ to: TOKEN, body: 'b' }], ctrl.signal)).resolves.toEqual([
      { status: 'ok', id: 'x' },
    ]);
    expect(calls[0].signal).toBe(ctrl.signal);
    const down = new FetchExpoPushClient(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ errors: [{ code: 'INTERNAL' }] }),
    }));
    await expect(down.send([], ctrl.signal)).rejects.toMatchObject({
      retryable: true,
      status: 503,
    });
    const bad = new FetchExpoPushClient(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ errors: [{ code: 'VALIDATION_ERROR' }] }),
    }));
    await expect(bad.getReceipts([], ctrl.signal)).rejects.toMatchObject({
      retryable: false,
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('OR-113-5: quiet hours 21:00-08:00 in the recipient zone', () => {
  it('a message at 23:00 New York waits until 08:00 New York; Tokyo (noon) is sent now', async () => {
    const w = setup({ clock: NY_LATE, tokens: { 'u-1': TOKEN, 'u-2': COACH_TOKEN } });
    const ny = await w.svc.enqueue(base());
    const tokyo = await w.svc.enqueue(base({ userId: 'u-2', timeZone: 'Asia/Tokyo' }));
    expect(ny.code).toBe('deferred');
    expect(ny.notBefore.toISOString()).toBe('2026-06-02T12:00:00.000Z');
    expect(tokyo.code).toBe('queued');
    expect(await w.svc.drain()).toBe(1);
    expect(w.client.send.mock.calls[0][0][0].to).toBe(COACH_TOKEN);
    w.svc.clock = new Date('2026-06-02T12:00:00Z');
    expect(await w.svc.drain()).toBe(1);
  });

  it('urgent bypass: the 1 h reminder, and a cancellation of a session before 10:00 local', () => {
    expect(
      quietHoursFor({ kind: NotificationKind.BOOKING_REMINDER_1H, timeZone: NY, now: NY_LATE })
        .deferred,
    ).toBe(false);
    const early = quietHoursFor({
      kind: NotificationKind.BOOKING_CANCELLED,
      timeZone: NY,
      now: NY_LATE,
      context: { scheduledAt: '2026-06-02T11:30:00Z' }, // 07:30 EDT
    });
    expect(early).toMatchObject({ deferred: false, reason: 'urgent' });
    const later = quietHoursFor({
      kind: NotificationKind.BOOKING_CANCELLED,
      timeZone: NY,
      now: NY_LATE,
      context: { scheduledAt: '2026-06-02T20:00:00Z' }, // 16:00 EDT
    });
    expect(later).toMatchObject({ deferred: true, reason: 'quiet_hours' });
    expect(
      quietHoursFor({ kind: NotificationKind.MESSAGE_RECEIVED, timeZone: null, now: NY_LATE }),
    ).toMatchObject({ deferred: false, reason: 'no-zone' });
  });

  it('a deferred 24 h reminder is re-rendered at 08:00 ("today"), and dropped if the session was cancelled', async () => {
    const at = new Date('2026-06-03T02:00:00Z'); // 22:00 EDT Jun 2
    const w = setup({
      clock: new Date('2026-06-02T02:00:00Z'), // 22:00 EDT Jun 1
      sessions: {
        'sess-1': { status: 'scheduled', start_at: at },
        'sess-2': { status: 'canceled', start_at: at },
      },
    });
    const r24 = (id: string) =>
      base({
        userId: 'coach-1',
        kind: NotificationKind.BOOKING_REMINDER_24H,
        dedupeKey: `r24:${id}`,
        collapseKey: `r24:${id}`,
        context: {
          sessionId: id,
          scheduledAt: at.toISOString(),
          timeZone: NY,
          otherPartyDisplayName: 'Jamie',
        },
      });
    expect((await w.svc.enqueue(r24('sess-1'))).code).toBe('deferred');
    expect((await w.svc.enqueue(r24('sess-2'))).code).toBe('deferred');
    expect(await w.svc.drain()).toBe(0);
    w.svc.clock = new Date('2026-06-02T12:00:00Z');
    expect(await w.svc.drain()).toBe(1);
    expect(w.client.send.mock.calls[0][0][0].body).toBe(
      'Your session with Jamie is today at 10:00 PM EDT.',
    );
    expect(w.rows.find((r) => r.dedupe_key === 'r24:sess-2')?.result_code).toBe('obsolete');
  });
});

describe('tokens, Android without the FCM key, receipts', () => {
  it('DeviceNotRegistered on the ticket clears only that exact token', async () => {
    const c = expo(async () => [
      { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } },
    ]);
    const w = setup({ client: c });
    await w.svc.enqueue(base());
    await w.svc.drain();
    expect(w.tokens['u-1']).toBeNull();
    expect(w.rows[0].result_code).toBe('device-not-registered');
  });

  it('InvalidCredentials keeps the token, never records the push as sent, and alerts once an hour', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    errorSpy.mockClear();
    const c = expo(async () => [
      { status: 'error', message: 'x', details: { error: 'InvalidCredentials' } },
    ]);
    const w = setup({ client: c });
    for (let i = 0; i < 3; i += 1) {
      await w.svc.enqueue(base({ collapseKey: `k-${i}` }));
    }
    await w.svc.drain();
    expect(w.tokens['u-1']).toBe(TOKEN);
    expect(w.rows.map((r) => [r.status, r.result_code])).toEqual(
      Array(3).fill(['dropped', 'provider-not-configured']),
    );
    const alerts = errorSpy.mock.calls.filter((c2) =>
      String(c2[0]).includes('PUSH_PROVIDER_NOT_CONFIGURED'),
    );
    expect(alerts).toHaveLength(1);
  });

  it('receipts survive a restart: a new process reads them from the outbox and clears a dead token', async () => {
    const w = setup({});
    await w.svc.enqueue(base());
    await w.svc.drain();
    const c2 = expo();
    c2.getReceipts.mockResolvedValueOnce({
      'ticket-1': { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } },
    });
    const restarted = new Clocked(Object.create(w.db), c2);
    restarted.clock = new Date(NOON_UTC.getTime() + RECEIPT_MIN_AGE_MS);
    expect(await restarted.checkReceipts()).toEqual({ checked: 1, remaining: 0 });
    expect(c2.getReceipts.mock.calls[0][0]).toEqual(['ticket-1']);
    expect(w.tokens['u-1']).toBeNull();
    expect(w.rows[0].receipt_checked_at).not.toBeNull();
  });

  it('a row left `sending` by a dead process is closed at lease expiry, never sent twice', async () => {
    const w = setup({});
    await w.svc.enqueue(base());
    w.rows[0].status = 'sending';
    // B-648-8: it had been handed to Expo (an unstarted claim is re-queued instead).
    w.rows[0].handed_off_at = new Date(NOON_UTC.getTime() - 60_000);
    w.rows[0].lease_until = new Date(NOON_UTC.getTime() - 1);
    expect(await w.svc.sweep()).toEqual({ sent: 0, expired: 1 });
    expect(w.rows[0].result_code).toBe('lease-expired');
    expect(w.client.send).not.toHaveBeenCalled();
  });

  it('never puts health detail or message text on the lock screen', () => {
    const quiet = lockScreenCopy(NotificationKind.WEIGHT_TREND_ALERT, 'You are down 2.4 kg');
    expect(quiet.body).not.toMatch(/kg|2\.4/);
    expect(lockScreenCopy(NotificationKind.MESSAGE_RECEIVED, 'New message from Coach K').body).toBe(
      'New message from Coach K',
    );
    for (const copy of [quiet, lockScreenCopy('unknown_kind', 'x')]) {
      expect(copy.body).not.toMatch(/!/);
      expect(copy.title).not.toMatch(/!/);
    }
  });
});

// ── Real NotificationsService + BookingEmitter + PushDeliveryService ─────────

interface NRow {
  id: string;
  user_id: string;
  kind: string;
  channel: string;
  body: string;
  deep_link: string | null;
  read_at: Date | null;
  created_at: Date;
  inbox_hidden: boolean;
  ai_draft_id?: string | null;
}

function serviceWorld(prefs: Record<string, Record<string, unknown>> = {}) {
  const w = setup({});
  const rows: NRow[] = [];
  const visible = (r: NRow, where: { user_id: string; read_at?: null; inbox_hidden?: boolean }) =>
    r.user_id === where.user_id &&
    (where.read_at !== null || r.read_at === null) &&
    (where.inbox_hidden === undefined || r.inbox_hidden === where.inbox_hidden);
  const db = {
    ...w.db,
    notificationPreferences: {
      findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) =>
        prefs[where.user_id] ? { user_id: where.user_id, ...prefs[where.user_id] } : null,
      ),
    },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: { where: { user_id: string } }) =>
        where.user_id === 'coach-1' ? { timezone: NY } : null,
      ),
    },
    coachingSession: {
      findUnique: jest.fn(async () => ({
        coach_id: 'coach-1',
        status: 'scheduled',
        start_at: new Date('2026-06-02T13:00:00Z'),
      })),
    },
    user: {
      ...w.db.user,
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
        expo_push_token: w.tokens[where.id] ?? null,
        coach_id: where.id === 'u-1' ? 'coach-1' : null,
      })),
    },
    notification: {
      create: jest.fn(
        async ({
          data,
        }: {
          data: Omit<NRow, 'id' | 'read_at' | 'created_at' | 'inbox_hidden' | 'deep_link'> & {
            inbox_hidden?: boolean;
            deep_link?: string | null;
          };
        }) => {
          const row: NRow = {
            ...data,
            inbox_hidden: data.inbox_hidden ?? false,
            deep_link: data.deep_link ?? null,
            id: `n-${rows.length + 1}`,
            read_at: null,
            created_at: new Date(),
          };
          rows.push(row);
          return row;
        },
      ),
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: {
            user_id: string;
            kind: string;
            channel: string;
            body: string;
            deep_link: string | null;
          };
        }) =>
          rows.find(
            (r) =>
              r.user_id === where.user_id &&
              r.kind === where.kind &&
              r.channel === where.channel &&
              r.body === where.body &&
              r.deep_link === where.deep_link,
          ) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: { user_id: string; inbox_hidden?: boolean } }) =>
        rows.filter((r) => visible(r, where)),
      ),
      findUnique: jest.fn(async () => null),
      count: jest.fn(
        async ({ where }: { where: { user_id: string; read_at?: null; inbox_hidden?: boolean } }) =>
          rows.filter((r) => visible(r, where)).length,
      ),
    },
  };
  const delivery = new Clocked(Object.create(db), w.client);
  delivery.autoDrain = false;
  const notifications = new NotificationsService(Object.create(db), undefined, undefined, delivery);
  const emitter = new BookingEmitter(notifications, Object.create(db));
  return { ...w, outbox: w.rows, rows, delivery, notifications, emitter };
}

describe('emitters through the real services', () => {
  const reminder = (recipientUserId: string) => ({
    recipientUserId,
    otherPartyDisplayName: 'Coach K',
    sessionId: 'sess-1',
    scheduledAt: new Date('2026-06-02T13:00:00Z'),
  });

  it('one push to each eligible participant, one inbox item each, and the call never waits on Expo', async () => {
    const w = serviceWorld();
    w.tokens['client-1'] = TOKEN;
    await w.emitter.emitReminder1h(reminder('client-1'));
    await w.emitter.emitReminder1h(reminder('coach-1'));
    expect(w.client.send).not.toHaveBeenCalled();
    expect(await w.delivery.drain()).toBe(2);
    expect(w.rows.map((r) => [r.user_id, r.channel])).toEqual([
      ['client-1', 'inapp'],
      ['coach-1', 'inapp'],
    ]);
    expect(await w.notifications.getUnreadCount('client-1')).toBe(1);
  });

  it('zero pushes when the recipient opted out of booking pushes or muted everything', async () => {
    const w = serviceWorld({
      'client-1': { muted: true },
      'coach-1': { muted: false, booking_push: false },
    });
    await w.emitter.emitReminder1h(reminder('client-1'));
    await w.emitter.emitReminder1h(reminder('coach-1'));
    expect(w.outbox).toHaveLength(0);
  });

  it('B-648-7: a proven push twin is hidden; a sole push row of a listed kind stays visible', async () => {
    const w = serviceWorld();
    // A writer that stores inapp + push for one event (drip, purchase, first payment).
    await w.notifications.createNotification({
      user_id: 'u-1',
      kind: NotificationKind.MESSAGE_RECEIVED,
      body: 'New message from Coach K',
      deep_link: 'tgp://messages/t-1',
      channel: 'inapp',
    });
    await w.notifications.createNotification({
      user_id: 'u-1',
      kind: NotificationKind.MESSAGE_RECEIVED,
      body: 'New message from Coach K',
      deep_link: 'tgp://messages/t-1',
      channel: 'push',
      push_twin: true,
    });
    // A sole push row with a listed kind (for example a coach-approved AI notification).
    await w.notifications.createNotification({
      user_id: 'u-1',
      kind: NotificationKind.MISSED_CHECKIN,
      body: 'Your coach left you a note',
      channel: 'push',
    });
    expect(w.rows.map((r) => r.inbox_hidden)).toEqual([false, true, false]);
    const page = await w.notifications.listNotifications('u-1', {});
    expect(page.items.map((i: { id: string }) => i.id)).toEqual(['n-1', 'n-3']);
    expect(page.unreadCount).toBe(2);
    expect(await w.notifications.getUnreadCount('u-1')).toBe(2);
  });

  it('C-648-2: a production boot without PushDeliveryService fails loudly', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const unwired = new NotificationsService(Object.create({}));
      expect(() => unwired.onModuleInit()).toThrow(/PushDeliveryService/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
