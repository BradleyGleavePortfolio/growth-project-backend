/**
 * FR-1192 (R1, R2): a held push asks again, when it goes, what its sender
 * asked when it was queued; the nudges and the workout reminder keep their
 * Android channel.
 *
 *  - R1: a coach-thread message push held for quiet hours is not sent once
 *    the reader mutes that thread (LO-1192 C2, LS-1192 C1);
 *  - R1: a broadcast held for quiet hours is not sent once the client blocks
 *    its author (LS-1192 C2) or, for a team member's broadcast, the coach;
 *  - R2: nudge_* and workout_reminder go on 'default', as before PF-3-BE
 *    (LO-1192 C1); other kinds keep their channel.
 */
import { Expo } from 'expo-server-sdk';
import { BroadcastDispatcherService } from '../src/broadcasts/broadcast-dispatcher.service';
import type { BroadcastScopeService } from '../src/broadcasts/broadcast-scope.service';
import type { SegmentResolverService } from '../src/broadcasts/segment-resolver.service';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import type { PrismaService } from '../src/prisma.service';
import type { SupabaseService } from '../src/supabase/supabase.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const LA = 'America/Los_Angeles';
const CLIENT = 'fr1192-client';
const COACH = 'fr1192-coach';
const MEMBER = 'fr1192-team-member';
// 23:00 and 08:00 in Los Angeles.
const NIGHT = '2026-10-06T06:00:00Z';
const MORNING = new Date('2026-10-06T15:00:00Z');

const savedEnv = { ...process.env };
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...savedEnv };
});

function rig() {
  const clock = { at: new Date(NIGHT) };
  const zone = { timezone: LA, timezone_updated_at: new Date('2026-01-01T00:00:00Z') };
  const world = pushOutboxWorld({ now: () => clock.at, prefs: { [CLIENT]: { ...zone }, [COACH]: { ...zone } } });
  world.tokens[CLIENT] = 'fr1192-device-client';
  world.tokens[COACH] = 'fr1192-device-coach';
  const blocks: Array<[blocker: string, blocked: string]> = [];
  const mutes = new Map<string, Date>(); // `${user}|${coach}|${client}` -> muted_until
  const db = {
    ...world.db,
    userBlock: {
      findFirst: jest.fn(async ({ where }: { where: { OR: Array<{ blocker_id: string; blocked_id: string }> } }) =>
        where.OR.some((c) => blocks.some(([a, b]) => a === c.blocker_id && b === c.blocked_id)) ? { id: 'blk' } : null,
      ),
    },
    coachThreadState: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { CoachThreadState_user_thread_key: { user_id: string; coach_id: string; client_id: string } };
        }) => {
          const k = where.CoachThreadState_user_thread_key;
          const until = mutes.get(`${k.user_id}|${k.coach_id}|${k.client_id}`);
          return until ? { muted_until: until } : null;
        },
      ),
    },
  };
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const sent = jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok', id: `fr1192-${i}` })));
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
  jest.spyOn(notifications, 'createNotification').mockResolvedValue(null); // inbox row: not under test
  const emitter = new MessageReceivedEmitter(notifications);
  const morning = async () => {
    clock.at = MORNING;
    await delivery.drain();
  };
  const sentMessages = () => sent.mock.calls.flatMap((c) => c[0] as Array<Record<string, unknown>>);
  return { world, blocks, mutes, sent, sentMessages, delivery, notifications, emitter, morning };
}

/** The coach-thread push MessagingService.notifyNewMessage emits with core v2 on (client wrote). */
const threadPush = (r: ReturnType<typeof rig>) => {
  const payload = {
    senderName: 'Sam',
    threadId: CLIENT,
    senderId: CLIENT,
    coachThread: { coachId: COACH, clientId: CLIENT },
  };
  return r.emitter.emit(COACH, payload);
};

describe('FR-1192 R1: a thread muted while its push was held', () => {
  beforeEach(() => {
    process.env.FEATURE_MESSAGING_CORE_V2 = 'true';
  });

  it('is not sent: the row is dropped', async () => {
    const r = rig();
    await threadPush(r);
    expect(r.world.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'quiet_hours', not_before: MORNING });
    r.mutes.set(`${COACH}|${COACH}|${CLIENT}`, new Date('2026-10-07T00:00:00Z'));
    await r.morning();
    expect(r.sent).not.toHaveBeenCalled();
    expect(r.world.rows[0].status).toBe('dropped');
  });

  it('control: unmuted, the same push goes once at 08:00', async () => {
    const r = rig();
    await threadPush(r);
    await r.morning();
    expect(r.sent).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
  });

  it('control: a mute that ended before 08:00 does not stop it', async () => {
    const r = rig();
    await threadPush(r);
    r.mutes.set(`${COACH}|${COACH}|${CLIENT}`, new Date('2026-10-06T14:00:00Z'));
    await r.morning();
    expect(r.sent).toHaveBeenCalledTimes(1);
  });

  it("control: another person's mute of the thread does not stop it", async () => {
    const r = rig();
    await threadPush(r);
    r.mutes.set(`${CLIENT}|${COACH}|${CLIENT}`, new Date('2026-10-07T00:00:00Z'));
    await r.morning();
    expect(r.sent).toHaveBeenCalledTimes(1);
  });

  it('control: with core v2 off the mute is not read (as when it was queued)', async () => {
    const r = rig();
    await threadPush(r);
    r.mutes.set(`${COACH}|${COACH}|${CLIENT}`, new Date('2026-10-07T00:00:00Z'));
    delete process.env.FEATURE_MESSAGING_CORE_V2;
    await r.morning();
    expect(r.sent).toHaveBeenCalledTimes(1);
  });
});

/** A broadcast delivery, faked like test/broadcasts/dispatcher-delivery.spec.ts; the push goes through `r`. */
function broadcastFor(r: ReturnType<typeof rig>, authorId: string) {
  const delivery = {
    id: 'd1',
    attempts: 0,
    recipient_id: CLIENT,
    run: {
      urgent: true, // the message goes at 23:00; its push still waits for 08:00
      body: 'Morning {first_name}, new block starts Monday.',
      card: null,
      segment: {},
      broadcast: { id: 'b1', coach_id: COACH, author_user_id: authorId, status: 'sending', urgent: true },
    },
  };
  const tx = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) =>
      sql.join('?').includes('"coach_broadcasts"') ? [{ status: 'sending' }] : [],
    ),
    coachMessage: { create: jest.fn(async () => ({ id: 'm1' })) },
    coachMessageCard: { create: jest.fn(async () => ({})) },
    coachBroadcastDelivery: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    coachBroadcastDelivery: { updateMany: jest.fn(async () => ({ count: 1 })), findUnique: jest.fn(async () => delivery) },
    user: {
      findFirst: jest.fn(async () => ({ id: CLIENT, name: 'Sarah Lee' })),
      findUnique: jest.fn(async () => ({ name: 'Coach Bradley' })),
    },
    userBlock: { findFirst: jest.fn(async () => null) }, // no block when it was queued
    notificationPreferences: { findUnique: jest.fn(async () => ({ timezone: LA, muted: false, message_push: true })) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return new BroadcastDispatcherService(
    stub<PrismaService>(prisma),
    stub<BroadcastScopeService>({ lockSendAuthority: jest.fn(async () => null) }),
    stub<SegmentResolverService>({}),
    stub<SupabaseService>({ pingChat: jest.fn(async () => undefined) }),
    r.emitter,
  );
}

describe('FR-1192 R1: a broadcast push held after a block', () => {
  beforeEach(() => {
    process.env.FEATURE_COACH_BROADCASTS = 'true';
  });

  it('the client blocks the author while it waits: not sent', async () => {
    const r = rig();
    expect(await broadcastFor(r, COACH).deliverOne('d1', new Date(NIGHT))).toBe('delivered');
    expect(r.world.rows[0]).toMatchObject({
      kind: NotificationKind.MESSAGE_RECEIVED,
      status: 'pending',
      deferred_reason: 'quiet_hours',
      context: expect.objectContaining({ otherUserId: COACH }),
    });
    r.blocks.push([CLIENT, COACH]);
    await r.morning();
    expect(r.sent).not.toHaveBeenCalled();
    expect(r.world.rows[0].status).toBe('dropped');
  });

  it("a team member's broadcast: the client blocks the coach while it waits: not sent", async () => {
    const r = rig();
    await broadcastFor(r, MEMBER).deliverOne('d1', new Date(NIGHT));
    expect(r.world.rows[0].context).toMatchObject({ otherUserId: MEMBER, alsoUserId: COACH });
    r.blocks.push([COACH, CLIENT]);
    await r.morning();
    expect(r.sent).not.toHaveBeenCalled();
    expect(r.world.rows[0].status).toBe('dropped');
  });

  it('control: no block, it goes once at 08:00', async () => {
    const r = rig();
    await broadcastFor(r, MEMBER).deliverOne('d1', new Date(NIGHT));
    await r.morning();
    expect(r.sent).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
  });
});

describe("FR-1192 R2: the nudges and the workout reminder keep Android channel 'default'", () => {
  it.each([
    [NotificationKind.NUDGE_INACTIVE, 'default'],
    [NotificationKind.NUDGE_MISSED_CHECKIN, 'default'],
    [NotificationKind.WORKOUT_REMINDER, 'default'],
    [NotificationKind.WORKOUT_ASSIGNED, 'client-bot'],
    [NotificationKind.MISSED_CHECKIN, 'client-bot'],
  ])('%s goes on %s', async (kind, channel) => {
    const r = rig();
    await r.notifications.pushToUser(CLIENT, 't', 'b', { kind }, undefined, { kind, dedupeKey: `fr1192:${kind}` });
    await r.morning();
    expect(r.sentMessages().map((m) => m.channelId)).toEqual([channel]);
  });
});
