/**
 * C-S-PUSH-4: a cohort (group chat) message sends a COMMUNITY_MESSAGE_RECEIVED
 * push to the other members of the cohort.
 *
 * Before this fix CommunityMessagesService.send wrote the message and emitted
 * the realtime ping but never called a push sender, so a member with the app
 * closed never heard about a new group message. These tests pin who gets the
 * push: other ACTIVE members of the cohort, never the sender, never a member
 * banned from the workspace, never either side of a block, never a member whose
 * cohort notify level is "quiet". Delivery goes through the existing
 * CommunityNotificationsService.sendCommunityPush (flag, "Mute all" and token
 * gates live there). The real repository runs over an in-memory Prisma fake.
 */
import type { CommunityMessage, User } from '@prisma/client';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import type { CommunityAccessService } from '../../../src/community/community-access.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { PlanContextService } from '../../../src/community/plan-context/plan-context.service';
import type {
  CommunityNotificationsService,
  SendCommunityPushInput,
} from '../../../src/community/notifications/community-notifications.service';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import type { PrismaService } from '../../../src/prisma.service';
import { safetyWithBlocks } from '../safety/safety-test-helpers';

function stub<T>(v: unknown): T {
  return v as T;
}

const COHORT = '11111111-1111-1111-1111-111111111111';
const OTHER_COHORT = '11111111-1111-1111-1111-222222222222';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';
const MESSAGE_ID = 'eeeeeeee-0000-0000-0000-000000000001';

const SENDER = 'aaaaaaaa-0000-0000-0000-000000000001';
const MATE = 'aaaaaaaa-0000-0000-0000-000000000002';
const MATE2 = 'aaaaaaaa-0000-0000-0000-000000000003';

interface MembershipRow {
  cohort_id: string;
  user_id: string;
  status: 'invited' | 'active' | 'muted' | 'removed';
  notify_level: string;
}

function member(user_id: string, over: Partial<MembershipRow> = {}): MembershipRow {
  return { cohort_id: COHORT, user_id, status: 'active', notify_level: 'digest', ...over };
}

function fakePrisma(memberships: MembershipRow[], bannedUserIds: string[] = []) {
  return {
    communityMessage: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        const at = new Date('2026-01-01T00:00:00.000Z');
        return stub<CommunityMessage>({
          id: MESSAGE_ID,
          created_at: at,
          updated_at: at,
          coach_replied_at: null,
          coach_seen_at: null,
          coach_acked_at: null,
          deleted_at: null,
          plan_context_type: null,
          ...args.data,
          plan_context_payload: null,
        });
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    communityMembership: {
      findMany: jest.fn(
        async (args: {
          where: { cohort_id: string; status: string; user_id?: { not?: string } };
        }) =>
          memberships
            .filter(
              (m) =>
                m.cohort_id === args.where.cohort_id &&
                m.status === args.where.status &&
                (args.where.user_id?.not === undefined || m.user_id !== args.where.user_id.not),
            )
            .map((m) => ({ user_id: m.user_id, notify_level: m.notify_level })),
      ),
    },
    communityWorkspaceBan: {
      findMany: jest.fn(
        async (args: { where: { workspace_id: string; user_id: { in: string[] } } }) =>
          args.where.workspace_id === WORKSPACE
            ? bannedUserIds
                .filter((id) => args.where.user_id.in.includes(id))
                .map((user_id) => ({ user_id }))
            : [],
      ),
    },
  };
}

const sender = stub<User>({ id: SENDER, role: 'client' });

/** Flush the fire-and-forget push tail. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

function build(opts: {
  memberships: MembershipRow[];
  banned?: string[];
  blocks?: Array<[string, string]>;
  pushOn?: boolean;
}) {
  const prisma = fakePrisma(opts.memberships, opts.banned ?? []);
  const access = {
    findCohort: jest.fn(async () => ({ id: COHORT, workspace_id: WORKSPACE })),
    canAccessCohort: jest.fn(async () => true),
  };
  const realtime = {
    channels: { cohort: jest.fn(() => 'cohort-channel') },
    cohortShard: jest.fn(() => 0),
    broadcastCommunityEvent: jest.fn(async () => undefined),
  };
  const communityPush = {
    pushEnabled: jest.fn(() => opts.pushOn ?? true),
    sendCommunityPush: jest.fn(async (_input: SendCommunityPushInput) => undefined),
  };
  const service = new CommunityMessagesService(
    stub<CommunityAccessService>(access),
    new CommunityMessagesRepository(stub<PrismaService>(prisma)),
    stub<CommunityRealtimeService>(realtime),
    stub<PlanContextService>({ validate: jest.fn(async () => null) }),
    safetyWithBlocks(opts.blocks ?? []),
    stub<CommunityNotificationsService>(communityPush),
  );
  return { service, communityPush, prisma };
}

function recipients(push: ReturnType<typeof build>['communityPush']): string[] {
  return push.sendCommunityPush.mock.calls.map(([input]) => input.recipientId);
}

describe('CommunityMessagesService.send — group chat push (C-S-PUSH-4)', () => {
  it('pushes every other active member of the cohort, with ids and a deep link only', async () => {
    const { service, communityPush } = build({
      memberships: [member(SENDER), member(MATE), member(MATE2, { notify_level: 'live' })],
    });
    await service.send(sender, COHORT, 'leg day done, who is in tomorrow');
    await settle();

    expect(recipients(communityPush).sort()).toEqual([MATE, MATE2].sort());
    for (const [input] of communityPush.sendCommunityPush.mock.calls) {
      expect(input).toEqual({
        recipientId: expect.any(String),
        kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
        targetType: 'message',
        targetId: MESSAGE_ID,
        deepLink: `tgp://community/cohorts/${COHORT}`,
      });
      // Never the message text (lock-screen privacy).
      expect(JSON.stringify(input)).not.toContain('leg day');
    }
  });

  it('never pushes the sender', async () => {
    const { service, communityPush } = build({ memberships: [member(SENDER), member(MATE)] });
    await service.send(sender, COHORT, 'hello team');
    await settle();
    expect(recipients(communityPush)).toEqual([MATE]);
  });

  it('skips members who are not active in this cohort (removed, muted, invited, other cohort)', async () => {
    const { service, communityPush } = build({
      memberships: [
        member(SENDER),
        member(MATE),
        member('u-removed', { status: 'removed' }),
        member('u-muted', { status: 'muted' }),
        member('u-invited', { status: 'invited' }),
        member('u-elsewhere', { cohort_id: OTHER_COHORT }),
      ],
    });
    await service.send(sender, COHORT, 'hello team');
    await settle();
    expect(recipients(communityPush)).toEqual([MATE]);
  });

  it('skips a member banned from the workspace', async () => {
    const { service, communityPush } = build({
      memberships: [member(SENDER), member(MATE), member('u-banned')],
      banned: ['u-banned'],
    });
    await service.send(sender, COHORT, 'hello team');
    await settle();
    expect(recipients(communityPush)).toEqual([MATE]);
  });

  it('skips both sides of a block (the sender blocked them, or they blocked the sender)', async () => {
    const { service, communityPush } = build({
      memberships: [
        member(SENDER),
        member(MATE),
        member('u-blocked-by-sender'),
        member('u-who-blocked-sender'),
      ],
      blocks: [
        [SENDER, 'u-blocked-by-sender'],
        ['u-who-blocked-sender', SENDER],
      ],
    });
    await service.send(sender, COHORT, 'hello team');
    await settle();
    expect(recipients(communityPush)).toEqual([MATE]);
  });

  it('skips a member whose cohort notify level is quiet', async () => {
    const { service, communityPush } = build({
      memberships: [member(SENDER), member(MATE), member('u-quiet', { notify_level: 'quiet' })],
    });
    await service.send(sender, COHORT, 'hello team');
    await settle();
    expect(recipients(communityPush)).toEqual([MATE]);
  });

  it('does not look up recipients when community push is switched off', async () => {
    const { service, communityPush, prisma } = build({
      memberships: [member(SENDER), member(MATE)],
      pushOn: false,
    });
    await service.send(sender, COHORT, 'hello team');
    await settle();
    expect(communityPush.sendCommunityPush).not.toHaveBeenCalled();
    expect(prisma.communityMembership.findMany).not.toHaveBeenCalled();
  });

  it('still returns the sent message when the recipient lookup fails', async () => {
    const { service, communityPush, prisma } = build({
      memberships: [member(SENDER), member(MATE)],
    });
    prisma.communityMembership.findMany.mockRejectedValueOnce(new Error('db down'));
    const res = await service.send(sender, COHORT, 'hello team');
    await settle();
    expect(res.message.id).toBe(MESSAGE_ID);
    expect(communityPush.sendCommunityPush).not.toHaveBeenCalled();
  });
});
