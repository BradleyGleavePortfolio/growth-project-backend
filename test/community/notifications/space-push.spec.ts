/**
 * SC-PUSH (b#1138): space chat push policy, lock-screen copy and the push service. Lives under test/ because
 * jest.config.js roots do not include src/community/space-push (FX-1138 moved it here so CI runs it).
 */
import 'reflect-metadata';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { lockScreenCopy } from '../../../src/notifications/push/lock-screen-copy';
import { quietHoursFor } from '../../../src/notifications/push/push-quiet-hours';
import { CommunitySpacePushService } from '../../../src/community/space-push/community-space-push.service';
import {
  HIGH_ALERT_DAILY_LIMIT,
  asSpacePushContext,
  planSpacePush,
  spaceCollapseId,
  spacePushCopy,
  spacePushExpoFields,
  spacePushOn,
  type SpacePushReader,
} from '../../../src/community/space-push/space-push-policy';

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

  it('#168-14: a reply names its sender (never the text); "Someone" when no name is stored', () => {
    const reply = { kind: 'reply' as const, unread: 0, space: 'Team', cohortId: 'c1' };
    expect(spacePushCopy({ ...reply, from: 'Sam' })).toEqual({ title: 'New reply', body: 'Sam replied to your message in Team' });
    expect(spacePushCopy(reply)).toEqual({ title: 'New reply', body: 'Someone replied to your message in Team' });
    // The stored outbox row keeps the name through the send step; only a reply carries one.
    expect(asSpacePushContext({ ...reply, from: ' Sam ' })).toEqual({ spacePush: { ...reply, from: 'Sam' } });
    expect(asSpacePushContext({ ...reply, from: '  ' })).toEqual({ spacePush: reply });
    expect(asSpacePushContext({ ...reply, kind: 'unread', from: 'Sam' })).toEqual({ spacePush: { ...reply, kind: 'unread' } });
    expect(lockScreenCopy(NotificationKind.COMMUNITY_MESSAGE_RECEIVED, 'the message text', { spacePush: { ...reply, from: 'Sam' } }).body).toBe(
      'Sam replied to your message in Team',
    );
  });

  it('quiet hours: a space push sent at 23:00 local waits for 08:00; at noon it goes now', () => {
    const tz = 'America/Los_Angeles';
    const night = quietHoursFor({ kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED, timeZone: tz, now: new Date('2026-10-23T06:00:00Z') });
    expect(night).toEqual({ deliverAt: new Date('2026-10-23T15:00:00Z'), deferred: true, reason: 'quiet_hours' });
    const noon = new Date('2026-10-23T19:00:00Z');
    expect(quietHoursFor({ kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED, timeZone: tz, now: noon })).toEqual({ deliverAt: noon, deferred: false, reason: 'open' });
  });
});

describe('SC-PUSH service', () => {
  const realtime = { onSpaceMessageStored: jest.fn() };
  const sendPush = jest.fn().mockResolvedValue(null);
  const prisma = {
    communityMessage: { findFirst: jest.fn(), count: jest.fn() },
    communityCohort: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findMany: jest.fn() },
    communityWorkspaceBan: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    communityWorkspace: { findUnique: jest.fn() },
    userBlock: { findMany: jest.fn() },
    communitySpaceRead: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const svc = new CommunitySpacePushService(prisma as never, { sendPush } as never, realtime as never);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'true';
    prisma.communityMessage.findFirst.mockResolvedValue({ id: 'm1', workspace_id: 'w', cohort_id: 'c1', sender_id: S, parent_message_id: null, high_alert: false, deleted_at: null });
    prisma.communityCohort.findUnique.mockResolvedValue({ name: 'Team' });
    prisma.communityCohort.findUniqueOrThrow.mockResolvedValue({ posting_policy: 'coach' }); // default All
    // readersNow, then one unread count per reader on All
    prisma.$queryRaw.mockResolvedValueOnce([{ id: S }, { id: 'a' }, { id: 'blocked' }, { id: 'blocker' }]).mockResolvedValue([{ c: 'c1', n: 2 }]);
    prisma.userBlock.findMany.mockResolvedValue([{ blocker_id: S, blocked_id: 'blocked' }, { blocker_id: 'blocker', blocked_id: S }]);
    prisma.communitySpaceRead.findMany.mockResolvedValue([]);
    prisma.communityWorkspaceBan.findFirst.mockResolvedValue(null);
    prisma.communityCohort.findMany.mockResolvedValue([]); // no all-clients space: first names
    prisma.user.findUnique.mockResolvedValue({ name: 'Sam Rivers' });
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

  it('only chat messages push: the lookup is the unread count\'s rows (no post comment, plan tag or deleted row)', async () => {
    prisma.communityMessage.findFirst.mockReset().mockResolvedValue(null);
    await svc.messageStored('comment1');
    expect(prisma.communityMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'comment1', scope: 'cohort', plan_context_type: null, deleted_at: null } }),
    );
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('a sender banned from the community causes no push', async () => {
    prisma.communityWorkspaceBan.findFirst.mockResolvedValue({ id: 'ban' });
    await svc.messageStored('m1');
    expect(prisma.communityWorkspaceBan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspace_id: 'w', user_id: S, lifted_at: null } }),
    );
    expect(sendPush).not.toHaveBeenCalled();
  });

  describe('a reply', () => {
    const reply = { id: 'm2', workspace_id: 'w', cohort_id: 'c1', sender_id: S, parent_message_id: 'p1', high_alert: false };
    const replyTo = (author: string) =>
      prisma.communityMessage.findFirst.mockReset().mockResolvedValueOnce(reply).mockResolvedValueOnce({ sender_id: author });

    it('one push to the author replied to, naming the sender as they see them; opens the space at that message', async () => {
      replyTo('a');
      prisma.$queryRaw.mockReset().mockResolvedValueOnce([{ id: S }, { id: 'a' }, { id: 'b' }]).mockResolvedValue([{ c: 'c1', n: 3 }]);
      prisma.userBlock.findMany.mockResolvedValue([]);
      await svc.messageStored('m2');
      // The parent must be a chat message of the same space.
      expect(prisma.communityMessage.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { id: 'p1', cohort_id: 'c1', scope: 'cohort', deleted_at: null } }),
      );
      const calls = sendPush.mock.calls.map((c) => c[0]);
      expect(calls.filter((c) => c.user_id === 'a')).toEqual([
        expect.objectContaining({
          deep_link: 'tgp://community/cohorts/c1?message=m2',
          dedupe_key: 'space-push:m2:a',
          context: { spacePush: { kind: 'reply', unread: 3, space: 'Team', cohortId: 'c1', from: 'Sam' } },
        }),
      ]);
      // Everyone else on All gets the unread notification, which opens the space at its read line; never the sender.
      expect(calls.find((c) => c.user_id === 'b')).toMatchObject({ deep_link: 'tgp://community/cohorts/c1', context: { spacePush: { kind: 'unread' } } });
      expect(calls.find((c) => c.user_id === S)).toBeUndefined();
      expect(JSON.stringify(calls)).not.toContain('Rivers');
    });

    it('full name in a space open to all of the coach\'s clients; "Someone" when no name is stored', async () => {
      replyTo('a');
      prisma.communityCohort.findMany.mockResolvedValue([{ id: 'c1' }]);
      prisma.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([{ id: S }, { id: 'a' }]) // readersNow
        .mockResolvedValueOnce([{ c: 'c1', n: 1 }]) // a's unread
        .mockResolvedValueOnce([{ k: 'c1:a' }]) // the viewer is in the all-clients space
        .mockResolvedValueOnce([{ k: `c1:${S}` }]); // and so is the sender
      prisma.userBlock.findMany.mockResolvedValue([]);
      await svc.messageStored('m2');
      expect(sendPush.mock.calls[0][0].context.spacePush.from).toBe('Sam Rivers');

      sendPush.mockClear();
      replyTo('a');
      prisma.user.findUnique.mockResolvedValue({ name: '  ' });
      prisma.$queryRaw.mockReset().mockResolvedValueOnce([{ id: S }, { id: 'a' }]).mockResolvedValue([{ c: 'c1', n: 1 }]);
      await svc.messageStored('m2');
      expect(sendPush.mock.calls[0][0].context.spacePush).toEqual({ kind: 'reply', unread: 1, space: 'Team', cohortId: 'c1' });
    });

    it('mute modes: Mute low still gets the reply, Mute all (or a running silence) gets nothing', async () => {
      for (const [row, pushed] of [
        [{ user_id: 'a', notify_mode: 'mute_low', silenced_until: null }, true],
        [{ user_id: 'a', notify_mode: 'mute_all', silenced_until: null }, false],
        [{ user_id: 'a', notify_mode: 'all', silenced_until: new Date(Date.now() + 3_600_000) }, false],
      ] as const) {
        sendPush.mockClear();
        replyTo('a');
        prisma.$queryRaw.mockReset().mockResolvedValueOnce([{ id: S }, { id: 'a' }]).mockResolvedValue([{ c: 'c1', n: 1 }]);
        prisma.userBlock.findMany.mockResolvedValue([]);
        prisma.communitySpaceRead.findMany.mockResolvedValue([row]);
        await svc.messageStored('m2');
        expect(sendPush.mock.calls.map((c) => [c[0].user_id, c[0].context.spacePush.kind])).toEqual(pushed ? [['a', 'reply']] : []);
      }
    });

    it('either side of a block: the author replied to gets nothing, and a reply to yourself pushes no one twice', async () => {
      replyTo('a');
      prisma.$queryRaw.mockReset().mockResolvedValueOnce([{ id: S }, { id: 'a' }]).mockResolvedValue([{ c: 'c1', n: 1 }]);
      prisma.userBlock.findMany.mockResolvedValue([{ blocker_id: 'a', blocked_id: S }]);
      await svc.messageStored('m2');
      expect(sendPush).not.toHaveBeenCalled();

      replyTo(S);
      prisma.$queryRaw.mockReset().mockResolvedValueOnce([{ id: S }, { id: 'a' }]).mockResolvedValue([{ c: 'c1', n: 1 }]);
      prisma.userBlock.findMany.mockResolvedValue([]);
      await svc.messageStored('m2');
      expect(sendPush.mock.calls.map((c) => [c[0].user_id, c[0].context.spacePush.kind])).toEqual([['a', 'unread']]);
    });
  });

  it('switch off: nothing', async () => {
    process.env.FEATURE_COMMUNITY_SPACE_PUSH = 'false';
    await svc.messageStored('m1');
    expect(prisma.communityMessage.findFirst).not.toHaveBeenCalled();
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
