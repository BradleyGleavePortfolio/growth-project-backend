import { NotificationKind } from '../../../notifications/notification-kind';
import { lockScreenCopy } from '../../../notifications/push/lock-screen-copy';
import { CommunitySpacePushService } from '../community-space-push.service';
import {
  HIGH_ALERT_DAILY_LIMIT,
  asSpacePushContext,
  planSpacePush,
  spaceCollapseId,
  spacePushCopy,
  spacePushExpoFields,
  spacePushOn,
  type SpacePushReader,
} from '../space-push-policy';

const S = 'sender';
const r = (userId: string, effectiveMode: SpacePushReader['effectiveMode'], unread = 1): SpacePushReader => ({ userId, effectiveMode, unread });
const readers = [r(S, 'all'), r('all1', 'all', 1), r('all5', 'all', 5), r('low', 'mute_low', 3), r('off', 'mute_all', 2)];

describe('SC-PUSH policy', () => {
  it('is off unless FEATURE_COMMUNITY_SPACE_PUSH is "true"', () => {
    const was = process.env.FEATURE_COMMUNITY_SPACE_PUSH;
    delete process.env.FEATURE_COMMUNITY_SPACE_PUSH;
    expect(spacePushOn()).toBe(false);
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = '1';
    expect(spacePushOn()).toBe(false);
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
    expect(spacePushOn()).toBe(true);
    if (was === undefined) delete process.env.FEATURE_COMMUNITY_SPACE_PUSH;
    else process.env.FEATURE_COMMUNITY_SPACE_PUSH = was;
  });

  it('a plain message: All gets the unread notification, Mute low and Mute all nothing, never the sender', () => {
    expect(planSpacePush({ senderId: S, repliedToId: null, highAlert: false }, readers)).toEqual([
      { userId: 'all1', kind: 'unread', unread: 1 },
      { userId: 'all5', kind: 'unread', unread: 5 },
    ]);
  });

  it('a reply rings for the person replied to, even on Mute low; not on Mute all', () => {
    const plan = (to: string) => planSpacePush({ senderId: S, repliedToId: to, highAlert: false }, readers);
    expect(plan('low')).toContainEqual({ userId: 'low', kind: 'reply', unread: 3 });
    expect(plan('off').find((p) => p.userId === 'off')).toBeUndefined();
    expect(plan(S).find((p) => p.userId === S)).toBeUndefined();
  });

  it('a High alert rings for everyone but the sender and Mute all (a silence is Mute all)', () => {
    const plan = planSpacePush({ senderId: S, repliedToId: null, highAlert: true }, readers);
    expect(plan.map((p) => [p.userId, p.kind])).toEqual([['all1', 'high_alert'], ['all5', 'high_alert'], ['low', 'high_alert']]);
    expect(HIGH_ALERT_DAILY_LIMIT).toBe(3);
  });

  it('one collapse id per space; the first unread rings, later ones update quietly; priority rings on its own', () => {
    const at = (kind: 'unread' | 'reply' | 'high_alert', unread: number) => ({ kind, unread, space: 'Team', cohortId: 'c1' });
    expect(spacePushExpoFields(at('unread', 1))).toEqual({ sound: 'default', interruptionLevel: 'active', collapseId: spaceCollapseId('c1'), tag: spaceCollapseId('c1') });
    expect(spacePushExpoFields(at('unread', 4))).toEqual({ sound: null, interruptionLevel: 'passive', collapseId: 'space-unread-c1', tag: 'space-unread-c1' });
    expect(spaceCollapseId('c2')).not.toBe(spaceCollapseId('c1'));
    expect(spacePushExpoFields(at('reply', 4))).toEqual({ sound: 'default', interruptionLevel: 'time-sensitive' });
    expect(spacePushExpoFields(at('high_alert', 0)).collapseId).toBeUndefined();
    expect(spacePushExpoFields(undefined)).toEqual({});
  });

  it('lock screen copy: a count and the space name only, never a name or message text', () => {
    const ctx = { kind: 'unread' as const, unread: 7, space: 'Team', cohortId: 'c1' };
    expect(spacePushCopy(ctx)).toEqual({ title: 'Team', body: '7 unread messages in Team' });
    expect(spacePushCopy({ ...ctx, unread: 1 }).body).toBe('1 unread message in Team');
    expect(spacePushCopy({ ...ctx, unread: 99 }).body).toBe('99+ unread messages in Team');
    expect(lockScreenCopy(NotificationKind.COMMUNITY_MESSAGE_RECEIVED, 'secret text', { spacePush: ctx })).toEqual(spacePushCopy(ctx));
    expect(JSON.stringify(spacePushCopy({ ...ctx, kind: 'reply' }))).not.toContain('secret');
    expect(asSpacePushContext({ ...ctx })).toEqual({ spacePush: ctx });
    expect(asSpacePushContext({ ...ctx, kind: 'other' })).toEqual({});
  });
});

describe('SC-PUSH service', () => {
  const realtime = { onSpaceMessageStored: jest.fn() };
  const sendPush = jest.fn().mockResolvedValue(null);
  const prisma = {
    communityMessage: { findUnique: jest.fn(), count: jest.fn() },
    communityCohort: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    communityWorkspace: { findUnique: jest.fn() },
    userBlock: { findMany: jest.fn() },
    communitySpaceRead: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const svc = new CommunitySpacePushService(prisma as never, { sendPush } as never, realtime as never);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
    prisma.communityMessage.findUnique.mockResolvedValue({ id: 'm1', workspace_id: 'w', cohort_id: 'c1', sender_id: S, parent_message_id: null, high_alert: false, deleted_at: null });
    prisma.communityCohort.findUnique.mockResolvedValue({ name: 'Team' });
    prisma.communityCohort.findUniqueOrThrow.mockResolvedValue({ posting_policy: 'coach' }); // default All
    // readersNow, then one unread count per reader on All
    prisma.$queryRaw.mockResolvedValueOnce([{ id: S }, { id: 'a' }, { id: 'blocked' }, { id: 'blocker' }]).mockResolvedValue([{ c: 'c1', n: 2 }]);
    prisma.userBlock.findMany.mockResolvedValue([{ blocker_id: S, blocked_id: 'blocked' }, { blocker_id: 'blocker', blocked_id: S }]);
    prisma.communitySpaceRead.findMany.mockResolvedValue([]);
  });
  afterAll(() => delete process.env.FEATURE_COMMUNITY_SPACE_PUSH);

  it('listens at the one stored-message point', () => {
    svc.onModuleInit();
    expect(realtime.onSpaceMessageStored).toHaveBeenCalledTimes(1);
  });

  it('pushes the unread notification through the outbox, never to the sender or either side of a block', async () => {
    await svc.messageStored('m1');
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush.mock.calls[0][0]).toMatchObject({
      user_id: 'a',
      kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
      dedupe_key: 'space-push:m1:a',
      context: { spacePush: { kind: 'unread', unread: 2, space: 'Team', cohortId: 'c1' } },
    });
    expect(JSON.stringify(sendPush.mock.calls)).not.toMatch(/blocked|blocker/);
  });

  it('switch off: nothing', async () => {
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'false';
    await svc.messageStored('m1');
    expect(prisma.communityMessage.findUnique).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('High alert: the coach of the space only; reach leaves out Mute all; the day count is returned', async () => {
    prisma.communityWorkspace.findUnique.mockResolvedValue({ coach_id: 'coach' });
    await expect(svc.highAlertAllowance('someone', { id: 'c1', workspace_id: 'w' })).rejects.toMatchObject({ status: 403 });
    prisma.$queryRaw.mockReset().mockResolvedValueOnce([{ id: 'coach' }, { id: 'a' }, { id: 'b' }]);
    prisma.userBlock.findMany.mockResolvedValue([]);
    prisma.communitySpaceRead.findMany.mockResolvedValue([{ user_id: 'b', notify_mode: 'mute_all', silenced_until: null }]);
    prisma.communityMessage.count.mockResolvedValue(2);
    await expect(svc.highAlertAllowance('coach', { id: 'c1', workspace_id: 'w' })).resolves.toEqual({ reach: 1, used_today: 2, limit: 3 });
  });
});
