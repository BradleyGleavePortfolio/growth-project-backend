/**
 * SC-BE3: every erasure job removes photo objects through the voice erasure
 * path (community_voice_erasures, kinds 'image_object' and 'image_folder').
 * Author delete: community-images.e2e.spec.ts. Account erasure:
 * test/account-deletion.voice-erasure.spec.ts. Here: the store routing, and a
 * reported photo in the coach's queue (FX-1139: the photo itself) and hidden.
 */
import 'reflect-metadata';
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
import type { CommunityImageStore } from '../../../src/community/images/community-image-store';
import { attemptVoiceErasures, type VoiceErasureStorage } from '../../../src/community/voice/voice-erasure';
import { InMemoryPrisma } from '../safety/in-memory-prisma';

function stub<T>(v: object): T {
  return v as T;
}

const COACH = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const COHORT = '33333333-3333-4333-8333-333333333333';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const MSG = '77777777-7777-4777-8777-777777777777';
const REPORTER = '99999999-9999-4999-8999-999999999999';
const UPLOAD_KEY = `${MEMBER}/${COHORT}-1790000000000-0123456789abcdef-0123456789abcdef0123456789abcdef.jpg`;
const IMAGE_KEY = UPLOAD_KEY.replace(/\.jpg$/, '.sent.jpg');
const VOICE_KEY = `${MEMBER}/1700000000000-0123456789abcdef.m4a`;

function fakeStore(bucket: string) {
  const gone = new Set<string>();
  return {
    bucket: () => bucket,
    isStoreKey: (k: string) => k.startsWith(`${MEMBER}/`),
    removeObjects: jest.fn(async (keys: string[]) => {
      for (const k of keys) gone.add(k);
      return { removed: keys.length, failed: false };
    }),
    objectGone: jest.fn(async (k: string) => gone.has(k)),
    removeOwnerFolder: jest.fn(async () => ({ removed: 1, failed: false })),
    ownerFolderEmpty: jest.fn(async () => true),
    createSignedDownload: jest.fn(async (k: string) => `https://s.test/sign/${k}`),
  };
}

describe('photo erasure through the voice erasure path (SC-BE3)', () => {
  let db: InMemoryPrisma;
  beforeEach(() => {
    db = new InMemoryPrisma();
  });

  function work(kind: string, target: string) {
    return stub<{ id: string; kind: 'object'; target: string; attempts: number }>(
      db.seed('communityVoiceErasure', { kind, target, reason: 'moderation', attempts: 0, completed_at: null }),
    );
  }

  it('sends image rows to the photo store and voice rows to the voice store', async () => {
    const voice = fakeStore('voice-notes');
    const images = fakeStore('community-images');
    const rows = [work('object', VOICE_KEY), work('image_object', IMAGE_KEY), work('image_folder', MEMBER)];
    const out = await attemptVoiceErasures(stub<PrismaService>(db), { voice, images }, rows);
    expect(out).toEqual({ completed: 3, pending: 0 });
    expect(voice.removeObjects).toHaveBeenCalledWith([VOICE_KEY]);
    expect(images.removeObjects).toHaveBeenCalledWith([IMAGE_KEY]);
    expect(images.removeOwnerFolder).toHaveBeenCalledWith(MEMBER);
    expect(voice.removeOwnerFolder).not.toHaveBeenCalled();
    expect(db.table('communityVoiceErasure').every((r) => r.completed_at instanceof Date)).toBe(true);
  });

  it('keeps an image row open for the cron when no photo store is wired', async () => {
    const voice: VoiceErasureStorage = fakeStore('voice-notes');
    const out = await attemptVoiceErasures(stub<PrismaService>(db), voice, [work('image_object', IMAGE_KEY)]);
    expect(out).toEqual({ completed: 0, pending: 1 });
    expect(db.table('communityVoiceErasure')[0]).toMatchObject({ completed_at: null, last_error: 'store_not_wired' });
  });

  afterEach(() => {
    delete process.env.FEATURE_COMMUNITY_API;
  });

  /** A member's captionless photo in the coach's space, reported by another member. */
  function reportedPhoto() {
    process.env.FEATURE_COMMUNITY_API = 'true';
    const prisma = stub<PrismaService>(db);
    const coach = stub<User>(db.seed('user', { id: COACH, role: 'coach', coach_id: null }));
    db.seed('user', { id: MEMBER, role: 'student', coach_id: COACH });
    db.seed('communityWorkspace', { id: WS, coach_id: COACH, archived_at: null });
    db.seed('communityCohort', { id: COHORT, workspace_id: WS, status: 'active', archived_at: null, sort_order: 0 });
    db.seed('communityMembership', { workspace_id: WS, cohort_id: COHORT, user_id: MEMBER, status: 'active', role: 'student' });
    db.seed('communityMessage', {
      id: MSG,
      created_at: new Date('2026-10-01T00:00:00Z'),
      workspace_id: WS,
      cohort_id: COHORT,
      scope: 'cohort',
      kind: 'image',
      sender_id: MEMBER,
      body: '',
      deleted_at: null,
      plan_context_type: null,
    });
    db.seed('communityMessageImage', { message_id: MSG, cohort_id: COHORT, author_id: MEMBER, storage_key: IMAGE_KEY, width: 1200, height: 900 });
    const report = db.seed('communityModerationAction', {
      workspace_id: WS,
      target_type: 'message',
      target_id: MSG,
      status: 'open',
      reported_by_id: REPORTER,
      reason: 'other',
      created_at: new Date(),
    });
    const images = fakeStore('community-images');
    const svc = new CommunityModerationService(
      new CommunityAccessService(prisma),
      new CommunityModerationRepository(prisma),
      new CommunityMessagesRepository(prisma),
      new CommunityPostsRepository(prisma),
      stub<CommunityRealtimeService>({ channels: { cohort: () => 'c', workspace: () => 'w', moderation: () => 'm' }, cohortShard: () => 0, broadcastCommunityEvent: async () => undefined }),
      stub<CommunityNotificationsService>({ sendCommunityPush: async () => undefined }),
      prisma,
      stub<VoiceUploadProvider>(fakeStore('voice-notes')),
      undefined,
      stub<CommunityImageStore>(images),
    );
    return { svc, coach, report, images };
  }

  it('the coach queue item for a reported photo carries the photo, signed for 15 minutes in the author folder (FX-1139)', async () => {
    const { svc, coach, images } = reportedPhoto();
    const { items } = await svc.listFlagged(coach, {});
    expect(items[0]).toMatchObject({ target_type: 'message', target_id: MSG, content: '', media: null, removed: false });
    expect(items[0].image).toEqual({ url: `https://s.test/sign/${IMAGE_KEY}`, width: 1200, height: 900, expires_at: expect.any(String) });
    expect(Date.parse(items[0].image?.expires_at ?? '') - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect(images.createSignedDownload).toHaveBeenCalledWith(IMAGE_KEY, 15 * 60, MEMBER);
    db.table('communityMessage')[0].deleted_at = new Date(); // the author deleted it while the report is open
    expect((await svc.listFlagged(coach, {})).items[0]).toMatchObject({ removed: true, image: null });
  });

  it('a coach hiding a reported photo records the erasure of both objects in the action and removes them', async () => {
    const { svc, coach, report, images } = reportedPhoto();
    await svc.act(coach, String(report.id), 'hide', undefined);
    expect(db.table('communityMessage')[0].deleted_at).toBeInstanceOf(Date);
    expect(db.table('communityVoiceErasure')).toEqual([
      expect.objectContaining({ kind: 'image_object', target: IMAGE_KEY, reason: 'moderation', completed_at: expect.any(Date) }),
      expect.objectContaining({ kind: 'image_object', target: UPLOAD_KEY, reason: 'moderation', completed_at: expect.any(Date) }),
    ]);
    expect(images.removeObjects.mock.calls).toEqual([[[IMAGE_KEY]], [[UPLOAD_KEY]]]);
  });
});
