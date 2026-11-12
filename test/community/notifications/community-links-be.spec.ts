/**
 * COMMUNITY-LINKS-BE (agent 203, class-first): every link and tap target a server notice or push carries resolves,
 * for its recipient's role at phone main, to the phone's own route for the thing that notice is about, or is listed
 * under "Found, not fixed" in the PR body.
 *
 * The phone's side is the one copy in test/utils/phone-link-routes.ts (mobile 868825cc8c472ee120fcab7266b3c76a20a20051).
 * The senders are driven for real: CommunityPostsService.addComment over the KT-2 fixture
 * (test/community/access/member-content-fixture.ts), CommunityNotificationsService.sendCommunityPush,
 * NotificationsService.sendPush and pushToUser, the drip senders (DripDispatcherCron and PackagePushService alerts),
 * and the push outbox with its Expo transport mocked (as test/pf-3-push-send-path.spec.ts drives it). Each case reads
 * the stored Notification row, the stored PushOutbox data and the Expo message.
 *
 * Fixes: F1 the post reply link is tgp://community/thread/<post id> (resolveAppLink's form); F3 every community push
 * carries its own deepLink in device data, the row's string, with no actionScreen or actionParams; F2 the
 * "New content" push (drip_released) opens Deliverables {purchaseId}, as its inbox row already does.
 * Made-up names and neutral text only.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Expo } from 'expo-server-sdk';
import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import { CommunityPostsService } from '../../../src/community/posts/community-posts.service';
import { CommunityPostsRepository } from '../../../src/community/posts/community-posts.repository';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityReactionsRepository } from '../../../src/community/reactions/community-reactions.repository';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import { NotificationsService, pushTapData, BOOKING_PUSH_SCREEN } from '../../../src/notifications/notifications.service';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { NotificationCategory } from '../../../src/notifications/notification-category.enum';
import { notificationPrefsPrefix } from '../../../src/notifications/push/push-preferences';
import type { ExpoPushClient } from '../../../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../../../src/notifications/push/push-delivery.service';
import { currentCoachInbox, pushStillCurrent } from '../../../src/notifications/current-coach-inbox';
import { DripDispatcherCron } from '../../../src/packages/drip-dispatcher.cron';
import { PackagePushService } from '../../../src/packages/package-push.service';
import type { PrismaService } from '../../../src/prisma.service';
import { accessWorld } from '../access/member-content-fixture';
import { pushOutboxWorld } from '../../utils/push-outbox-fake';
import { whereMatches } from '../../utils/notification-where';
import { stub } from '../../utils/trial-fakes';
import {
  devicePushTap,
  fallbackScreenForKind,
  inboxScreenForKind,
  incomingLinkPath,
  resolveAppLink,
  rowTap,
} from '../../utils/phone-link-routes';

const SWITCHES = ['FEATURE_COMMUNITY_PUSH', 'FEATURE_COMMUNITY_API', 'FEATURE_COMMUNITY_TELEMETRY'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of SWITCHES) {
    saved[k] = process.env[k];
    process.env[k] = 'true';
  }
});
afterAll(() => {
  for (const k of SWITCHES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterEach(() => jest.restoreAllMocks());

// Case 11: made-up words that no stored or sent value may hold.
const REPLIER = 'Quillon Marsh';
const POST_TITLE = 'Lantern harbor walk';
const POST_BODY = 'Meet by the blue gate';
const REPLY = 'Bringing the striped umbrella';

const CLIENT_LANDING = { root: 'CommunityTab' };
const COACH_LANDING = { root: 'ClientsStack', screen: 'NotificationCenter' };

type Row = Record<string, unknown> & { user_id: string; kind: string; deep_link?: string | null; payload?: unknown };

/** The real send path over in-memory tables: Notification rows, the push outbox, Expo mocked. */
function rig() {
  const clock = { at: new Date('2026-06-02T16:00:00Z') };
  const world = pushOutboxWorld({ now: () => clock.at });
  const notes: Row[] = [];
  const hit = (n: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'payload') {
        const c = v as { path: string[]; equals: unknown };
        return ((n.payload ?? {}) as Record<string, unknown>)[c.path[0]] === c.equals;
      }
      if (v && typeof v === 'object' && !(v instanceof Date)) return true; // created_at windows
      return (n[k] ?? null) === v;
    });
  const notification = {
    findFirst: jest.fn(async ({ where }: { where?: Record<string, unknown> }) => notes.find((n) => hit(n, where)) ?? null),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: randomUUID(), created_at: new Date(clock.at), read_at: null, inbox_hidden: false, ...data } as unknown as Row;
      notes.push(row);
      return row;
    }),
  };
  const db = {
    ...world.db,
    notification,
    userBlock: { findFirst: jest.fn(async () => null) },
    communityWorkspaceBan: { findMany: jest.fn(async () => []) },
  };
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const sent = jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok', id: `links-${i}` })));
  const transport = stub<ExpoPushClient>({ send: sent, getReceipts: jest.fn(async () => ({})) });
  class Clocked extends PushDeliveryService {
    protected now(): Date {
      return new Date(clock.at.getTime());
    }
  }
  const delivery = new Clocked(stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db), transport);
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined,
    undefined,
    delivery,
  );
  const community = new CommunityNotificationsService(
    notifications,
    stub<ConstructorParameters<typeof CommunityNotificationsService>[1]>(db),
    stub<ConstructorParameters<typeof CommunityNotificationsService>[2]>({ capture: jest.fn() }),
  );
  /** A person with a phone, in UTC (16:00 is outside quiet hours). */
  const person = (id: string = randomUUID()) => {
    world.tokens[id] = `ExponentPushToken[${id.slice(0, 12)}]`;
    world.prefs[id] = { timezone: 'UTC', timezone_updated_at: new Date('2026-01-01T00:00:00Z') };
    return id;
  };
  const rowsOf = (id: string) => notes.filter((n) => n.user_id === id);
  const outboxOf = (id: string) => world.rows.filter((r) => r.user_id === id);
  const expoTo = (id: string) =>
    sent.mock.calls
      .flatMap((c) => c[0] as Array<Record<string, unknown>>)
      .filter((m) => m.to === `ExponentPushToken[${id.slice(0, 12)}]`);
  return { world, notes, db, delivery, notifications, community, person, rowsOf, outboxOf, expoTo };
}

/** The post reply, through the real posts service (KT-2 fixture) and the rig's real community push. */
async function replyWorld() {
  const r = rig();
  const w = await accessWorld();
  const prisma = stub<PrismaService>(w.db);
  const sends: Promise<void>[] = [];
  const real = r.community.sendCommunityPush.bind(r.community);
  const push = stub<CommunityNotificationsService>({
    pushEnabled: () => true,
    sendCommunityPush: (input: Parameters<CommunityNotificationsService['sendCommunityPush']>[0]) => {
      const p = real(input);
      sends.push(p);
      return p;
    },
  });
  const realtime = stub<CommunityRealtimeService>({
    channels: { cohort: () => 'cohort', workspace: () => 'workspace', user: () => 'user', moderation: () => 'moderation' },
    cohortShard: () => 0,
    broadcastCommunityEvent: async () => undefined,
  });
  const posts = new CommunityPostsService(
    new CommunityAccessService(prisma),
    new CommunityPostsRepository(prisma),
    new CommunityMessagesRepository(prisma),
    realtime,
    push,
    w.safety,
    new CommunityReactionsRepository(prisma),
  );
  const replier = w.member(REPLIER);
  const reply = async (postId: string) => {
    await posts.addComment(replier, postId, REPLY);
    await Promise.all(sends);
  };
  return { r, w, posts, replier, reply };
}

const KEYS = ['category', 'deepLink', 'kind', 'target_id', 'target_type'];

describe('COMMUNITY-LINKS-BE: the post reply (F1, F3)', () => {
  it("1. a member replies to a client's post: the row link is tgp://community/thread/<post id>, which the phone opens as CommunityThread {postId}", async () => {
    const { r, w, posts, reply } = await replyWorld();
    const { post } = await posts.create(w.viewer, w.wsId, { title: POST_TITLE, body: POST_BODY });
    r.person(w.viewer.id);
    await reply(post.id);
    const rows = r.rowsOf(w.viewer.id);
    expect(rows.map((n) => [n.kind, n.deep_link])).toEqual([
      [NotificationKind.COMMUNITY_POST_REPLIED, `tgp://community/thread/${post.id}`],
    ]);
    const path = incomingLinkPath(rows[0].deep_link as string);
    expect(path).not.toBeNull();
    expect(resolveAppLink(path as string, 'student')).toEqual({
      root: 'CommunityTab',
      screen: 'CommunityThread',
      params: { postId: post.id },
    });
  });

  it('2, 11. the same push: outbox and Expo data carry deepLink equal to the row link, kind community_post_replied, no screen, and no user text anywhere', async () => {
    const { r, w, posts, reply } = await replyWorld();
    const { post } = await posts.create(w.viewer, w.wsId, { title: POST_TITLE, body: POST_BODY });
    r.person(w.viewer.id);
    await reply(post.id);
    const [row] = r.rowsOf(w.viewer.id);
    const outbox = r.outboxOf(w.viewer.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].data).toEqual({
      kind: NotificationKind.COMMUNITY_POST_REPLIED,
      category: expect.any(String),
      target_type: 'post',
      target_id: post.id,
      deepLink: row.deep_link,
    });
    expect(Object.keys(outbox[0].data).sort()).toEqual(KEYS);
    expect(await r.delivery.drain()).toBe(1);
    const [message] = r.expoTo(w.viewer.id);
    expect(message.data).toEqual(outbox[0].data);
    expect(message.data).not.toHaveProperty('actionScreen');
    expect(message.data).not.toHaveProperty('actionParams');
    const everything = JSON.stringify([row.payload, row.body, outbox[0].data, outbox[0].context, outbox[0].title, outbox[0].body, message]);
    for (const words of [REPLIER, POST_TITLE, POST_BODY, REPLY]) expect(everything).not.toContain(words);
  });

  it("8. a coach who wrote the post: the reply row lists in the coach's inbox with the new link and the old one, and the coach's send-time check reads nothing", async () => {
    const { r, w, reply } = await replyWorld();
    r.person(w.coach.id);
    await reply(w.postId);
    const rows = r.rowsOf(w.coach.id);
    expect(rows.map((n) => n.kind)).toEqual([NotificationKind.COMMUNITY_POST_REPLIED]);
    const row = rows[0];
    const reads: string[] = [];
    const empty = stub<PrismaService>(
      new Proxy(
        {},
        {
          get: (_t, model) =>
            model === '$queryRaw'
              ? async () => []
              : new Proxy(
                  {},
                  {
                    get: (_m, method) => async () => {
                      reads.push(`${String(model)}.${String(method)}`);
                      return String(method).startsWith('findMany') ? [] : String(method) === 'count' ? 0 : null;
                    },
                  },
                ),
        },
      ),
    );
    const inbox = await currentCoachInbox(empty, w.coach.id);
    for (const link of [`tgp://community/thread/${w.postId}`, `tgp://community/posts/${w.postId}`]) {
      expect([link, whereMatches({ ...row, deep_link: link }, inbox)]).toEqual([link, true]);
    }
    reads.length = 0;
    const data = r.outboxOf(w.coach.id)[0].data;
    for (const sent of [data, { ...data, deepLink: `tgp://community/thread/${w.postId}` }]) {
      await expect(pushStillCurrent(empty, w.coach.id, sent as never)).resolves.toBe(true);
    }
    expect(reads).toEqual([]);
    // At phone main the coach's tap lands on the Notifications list (no 'Community' coach route), push and row alike.
    expect(devicePushTap('coach', r.outboxOf(w.coach.id)[0].data)).toEqual(COACH_LANDING);
    expect(rowTap('coach', row)).toEqual(COACH_LANDING);
  });
});

/** Each community sender's exact call (file:line at e24409bc) with made-up ids. */
const ID = () => randomUUID();
function communityCalls(member: string, other: string, ws: string) {
  const challenge = ID();
  const eventId = ID();
  const cohort = ID();
  return [
    {
      file: 'src/community/challenges/community-challenges.service.ts',
      literal: 'deepLink: `tgp://community/challenges/${challengeId}`',
      input: {
        recipientId: member,
        kind: NotificationKind.COMMUNITY_CHALLENGE_MILESTONE,
        targetType: 'challenge',
        targetId: challenge,
        deepLink: `tgp://community/challenges/${challenge}`,
      },
    },
    {
      file: 'src/community/events/community-events.service.ts',
      literal: 'deepLink: `tgp://community/events/${event.id}`',
      input: {
        recipientId: member,
        kind: NotificationKind.COMMUNITY_EVENT_STARTING_SOON,
        targetType: 'event',
        targetId: eventId,
        deepLink: `tgp://community/events/${eventId}`,
        otherUserId: other,
        workspaceId: ws,
      },
    },
    {
      file: 'src/community/moderation/community-moderation.service.ts',
      literal: "deepLink: 'tgp://community/moderation'",
      input: {
        recipientId: member,
        kind: NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME,
        targetType: 'message',
        targetId: ID(),
        deepLink: 'tgp://community/moderation',
      },
    },
    {
      file: 'src/community/messages/community-messages.service.ts',
      literal: 'deepLink: `tgp://community/cohorts/${cohortId}`',
      input: {
        recipientId: member,
        kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
        targetType: 'message',
        targetId: ID(),
        deepLink: `tgp://community/cohorts/${cohort}`,
        otherUserId: other,
        workspaceId: ws,
      },
    },
  ];
}

describe('COMMUNITY-LINKS-BE: every community push carries its own link (F3)', () => {
  it('3. challenge milestone, event starting soon, moderation action and the legacy cohort message: device data deepLink is the row link', async () => {
    const r = rig();
    for (const call of communityCalls('', ID(), ID())) {
      const src = readFileSync(join(__dirname, '../../..', call.file), 'utf8');
      expect(src).toContain(call.literal);
      const member = r.person();
      await r.community.sendCommunityPush({ ...call.input, recipientId: member });
      const [row] = r.rowsOf(member);
      const [outbox] = r.outboxOf(member);
      expect([call.input.kind, row?.deep_link]).toEqual([call.input.kind, call.input.deepLink]);
      expect([call.input.kind, outbox?.data.deepLink]).toEqual([call.input.kind, call.input.deepLink]);
      expect(Object.keys(outbox.data).sort()).toEqual(KEYS);
    }
    await r.delivery.drain();
    for (const m of r.world.rows) {
      const [message] = r.expoTo(m.user_id);
      expect(message.data).toEqual(m.data);
    }
  });

  it("4. at phone main nothing moves: every community kind's push and row open 'Community' (the Community tab for a client, the Notifications list for a coach), the reply's new link included", async () => {
    const community = Object.values(NotificationKind).filter((k) => k.startsWith('community_'));
    expect(community.length).toBeGreaterThanOrEqual(7);
    for (const kind of community) {
      expect([kind, fallbackScreenForKind(kind), inboxScreenForKind(kind)]).toEqual([kind, 'Community', 'Community']);
    }
    const r = rig();
    const post = ID();
    const calls = [
      ...communityCalls('', ID(), ID()).map((c) => c.input),
      {
        recipientId: '',
        kind: NotificationKind.COMMUNITY_POST_REPLIED,
        targetType: 'post',
        targetId: post,
        deepLink: `tgp://community/thread/${post}`,
      },
      {
        recipientId: '',
        kind: NotificationKind.COMMUNITY_DM_RECEIVED,
        targetType: 'dm',
        targetId: ID(),
        deepLink: `tgp://community/dm/${ID()}`,
      },
    ];
    for (const input of calls) {
      for (const role of ['student', 'coach'] as const) {
        const member = r.person();
        await r.community.sendCommunityPush({ ...input, recipientId: member });
        const [row] = r.rowsOf(member);
        const [outbox] = r.outboxOf(member);
        const want = role === 'student' ? CLIENT_LANDING : COACH_LANDING;
        expect([input.kind, role, devicePushTap(role, outbox.data)]).toEqual([input.kind, role, want]);
        expect([input.kind, role, rowTap(role, row)]).toEqual([input.kind, role, want]);
      }
    }
  });

  it('6. DM: link and device data byte for byte as at main', async () => {
    const r = rig();
    const member = r.person();
    const other = ID();
    const thread = ID();
    await r.community.sendCommunityPush({
      recipientId: member,
      kind: NotificationKind.COMMUNITY_DM_RECEIVED,
      targetType: 'dm',
      targetId: thread,
      deepLink: `tgp://community/dm/${other}`,
      otherUserId: other,
      workspaceId: ID(),
    });
    expect(r.rowsOf(member).map((n) => n.deep_link)).toEqual([`tgp://community/dm/${other}`]);
    expect(r.outboxOf(member)[0].data).toEqual({
      kind: NotificationKind.COMMUNITY_DM_RECEIVED,
      category: NotificationCategory.COACH_DIRECT,
      target_type: 'dm',
      target_id: thread,
      deepLink: `tgp://community/dm/${other}`,
    });
  });

  it('10. a push queued before the change (no deepLink) sends as stored, and an old post link row still opens Community', async () => {
    const r = rig();
    const member = r.person();
    const old = { kind: NotificationKind.COMMUNITY_POST_REPLIED, category: 'client_bot', target_type: 'post', target_id: ID() };
    await r.delivery.enqueue({
      userId: member,
      kind: NotificationKind.COMMUNITY_POST_REPLIED,
      title: 'Community',
      body: 'New reply on your post',
      data: old,
      context: { senderWords: true, muteAllOnly: true },
      dedupeKey: `community:${old.kind}:${member}:post:${old.target_id}`,
      collapseKey: `${old.kind}:`,
      timeZone: 'UTC',
    });
    await r.delivery.drain();
    expect(r.expoTo(member).map((m) => m.data)).toEqual([old]);
    const stored = { user_id: member, kind: old.kind, deep_link: `tgp://community/posts/${old.target_id}` };
    expect(rowTap('student', stored)).toEqual(CLIENT_LANDING);
    expect(devicePushTap('student', old)).toEqual(CLIENT_LANDING);
  });
});

/** pushTapData as written at e24409bc (notifications.service.ts:1117-1150): the frozen "before" for case 9. */
function pushTapDataAtMain(
  kind: string,
  deepLink: string | undefined,
  sessionId: string | undefined,
  bookingRole: 'client' | 'coach' | null = null,
  clientId?: string,
): Record<string, unknown> {
  const prefix = notificationPrefsPrefix(kind);
  const booking = prefix === 'booking' && bookingRole !== null && typeof sessionId === 'string' && sessionId.length > 0;
  const workout = kind === 'workout_assigned' || kind === 'workout_reminder';
  const actionScreen = booking
    ? BOOKING_PUSH_SCREEN[bookingRole as 'client' | 'coach']
    : prefix === 'message'
      ? 'Messages'
      : workout
        ? 'WorkoutMain'
        : 'NotificationCenter';
  return {
    actionScreen,
    ...(booking
      ? { actionParams: { sessionId } }
      : actionScreen === 'Messages' && clientId
        ? { actionParams: { clientId } }
        : {}),
    ...(deepLink ? { deepLink } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function drop(purchaseId: string) {
  return {
    id: ID(),
    client_purchase_id: purchaseId,
    asset_type: 'video',
    asset_id: ID(),
    content_id: ID(),
    display_title: 'Week two stretches',
  };
}

const DELIVERABLES = (purchaseId: string) => ({ root: 'MoreTab', screen: 'Deliverables', params: { purchaseId } });

describe('COMMUNITY-LINKS-BE: the "New content" push opens that purchase (F2)', () => {
  it("9a. the drip cron's push: actionScreen 'Deliverables' with actionParams {purchaseId}, deepLink kept, and the tap opens that purchase", async () => {
    const r = rig();
    const client = r.person();
    const purchase = ID();
    const prisma = { scheduledDrop: { updateMany: jest.fn(async () => ({ count: 1 })) } };
    const cron = new DripDispatcherCron(stub<PrismaService>(prisma), undefined, r.notifications);
    await (cron as unknown as { dispatchBuyerAlert(d: unknown, c: string, n: Date): Promise<void> }).dispatchBuyerAlert(
      drop(purchase),
      client,
      new Date('2026-06-02T16:00:00Z'),
    );
    const [outbox] = r.outboxOf(client);
    expect(outbox.data).toEqual({
      actionScreen: 'Deliverables',
      actionParams: { purchaseId: purchase },
      deepLink: 'tgp://client/library',
      kind: NotificationKind.DRIP_RELEASED,
    });
    expect(devicePushTap('student', outbox.data)).toEqual(DELIVERABLES(purchase));
    // Its rows are as at main and already open the same screen.
    const rows = r.rowsOf(client);
    expect(rows.map((n) => n.deep_link)).toEqual(['tgp://client/library', 'tgp://client/library']);
    for (const row of rows) expect(rowTap('student', row)).toEqual(DELIVERABLES(purchase));
    await r.delivery.drain();
    expect(r.expoTo(client).map((m) => m.data)).toEqual([outbox.data]);
  });

  it('9b. the inline push alert (PackagePushService): the same screen and purchase', async () => {
    const r = rig();
    const client = r.person();
    const purchase = ID();
    const d = drop(purchase);
    const prisma = {
      scheduledDrop: {
        findMany: jest.fn(async () => [d]),
        update: jest.fn(async () => ({})),
      },
    };
    const svc = new PackagePushService(stub<PrismaService>(prisma), stub<never>({}), undefined, r.notifications);
    await (svc as unknown as {
      dispatchInlineAlerts(ids: string[], by: Map<string, { client_user_id: string }>, contentId: string, now: Date): Promise<void>;
    }).dispatchInlineAlerts([d.id], new Map([[purchase, { client_user_id: client }]]), d.content_id, new Date('2026-06-02T16:00:00Z'));
    const [outbox] = r.outboxOf(client);
    expect(outbox.data).toEqual({
      actionScreen: 'Deliverables',
      actionParams: { purchaseId: purchase },
      deepLink: 'tgp://client/library',
      kind: NotificationKind.DRIP_RELEASED,
    });
    expect(devicePushTap('student', outbox.data)).toEqual(DELIVERABLES(purchase));
  });

  it("9c. every other kind's pushTapData output is as at main, whatever the call passes", () => {
    const kinds = [...new Set(Object.values(NotificationKind))];
    const tap = pushTapData as unknown as (...a: unknown[]) => Record<string, unknown>;
    const inputs: unknown[][] = [
      ['tgp://x/1', undefined, null, undefined],
      ['tgp://x/1', 's-1', 'client', undefined],
      ['tgp://x/1', 's-1', 'coach', undefined],
      [undefined, undefined, null, undefined],
      ['tgp://messages/c-1', undefined, null, 'c-1'],
    ];
    for (const kind of kinds) {
      for (const input of inputs) {
        const before = pushTapDataAtMain(kind, ...(input as [string | undefined, string | undefined, 'client' | 'coach' | null, string | undefined]));
        expect([kind, input, tap(kind, ...input)]).toEqual([kind, input, before]);
        if (kind !== NotificationKind.DRIP_RELEASED) {
          expect([kind, input, tap(kind, ...input, 'purchase-1')]).toEqual([kind, input, before]);
        }
      }
    }
  });
});

describe('COMMUNITY-LINKS-BE: guards', () => {
  it('7. message_received data and the space push link are byte for byte as at main', async () => {
    const r = rig();
    const coach = r.person();
    const client = ID();
    await r.notifications.sendPush({
      user_id: coach,
      kind: NotificationKind.MESSAGE_RECEIVED,
      body: 'New message',
      deep_link: `tgp://messages/${client}`,
      tap_client_id: client,
    });
    expect(r.outboxOf(coach)[0].data).toEqual({
      actionScreen: 'Messages',
      actionParams: { clientId: client },
      deepLink: `tgp://messages/${client}`,
      kind: NotificationKind.MESSAGE_RECEIVED,
    });
    const reader = r.person();
    const cohort = ID();
    const msg = ID();
    await r.notifications.sendPush({
      user_id: reader,
      kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
      body: '',
      deep_link: `tgp://community/cohorts/${cohort}?message=${msg}`,
      dedupe_key: `space-push:${msg}:${reader}`,
    });
    expect(r.outboxOf(reader)[0].data).toEqual({
      actionScreen: 'NotificationCenter',
      deepLink: `tgp://community/cohorts/${cohort}?message=${msg}`,
      kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
    });
  });

  it('5. every link a notice or push in the class table carries passes the phone parse, so no tap is dropped', () => {
    const u = randomUUID();
    const table: Array<[file: string, literal: string, sent: string]> = [
      // The post reply: tgp://community/thread/<post id> after F1 (tgp://community/posts/<post id> on older rows).
      ['src/community/posts/community-posts.service.ts', 'deepLink: `tgp://community/', `tgp://community/thread/${u}`],
      ['src/community/posts/community-posts.service.ts', 'deepLink: `tgp://community/', `tgp://community/posts/${u}`],
      ['src/community/challenges/community-challenges.service.ts', 'tgp://community/challenges/${challengeId}', `tgp://community/challenges/${u}`],
      ['src/community/events/community-events.service.ts', 'tgp://community/events/${event.id}', `tgp://community/events/${u}`],
      ['src/community/moderation/community-moderation.service.ts', "'tgp://community/moderation'", 'tgp://community/moderation'],
      ['src/community/safety/community-moderation-notices.ts', "'tgp://community/safety'", 'tgp://community/safety'],
      ['src/community/messages/community-messages.service.ts', 'tgp://community/cohorts/${cohortId}', `tgp://community/cohorts/${u}`],
      ['src/community/space-push/community-space-push.service.ts', 'tgp://community/cohorts/${cohortId}', `tgp://community/cohorts/${u}?message=${u}`],
      ['src/community/dms/community-dms.service.ts', 'tgp://community/dm/${user.id}', `tgp://community/dm/${u}`],
      ['src/packages/drip-dispatcher.cron.ts', "'tgp://client/library'", 'tgp://client/library'],
      ['src/packages/package-push.service.ts', "'tgp://client/library'", 'tgp://client/library'],
      ['src/packages/drip-dispatcher.cron.ts', 'tgp://coach/clients/${purchase.client_user_id}', `tgp://coach/clients/${u}`],
      ['src/packages/purchase-fanout.service.ts', 'tgp://coach/purchases/${alert.purchaseId}', `tgp://coach/purchases/${u}`],
      ['src/packages/trials/trial-notice.service.ts', "'tgp://plan'", 'tgp://plan'],
      ['src/billing/billing.service.ts', "'tgp://coach/billing/transfers'", 'tgp://coach/billing/transfers'],
      ['src/checkout/refund-dispute-handler.service.ts', "'tgp://coach/billing/refunds'", 'tgp://coach/billing/refunds'],
      ['src/checkout/refund-dispute-handler.service.ts', "'tgp://coach/billing/disputes'", 'tgp://coach/billing/disputes'],
      ['src/storefront/guest-checkout.service.ts', "'tgp://coach/billing/refunds'", 'tgp://coach/billing/refunds'],
      ['src/storefront/guest-checkout.service.ts', "'tgp://coach/billing/disputes'", 'tgp://coach/billing/disputes'],
      ['src/checkout/payout-notice.service.ts', "'tgp://coach/money'", 'tgp://coach/money'],
      ['src/checkout/dunning-v2/dunning-v2.dispatcher.ts', "'tgp://billing/update'", 'tgp://billing/update'],
      ['src/checkout/plan-renewal/plan-renewal.service.ts', "'tgp://home'", 'tgp://home'],
      ['src/coach/brief/coach-brief.scheduler.ts', "'tgp://coach/brief/today'", 'tgp://coach/brief/today'],
      ['src/messaging/messaging.service.ts', 'tgp://messages/${clientId}', `tgp://messages/${u}`],
      ['src/notifications/emitters/message-received.emitter.ts', "'tgp://messages'", 'tgp://messages'],
      ['src/notifications/emitters/booking.emitter.ts', 'tgp://coach/sessions/${p.sessionId}', `tgp://coach/sessions/${u}`],
      ['src/notifications/emitters/booking.emitter.ts', 'tgp://client/sessions/${p.sessionId}', `tgp://client/sessions/${u}`],
      ['src/notifications/emitters/booking.emitter.ts', 'tgp://sessions/${p.sessionId}', `tgp://sessions/${u}`],
      ['src/notifications/emitters/build-week-day-unlocked.emitter.ts', 'tgp://build-week/day/${dayNumber}', 'tgp://build-week/day/3'],
      ['src/notifications/emitters/checkin-submitted.emitter.ts', 'tgp://coach/clients/${clientUserId}/checkins', `tgp://coach/clients/${u}/checkins`],
      ['src/notifications/emitters/coach-alert.emitter.ts', "'tgp://coach/alerts'", 'tgp://coach/alerts'],
      ['src/notifications/push/lock-screen-copy.ts', "'tgp://coach/space-alerts/'", `tgp://coach/space-alerts/${u}`],
      ['src/notifications/push/lock-screen-copy.ts', "'tgp://coach/clients/'", `tgp://coach/clients/${u}`],
      ['src/notifications/emitters/milestone-reached.emitter.ts', "'tgp://timeline'", 'tgp://timeline'],
      ['src/notifications/emitters/missed-checkin.emitter.ts', "'tgp://checkin/today'", 'tgp://checkin/today'],
      ['src/notifications/emitters/weight-trend-alert.emitter.ts', "'tgp://weight'", 'tgp://weight'],
      ['src/notifications/nudges/copy.ts', "'tgp://onboarding'", 'tgp://onboarding'],
      ['src/engagement/workout-reminder.service.ts', 'tgp://workouts/${assignments[0].id}', `tgp://workouts/${u}`],
      ['src/workout-builder/workout-builder.service.ts', 'tgp://workouts/${assignmentId}', `tgp://workouts/${u}`],
      ['src/workout-builder/program-library.service.ts', "'tgp://workouts'", 'tgp://workouts'],
      ['src/ai/gateway/materialisers/assign-meal-plan.materialiser.ts', 'tgp://meal-plan/${assignmentId}', `tgp://meal-plan/${u}`],
      ['src/ai/gateway/materialisers/assign-workout.materialiser.ts', 'tgp://workouts/${assignmentId}', `tgp://workouts/${u}`],
    ];
    for (const [file, literal, link] of table) {
      expect([file, readFileSync(join(__dirname, '../../..', file), 'utf8').includes(literal)]).toEqual([file, true]);
      expect([link, incomingLinkPath(link)]).toEqual([link, expect.any(String)]);
    }
  });
});
