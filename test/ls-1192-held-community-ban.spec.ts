import { Expo } from 'expo-server-sdk';
import { CommunityAccessService } from '../src/community/community-access.service';
import { recordWorkspaceBan } from '../src/community/community-ban';
import { CommunityNotificationsService } from '../src/community/notifications/community-notifications.service';
import { NotificationKind } from '../src/notifications/notification-kind';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { ExpoPushClient } from '../src/notifications/push/expo-push-client';
import { PushDeliveryService } from '../src/notifications/push/push-delivery.service';
import { pushOutboxWorld } from './utils/push-outbox-fake';
import { stub } from './utils/trial-fakes';

const READER = 'review-reader';
const AUTHOR = 'review-author';
const WORKSPACE = 'review-workspace';
const COHORT = 'review-cohort';
const START = new Date('2026-10-07T06:00:00Z'); // 23:00 Los Angeles
const MORNING = new Date('2026-10-07T15:00:00Z');

type BanRow = { id: string; workspace_id: string; user_id: string; lifted_at: Date | null };

function rig() {
  const clock = { at: START };
  const world = pushOutboxWorld({
    now: () => clock.at,
    tokens: { [READER]: 'review-device' },
    prefs: {
      [READER]: {
        muted: false,
        timezone: 'America/Los_Angeles',
        timezone_updated_at: START,
      },
    },
  });
  const bans: BanRow[] = [];
  const communityWorkspaceBan = {
    findFirst: jest.fn(async ({ where }: { where: { workspace_id: string; user_id: string } }) =>
      bans.find((b) => b.workspace_id === where.workspace_id && b.user_id === where.user_id && b.lifted_at === null) ?? null,
    ),
    findMany: jest.fn(async ({ where }: { where: { workspace_id: string; user_id: { in: string[] } } }) =>
      bans.filter((b) => b.workspace_id === where.workspace_id && where.user_id.in.includes(b.user_id) && b.lifted_at === null),
    ),
    upsert: jest.fn(async ({ create }: { create: Omit<BanRow, 'id' | 'lifted_at'> }) => {
      const row = { id: 'review-ban', ...create, lifted_at: null };
      bans.push(row);
      return row;
    }),
  };
  const db = {
    ...world.db,
    communityWorkspaceBan,
    userBlock: { findFirst: jest.fn(async () => null) },
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'review-notice', ...data })),
    },
    communityMessage: {
      findUnique: jest.fn(async () => ({
        id: 'review-target', workspace_id: WORKSPACE, cohort_id: COHORT,
        sender_id: AUTHOR, deleted_at: null, scope: 'cohort',
      })),
      // FR-1192: fixture only. community_messages' key is (id, created_at), so
      // the real lookup by id alone is findFirst (findUnique by id does not
      // type-check: TS2322 in build-and-test run 41164376583). Same row.
      findFirst: jest.fn(async () => ({
        id: 'review-target', workspace_id: WORKSPACE, cohort_id: COHORT,
        sender_id: AUTHOR, deleted_at: null, scope: 'cohort',
      })),
    },
    communityPost: {
      findUnique: jest.fn(async () => ({
        id: 'review-target', workspace_id: WORKSPACE, cohort_id: COHORT,
        author_id: READER, deleted_at: null,
      })),
    },
  };
  jest.spyOn(Expo, 'isExpoPushToken').mockReturnValue(true);
  const direct = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockResolvedValue([]);
  const send = jest.fn(async (messages: unknown[]) => messages.map(() => ({ status: 'ok', id: 'review-ticket' })));
  class Clocked extends PushDeliveryService {
    protected now(): Date { return clock.at; }
  }
  const delivery = new Clocked(
    stub<ConstructorParameters<typeof PushDeliveryService>[0]>(db),
    stub<ExpoPushClient>({ send, getReceipts: jest.fn(async () => ({})) }),
  );
  delivery.autoDrain = false;
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(db),
    undefined, undefined, delivery,
  );
  const community = new CommunityNotificationsService(
    notifications,
    stub<ConstructorParameters<typeof CommunityNotificationsService>[1]>(db),
    stub<ConstructorParameters<typeof CommunityNotificationsService>[2]>({ capture: jest.fn() }),
  );
  const access = new CommunityAccessService(stub<ConstructorParameters<typeof CommunityAccessService>[0]>(db));
  return { clock, world, db, direct, send, delivery, community, access };
}

const PATHS = [
  [NotificationKind.COMMUNITY_DM_RECEIVED, 'dm'],
  [NotificationKind.COMMUNITY_POST_REPLIED, 'post'],
  [NotificationKind.COMMUNITY_MESSAGE_RECEIVED, 'message'],
] as const;

describe('LS-1192 B1: newly held Community pushes respect workspace bans at delivery', () => {
  const oldFlag = process.env.FEATURE_COMMUNITY_PUSH;
  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_PUSH = 'true';
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    jest.setSystemTime(START);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (oldFlag === undefined) delete process.env.FEATURE_COMMUNITY_PUSH;
    else process.env.FEATURE_COMMUNITY_PUSH = oldFlag;
  });

  it.each(PATHS)('control: an eligible %s reaches the device once at 08:00', async (kind, targetType) => {
    const r = rig();
    await r.community.sendCommunityPush({
      recipientId: READER, kind, targetType, targetId: 'review-target', otherUserId: AUTHOR,
    });
    expect(r.world.rows).toHaveLength(1);
    expect(r.world.rows[0].not_before).toEqual(MORNING);
    expect(r.direct).not.toHaveBeenCalled();
    expect(r.send).not.toHaveBeenCalled();
    r.clock.at = MORNING;
    jest.setSystemTime(MORNING);
    await r.delivery.drain();
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.world.rows[0].status).toBe('sent');
  });

  it.each(PATHS.flatMap(([kind, targetType]) =>
    [AUTHOR, READER].map((banned) => ({ kind, targetType, banned })),
  ))('B1: $kind held at 23:00 does not send after $banned is banned', async ({ kind, targetType, banned }) => {
    const r = rig();
    expect(await r.access.isBanned(WORKSPACE, banned)).toBe(false);
    await r.community.sendCommunityPush({
      recipientId: READER, kind, targetType, targetId: 'review-target', otherUserId: AUTHOR,
    });
    expect(r.world.rows).toHaveLength(1);
    expect(r.world.rows[0].not_before).toEqual(MORNING);
    // The same durable write used by moderation. The normal access rule now refuses this person.
    await recordWorkspaceBan(stub<Parameters<typeof recordWorkspaceBan>[0]>(r.db), {
      workspaceId: WORKSPACE, userId: banned, bannedById: 'review-coach',
      moderationActionId: null, at: new Date('2026-10-07T07:00:00Z'),
    });
    expect(await r.access.isBanned(WORKSPACE, banned)).toBe(true);
    r.clock.at = MORNING;
    jest.setSystemTime(MORNING);
    await r.delivery.drain();
    // The held push must be cancelled, not delivered after the workspace ban.
    expect(r.send).not.toHaveBeenCalled();
    expect(r.world.rows[0].status).toBe('dropped');
  });
});
