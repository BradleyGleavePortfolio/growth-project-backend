/**
 * COMMUNITY-ROW-ALWAYS (OB2, b#1154 AUDIT 6388619778): a community inbox row
 * is written for every member, whether or not their phone has a push token.
 * A member with no token (never allowed notifications, signed out, or the
 * token was cleared) gets the row; only the push is skipped (no_token).
 *
 * Runs the REAL NotificationsService gate over a stubbed Prisma; only the Expo
 * transport (pushToUser) is spied.
 */

import 'reflect-metadata';
import { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { CommunityPushKind } from '../../../src/community/notifications/community-notifications.types';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { stub } from '../../utils/trial-fakes';

const TOKEN = 'ExponentPushToken[member]';
// createNotification keeps a 60 s per-member, per-kind push-row throttle in
// module state, so every test uses its own member.
let seq = 0;

function build(opts: { token: string | null; muted?: boolean }) {
  seq += 1;
  const member = `member-${seq}`;
  const prefs = opts.muted ? { user_id: member, muted: true } : null;
  const rows: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const prisma = {
    notificationPreferences: { findUnique: jest.fn(async () => prefs) },
    notification: {
      findFirst: jest.fn(async () => (rows.length ? { id: 'n1' } : null)),
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        rows.push(a.data);
        order.push('row');
        return { id: 'n1', ...a.data };
      }),
    },
    user: { findUnique: jest.fn(async () => ({ expo_push_token: opts.token })) },
  };
  const notifications = new NotificationsService(stub<ConstructorParameters<typeof NotificationsService>[0]>(prisma));
  const push = jest.spyOn(notifications, 'pushToUser').mockImplementation(async () => {
    order.push('push');
    return { delivered: true, code: 'delivered' };
  });
  const analytics = { capture: jest.fn() };
  const svc = new CommunityNotificationsService(
    notifications,
    stub<ConstructorParameters<typeof CommunityNotificationsService>[1]>(prisma),
    stub<ConstructorParameters<typeof CommunityNotificationsService>[2]>(analytics),
  );
  return { svc, push, rows, order, analytics, member };
}

function send(w: { svc: CommunityNotificationsService; member: string }, kind: CommunityPushKind, id = 'target-1') {
  return w.svc.sendCommunityPush({
    recipientId: w.member,
    kind,
    targetType: 'post',
    targetId: id,
    deepLink: `tgp://community/posts/${id}`,
  });
}

// The community kinds with a live sender whose row the core gate writes at main.
// COMMUNITY_MESSAGE_RECEIVED is left out: its row still falls to the `digest`
// prefs at main (b#1138 owns that fix). COMMUNITY_MEMBERSHIP_CHANGED has no
// sender and its defaults table says no push, so it never reaches the row.
const KINDS: CommunityPushKind[] = [
  NotificationKind.COMMUNITY_DM_RECEIVED,
  NotificationKind.COMMUNITY_POST_REPLIED,
  NotificationKind.COMMUNITY_EVENT_STARTING_SOON,
  NotificationKind.COMMUNITY_CHALLENGE_MILESTONE,
  NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME,
];

describe('COMMUNITY-ROW-ALWAYS: the inbox row does not depend on a push token', () => {
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

  it.each(KINDS)('%s, no push token: the row is written, the push is skipped as no_token', async (kind) => {
    const w = build({ token: null });
    await send(w, kind);
    expect(w.rows).toEqual([expect.objectContaining({ user_id: w.member, kind })]);
    expect(w.push).not.toHaveBeenCalled();
    expect(w.analytics.capture).toHaveBeenCalledWith(w.member, 'community.push.skipped', { kind, reason: 'no_token' });
  });

  it.each(KINDS)('%s, with a push token: the row is written first, then the push goes', async (kind) => {
    const w = build({ token: TOKEN });
    await send(w, kind);
    expect(w.rows).toEqual([expect.objectContaining({ user_id: w.member, kind })]);
    expect(w.push).toHaveBeenCalledTimes(1);
    expect(w.order).toEqual(['row', 'push']);
  });

  it('Mute all on and no token: the row is still written, no push (reason no_token, as before)', async () => {
    const w = build({ token: null, muted: true });
    await send(w, NotificationKind.COMMUNITY_POST_REPLIED);
    expect(w.rows).toHaveLength(1);
    expect(w.push).not.toHaveBeenCalled();
    expect(w.analytics.capture).toHaveBeenCalledWith(w.member, 'community.push.skipped', {
      kind: NotificationKind.COMMUNITY_POST_REPLIED,
      reason: 'no_token',
    });
  });

  it('a replay of the same event for a member with no token writes no second row', async () => {
    const w = build({ token: null });
    await send(w, NotificationKind.COMMUNITY_DM_RECEIVED, 'dm-1');
    await send(w, NotificationKind.COMMUNITY_DM_RECEIVED, 'dm-1');
    expect(w.rows).toHaveLength(1);
    expect(w.push).not.toHaveBeenCalled();
  });

  it('the push feature flag off still writes nothing (unchanged)', async () => {
    process.env.FEATURE_COMMUNITY_PUSH = 'false';
    const w = build({ token: null });
    await send(w, NotificationKind.COMMUNITY_POST_REPLIED);
    expect(w.rows).toHaveLength(0);
    expect(w.push).not.toHaveBeenCalled();
  });
});
