/**
 * SPACE-404-CLASS (operator ruling 6353734516 on b#1137), FR-1161R B1(1):
 * PATCH /community/moderation/items/:itemId. A report outside the caller's
 * authority (another coach's workspace, or a member who is not a moderator)
 * answers the same 404 status and body as a report id that does not exist,
 * before any action work, so the API never confirms the report exists. The
 * workspace's coach and the platform owner still act. The queue route keeps
 * its 403 for a non-moderator (workspace-only, not in this class).
 */
import { ForbiddenException, HttpException } from '@nestjs/common';
import type { User } from '@prisma/client';

import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityPostsRepository } from '../../../src/community/posts/community-posts.repository';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityModerationService } from '../../../src/community/moderation/community-moderation.service';
import { CommunityModerationRepository } from '../../../src/community/moderation/community-moderation.repository';
import { CommunitySafetyService } from '../../../src/community/safety/community-safety.service';
import type { PrismaService } from '../../../src/prisma.service';
import type { VoiceUploadProvider } from '../../../src/community/voice/voice-upload.provider';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { PlanContextService } from '../../../src/community/plan-context/plan-context.service';
import { InMemoryPrisma } from '../safety/in-memory-prisma';

function stub<T>(v: unknown): T {
  return v as T;
}

const ABSENT_ITEM = '99999999-9999-4999-8999-999999999999';

/** The refusal a call ends in: HTTP status plus the exact response body. */
async function refusal(p: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error('expected the call to be refused');
}

describe('PATCH moderation/items/:itemId — foreign answers like missing (SPACE-404-CLASS)', () => {
  let db: InMemoryPrisma;
  let messages: CommunityMessagesService;
  let moderation: CommunityModerationService;
  let coach: User;
  let alice: User;
  let bob: User;
  let otherCoach: User;
  let platformOwner: User;
  let wsId: string;
  let cohortId: string;

  const realtime = {
    channels: {
      cohort: () => 'cohort',
      workspace: () => 'workspace',
      user: () => 'user',
      moderation: () => 'moderation',
    },
    cohortShard: () => 0,
    broadcastCommunityEvent: jest.fn(async () => undefined),
  };

  function user(role: string, name: string): User {
    const coachId = role === 'student' ? coach.id : null;
    return stub<User>(db.seed('user', { role, name, deleted_at: null, coach_id: coachId }));
  }

  beforeEach(() => {
    db = new InMemoryPrisma();
    const prisma = stub<PrismaService>(db);
    coach = user('coach', 'Coach One');
    alice = user('student', 'Alice Member');
    bob = user('student', 'Bob Member');
    otherCoach = user('coach', 'Other Coach');
    platformOwner = user('owner', 'Platform Owner');
    wsId = db.seed('communityWorkspace', {
      coach_id: coach.id,
      name: 'Hall',
      dm_enabled_default: true,
      archived_at: null,
    }).id as string;
    // The other coach runs a real workspace of their own; the report is not in it.
    db.seed('communityWorkspace', {
      coach_id: otherCoach.id,
      name: 'Elsewhere',
      dm_enabled_default: true,
      archived_at: null,
    });
    cohortId = db.seed('communityCohort', { workspace_id: wsId, name: 'Spring plan' }).id as string;
    for (const u of [alice, bob]) {
      db.seed('communityMembership', {
        workspace_id: wsId,
        cohort_id: cohortId,
        user_id: u.id,
        status: 'active',
        role: 'member',
        dm_enabled: null,
        removed_at: null,
      });
    }
    const access = new CommunityAccessService(prisma);
    const msgRepo = new CommunityMessagesRepository(prisma);
    const rt = stub<CommunityRealtimeService>(realtime);
    const np = stub<CommunityNotificationsService>({
      pushEnabled: () => false,
      sendCommunityPush: async () => undefined,
    });
    messages = new CommunityMessagesService(
      access,
      msgRepo,
      rt,
      stub<PlanContextService>({ validate: async () => null }),
      new CommunitySafetyService(prisma),
      np,
    );
    moderation = new CommunityModerationService(
      access,
      new CommunityModerationRepository(prisma),
      msgRepo,
      new CommunityPostsRepository(prisma),
      rt,
      np,
      prisma,
      stub<VoiceUploadProvider>({ createSignedDownload: async () => null }),
    );
  });

  async function reportedMessage(): Promise<{ itemId: string; messageId: string }> {
    const m = await messages.send(bob, cohortId, 'something');
    const r = await moderation.report(alice, 'message', m.message.id, 'spam', undefined);
    return { itemId: r.item.id, messageId: m.message.id };
  }

  function reportRow(itemId: string) {
    return db.table('communityModerationAction').find((row) => row.id === itemId);
  }

  it('another coach and a member get exactly the missing-item 404, and nothing is written', async () => {
    const { itemId, messageId } = await reportedMessage();
    const before = JSON.stringify(reportRow(itemId));
    const notices = db.table('notification').length;
    const tx = jest.spyOn(db, '$transaction');

    const missing = await refusal(moderation.act(coach, ABSENT_ITEM, 'hide', undefined));
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      error: 'not_found',
      code: 'community.moderation.not_found',
    });

    for (const caller of [otherCoach, alice, bob]) {
      for (const action of ['hide', 'warn', 'ban', 'dismiss'] as const) {
        expect(await refusal(moderation.act(caller, itemId, action, undefined))).toEqual(missing);
      }
    }

    // Refused before any action work: no transaction, the report is still
    // open and unchanged, no notice, and the message is still there.
    expect(tx).not.toHaveBeenCalled();
    expect(JSON.stringify(reportRow(itemId))).toBe(before);
    expect(reportRow(itemId)?.status).toBe('open');
    expect(db.table('notification').length).toBe(notices);
    const msg = db.table('communityMessage').find((row) => row.id === messageId);
    expect(msg?.deleted_at ?? null).toBeNull();
  });

  it("the workspace's coach still acts on the report", async () => {
    const { itemId } = await reportedMessage();
    const out = await moderation.act(coach, itemId, 'hide', undefined);
    expect(out.item).toMatchObject({ id: itemId, status: 'actioned', action: 'hide' });
  });

  it('the platform owner still acts on the report', async () => {
    const { itemId } = await reportedMessage();
    const out = await moderation.act(platformOwner, itemId, 'dismiss', undefined);
    expect(out.item).toMatchObject({ id: itemId, status: 'dismissed' });
  });

  it('the coach keeps acting after the author has left the space', async () => {
    const { itemId } = await reportedMessage();
    for (const row of db.table('communityMembership')) {
      if (row.user_id === bob.id) Object.assign(row, { status: 'removed', removed_at: new Date() });
    }
    const out = await moderation.act(coach, itemId, 'dismiss', undefined);
    expect(out.item).toMatchObject({ id: itemId, status: 'dismissed' });
  });

  it('the workspace queue keeps its 403 for a non-moderator (not in this class)', async () => {
    await expect(moderation.listQueue(alice, wsId, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(moderation.listQueue(otherCoach, wsId, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
