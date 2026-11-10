/**
 * LS-1243R1 B1 (b#1243 @ e760b3e08f055e959c4f57986d9e983fa1f602cf): the DM device push carries the link the phone
 * routes a tap by.
 *
 * sendCommunityPush writes `deepLink` to the inbox row (createNotification, community-notifications.service.ts:222-234)
 * but hands pushToUser a `data` of ids only (:262-271), and pushToUser queues that data as given
 * (notifications.service.ts pushToUser: `data: data ?? {}`). The phone's tap handler reads `data.actionScreen` and
 * `data.deepLink` (mobile src/services/pushNotifications.ts dispatchResponse -> routePushTap, pushTapRouter.ts:290-306
 * at f9d71749): with neither, routePushTap returns and the tap opens nothing. So the new link form
 * (community-dms.service.ts:234) never reaches a device tap, and READY's "a DM push opens the thread on the client's
 * phone" is not what the code does. This test fails at the head and passes once the device push data carries the link.
 *
 * Rig as test/community/notifications/community-row-always.spec.ts: the real NotificationsService gate over a stubbed
 * Prisma, only pushToUser spied.
 */
import 'reflect-metadata';
import { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { stub } from '../../utils/trial-fakes';

describe('LS-1243R1 B1: the DM device push carries its deep link', () => {
  const saved = process.env.FEATURE_COMMUNITY_PUSH;
  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_PUSH = 'true';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.FEATURE_COMMUNITY_PUSH;
    else process.env.FEATURE_COMMUNITY_PUSH = saved;
  });

  it("pushToUser's data carries deepLink tgp://community/dm/<sender id>, the field the phone routes a tap by", async () => {
    const prisma = {
      notificationPreferences: { findUnique: jest.fn(async () => null) },
      notification: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'n1', ...a.data })),
      },
      user: { findUnique: jest.fn(async () => ({ expo_push_token: 'ExponentPushToken[ls1243r1]' })) },
    };
    const notifications = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma));
    const push = jest.spyOn(notifications, 'pushToUser').mockImplementation(async () => ({ delivered: true, code: 'delivered' }));
    const svc = new CommunityNotificationsService(
      notifications,
      stub<ConstructorParameters<typeof CommunityNotificationsService>[1]>(prisma),
      stub<ConstructorParameters<typeof CommunityNotificationsService>[2]>({ capture: jest.fn() }),
    );
    const link = 'tgp://community/dm/0f5d3c2a-1111-4222-8333-444455556666';
    await svc.sendCommunityPush({
      recipientId: 'ls1243r1-client',
      kind: NotificationKind.COMMUNITY_DM_RECEIVED,
      targetType: 'dm',
      targetId: 'ls1243r1-dm-1',
      deepLink: link,
      otherUserId: 'ls1243r1-coach',
      workspaceId: 'ls1243r1-ws',
    });
    // The inbox row got the link (today).
    expect(prisma.notification.create.mock.calls[0][0].data.deep_link).toBe(link);
    // The device push must carry it too, or the tap goes nowhere.
    expect(push).toHaveBeenCalledTimes(1);
    const data = push.mock.calls[0][3] as Record<string, unknown>;
    expect(data.deepLink).toBe(link);
  });
});
