/**
 * COACH-ROW-CHAT-BE (owner 203-D4, #203-E22): a coach's message push names its
 * client by id, so a tap can open that client's chat.
 *
 * A client's message to their coach queues a device push whose data gains
 * `actionParams: { clientId }`, the same id that is already after
 * `tgp://messages/` in its deepLink, and nothing else: no name, no text. A
 * client's own push, a broadcast push and a push with no thread are as before.
 * Driven through the real MessagingService.sendAsClient / sendAsCoach, the
 * real MessageReceivedEmitter, NotificationsService.sendPush and the push
 * outbox (PushDeliveryService over test/utils/push-outbox-fake.ts), asserting
 * on the stored outbox data and on the Expo message.
 */
import type { ExpoPushMessage } from 'expo-server-sdk';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AuditService } from '../src/audit/audit.service';
import { ClientAIContextService } from '../src/ai/client-ai-context.service';
import { BroadcastDispatcherService } from '../src/broadcasts/broadcast-dispatcher.service';
import type { BroadcastScopeService } from '../src/broadcasts/broadcast-scope.service';
import type { SegmentResolverService } from '../src/broadcasts/segment-resolver.service';
import { MessagesSafetyService } from '../src/messages-safety/messages-safety.service';
import { MessagingService } from '../src/messaging/messaging.service';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import type { PrismaService } from '../src/prisma.service';
import { PtmService } from '../src/ptm/ptm.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { fakeOf } from './ai-egress/ai-egress.fakes';
import { whereMatches } from './utils/notification-where';
import { pushOutboxWorld, type FakeOutboxRow } from './utils/push-outbox-fake';

const COACH = '3b6f2d4e-8a1c-4f5e-9b7d-0c2a4e6f8a10';
const OTHER_COACH = '5d8a1f3c-2e4b-4a6d-8f0e-1b3c5d7e9f20';
const CLIENT = '7e2c9a4b-1d3f-4b5a-8c6e-2f4a6b8c0d30';
const OTHER_CLIENT = '9a4e1c6d-3f5b-4d7c-a8e0-3b5d7f9a1c40';
// A made-up, distinctive name: it must never reach the push data, context or lock screen.
const CLIENT_NAME = 'Quillon Marrowby';
const TEXT = 'See you at nine.';
const TOKEN = (id: string) => `ExponentPushToken[${id.slice(0, 22)}]`;
const NY = 'America/New_York';
const NOON = new Date('2026-06-02T16:00:00Z'); // 12:00 New York
const NIGHT = new Date('2026-06-03T03:00:00Z'); // 23:00 New York
const MORNING = new Date('2026-06-03T12:30:00Z'); // 08:30 New York
const MESSAGE_LOCK_SCREEN = { title: 'New message', body: 'You have a new message. Open the app to read it.' };
const KEYS_ALLOWED = ['actionParams', 'actionScreen', 'deepLink', 'kind'];

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  jest.restoreAllMocks();
});

const flush = async () => {
  for (let i = 0; i < 25; i += 1) await new Promise((r) => setImmediate(r));
};

type Row = Record<string, unknown>;
const table = <T extends object>(rows: T[]) => ({
  findFirst: jest.fn(async ({ where }: { where?: unknown }) => rows.find((r) => whereMatches(r, where ?? {})) ?? null),
  findMany: jest.fn(async ({ where }: { where?: unknown }) => rows.filter((r) => whereMatches(r, where ?? {}))),
});

function world(at: Date = NOON) {
  const clock = { at };
  const person = (id: string, role: string, coach_id: string | null, name: string) => ({ id, role, coach_id, name, deleted_at: null });
  const people = [
    person(COACH, 'coach', null, 'Coach Penhallow'),
    person(OTHER_COACH, 'coach', null, 'Coach Tavistock'),
    person(CLIENT, 'student', COACH, CLIENT_NAME),
    person(OTHER_CLIENT, 'student', OTHER_COACH, 'Orla Fenwick'),
  ];
  const zone = { timezone: NY, timezone_updated_at: new Date('2026-01-01T00:00:00Z'), muted: false };
  const w = pushOutboxWorld({
    now: () => clock.at,
    tokens: Object.fromEntries(people.map((p) => [p.id, TOKEN(p.id)])),
    prefs: Object.fromEntries(people.map((p) => [p.id, { ...zone }])),
  });
  const inbox: Row[] = [];
  const mutes = new Map<string, Date>(); // `${user}|${coach}|${client}` -> muted_until
  let seq = 0;
  const db = {
    ...w.db,
    notification: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { ...data, id: `n-${inbox.length + 1}` };
        inbox.push(row);
        return row;
      }),
      findFirst: jest.fn(async () => null),
    },
    user: {
      ...w.db.user,
      ...table(people),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const p = people.find((u) => u.id === where.id);
        return p ? { ...p, expo_push_token: w.tokens[where.id] ?? null } : null;
      }),
    },
    teamSubCoachAssignment: table([]),
    subCoachAssignment: table([]),
    coachingSession: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    communityCohort: { findMany: jest.fn(async () => []) },
    userBlock: { findFirst: jest.fn(async () => null) },
    coachThreadState: {
      findUnique: jest.fn(
        async ({ where }: { where: { CoachThreadState_user_thread_key: { user_id: string; coach_id: string; client_id: string } } }) => {
          const k = where.CoachThreadState_user_thread_key;
          const until = mutes.get(`${k.user_id}|${k.coach_id}|${k.client_id}`);
          return until ? { muted_until: until } : null;
        },
      ),
    },
    coachMessage: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Row }) => ({ ...data, id: `m-${(seq += 1)}`, created_at: clock.at })),
    },
  };
  const prisma = fakeOf<PrismaService>(Object.create(db));
  const send = jest.fn(async (m: ExpoPushMessage[]) => m.map((_, i) => ({ status: 'ok' as const, id: `t-${i}` })));
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const delivery = new Clocked(prisma, { send, getReceipts: jest.fn(async () => ({})) });
  delivery.autoDrain = false;
  const notifications = new NotificationsService(prisma, undefined, undefined, delivery);
  const emitter = new MessageReceivedEmitter(notifications);
  const messaging = new MessagingService(
    prisma,
    fakeOf<SupabaseService>({ pingChat: jest.fn(async () => undefined) }),
    fakeOf<AnalyticsService>({ capture: jest.fn() }),
    fakeOf<PtmService>({ emit: jest.fn() }),
    emitter,
    fakeOf<AuditService>({ write: jest.fn(async () => undefined) }),
    fakeOf<ClientAIContextService>({ invalidateForUser: jest.fn() }),
    fakeOf<MessagesSafetyService>({ isEitherSideBlocked: jest.fn(async () => false) }),
  );
  const clientWrites = async (client = CLIENT, text = TEXT) => {
    await messaging.sendAsClient(client, text);
    await flush();
  };
  const coachWrites = async (coach = COACH, client = CLIENT) => {
    await messaging.sendAsCoach(coach, client, TEXT);
    await flush();
  };
  const sendNow = async (to: Date = clock.at) => {
    clock.at = to;
    await delivery.drain();
  };
  const outboxFor = (user: string): FakeOutboxRow[] => w.rows.filter((r) => r.user_id === user);
  const sentTo = (user: string): ExpoPushMessage[] =>
    send.mock.calls.flatMap((c) => c[0]).filter((m) => m.to === TOKEN(user));
  const move = (client: string, to: string) => {
    const p = people.find((u) => u.id === client);
    if (p) p.coach_id = to;
  };
  return { clock, w, db, people, inbox, mutes, notifications, delivery, emitter, messaging, clientWrites, coachWrites, sendNow, outboxFor, sentTo, move, send };
}
type World = ReturnType<typeof world>;

/** The push data a coach's message push had before this change. */
const TODAY = (client: string) => ({
  actionScreen: 'Messages',
  deepLink: `tgp://messages/${client}`,
  kind: NotificationKind.MESSAGE_RECEIVED,
});
const linkId = (data: Record<string, unknown>) => String(data.deepLink).slice('tgp://messages/'.length);

/** A broadcast delivery to CLIENT, faked like test/fr-1192-send-time-rechecks.spec.ts; its push goes through `r`. */
function broadcastFor(r: World) {
  const delivery = {
    id: 'd1',
    attempts: 0,
    recipient_id: CLIENT,
    run: {
      urgent: true,
      body: 'Morning {first_name}, the new block starts Monday.',
      card: null,
      segment: {},
      broadcast: { id: 'b1', coach_id: COACH, author_user_id: COACH, status: 'sending', urgent: true },
    },
  };
  const tx = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) => (sql.join('?').includes('"coach_broadcasts"') ? [{ status: 'sending' }] : [])),
    coachMessage: { create: jest.fn(async () => ({ id: 'bm1' })) },
    coachMessageCard: { create: jest.fn(async () => ({})) },
    coachBroadcastDelivery: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    coachBroadcastDelivery: { updateMany: jest.fn(async () => ({ count: 1 })), findUnique: jest.fn(async () => delivery) },
    user: {
      findFirst: jest.fn(async () => ({ id: CLIENT, name: CLIENT_NAME })),
      findUnique: jest.fn(async () => ({ name: 'Coach Penhallow' })),
    },
    userBlock: { findFirst: jest.fn(async () => null) },
    notificationPreferences: { findUnique: jest.fn(async () => ({ timezone: NY, muted: false, message_push: true })) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return new BroadcastDispatcherService(
    fakeOf<PrismaService>(prisma),
    fakeOf<BroadcastScopeService>({ lockSendAuthority: jest.fn(async () => null) }),
    fakeOf<SegmentResolverService>({}),
    fakeOf<SupabaseService>({ pingChat: jest.fn(async () => undefined) }),
    r.emitter,
  );
}

describe('COACH-ROW-CHAT-BE: a client writes to their coach (messaging.service.ts sendAsClient)', () => {
  it.each([
    ['1. messaging core v2 off', false],
    ['2. messaging core v2 on, the thread not muted', true],
  ])('%s: the coach\'s push data is today\'s plus actionParams { clientId } equal to the deep link id', async (_name, v2) => {
    if (v2) process.env.FEATURE_MESSAGING_CORE_V2 = 'true';
    else delete process.env.FEATURE_MESSAGING_CORE_V2;
    const r = world();
    await r.clientWrites();
    const [row] = r.outboxFor(COACH);
    expect(r.outboxFor(COACH)).toHaveLength(1);
    expect(row.data).toEqual({ ...TODAY(CLIENT), actionParams: { clientId: CLIENT } });
    expect((row.data.actionParams as { clientId: string }).clientId).toBe(linkId(row.data));
    await r.sendNow();
    expect(r.sentTo(COACH).map((m) => m.data)).toEqual([{ ...TODAY(CLIENT), actionParams: { clientId: CLIENT } }]);
  });

  it('3. held for quiet hours, then sent: the Expo message carries the same actionParams under the fixed message template', async () => {
    const r = world(NIGHT);
    await r.clientWrites();
    const [row] = r.outboxFor(COACH);
    expect(row).toMatchObject({ status: 'pending', deferred_reason: 'quiet_hours' });
    await r.sendNow();
    expect(r.sentTo(COACH)).toHaveLength(0); // 23:00: it waits
    await r.sendNow(MORNING);
    const sent = r.sentTo(COACH);
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toEqual({ ...TODAY(CLIENT), actionParams: { clientId: CLIENT } });
    expect({ title: sent[0].title, body: sent[0].body }).toEqual(MESSAGE_LOCK_SCREEN);
    expect({ title: row.title, body: row.body }).toEqual(MESSAGE_LOCK_SCREEN);
  });
});

describe('COACH-ROW-CHAT-BE guards: everything else stays as it was', () => {
  it("4. a coach writes to a client (sendAsCoach): the client's push data is exactly today's, with no actionParams", async () => {
    const r = world();
    await r.coachWrites();
    const [row] = r.outboxFor(CLIENT);
    expect(r.outboxFor(CLIENT)).toHaveLength(1);
    expect(row.data).toEqual(TODAY(CLIENT));
    await r.sendNow();
    expect(r.sentTo(CLIENT).map((m) => m.data)).toEqual([TODAY(CLIENT)]);
    expect(r.outboxFor(COACH)).toHaveLength(0);
  });

  it('5. a broadcast to a client (deliverOne): its push data is unchanged, with no actionParams', async () => {
    process.env.FEATURE_COACH_BROADCASTS = 'true';
    const r = world();
    expect(await broadcastFor(r).deliverOne('d1', NOON)).toBe('delivered');
    const [row] = r.outboxFor(CLIENT);
    expect(r.outboxFor(CLIENT)).toHaveLength(1);
    expect(row.data).toEqual(TODAY(CLIENT));
    await r.sendNow();
    expect(r.sentTo(CLIENT).map((m) => m.data)).toEqual([TODAY(CLIENT)]);
  });

  it.each([
    ['v2 off', false],
    ['v2 on', true],
  ])('6. no user text (%s): the client\'s name is in no data, context, title or body, and only the allowed keys are there', async (_n, v2) => {
    if (v2) process.env.FEATURE_MESSAGING_CORE_V2 = 'true';
    else delete process.env.FEATURE_MESSAGING_CORE_V2;
    const r = world(NIGHT);
    await r.clientWrites();
    await r.coachWrites();
    await r.sendNow(MORNING);
    const rows = [...r.outboxFor(COACH), ...r.outboxFor(CLIENT)];
    expect(rows).toHaveLength(2);
    const words = [CLIENT_NAME, ...CLIENT_NAME.split(' '), TEXT];
    for (const row of rows) {
      const stored = JSON.stringify({ data: row.data, context: row.context, title: row.title, body: row.body });
      for (const w of words) expect(stored).not.toContain(w);
      expect(Object.keys(row.data).every((k) => KEYS_ALLOWED.includes(k))).toBe(true);
      if (row.data.actionParams !== undefined) expect(Object.keys(row.data.actionParams as object)).toEqual(['clientId']);
    }
    const sent = r.send.mock.calls.flatMap((c) => c[0]);
    expect(sent).toHaveLength(2);
    for (const m of sent) {
      const out = JSON.stringify({ data: m.data, title: m.title, body: m.body });
      for (const w of words) expect(out).not.toContain(w);
      expect(Object.keys(m.data ?? {}).every((k) => KEYS_ALLOWED.includes(k))).toBe(true);
    }
  });

  it('7. the inbox row is unchanged: kind, body, payload { senderName, threadId }, deep_link', async () => {
    const r = world();
    await r.clientWrites();
    expect(r.inbox.filter((n) => n.user_id === COACH)).toEqual([
      {
        id: 'n-1',
        user_id: COACH,
        kind: NotificationKind.MESSAGE_RECEIVED,
        body: `New message from ${CLIENT_NAME}`,
        payload: { senderName: CLIENT_NAME, threadId: CLIENT },
        deep_link: `tgp://messages/${CLIENT}`,
        channel: 'inapp',
      },
    ]);
  });

  it('8. an emit with no thread: deep link tgp://messages and no actionParams', async () => {
    const r = world();
    await r.emitter.emit(COACH, { senderName: CLIENT_NAME });
    const [row] = r.outboxFor(COACH);
    expect(row.data).toEqual({ actionScreen: 'Messages', deepLink: 'tgp://messages', kind: NotificationKind.MESSAGE_RECEIVED });
  });

  it('9. the collapse key and dedupe key are unchanged; two messages from one client collapse into one push', async () => {
    const r = world(NIGHT);
    await r.clientWrites(CLIENT, 'First note.');
    await r.clientWrites(CLIENT, 'Second note.');
    const rows = r.outboxFor(COACH);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ collapse_key: `${NotificationKind.MESSAGE_RECEIVED}:tgp://messages/${CLIENT}`, dedupe_key: null });
    await r.sendNow(MORNING);
    expect(r.sentTo(COACH)).toHaveLength(1);
  });

  it("10. the client moves to another coach before the held push goes: dropped 'obsolete'; no coach's push names another coach's client", async () => {
    const r = world(NIGHT);
    await r.clientWrites(CLIENT);
    await r.clientWrites(OTHER_CLIENT);
    r.move(CLIENT, OTHER_COACH);
    await r.sendNow(MORNING);
    expect(r.outboxFor(COACH).map((x) => [x.status, x.result_code])).toEqual([['dropped', 'obsolete']]);
    expect(r.sentTo(COACH)).toHaveLength(0);
    // Every queued push names, if anything, a client of its own coach at the time it was queued.
    expect(r.outboxFor(COACH).map((x) => (x.data.actionParams as { clientId?: string } | undefined)?.clientId ?? CLIENT)).toEqual([CLIENT]);
    expect(r.outboxFor(OTHER_COACH).map((x) => (x.data.actionParams as { clientId?: string } | undefined)?.clientId ?? OTHER_CLIENT)).toEqual([OTHER_CLIENT]);
    expect(r.sentTo(OTHER_COACH).map((m) => m.to)).toEqual([TOKEN(OTHER_COACH)]);
  });

  it('11. a coach who muted the thread (v2): no push', async () => {
    process.env.FEATURE_MESSAGING_CORE_V2 = 'true';
    const r = world();
    // MessagingService reads the mute against the wall clock, so it ends well after today.
    r.mutes.set(`${COACH}|${COACH}|${CLIENT}`, new Date('2099-01-01T00:00:00Z'));
    await r.clientWrites();
    expect(r.outboxFor(COACH)).toHaveLength(0);
    await r.sendNow();
    expect(r.sentTo(COACH)).toHaveLength(0);
  });

  it('12. a push queued before this change (no actionParams) sends as stored', async () => {
    const r = world();
    await r.delivery.enqueue({
      userId: COACH,
      kind: NotificationKind.MESSAGE_RECEIVED,
      title: MESSAGE_LOCK_SCREEN.title,
      body: MESSAGE_LOCK_SCREEN.body,
      data: { actionScreen: 'Messages', deepLink: `tgp://messages/${CLIENT}` },
      context: { otherUserId: CLIENT },
      dedupeKey: null,
      collapseKey: `${NotificationKind.MESSAGE_RECEIVED}:tgp://messages/${CLIENT}`,
      timeZone: NY,
    });
    await r.sendNow();
    expect(r.sentTo(COACH).map((m) => m.data)).toEqual([TODAY(CLIENT)]);
  });
});
