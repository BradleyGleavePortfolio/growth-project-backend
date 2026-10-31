import { randomUUID } from 'crypto';
import { Logger } from '@nestjs/common';
import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { ChurnInterventionService } from '../src/coach/command-center/churn-intervention.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { InboxBlockRule } from '../src/notifications/inbox-block-rule';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

// B-LSNOTIFY-2 (FR-NOTIFY2, agent 177; b#1171 AUDIT 6426427779) — contract:
// coach sends a churn nudge -> the client's phone gets the new-message
// lock-screen line (CPC-W2, owner DECISIONS #178-3) -> the tap opens the inbox
// the Home bell opens -> that inbox lists the nudge with the coach's whole
// message. B-LONOTIFY3-1 (FR-NOTIFY4): while the two are in a block either way
// the row is not listed, counted or marked; unblock brings it back.
//
// Real ChurnInterventionService.sendIntervention, real
// NotificationsService.pushToUser, the real push outbox (PF-3-BE: the one send
// path; its Expo transport is the fake) and the real inbox
// reads (listNotifications / getUnreadCount, with the real current-coach inbox
// rule). Only storage is a fake, which evaluates the inbox query's where.
//
// The phone side (mobile main 1dd970e7), cited not imported:
//   - src/services/pushNotifications.ts:167-179 — a push's data.actionScreen is
//     the tap screen; with none, :159-165 falls back to NotificationCenter for
//     any data.kind (no kind = no navigation, the bug).
//   - src/services/pushTapRouter.ts:95 — client 'NotificationCenter' ->
//     Home > NotificationCenter, the screen the Home bell opens
//     (src/components/home/HomeHeaderActions.tsx:208).
//   - src/services/notificationsApi.ts:409-426 — that screen reads
//     GET /notifications; normalizeNotification :326-374 shows payload.title as
//     the row title and body in full (NotificationCenterScreen.tsx:266).

const TOKEN = 'ExponentPushToken[frnotify2churninbox]';
const COACH = 'coach-a';
const CLIENT = '6f1c1a8e-2b7d-4c3e-9a51-0d2f4e6b8a10';
const OTHER_CLIENT = '0b9e4f2a-7c61-4d8e-8f3a-5e2d1c0b9a77';

type Row = Record<string, unknown>;

/** Enough of Prisma's where semantics for the inbox query (user, OR/NOT, null, not/in/notIn/startsWith, json path). */
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

function world(opts: { muted?: boolean; token?: string | null } = {}) {
  const inbox: Row[] = [];
  const nudges: Row[] = [];
  const blocks: Row[] = [];
  const intervention = {
    id: 'int-1', coach_id: COACH, client_id: CLIENT, status: 'draft', draft_text: 'Hi',
    send_idempotency_key: null as string | null, nudge_id: null as string | null, sent_at: null as Date | null,
  };
  const notification = {
    create: jest.fn(async (a: { data: Row }) => {
      const row = { read_at: null, inbox_hidden: false, created_at: new Date(), ...a.data };
      inbox.push(row);
      return row;
    }),
    findMany: jest.fn(async (a: { where: Row }) => inbox.filter((r) => matches(r, a.where))),
    count: jest.fn(async (a: { where: Row }) => inbox.filter((r) => matches(r, a.where)).length),
    findUnique: jest.fn(async () => null),
    findFirst: jest.fn(async (a: { where: Row }) => inbox.find((r) => matches(r, a.where)) ?? null),
    update: jest.fn(async (a: { where: { id: string }; data: Row }) => {
      const row = inbox.find((r) => r.id === a.where.id);
      return Object.assign(row ?? {}, a.data);
    }),
    updateMany: jest.fn(async (a: { where: Row; data: Row }) => {
      const hit = inbox.filter((r) => matches(r, a.where));
      hit.forEach((r) => Object.assign(r, a.data));
      return { count: hit.length };
    }),
  };
  const tx = {
    $queryRaw: jest.fn(async () => [{ id: CLIENT, coach_id: COACH, role: 'student', deleted_at: null }]),
    churnIntervention: {
      updateMany: jest.fn(async (a: { data: Row }) => {
        if (intervention.status === 'sent') return { count: 0 };
        Object.assign(intervention, a.data);
        return { count: 1 };
      }),
      findFirst: jest.fn(async () => intervention),
    },
    coachNudge: { create: jest.fn(async (a: { data: Row }) => (nudges.push(a.data), a.data)) },
    notification,
  };
  // PF-3-BE: the push outbox the pushes queue in (no zone known: no quiet hours).
  const outbox = pushOutboxWorld({ now: () => new Date() });
  const db = {
    ...outbox.db,
    ...tx,
    churnIntervention: {
      ...tx.churnIntervention,
      findFirst: jest.fn(async (a: { where: Row }) =>
        a.where.id === intervention.id ||
        (a.where.send_idempotency_key !== undefined && a.where.send_idempotency_key === intervention.send_idempotency_key)
          ? intervention
          : null,
      ),
    },
    notificationPreferences: { findUnique: jest.fn(async () => (opts.muted ? { muted: true } : null)) },
    userBlock: {
      findMany: jest.fn(async (a: { where: Row }) => blocks.filter((b) => matches(b, a.where))),
      findFirst: jest.fn(async (a: { where: Row }) => blocks.find((b) => matches(b, a.where)) ?? null),
    },
    user: {
      ...outbox.db.user,
      findUnique: jest.fn(async () => ({
        role: 'student',
        expo_push_token: opts.token === undefined ? TOKEN : opts.token,
      })),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const before = { inbox: inbox.length, nudges: nudges.length, status: intervention.status };
      try {
        return await fn(tx);
      } catch (err) {
        inbox.length = before.inbox;
        nudges.length = before.nudges;
        intervention.status = before.status;
        throw err;
      }
    }),
  };
  // As NotificationsModule wires it: the inbox's block rule (B-LONOTIFY3-1).
  const transport = stub<ExpoPushClient>({
    send: queuedSend,
    getReceipts: jest.fn(async () => ({})),
  });
  const delivery = new PushDeliveryService(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), transport);
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db), undefined, undefined, delivery,
    new InboxBlockRule(stub<ConstructorParameters<typeof InboxBlockRule>[0]>(db)),
  );
  const direct = jest.spyOn(notifications, 'pushToUser');
  const svc = new ChurnInterventionService(
    stub<ConstructorParameters<typeof ChurnInterventionService>[0]>(db),
    stub<ConstructorParameters<typeof ChurnInterventionService>[1]>({}),
    stub<ConstructorParameters<typeof ChurnInterventionService>[2]>({}),
    stub<ConstructorParameters<typeof ChurnInterventionService>[3]>({}),
    notifications,
  );
  const key = randomUUID();
  return {
    inbox,
    nudges,
    blocks,
    notifications,
    send: (text: string) => svc.sendIntervention(COACH, 'int-1', { message_text: text, idempotency_key: key }),
    /** What reached the Expo transport, after the fire-and-forget push settles. */
    delivered: async () => {
      const results = await Promise.all(direct.mock.results.map((r) => r.value));
      await delivery.drain(); // PF-3-BE: the outbox sends what was queued
      return { results, sent: queuedSend.mock.calls.flatMap(([chunk]) => chunk) };
    },
  };
}

let expoSend: jest.SpyInstance<Promise<ExpoPushTicket[]>, [ExpoPushMessage[]]>;
/** The outbox's transport (PF-3-BE): what the one send path sent. */
let queuedSend: jest.Mock<Promise<ExpoPushTicket[]>, [ExpoPushMessage[]]>;

// A 1000-character message (the send limit) that names private things.
const MESSAGE = `Hi Alice, your weigh-in is up 3 kg and you missed two sessions. ${'Call me tonight about the plan. '.repeat(40)}`
  .slice(0, 999)
  .trimEnd()
  .padEnd(1000, '!');

describe('B-LSNOTIFY-2 contract: churn nudge -> generic push -> client inbox row -> full text', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  beforeEach(() => {
    queuedSend = jest.fn(async (chunk: ExpoPushMessage[]) => chunk.map(() => ({ status: 'ok' as const, id: 'ticket' })));
    expoSend = jest
      .spyOn(Expo.prototype, 'sendPushNotificationsAsync')
      .mockImplementation(async (chunk) => chunk.map(() => ({ status: 'ok' as const, id: 'ticket' })));
    jest.spyOn(Expo.prototype, 'getPushNotificationReceiptsAsync').mockImplementation(async () => ({}));
  });
  afterEach(() => {
    expoSend.mockRestore();
  });
  afterAll(() => jest.restoreAllMocks());

  it('unmuted with a token: the lock screen gets the new-message line; the tap opens the inbox; the inbox has the whole message', async () => {
    const w = world();
    const out = await w.send(MESSAGE);
    const { results, sent } = await w.delivered();
    expect(results).toEqual([{ delivered: true, code: 'delivered', detail: 'queued' }]);
    expect(sent).toHaveLength(1);
    expect(expoSend).not.toHaveBeenCalled(); // no direct Expo send

    // 1) Lock screen (CPC-W2, owner 10-27 DECISIONS #178-3): the new-message
    //    line, nothing from the message.
    expect({ title: sent[0].title, body: sent[0].body }).toEqual({
      title: 'New message',
      body: 'You have a new message. Open the app to read it.',
    });
    expect(`${sent[0].title} ${sent[0].body}`).not.toMatch(/Alice|weigh-in|3 kg|sessions|Call me|coach/i);

    // 2) Tap target the phone knows: an explicit NotificationCenter, and a kind
    //    so an older decoder's kind fallback lands there too.
    const data = sent[0].data as Row;
    expect(data).toEqual({
      type: 'coach_nudge',
      kind: 'coach_nudge',
      actionScreen: 'NotificationCenter',
      nudge_id: out.nudge_id,
      notification_id: expect.any(String),
    });

    // 3) The inbox the bell opens (GET /notifications) lists that row, whole.
    const page = await w.notifications.listNotifications(CLIENT, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: data.notification_id,
      user_id: CLIENT,
      kind: 'coach_nudge',
      channel: 'inapp',
      body: MESSAGE,
      payload: { title: 'Message from your coach', nudge_id: out.nudge_id, coach_id: COACH },
    });
    expect(MESSAGE.length).toBe(1000);
    expect(page.unreadCount).toBe(1);
    expect(await w.notifications.getUnreadCount(CLIENT)).toBe(1); // the bell badge
    // Nobody else's inbox lists it.
    expect((await w.notifications.listNotifications(OTHER_CLIENT, {})).items).toEqual([]);
    // The nudge itself (CoachNudge) is unchanged: same id, same text.
    expect(w.nudges).toEqual([expect.objectContaining({ id: out.nudge_id, body: MESSAGE })]);
  });

  it('Mute all on: no push at all; the message is still in the inbox, whole (owner #171-3)', async () => {
    const w = world({ muted: true });
    const out = await w.send(MESSAGE);
    const { results, sent } = await w.delivered();
    expect(results).toEqual([]);
    expect(sent).toEqual([]);
    const page = await w.notifications.listNotifications(CLIENT, {});
    expect(page.items).toEqual([expect.objectContaining({ body: MESSAGE, payload: expect.objectContaining({ nudge_id: out.nudge_id }) })]);
  });

  it('no push token: nothing reaches Expo; the message is still in the inbox, whole', async () => {
    const w = world({ token: null });
    await w.send(MESSAGE);
    const { results, sent } = await w.delivered();
    expect(results).toEqual([{ delivered: false, code: 'no-token' }]);
    expect(sent).toEqual([]);
    expect((await w.notifications.listNotifications(CLIENT, {})).items).toEqual([
      expect.objectContaining({ kind: 'coach_nudge', body: MESSAGE }),
    ]);
  });

  it('the same send again (idempotent replay): one inbox row, one push', async () => {
    const w = world();
    const first = await w.send(MESSAGE);
    const second = await w.send(MESSAGE);
    expect(second.nudge_id).toBe(first.nudge_id);
    const { sent } = await w.delivered();
    expect(sent).toHaveLength(1);
    expect((await w.notifications.listNotifications(CLIENT, {})).items).toHaveLength(1);
  });
  it('(failed before) B-LONOTIFY3-1: a block either way hides the nudge from the list, the badge and the read marks; unblock restores it', async () => {
    const w = world();
    const out = await w.send(MESSAGE);
    // Control: the client's other rows stay (no payload at all, and a payload without coach_id).
    w.inbox.push(
      { id: 'n-plain', user_id: CLIENT, kind: 'milestone_reached', channel: 'inapp', body: 'You hit a milestone',
        deep_link: null, payload: null, read_at: null, inbox_hidden: false, created_at: new Date() },
      { id: 'n-other', user_id: CLIENT, kind: 'coach_nudge', channel: 'inapp', body: 'From the app',
        deep_link: null, payload: { title: 'Update' }, read_at: null, inbox_hidden: false, created_at: new Date() },
    );
    const nudgeRow = w.inbox.find((r) => (r.payload as Row | null)?.nudge_id === out.nudge_id);
    expect(nudgeRow).toBeDefined();
    const rowId = String(nudgeRow?.id);
    const listed = async () => (await w.notifications.listNotifications(CLIENT, {})).items.map((n) => n.id).sort();

    for (const block of [{ blocker_id: CLIENT, blocked_id: COACH }, { blocker_id: COACH, blocked_id: CLIENT }]) {
      w.blocks.push(block);
      expect(await listed()).toEqual(['n-other', 'n-plain']);
      expect(await w.notifications.getUnreadCount(CLIENT)).toBe(2); // the bell badge counts the nudge 0
      await expect(w.notifications.markRead(rowId, CLIENT)).rejects.toThrow('Notification not found');
      w.blocks.length = 0;
      // Unblock: back as it was, still unread.
      expect(await listed()).toEqual(['n-other', 'n-plain', rowId].sort());
      expect(await w.notifications.getUnreadCount(CLIENT)).toBe(3);
    }

    // Mark all read during a block leaves the hidden row unread; unblock shows it unread.
    w.blocks.push({ blocker_id: CLIENT, blocked_id: COACH });
    expect(await w.notifications.markAllRead(CLIENT)).toEqual({ updated: 2 });
    w.blocks.length = 0;
    expect(await w.notifications.getUnreadCount(CLIENT)).toBe(1);
    expect(nudgeRow?.read_at).toBeNull();
    // Nothing was deleted.
    expect(w.inbox).toHaveLength(3);
  });
});
