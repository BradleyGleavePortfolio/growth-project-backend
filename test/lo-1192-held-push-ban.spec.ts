/**
 * LO-1192 B1 (b#1192 @ d38a8ed4): a community push held for quiet hours is
 * still sent at 08:00 after the sender was banned from the coach's community
 * while it waited.
 *
 * Owner 10-22 (O01): a banned person's messaging is hidden entirely. Before
 * PF-3-BE a community push went at once; now it waits in the outbox until
 * 08:00, and the send-time re-check covers a block (otherUserId) but never a
 * community ban (community_workspace_bans). The fake db below answers any
 * ban query that names the sender, so a fix may pick its own query shape.
 */
import { Expo } from 'expo-server-sdk';
import { CommunityNotificationsService } from '../src/community/notifications/community-notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.FEATURE_COMMUNITY_PUSH;
});

const LA = 'America/Los_Angeles';
const MEMBER = 'lo1192-member';
const SENDER = 'lo1192-sender';
const WORKSPACE = 'lo1192-workspace';
// 23:30 PDT on 10-05 and the next 08:00 PDT.
const NIGHT = '2026-10-06T06:30:00Z';
const MORNING = new Date('2026-10-06T15:00:00Z');

function rig() {
  const clock = { at: new Date(NIGHT) };
  const world = pushOutboxWorld({
    now: () => clock.at,
    prefs: { [MEMBER]: { timezone: LA, timezone_updated_at: new Date('2026-01-01T00:00:00Z') } },
  });
  world.tokens[MEMBER] = 'lo1192-device-member';
  const bans: Array<{ workspace_id: string; user_id: string }> = [];
  const matchesBan = (where: Record<string, unknown> = {}) => {
    const ids = where.user_id as string | { in?: string[] } | undefined;
    const want = typeof ids === 'string' ? [ids] : (ids?.in ?? []);
    return bans.filter((b) => want.includes(b.user_id)).map((b) => ({ id: `ban-${b.user_id}`, ...b, lifted_at: null }));
  };
  const communityWorkspaceBan = {
    findFirst: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => matchesBan(where)[0] ?? null),
    findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => matchesBan(where)),
    count: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => matchesBan(where).length),
  };
  const userBlock = { findFirst: jest.fn(async () => null) };
  const db = { ...world.db, userBlock, communityWorkspaceBan };
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const sent = jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok', id: `lo1192-${i}` })));
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
  const communityDb = {
    ...db,
    notification: { findFirst: jest.fn(async () => null) },
    user: { findUnique: jest.fn(async () => ({ expo_push_token: world.tokens[MEMBER] })) },
  };
  const community = new CommunityNotificationsService(
    notifications,
    stub<ConstructorParameters<typeof CommunityNotificationsService>[1]>(communityDb),
    stub<ConstructorParameters<typeof CommunityNotificationsService>[2]>({ capture: jest.fn() }),
  );
  return { clock, world, bans, sent, delivery, community };
}

describe('LO-1192 B1: a held community push re-checks a ban when it goes', () => {
  it('a DM push held overnight is not sent once the coach bans the sender from the community', async () => {
    process.env.FEATURE_COMMUNITY_PUSH = 'true';
    const r = rig();
    await r.community.sendCommunityPush({
      recipientId: MEMBER,
      kind: NotificationKind.COMMUNITY_DM_RECEIVED,
      targetType: 'dm',
      targetId: 'lo1192-dm-1',
      deepLink: `tgp://community/dms/${MEMBER}:${SENDER}`,
      otherUserId: SENDER,
    });
    // Held for quiet hours (the PR's own rule).
    expect(r.world.rows).toHaveLength(1);
    expect(r.world.rows[0]).toMatchObject({ status: 'pending', deferred_reason: 'quiet_hours', not_before: MORNING });

    // 23:45: the coach bans the sender from the whole community (owner O01/O02).
    r.bans.push({ workspace_id: WORKSPACE, user_id: SENDER });

    r.clock.at = MORNING;
    await r.delivery.drain();
    expect(r.sent).not.toHaveBeenCalled();
    expect(r.world.rows[0].status).toBe('dropped');
  });
});
