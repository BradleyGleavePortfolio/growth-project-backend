/**
 * community-push-mute.spec.ts — B-S-PUSH-1: community push honours the
 * recipient's "Mute all notifications" switch.
 *
 * A member mutes everything, another member replies to their post, and the
 * reply must not reach the muted member's device. The same reply to an
 * unmuted member still sends with the community defaults (community kinds have
 * no per-kind preference column; the core gate maps them onto `digest`, whose
 * push default is off, so that mapping must not silence community push).
 *
 * Runs the REAL NotificationsService preference gate over a stubbed Prisma;
 * only the Expo transport (pushToUser) is spied.
 */

import 'reflect-metadata';
import { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { NotificationCategory } from '../../../src/notifications/notification-category.enum';
import { stub } from '../../utils/trial-fakes';

const AUTHOR = 'author-1';
const POST = 'post-1';

function build(prefsRow: Record<string, unknown> | null) {
  const prisma = {
    notificationPreferences: { findUnique: jest.fn(async () => prefsRow) },
    notification: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (a: { data: object }) => ({ id: 'n1', ...a.data })),
    },
    user: {
      findUnique: jest.fn(async () => ({ expo_push_token: 'ExponentPushToken[author]' })),
    },
  };
  const notifications = new NotificationsService(
    stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma),
  );
  const push = jest
    .spyOn(notifications, 'pushToUser')
    .mockResolvedValue({ delivered: true, code: 'delivered' });
  const analytics = { capture: jest.fn() };
  const svc = new CommunityNotificationsService(
    notifications,
    stub<ConstructorParameters<typeof CommunityNotificationsService>[1]>(prisma),
    stub<ConstructorParameters<typeof CommunityNotificationsService>[2]>(analytics),
  );
  return { svc, push, prisma, analytics };
}

/** The exact call the reply producer makes (community-posts.service.ts). */
function reply(svc: CommunityNotificationsService) {
  return svc.sendCommunityPush({
    recipientId: AUTHOR,
    kind: NotificationKind.COMMUNITY_POST_REPLIED,
    targetType: 'post',
    targetId: POST,
    deepLink: `tgp://community/posts/${POST}`,
  });
}

describe('B-S-PUSH-1 community push and "Mute all notifications"', () => {
  const saved = {
    push: process.env.FEATURE_COMMUNITY_PUSH,
    telemetry: process.env.FEATURE_COMMUNITY_TELEMETRY,
  };

  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_PUSH = 'true';
    process.env.FEATURE_COMMUNITY_TELEMETRY = 'true';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (saved.push === undefined) delete process.env.FEATURE_COMMUNITY_PUSH;
    else process.env.FEATURE_COMMUNITY_PUSH = saved.push;
    if (saved.telemetry === undefined) delete process.env.FEATURE_COMMUNITY_TELEMETRY;
    else process.env.FEATURE_COMMUNITY_TELEMETRY = saved.telemetry;
  });

  it('muted member: a reply to their post sends no push and writes no inbox row', async () => {
    const { svc, push, prisma, analytics } = build({
      user_id: AUTHOR,
      muted: true,
      digest_push: false,
    });

    await reply(svc);

    expect(push).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(analytics.capture).toHaveBeenCalledWith(AUTHOR, 'community.push.skipped', {
      kind: NotificationKind.COMMUNITY_POST_REPLIED,
      reason: 'muted',
    });
  });

  it('unmuted member: the same reply still sends with the community defaults', async () => {
    const { svc, push } = build({ user_id: AUTHOR, muted: false, digest_push: false });

    await reply(svc);

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(AUTHOR, 'Community', 'New reply on your post', {
      kind: NotificationKind.COMMUNITY_POST_REPLIED,
      category: NotificationCategory.CLIENT_BOT,
      target_type: 'post',
      target_id: POST,
    });
  });

  it('member with no preferences row yet: the reply sends (default is unmuted)', async () => {
    const { svc, push } = build(null);

    await reply(svc);

    expect(push).toHaveBeenCalledTimes(1);
  });
});
