/**
 * SC-BE3: photos in the space chat. DB-free: the upload route, the send check,
 * the list rows and the delete erasure run on the real controller, service,
 * repository and photo store over a fake Prisma and a fake storage client.
 * Live RLS: test/rls/community-message-images-rls.spec.ts.
 */
import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { CommunityMessage, User } from '@prisma/client';
import { CommunityImagesController } from '../../../src/community/images/community-images.controller';
import {
  CommunityImageStore,
  isPublishableImageKey,
  mintImageKey,
} from '../../../src/community/images/community-image-store';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import { CreateMessageDto, ImageUploadUrlDto } from '../../../src/community/dto/community-message.dto';
import type { CommunityAccessService } from '../../../src/community/community-access.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { PlanContextService } from '../../../src/community/plan-context/plan-context.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { PrismaService } from '../../../src/prisma.service';
import type { SupabaseService } from '../../../src/supabase/supabase.service';
import type { AuthedRequest } from '../../../src/auth/auth-request';
import { safetyWithBlocks } from '../safety/safety-test-helpers';

function stub<T>(v: unknown): T {
  return v as T;
}

const WS = '22222222-2222-4222-8222-222222222222';
const OTHER_WS = '22222222-2222-4222-8222-333333333333';
const SPACE = '11111111-1111-4111-8111-111111111111';
const FOREIGN_SPACE = '11111111-1111-4111-8111-999999999999';
const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const MATE = 'aaaaaaaa-0000-4000-8000-000000000002';
const BANNED = 'aaaaaaaa-0000-4000-8000-000000000003';
const MB = 1024 * 1024;

const me = stub<User>({ id: ME, role: 'client' });
const cohorts: Record<string, { id: string; workspace_id: string; kind: string }> = {
  [SPACE]: { id: SPACE, workspace_id: WS, kind: 'group' },
  [FOREIGN_SPACE]: { id: FOREIGN_SPACE, workspace_id: OTHER_WS, kind: 'group' },
};

interface Obj {
  size: number;
  contentType: string;
  head: number[];
}

function fakeStorage(objects: Map<string, Obj>) {
  const removed: string[][] = [];
  const from = (bucket: string) => ({
    createSignedUploadUrl: async (key: string) => ({
      data: { signedUrl: `https://s.test/upload/${bucket}/${key}?token=u`, token: 'u', path: key },
      error: null,
    }),
    createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://s.test/sign/${bucket}/${key}?t=1` }, error: null }),
    info: async (key: string) => {
      const o = objects.get(key);
      return o
        ? { data: { size: o.size, contentType: o.contentType }, error: null }
        : { data: null, error: { message: 'Object not found', statusCode: '404' } };
    },
    remove: async (keys: string[]) => {
      removed.push(keys);
      for (const k of keys) objects.delete(k);
      return { data: keys.map((name) => ({ name })), error: null };
    },
    list: async () => ({ data: [], error: null }),
  });
  const client = { storage: { from, getBucket: async (id: string) => ({ data: { id, name: id }, error: null }) } };
  jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const key = decodeURIComponent(String(url).split('/sign/community-images/')[1]?.split('?')[0] ?? '');
    return new Response(Uint8Array.from(objects.get(key)?.head ?? []));
  });
  return { store: new CommunityImageStore(stub<SupabaseService>({ getClient: () => client })), removed };
}

function world(opts: { banned?: string[]; access?: (cohortId: string) => boolean } = {}) {
  const messages: CommunityMessage[] = [];
  const images: Array<Record<string, unknown>> = [];
  const erasures: Array<Record<string, unknown>> = [];
  const prisma = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
    communityMessage: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const at = new Date(Date.UTC(2026, 9, 1, 0, messages.length));
        const m = stub<CommunityMessage>({
          id: `eeeeeeee-0000-4000-8000-00000000000${messages.length + 1}`,
          created_at: at,
          updated_at: at,
          deleted_at: null,
          plan_context_type: null,
          ...data,
          plan_context_payload: null,
        });
        messages.push(m);
        return m;
      },
      findMany: async () => [...messages].filter((m) => !m.deleted_at).reverse(),
      findUnique: async ({ where }: { where: { id: string } }) => messages.find((m) => m.id === where.id) ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => messages.find((m) => m.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id_created_at: { id: string } }; data: Record<string, unknown> }) => {
        const m = messages.find((x) => x.id === where.id_created_at.id);
        Object.assign(m ?? {}, data);
        return m;
      },
    },
    communityMessageImage: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (images.some((i) => i.storage_key === data.storage_key)) throw Object.assign(new Error('dup'), { code: 'P2002' });
        images.push(data);
        return data;
      },
      findMany: async ({ where }: { where: { message_id: { in: string[] } } }) =>
        images.filter((i) => where.message_id.in.includes(String(i.message_id))),
      findUnique: async ({ where }: { where: { message_id: string } }) => images.find((i) => i.message_id === where.message_id) ?? null,
    },
    communityWorkspaceBan: {
      findMany: async ({ where }: { where: { user_id: { in: string[] } } }) =>
        (opts.banned ?? []).filter((u) => where.user_id.in.includes(u)).map((user_id) => ({ user_id })),
    },
    communityVoiceErasure: {
      updateMany: async ({ where, data }: { where: { id?: string }; data: Record<string, unknown> }) => {
        const hit = erasures.filter((e) => where.id !== undefined && e.id === where.id && !e.completed_at);
        for (const e of hit) Object.assign(e, data);
        return { count: hit.length };
      },
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        const row = { id: `er-${erasures.length + 1}`, attempts: 0, completed_at: null, ...create };
        erasures.push(row);
        return row;
      },
    },
    communityWorkspace: { findUnique: async () => ({ coach_id: 'coach-1' }) },
    user: { findMany: async () => [] },
    communityMembership: { findMany: async () => [] },
    communityCohort: { findMany: async () => [] },
    $queryRaw: async () => [],
  };
  const canAccess = opts.access ?? ((id: string) => id === SPACE);
  const access = stub<CommunityAccessService>({
    findCohort: async (id: string) => cohorts[id] ?? null,
    canAccessCohort: async (c: { id: string }) => canAccess(c.id),
    assertCanPost: async () => undefined,
    isWorkspaceCoach: async () => false,
  });
  const objects = new Map<string, Obj>();
  const { store, removed } = fakeStorage(objects);
  const repo = new CommunityMessagesRepository(stub<PrismaService>(prisma));
  const service = new CommunityMessagesService(
    access,
    repo,
    stub<CommunityRealtimeService>({ channels: { cohort: () => 'c' }, cohortShard: () => 0, broadcastCommunityEvent: async () => undefined }),
    stub<PlanContextService>({ validate: async () => null }),
    safetyWithBlocks([]),
    stub<CommunityNotificationsService>({ pushEnabled: () => false }),
    store,
  );
  const controller = new CommunityImagesController(access, store);
  return { service, controller, store, objects, removed, messages, images, erasures };
}

const req = stub<AuthedRequest>({ user: me });
const JPEG = [0xff, 0xd8, 0xff, 0xe0];

beforeEach(() => {
  process.env.FEATURE_COMMUNITY_IMAGES = 'true';
  process.env.VOICE_KEY_SIGNING_SECRET = 'sc-be3-test-secret';
});
afterEach(() => {
  delete process.env.FEATURE_COMMUNITY_IMAGES;
  delete process.env.VOICE_KEY_SIGNING_SECRET;
  jest.restoreAllMocks();
});

describe('POST /community/cohorts/:cohortId/images/upload-url (SC-BE3)', () => {
  const dto = { mime: 'image/jpeg' as const, size_bytes: 2 * MB };

  it('signs one upload for a member, at a key bound to that member and that space', async () => {
    const { controller } = world();
    const out = await controller.uploadUrl(req, SPACE, dto);
    expect(out.upload_url).toContain('/upload/community-images/');
    expect(out.key.startsWith(`${ME}/${SPACE}-`)).toBe(true);
    expect(isPublishableImageKey(out.key, ME, SPACE)).toBe(true);
    expect(isPublishableImageKey(out.key, MATE, SPACE)).toBe(false);
    expect(isPublishableImageKey(out.key, ME, FOREIGN_SPACE)).toBe(false);
    expect(Date.parse(out.expires_at)).toBeGreaterThan(Date.now());
    expect((await controller.uploadUrl(req, SPACE, dto)).key).not.toBe(out.key);
  });

  it('refuses a non-member, a space of another workspace and a missing space alike (403)', async () => {
    const { controller } = world({ access: () => false });
    await expect(controller.uploadUrl(req, SPACE, dto)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.uploadUrl(req, FOREIGN_SPACE, dto)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.uploadUrl(req, '11111111-1111-4111-8111-000000000000', dto)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 404 with FEATURE_COMMUNITY_IMAGES off', async () => {
    delete process.env.FEATURE_COMMUNITY_IMAGES;
    await expect(world().controller.uploadUrl(req, SPACE, dto)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('takes JPEG only, up to 10 MB', async () => {
    const errs = async (v: object) => (await validate(plainToInstance(ImageUploadUrlDto, v))).length;
    expect(await errs(dto)).toBe(0);
    expect(await errs({ mime: 'image/png', size_bytes: MB })).toBeGreaterThan(0);
    expect(await errs({ mime: 'image/jpeg', size_bytes: 10 * MB + 1 })).toBeGreaterThan(0);
    expect(await errs({ kind: 'image', image_key: 'k', width: 0, height: 10 })).toBeGreaterThan(0);
    expect((await validate(plainToInstance(CreateMessageDto, { kind: 'image', image_key: 'k', width: 4, height: 3 }))).length).toBe(0);
  });
});

describe('POST messages kind image (SC-BE3)', () => {
  async function uploaded(w: ReturnType<typeof world>, obj: Partial<Obj> = {}) {
    const { key } = await w.controller.uploadUrl(req, SPACE, { mime: 'image/jpeg', size_bytes: MB });
    w.objects.set(key, { size: MB, contentType: 'image/jpeg', head: JPEG, ...obj });
    return key;
  }
  const code = async (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: unknown) => (e instanceof UnprocessableEntityException ? (e.getResponse() as { code: string }).code : String(e)),
    );

  it('writes the message and its photo row and lists it with a signed URL', async () => {
    const w = world();
    const key = await uploaded(w);
    const sent = await w.service.send(me, SPACE, 'after the long run', undefined, undefined, { key, width: 1200, height: 900 });
    expect(sent.message).toMatchObject({ kind: 'image', body: 'after the long run' });
    expect(sent.message.image).toMatchObject({ width: 1200, height: 900, url: expect.stringContaining(key) });
    expect(w.images).toEqual([expect.objectContaining({ storage_key: key, size_bytes: MB, author_id: ME, cohort_id: SPACE })]);
    const listed = await w.service.list(me, SPACE, {});
    expect(listed.messages[0].image?.url).toContain(key);
    expect(Date.parse(listed.messages[0].image?.expires_at ?? '')).toBeGreaterThan(Date.now());
  });

  it('refuses a wrong key, a missing object, a non-JPEG, an oversize object and a used key (422)', async () => {
    const w = world();
    const send = (key: string) => w.service.send(me, SPACE, '', undefined, undefined, { key, width: 10, height: 10 });
    expect(await code(send(mintImageKey(MATE, SPACE)))).toBe('community.image.key_invalid');
    expect(await code(send(mintImageKey(ME, FOREIGN_SPACE)))).toBe('community.image.key_invalid');
    expect(await code(send(`${ME}/../x.jpg`))).toBe('community.image.key_invalid');
    expect(await code(send(mintImageKey(ME, SPACE)))).toBe('community.image.missing');
    expect(await code(send(await uploaded(w, { contentType: 'image/png' })))).toBe('community.image.not_jpeg');
    expect(await code(send(await uploaded(w, { head: [0x89, 0x50, 0x4e] })))).toBe('community.image.not_jpeg');
    expect(await code(send(await uploaded(w, { size: 10 * MB + 1 })))).toBe('community.image.too_large');
    const key = await uploaded(w);
    expect(await code(send(key))).toBe('ok');
    expect(await code(send(key))).toBe('community.image.key_used');
  });

  it('answers 422 with FEATURE_COMMUNITY_IMAGES off, and a non-member gets the usual 404', async () => {
    const w = world();
    const key = await uploaded(w);
    delete process.env.FEATURE_COMMUNITY_IMAGES;
    expect(await code(w.service.send(me, SPACE, '', undefined, undefined, { key, width: 1, height: 1 }))).toBe('community.image.disabled');
    await expect(
      w.service.send(me, FOREIGN_SPACE, '', undefined, undefined, { key, width: 1, height: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hides a photo from an author banned in the workspace', async () => {
    const w = world({ banned: [BANNED] });
    const key = await uploaded(w);
    await w.service.send(me, SPACE, 'mine', undefined, undefined, { key, width: 1, height: 1 });
    w.messages.push(stub<CommunityMessage>({ ...w.messages[0], id: 'eeeeeeee-0000-4000-8000-0000000000b1', sender_id: BANNED }));
    const listed = await w.service.list(me, SPACE, {});
    expect(listed.messages.map((m) => m.sender_user_id)).toEqual([ME]);
    await expect(w.service.getOne(me, 'eeeeeeee-0000-4000-8000-0000000000b1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delete records the object erasure, removes the object and verifies it is gone', async () => {
    const w = world();
    const key = await uploaded(w);
    const sent = await w.service.send(me, SPACE, '', undefined, undefined, { key, width: 1, height: 1 });
    const out = await w.service.remove(me, sent.message.id);
    expect(out.message.image).toBeNull();
    expect(w.erasures).toEqual([expect.objectContaining({ kind: 'image_object', target: key, reason: 'author_delete' })]);
    expect(w.removed).toEqual([[key]]);
    expect(w.objects.has(key)).toBe(false);
    expect(w.erasures[0].completed_at).toEqual(expect.any(Date));
  });
});
