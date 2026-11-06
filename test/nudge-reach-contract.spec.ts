import { Logger, NotFoundException } from '@nestjs/common';
import { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { NudgesService } from '../src/nudges/nudges.service';
import { NudgesModule } from '../src/nudges/nudges.module';
import { CoachNudgesController } from '../src/nudges/coach-nudges.controller';
import { NotificationsModule } from '../src/notifications/notifications.module';
import { NotificationsService } from '../src/notifications/notifications.service';
import { InboxBlockRule } from '../src/notifications/inbox-block-rule';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

// NUDGE-REACH-BE (agent 199; owner #199-E6 "199-D11 - Nudge - depends on
// exactly what that entails/looks like for the client") — contract: a coach's
// nudge from the client file (POST /coach/clients/:id/nudges; the editor
// promises "Send a push-style notification to <name>") reaches the client the
// way the churn send's does: one inbox row in the inbox the Home bell opens
// (GET /notifications), with the coach's own title and whole message, and one
// push, the copy table's new-message line, that opens that inbox.
//
// Real NudgesService.createForClient, real NotificationsService.pushToUser,
// the real push outbox (PF-3-BE: the one send path; its Expo transport is the
// fake) and the real inbox reads (listNotifications / getUnreadCount, with the
// real inbox block rule). Only storage is a fake, which evaluates the queries'
// where. Red on main 1bef2db6: createForClient saved a CoachNudge row only.

const TOKEN = 'ExponentPushToken[nudgereachbe199]';
const COACH = 'coach-a';
const OTHER_COACH = 'coach-b';
const CLIENT = '3d0e8a52-6b1f-4c7a-9e24-1f5b7c9d2a60';
const OTHER_CLIENT = 'a71c2e94-0d3b-4f58-8b6e-2c4d6e8f0a13';

type Row = Record<string, unknown>;

/** Enough of Prisma's where semantics for these queries (OR/AND/NOT, null, not/in/notIn/startsWith, json path). */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    if (key === 'NOT') return !(Array.isArray(cond) ? cond : [cond]).some((w) => matches(row, w as Row));
    const v = row[key] ?? null;
    if (cond === null) return v === null;
    if (typeof cond !== 'object') return v === cond;
    const c = cond as Row;
    if ('path' in c) {
      const at = (c.path as string[]).reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Row)[k] : undefined), v);
      return at === c.equals;
    }
    if ('not' in c && (c.not === null ? v === null : v === c.not)) return false;
    if ('in' in c && !(c.in as unknown[]).includes(v)) return false;
    if ('notIn' in c && (c.notIn as unknown[]).includes(v)) return false;
    if ('startsWith' in c && !(typeof v === 'string' && v.startsWith(c.startsWith as string))) return false;
    return true;
  });
}

let queuedSend: jest.Mock<Promise<ExpoPushTicket[]>, [ExpoPushMessage[]]>;

function world(opts: { muted?: boolean; prefsUnreadable?: boolean; at?: string; zone?: string } = {}) {
  const clock = { at: opts.at ? new Date(opts.at) : new Date() };
  const inbox: Row[] = [];
  const nudges: Row[] = [];
  const blocks: Row[] = [];
  const users: Row[] = [
    { id: CLIENT, coach_id: COACH, role: 'student' },
    { id: OTHER_CLIENT, coach_id: OTHER_COACH, role: 'student' },
  ];
  let seq = 0;
  const tx = {
    coachNudge: {
      create: jest.fn(async (a: { data: Row }) => {
        const row = { id: `nudge-${++seq}`, created_at: new Date(), read_at: null, ...a.data };
        nudges.push(row);
        return { ...row };
      }),
    },
    notification: {
      create: jest.fn(async (a: { data: Row }) => {
        const row = { read_at: null, inbox_hidden: false, created_at: new Date(), ...a.data };
        inbox.push(row);
        return row;
      }),
    },
  };
  // The client's NotificationPreferences row: Mute all and the zone quiet hours read.
  const pref: Row = {
    ...(opts.muted ? { muted: true } : {}),
    ...(opts.zone ? { timezone: opts.zone, timezone_updated_at: new Date('2026-01-01T00:00:00Z') } : {}),
  };
  const outbox = pushOutboxWorld({ now: () => clock.at, prefs: Object.keys(pref).length ? { [CLIENT]: pref } : {} });
  outbox.tokens[CLIENT] = TOKEN;
  const db = {
    ...outbox.db,
    coachNudge: tx.coachNudge,
    notification: {
      ...tx.notification,
      findMany: jest.fn(async (a: { where: Row }) => inbox.filter((r) => matches(r, a.where))),
      count: jest.fn(async (a: { where: Row }) => inbox.filter((r) => matches(r, a.where)).length),
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async (a: { where: Row }) => inbox.find((r) => matches(r, a.where)) ?? null),
    },
    notificationPreferences: {
      findUnique: jest.fn(async (a: { where: { user_id: string } }) => {
        if (opts.prefsUnreadable) throw new Error('db down');
        return outbox.db.notificationPreferences.findUnique(a);
      }),
    },
    userBlock: {
      findMany: jest.fn(async (a: { where: Row }) => blocks.filter((b) => matches(b, a.where))),
      findFirst: jest.fn(async (a: { where: Row }) => blocks.find((b) => matches(b, a.where)) ?? null),
    },
    user: {
      ...outbox.db.user,
      findFirst: jest.fn(async (a: { where: Row }) => {
        const u = users.find((r) => matches(r, a.where));
        return u ? { id: u.id } : null;
      }),
      findUnique: jest.fn(async () => ({ role: 'student', expo_push_token: TOKEN })),
    },
    // Rolls back what the callback wrote when it throws, as Prisma does.
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const before = { inbox: inbox.length, nudges: nudges.length };
      try {
        return await fn(tx);
      } catch (err) {
        inbox.length = before.inbox;
        nudges.length = before.nudges;
        throw err;
      }
    }),
  };
  const transport = stub<ExpoPushClient>({ send: queuedSend, getReceipts: jest.fn(async () => ({})) });
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), transport);
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db), undefined, undefined, delivery,
    new InboxBlockRule(stub<ConstructorParameters<typeof InboxBlockRule>[0]>(db)),
  );
  const direct = jest.spyOn(notifications, 'pushToUser');
  // As NudgesModule wires it (positional: PrismaService, NotificationsService).
  const svc = new (NudgesService as unknown as new (p: unknown, n: unknown) => NudgesService)(db, notifications);
  return {
    clock,
    outboxRows: outbox.rows,
    delivery,
    inbox,
    nudges,
    blocks,
    direct,
    notifications,
    send: (title: string, body: string, coachId = COACH, clientId = CLIENT) =>
      svc.createForClient(coachId, clientId, title, body),
    /** What reached the Expo transport, after the fire-and-forget push settles. */
    delivered: async () => {
      const results = await Promise.all(direct.mock.results.map((r) => Promise.resolve(r.value).catch((e) => e)));
      await delivery.drain(); // PF-3-BE: the outbox sends what was queued
      return { results, sent: queuedSend.mock.calls.flatMap(([chunk]) => chunk) };
    },
  };
}

// The coach's own words (the nudge modal: a title and a message).
const TITLE = 'Check in on your week';
const BODY = 'Hi Sam, you missed two sessions and your weigh-in is up. Can we talk tonight about the plan?';

describe('NUDGE-REACH-BE contract: coach nudge -> client inbox row (coach title, whole text) -> one push', () => {
  let warn: jest.SpyInstance;
  beforeAll(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  beforeEach(() => {
    warn.mockClear();
    queuedSend = jest.fn(async (chunk: ExpoPushMessage[]) => chunk.map(() => ({ status: 'ok' as const, id: 'ticket' })));
  });
  afterAll(() => jest.restoreAllMocks());

  it('LS-1226 B1: retry after a lost reply creates one nudge, one inbox row and one push', async () => {
    const w = world();
    // The server commits, but the coach's phone never receives the reply.
    // Its composer retains title/body and Send becomes available again.
    await w.send(TITLE, BODY);
    // The coach retries that same send, as the current phone callers do.
    await w.send(TITLE, BODY);
    const { sent } = await w.delivered();
    expect({
      nudges: w.nudges.length,
      inboxRows: w.inbox.length,
      deliveredPushes: sent.length,
    }).toEqual({ nudges: 1, inboxRows: 1, deliveredPushes: 1 });
  });

  it('(failed before) open pair: one inbox row with the coach title and whole message, and one push that opens it', async () => {
    const w = world();
    const nudge = await w.send(TITLE, BODY);
    const { results, sent } = await w.delivered();

    // The response is the CoachNudge row, as before.
    expect(nudge).toMatchObject({ coach_id: COACH, client_id: CLIENT, title: TITLE, body: BODY, read_at: null });
    expect(w.nudges).toHaveLength(1);

    // One push through the one send path: the new-message line, nothing of the message.
    expect(results).toEqual([{ delivered: true, code: 'delivered', detail: 'queued' }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(TOKEN);
    expect({ title: sent[0].title, body: sent[0].body }).toEqual({
      title: 'New message',
      body: 'You have a new message. Open the app to read it.',
    });
    expect(`${sent[0].title} ${sent[0].body}`).not.toMatch(/Sam|weigh-in|sessions|Check in|coach/i);
    const data = sent[0].data as Row;
    expect(data).toEqual({
      type: 'coach_nudge',
      kind: 'coach_nudge',
      actionScreen: 'NotificationCenter',
      nudge_id: nudge.id,
      notification_id: expect.any(String),
    });
    // Mute all rule, dedupe key and block re-check: the churn send's options.
    expect(w.direct).toHaveBeenCalledTimes(1);
    expect(w.direct.mock.calls[0][5]).toEqual({
      kind: 'coach_nudge',
      muteAllOnly: true,
      dedupeKey: `coach_nudge:${nudge.id}`,
      otherUserId: COACH,
    });

    // The inbox the bell opens (GET /notifications) lists one row: the coach's title, the whole text.
    const page = await w.notifications.listNotifications(CLIENT, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: data.notification_id,
      user_id: CLIENT,
      kind: 'coach_nudge',
      channel: 'inapp',
      body: BODY,
      payload: { title: TITLE, nudge_id: nudge.id, coach_id: COACH },
    });
    expect(page.unreadCount).toBe(1);
    expect(await w.notifications.getUnreadCount(CLIENT)).toBe(1); // the bell badge
    expect((await w.notifications.listNotifications(OTHER_CLIENT, {})).items).toEqual([]);
  });

  it('(failed before) Mute all on: the inbox row, no push (owner #171-3)', async () => {
    const w = world({ muted: true });
    const nudge = await w.send(TITLE, BODY);
    const { results, sent } = await w.delivered();
    expect(results).toEqual([]);
    expect(sent).toEqual([]);
    expect((await w.notifications.listNotifications(CLIENT, {})).items).toEqual([
      expect.objectContaining({ body: BODY, payload: { title: TITLE, nudge_id: nudge.id, coach_id: COACH } }),
    ]);
  });

  it('(failed before) a push failure never fails the send: the nudge and its inbox row stay saved', async () => {
    const w = world();
    w.direct.mockRejectedValueOnce(new Error('expo down'));
    const nudge = await w.send(TITLE, BODY);
    await w.delivered();
    expect(w.direct).toHaveBeenCalledTimes(1);
    expect(w.nudges).toEqual([expect.objectContaining({ id: nudge.id, body: BODY })]);
    expect((await w.notifications.listNotifications(CLIENT, {})).items).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Push failed for nudge=${nudge.id}`));
  });

  it('(failed before) a push that throws at once never fails the send either', async () => {
    const w = world();
    w.direct.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const nudge = await w.send(TITLE, BODY);
    expect(w.nudges).toEqual([expect.objectContaining({ id: nudge.id })]);
    expect((await w.notifications.listNotifications(CLIENT, {})).items).toHaveLength(1);
  });

  it('(failed before) an unreadable Mute all switch: the inbox row, no push', async () => {
    const w = world({ prefsUnreadable: true });
    await w.send(TITLE, BODY);
    const { sent } = await w.delivered();
    expect(w.direct).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect((await w.notifications.listNotifications(CLIENT, {})).items).toHaveLength(1);
  });

  it('a block either way: 403 messaging.blocked, nothing written, no push', async () => {
    for (const block of [{ blocker_id: CLIENT, blocked_id: COACH }, { blocker_id: COACH, blocked_id: CLIENT }]) {
      const w = world();
      w.blocks.push(block);
      await expect(w.send(TITLE, BODY)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ code: 'messaging.blocked' }),
      });
      const { sent } = await w.delivered();
      expect(w.nudges).toEqual([]);
      expect(w.inbox).toEqual([]);
      expect(w.direct).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    }
  });

  it('(failed before) a block after the send hides the row (inbox-block-rule); unblock brings it back', async () => {
    const w = world();
    await w.send(TITLE, BODY);
    expect((await w.notifications.listNotifications(CLIENT, {})).items).toHaveLength(1);
    for (const block of [{ blocker_id: CLIENT, blocked_id: COACH }, { blocker_id: COACH, blocked_id: CLIENT }]) {
      w.blocks.push(block);
      expect((await w.notifications.listNotifications(CLIENT, {})).items).toEqual([]);
      expect(await w.notifications.getUnreadCount(CLIENT)).toBe(0);
      w.blocks.length = 0;
      expect((await w.notifications.listNotifications(CLIENT, {})).items).toHaveLength(1);
    }
  });

  it('a client who is not this coach\'s: 404, nothing written, no push', async () => {
    const w = world();
    await expect(w.send(TITLE, BODY, COACH, OTHER_CLIENT)).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.send(TITLE, BODY, COACH, 'no-such-user')).rejects.toBeInstanceOf(NotFoundException);
    const { sent } = await w.delivered();
    expect(w.nudges).toEqual([]);
    expect(w.inbox).toEqual([]);
    expect(w.direct).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('(failed before) two nudges: two inbox rows and two pushes, one each (dedupe key is per nudge)', async () => {
    const w = world();
    const a = await w.send('One', 'First message');
    const b = await w.send('Two', 'Second message');
    const { sent } = await w.delivered();
    expect(sent).toHaveLength(2);
    expect(sent.map((m) => (m.data as Row).nudge_id).sort()).toEqual([a.id, b.id].sort());
    expect((await w.notifications.listNotifications(CLIENT, {})).items).toHaveLength(2);
  });

  it('(failed before) inside quiet hours: the inbox row at once, the push held to 08:00 in the client zone', async () => {
    // 23:00 PDT on 10-05; the next 08:00 PDT is 15:00Z on 10-06.
    const w = world({ at: '2026-10-06T06:00:00Z', zone: 'America/Los_Angeles' });
    const nudge = await w.send(TITLE, BODY);
    const { results, sent } = await w.delivered();
    expect(results).toEqual([expect.objectContaining({ delivered: true, detail: 'deferred' })]);
    expect(sent).toEqual([]);
    expect(w.outboxRows).toEqual([
      expect.objectContaining({ status: 'pending', deferred_reason: 'quiet_hours', not_before: new Date('2026-10-06T15:00:00Z') }),
    ]);
    expect((await w.notifications.listNotifications(CLIENT, {})).items).toHaveLength(1);
    w.clock.at = new Date('2026-10-06T15:00:00Z');
    await w.delivery.drain();
    const morning = queuedSend.mock.calls.flatMap(([chunk]) => chunk);
    expect(morning).toHaveLength(1);
    expect((morning[0].data as Row).nudge_id).toBe(nudge.id);
  });

  it('(failed before) the longest message (500 characters) shows whole in the inbox row, never on the lock screen', async () => {
    const w = world();
    const long = 'Your plan for the week, step by step. '.repeat(14).slice(0, 500);
    expect(long).toHaveLength(500);
    await w.send('A'.repeat(80), long);
    const { sent } = await w.delivered();
    const [row] = (await w.notifications.listNotifications(CLIENT, {})).items;
    expect(row.body).toBe(long);
    expect((row.payload as Row).title).toBe('A'.repeat(80));
    expect(`${sent[0].title} ${sent[0].body}`).not.toContain('step by step');
  });

  it('the 10-a-minute throttle on POST /coach/clients/:id/nudges is unchanged', () => {
    const handler = CoachNudgesController.prototype.create;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60000);
  });

  it('(failed before) production wiring: NudgesModule imports NotificationsModule and NudgesService takes NotificationsService (not optional)', () => {
    expect(Reflect.getMetadata('imports', NudgesModule) ?? []).toContain(NotificationsModule);
    const params = (Reflect.getMetadata('design:paramtypes', NudgesService) ?? []) as unknown[];
    expect(params).toContain(NotificationsService);
    // No @Optional(): a boot without the push sender fails instead of sending no push.
    expect(Reflect.getMetadata('optional:paramtypes', NudgesService) ?? []).toEqual([]);
  });
});
