/**
 * FIX-1243R1 (b#1243, class-first): what must not change when the DM device push gains its deep link
 * (LS-1243R1 B1 = LO-1243R1 C1, server half).
 *
 * The promise (widened by COMMUNITY-LINKS-BE F3 to every community kind): a push sent through sendCommunityPush
 * carries deepLink in its device data exactly when the sender gave a link. These cases pin the two edges that stay as at main:
 *   a. a DM push given no link: the device data has no deepLink key and is the ids and the enum only;
 *   b. the coach's send-time re-check (pushStillCurrent, current-coach-inbox.ts) passes a DM push that now carries
 *      tgp://community/dm/<id> without reading anything, the same answer it gives today for data with no link.
 * The other community kinds carry their own link the same way (community-links-be.spec.ts, community-push-mute.spec.ts).
 *
 * Rig as test/community/notifications/ls-1243r1-dm-push-tap-link.spec.ts: the real NotificationsService gate over a
 * stubbed Prisma, only pushToUser spied.
 */
import 'reflect-metadata';
import { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { NotificationCategory } from '../../../src/notifications/notification-category.enum';
import { pushStillCurrent } from '../../../src/notifications/current-coach-inbox';
import type { PrismaService } from '../../../src/prisma.service';
import { stub } from '../../utils/trial-fakes';

describe('FIX-1243R1: the DM device push link, and what stays as at main', () => {
  const saved = process.env.FEATURE_COMMUNITY_PUSH;
  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_PUSH = 'true';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.FEATURE_COMMUNITY_PUSH;
    else process.env.FEATURE_COMMUNITY_PUSH = saved;
  });

  it('a. a community_dm_received push given no deepLink: the device data has no deepLink key, ids and the enum only', async () => {
    const prisma = {
      notificationPreferences: { findUnique: jest.fn(async () => null) },
      notification: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'n1', ...a.data })),
      },
      user: { findUnique: jest.fn(async () => ({ expo_push_token: 'ExponentPushToken[fix1243r1]' })) },
    };
    const notifications = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma));
    const push = jest.spyOn(notifications, 'pushToUser').mockImplementation(async () => ({ delivered: true, code: 'delivered' }));
    const svc = new CommunityNotificationsService(
      notifications,
      stub<ConstructorParameters<typeof CommunityNotificationsService>[1]>(prisma),
      stub<ConstructorParameters<typeof CommunityNotificationsService>[2]>({ capture: jest.fn() }),
    );
    await svc.sendCommunityPush({
      recipientId: 'fix1243r1-member',
      kind: NotificationKind.COMMUNITY_DM_RECEIVED,
      targetType: 'dm',
      targetId: 'fix1243r1-dm-1',
    });
    expect(push).toHaveBeenCalledTimes(1);
    const data = push.mock.calls[0][3] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(data, 'deepLink')).toBe(false);
    expect(data).toEqual({
      kind: NotificationKind.COMMUNITY_DM_RECEIVED,
      category: NotificationCategory.COACH_DIRECT,
      target_type: 'dm',
      target_id: 'fix1243r1-dm-1',
    });
  });

  it("b. pushStillCurrent passes a coach's DM push carrying tgp://community/dm/<id> and reads nothing", async () => {
    const reads: string[] = [];
    // Every model, every method: record the read and throw, so any read fails the case.
    const db = new Proxy(
      {},
      {
        get: (_t, model) =>
          new Proxy(
            {},
            {
              get: (_m, method) => () => {
                reads.push(`${String(model)}.${String(method)}`);
                throw new Error(`pushStillCurrent read ${String(model)}.${String(method)}`);
              },
            },
          ),
      },
    );
    const data = {
      kind: NotificationKind.COMMUNITY_DM_RECEIVED,
      deepLink: 'tgp://community/dm/0f5d3c2a-1111-4222-8333-444455556666',
    };
    await expect(pushStillCurrent(stub<PrismaService>(db), 'fix1243r1-coach', data)).resolves.toBe(true);
    expect(reads).toEqual([]);
  });
});
