/**
 * #610 fix round 6 (GPT-6.1 Sol REQUEST CHANGES at a98d08b5): behaviour proofs
 * over the REAL moderation, access, repository and erasure code on the
 * in-memory Prisma, whose transactions now roll back like Postgres and refuse
 * root-client writes while a transaction is open (in-memory-prisma.ts).
 * Every test here fails on a98d08b5.
 *
 * - B-610-13: enforcement (ban row, memberships removed, content hidden),
 *   the recording erasure intent, the resolution and the member notice are
 *   one transaction. A failed notice write, a lost COMMIT or a process death
 *   after enforcement leaves no silent ban, no hidden content, an open report
 *   and nothing to erase; the moderator's retry then applies it exactly once.
 *   Sol's probe "a failed notice transaction cannot leave a member silently
 *   banned" is kept as the first test (adapted: on the fixed code there is
 *   only one transaction, so the failure is injected into that one).
 * - B-610-8: Sol's probe "ambiguous storage HTTP 400 cannot certify a
 *   recording erased", verbatim. The full real-SDK matrix lives in
 *   src/community/voice/__tests__/voice-erasure-verification.spec.ts.
 */
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { User } from '@prisma/client';

import type { PrismaService } from '../../../src/prisma.service';
import { CommunityModerationService } from '../../../src/community/moderation/community-moderation.service';
import { CommunityModerationRepository } from '../../../src/community/moderation/community-moderation.repository';
import { CommunityAccessService } from '../../../src/community/community-access.service';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CommunityPostsRepository } from '../../../src/community/posts/community-posts.repository';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { VoiceUploadProvider } from '../../../src/community/voice/voice-upload.provider';
import { VoiceUploadProvider as RealVoiceUploadProvider } from '../../../src/community/voice/voice-upload.provider';
import type { SupabaseService } from '../../../src/supabase/supabase.service';
import {
  VoiceErasureService,
  attemptVoiceErasures,
  recordVoiceErasures,
} from '../../../src/community/voice/voice-erasure';
import { COMMUNITY_MODERATION_NOTICE_KIND } from '../../../src/community/safety/community-moderation-notices';
import { InMemoryPrisma } from './in-memory-prisma';

function stub<T>(v: object): T {
  return v as T;
}

const COACH = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const COHORT = '33333333-3333-4333-8333-333333333333';
const POST = '66666666-6666-4666-8666-666666666666';
const NOTE = '77777777-7777-4777-8777-777777777777';
const REPORTER = '99999999-9999-4999-8999-999999999999';
const COACH_POST = '88888888-8888-4888-8888-888888888888';

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

describe('#610 round 6: B-610-13 one transaction for enforcement + notice', () => {
  let db: InMemoryPrisma;
  let prisma: PrismaService;
  let svc: CommunityModerationService;
  let push: { sendCommunityPush: jest.Mock };
  let removeObjects: jest.Mock;
  let coach: User;
  const KEY = '55555555-5555-4555-8555-555555555555/1700000000000-0123456789abcdef.m4a';

  function seedWorld(): void {
    coach = stub<User>(db.seed('user', { id: COACH, role: 'coach', coach_id: null }));
    db.seed('user', {
      id: '55555555-5555-4555-8555-555555555555',
      role: 'student',
      coach_id: COACH,
    });
    db.seed('communityWorkspace', { id: WS, coach_id: COACH, archived_at: null });
    db.seed('communityCohort', {
      id: COHORT,
      workspace_id: WS,
      status: 'active',
      archived_at: null,
      sort_order: 0,
    });
    db.seed('communityMembership', {
      workspace_id: WS,
      cohort_id: COHORT,
      user_id: '55555555-5555-4555-8555-555555555555',
      status: 'active',
      role: 'student',
    });
  }
  const MEMBER = '55555555-5555-4555-8555-555555555555';

  function seedPostReport(): string {
    db.seed('communityPost', { id: POST, workspace_id: WS, author_id: MEMBER });
    const r = db.seed('communityModerationAction', {
      workspace_id: WS,
      target_type: 'post',
      target_id: POST,
      status: 'open',
      reported_by_id: REPORTER,
      reason: 'other',
    });
    return r.id as string;
  }

  function seedVoiceReport(): string {
    db.seed('communityVoiceNote', {
      id: NOTE,
      workspace_id: WS,
      cohort_id: COHORT,
      author_id: MEMBER,
      storage_key: KEY,
      duration_ms: 42_000,
      bytes: BigInt(120_000),
      mime_type: 'audio/mp4',
    });
    db.seed('communitySearchEntry', {
      workspaceId: WS,
      cohortId: COHORT,
      kind: 'voice_note_transcript',
      targetId: NOTE,
      authorId: MEMBER,
    });
    const r = db.seed('communityModerationAction', {
      workspace_id: WS,
      target_type: 'voice_note',
      target_id: NOTE,
      status: 'open',
      reported_by_id: REPORTER,
      reason: 'other',
    });
    return r.id as string;
  }

  /** Every write act() can make, in the state a never-actioned report has. */
  function expectUntouched(reportId: string): void {
    expect(db.table('communityWorkspaceBan')).toHaveLength(0);
    expect(db.table('communityMembership').map((m) => m.status)).toEqual(['active']);
    expect(db.table('communityModerationAction').find((x) => x.id === reportId)).toMatchObject({
      status: 'open',
      action: null,
      actor_id: null,
      resolved_at: null,
    });
    expect(db.table('notification')).toHaveLength(0);
    for (const p of db.table('communityPost')) expect(p.deleted_at).toBeNull();
    for (const n of db.table('communityVoiceNote')) expect(n.soft_deleted_at).toBeNull();
    for (const s of db.table('communitySearchEntry')) expect(s.softDeletedAt).toBeNull();
    expect(db.table('communityVoiceErasure')).toHaveLength(0);
  }

  beforeEach(() => {
    process.env.FEATURE_COMMUNITY_API = 'true';
    db = new InMemoryPrisma();
    prisma = stub<PrismaService>(db);
    seedWorld();
    push = { sendCommunityPush: jest.fn(async () => undefined) };
    removeObjects = jest.fn(async (keys: string[]) => ({ removed: keys.length, failed: false }));
    const storage = stub<VoiceUploadProvider>({
      bucket: () => 'voice-notes',
      removeObjects,
      objectGone: jest.fn(async () => true),
      removeOwnerFolder: jest.fn(async () => ({ removed: 0, failed: false })),
      ownerFolderEmpty: jest.fn(async () => true),
      createSignedDownload: jest.fn(async () => null),
    });
    svc = new CommunityModerationService(
      new CommunityAccessService(prisma),
      new CommunityModerationRepository(prisma),
      new CommunityMessagesRepository(prisma),
      new CommunityPostsRepository(prisma),
      stub<CommunityRealtimeService>(realtime),
      stub<CommunityNotificationsService>(push),
      prisma,
      storage,
    );
  });

  /** Make the member-notice insert fail inside whatever transaction runs it. */
  function failNoticeInsert(): void {
    const realTx = db.$transaction.bind(db);
    jest.spyOn(db, '$transaction').mockImplementation(async (fn) =>
      realTx(async (tx) =>
        fn(
          new Proxy(tx, {
            get: (t, prop: string) =>
              prop === 'notification'
                ? {
                    findMany: async () => [],
                    create: async () => {
                      throw new Error('notice transaction unavailable');
                    },
                  }
                : Reflect.get(t, prop),
          }),
        ),
      ),
    );
  }

  it('AUD-SOL: a failed notice transaction cannot leave a member silently banned', async () => {
    const report = seedPostReport();
    failNoticeInsert();
    await expect(svc.act(coach, report, 'ban', undefined)).rejects.toThrow(
      'notice transaction unavailable',
    );
    expect(db.table('communityWorkspaceBan')).toHaveLength(0);
    expect(db.table('communityMembership')[0].status).toBe('active');
    expect(db.table('communityPost')[0].deleted_at).toBeNull();
    expectUntouched(report);
    expect(push.sendCommunityPush).not.toHaveBeenCalled();
  });

  it('a lost COMMIT after enforcement (process death) rolls back the ban, the hidden recording, its erasure work and the resolution', async () => {
    const report = seedVoiceReport();
    // The transaction body runs to the end (ban, memberships, soft delete,
    // erasure intent, resolution, notice); the COMMIT never happens.
    db.beforeCommit = (writes) => {
      if (writes.includes('notification.create')) throw new Error('connection lost before COMMIT');
    };
    await expect(svc.act(coach, report, 'ban', undefined)).rejects.toThrow(
      'connection lost before COMMIT',
    );
    expectUntouched(report);
    // Storage is external and only touched after a commit.
    expect(removeObjects).not.toHaveBeenCalled();
    expect(push.sendCommunityPush).not.toHaveBeenCalled();
  });

  it('the retry after a failed action applies everything exactly once: ban, hidden content, one notice, one push', async () => {
    const report = seedVoiceReport();
    db.beforeCommit = () => {
      throw new Error('connection lost before COMMIT');
    };
    await expect(svc.act(coach, report, 'ban', undefined)).rejects.toThrow();
    db.beforeCommit = null;

    const res = await svc.act(coach, report, 'ban', undefined);
    expect(res.item).toMatchObject({ status: 'actioned', action: 'ban' });
    expect(res.member_notice).toEqual({ stored: true, push: 'attempted' });
    expect(db.table('communityWorkspaceBan')).toEqual([
      expect.objectContaining({ workspace_id: WS, user_id: MEMBER, lifted_at: null }),
    ]);
    expect(db.table('communityMembership').map((m) => m.status)).toEqual(['removed']);
    expect(db.table('communityVoiceNote')[0].soft_deleted_at).toBeInstanceOf(Date);
    expect(db.table('communitySearchEntry')[0].softDeletedAt).toBeInstanceOf(Date);
    expect(db.table('notification')).toEqual([
      expect.objectContaining({ user_id: MEMBER, kind: COMMUNITY_MODERATION_NOTICE_KIND }),
    ]);
    expect(db.table('communityVoiceErasure')).toEqual([
      expect.objectContaining({ kind: 'object', target: KEY, reason: 'moderation' }),
    ]);
    expect(db.table('communityVoiceErasure')[0].completed_at).toBeInstanceOf(Date);
    expect(removeObjects).toHaveBeenCalledWith([KEY]);
    expect(push.sendCommunityPush).toHaveBeenCalledTimes(1);
  });

  it('a Ban is one transaction that holds every enforcement write, and storage runs only after it commits', async () => {
    const report = seedVoiceReport();
    const committed: string[][] = [];
    db.beforeCommit = (writes) => {
      // Storage has not been called yet when the transaction commits.
      expect(removeObjects).not.toHaveBeenCalled();
      committed.push([...writes]);
    };
    const txSpy = jest.spyOn(db, '$transaction');
    await svc.act(coach, report, 'ban', undefined);
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toEqual(
      expect.arrayContaining([
        'communityModerationAction.updateMany',
        'communityWorkspaceBan.upsert',
        'communityMembership.updateMany',
        'communityVoiceErasure.upsert',
        'communityVoiceNote.updateMany',
        'communitySearchEntry.updateMany',
        'notification.create',
      ]),
    );
    expect(removeObjects).toHaveBeenCalledWith([KEY]);
  });

  it('a failed Hide notice leaves a post visible and the report open (Hide is atomic too)', async () => {
    const report = seedPostReport();
    failNoticeInsert();
    await expect(svc.act(coach, report, 'hide', undefined)).rejects.toThrow(
      'notice transaction unavailable',
    );
    expectUntouched(report);
  });

  it('a refused Ban of the workspace coach opens no transaction and writes nothing', async () => {
    db.seed('communityPost', { id: COACH_POST, workspace_id: WS, author_id: COACH });
    const r = db.seed('communityModerationAction', {
      workspace_id: WS,
      target_type: 'post',
      target_id: COACH_POST,
      status: 'open',
      reported_by_id: REPORTER,
      reason: 'other',
    });
    const txSpy = jest.spyOn(db, '$transaction');
    await expect(svc.act(coach, r.id as string, 'ban', undefined)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(txSpy).not.toHaveBeenCalled();
    expect(db.table('communityWorkspaceBan')).toHaveLength(0);
    expect(db.table('communityPost').find((p) => p.id === COACH_POST)?.deleted_at).toBeNull();
  });

  it('the in-memory transaction is honest: a root-client write while it is open is refused', async () => {
    await expect(
      db.$transaction(async () => {
        await prisma.communityWorkspaceBan.create({
          data: { workspace_id: WS, user_id: MEMBER },
        });
      }),
    ).rejects.toThrow(/root client while a transaction is open/);
    expect(db.table('communityWorkspaceBan')).toHaveLength(0);
  });
});

describe('#610 round 6: B-610-8 Sol probe (actual provider)', () => {
  it('AUD-SOL: ambiguous storage HTTP 400 cannot certify a recording erased', async () => {
    const db = new InMemoryPrisma();
    const prisma = stub<PrismaService>(db);
    const storage = new RealVoiceUploadProvider(
      stub<SupabaseService>({
        getClient: () => ({
          storage: {
            from: () => ({
              info: async () => ({
                data: null,
                error: { statusCode: '400', message: 'Bad request' },
              }),
            }),
          },
        }),
      }),
    );
    jest.spyOn(storage, 'removeObjects').mockResolvedValue({ removed: 0, failed: true });
    const key = '44444444-4444-4444-4444-444444444444/1700000000000-0123456789abcdef.m4a';
    const work = await recordVoiceErasures(
      prisma,
      [{ kind: 'object', target: key }],
      'account_deletion',
    );
    expect(await attemptVoiceErasures(prisma, storage, work)).toEqual({ completed: 0, pending: 1 });
    expect(db.table('communityVoiceErasure')[0].completed_at).toBeNull();
    // And the retry cron keeps it open for as long as storage stays ambiguous.
    const cron = new VoiceErasureService(prisma, storage);
    await expect(cron.retryDue(new Date(Date.now() + 7 * 60 * 60 * 1000))).resolves.toEqual({
      completed: 0,
      pending: 1,
    });
    expect(db.table('communityVoiceErasure')[0]).toMatchObject({
      completed_at: null,
      attempts: 2,
      last_error: 'storage_remove_failed',
    });
  });
});
