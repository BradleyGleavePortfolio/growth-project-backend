/**
 * SC-BE3: photos in the space chat. DB-free: the upload route, the send check,
 * the list rows and the delete erasure run on the real controller, service,
 * repository and photo store over a fake Prisma and a fake storage client.
 * FX-1139: the reported-photo queue item is in community-image-erasure.spec.ts.
 * Live RLS: test/rls/community-message-images-rls.spec.ts.
 */
import { ForbiddenException, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma, type CommunityMessage, type User } from '@prisma/client';
import { CommunityImagesController } from '../../../src/community/images/community-images.controller';
import {
  CommunityImageStore,
  isPublishableImageKey,
  mintImageKey,
  sentImageKey,
} from '../../../src/community/images/community-image-store';
import { VoiceErasureService } from '../../../src/community/voice/voice-erasure';
import type { VoiceUploadProvider } from '../../../src/community/voice/voice-upload.provider';
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
import { InMemoryPrisma } from '../safety/in-memory-prisma';
import { CLEAN, JFIF, jpeg, LOCATED } from './jpeg-fixtures';

function stub<T>(v: unknown): T {
  return v as T;
}

const WS = '22222222-2222-4222-8222-222222222222';
const OTHER_WS = '22222222-2222-4222-8222-333333333333';
const SPACE = '11111111-1111-4111-8111-111111111111';
const SPACE_2 = '11111111-1111-4111-8111-222222222222';
const FOREIGN_SPACE = '11111111-1111-4111-8111-999999999999';
const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const MATE = 'aaaaaaaa-0000-4000-8000-000000000002';
const BANNED = 'aaaaaaaa-0000-4000-8000-000000000003';
const BLOCKED = 'aaaaaaaa-0000-4000-8000-000000000004';
const MB = 1024 * 1024;
const HOUR = 3600 * 1000;
/** A signed upload link's token, as Supabase mints it: a JWT whose exp is 2 hours out. */
const LINK_EXP_MS = Math.floor(Date.now() / 1000 + 7200) * 1000;
const LINK_TOKEN = `h.${Buffer.from(JSON.stringify({ exp: LINK_EXP_MS / 1000 })).toString('base64url')}.s`;

const me = stub<User>({ id: ME, role: 'client' });
const cohorts: Record<string, { id: string; workspace_id: string; kind: string }> = {
  [SPACE]: { id: SPACE, workspace_id: WS, kind: 'group' },
  [SPACE_2]: { id: SPACE_2, workspace_id: WS, kind: 'group' },
  [FOREIGN_SPACE]: { id: FOREIGN_SPACE, workspace_id: OTHER_WS, kind: 'group' },
};

interface Obj {
  size: number;
  contentType: string;
  head: number[];
  /** PHOTO-GPS: storage hands back at most this many bytes (a short download). */
  served?: number;
}

function fakeStorage(objects: Map<string, Obj>) {
  const removed: string[][] = [];
  const from = (bucket: string) => ({
    createSignedUploadUrl: async (key: string) => ({
      data: { signedUrl: `https://s.test/upload/${bucket}/${key}?token=${LINK_TOKEN}`, token: LINK_TOKEN, path: key },
      error: null,
    }),
    copy: async (src: string, dst: string) => {
      const o = objects.get(src);
      if (!o || objects.has(dst)) return { data: null, error: { message: 'copy refused' } };
      objects.set(dst, { ...o });
      return { data: { path: dst }, error: null };
    },
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
  const reads: string[] = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const key = decodeURIComponent(String(url).split('/sign/community-images/')[1]?.split('?')[0] ?? '');
    // PHOTO-GPS: a ranged read answers that many bytes of the object (its head, then zeros).
    const range = new Headers(init?.headers).get('range') ?? '';
    reads.push(range);
    const o = objects.get(key);
    const last = /^bytes=0-(\d+)$/.exec(range)?.[1];
    const bytes = new Uint8Array(o ? Math.min(o.size, o.served ?? o.size, last === undefined ? o.size : Number(last) + 1) : 0);
    bytes.set((o?.head ?? []).slice(0, bytes.length));
    return new Response(bytes);
  });
  return { store: new CommunityImageStore(stub<SupabaseService>({ getClient: () => client })), removed, reads };
}

function world(opts: { banned?: string[]; blocks?: Array<[string, string]>; access?: (cohortId: string) => boolean } = {}) {
  const messages: CommunityMessage[] = [];
  const images: Array<Record<string, unknown>> = [];
  const erasures: Array<Record<string, unknown>> = [];
  const prisma = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      const [m, i] = [messages.length, images.length];
      return fn(prisma).catch((e: unknown) => {
        messages.length = m; // a rolled-back send leaves nothing
        images.length = i;
        throw e;
      });
    },
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
          plan_context_payload: data.plan_context_payload === Prisma.JsonNull ? null : data.plan_context_payload,
        });
        messages.push(m);
        return m;
      },
      findMany: async ({ where }: { where?: { cohort_id?: string } } = {}) =>
        [...messages].filter((m) => !m.deleted_at && (!where?.cohort_id || m.cohort_id === where.cohort_id)).reverse(),
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
    communityVoiceErasure: {
      findMany: async ({ where }: { where: { next_attempt_at: { lte: Date } } }) =>
        erasures.filter((e) => !e.completed_at && (e.next_attempt_at as Date) <= where.next_attempt_at.lte),
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
  const canAccess = opts.access ?? ((id: string) => id === SPACE || id === SPACE_2);
  // #170-1: the real safety filter; a ban is on the person, for the coach's whole community (every space).
  const people = new InMemoryPrisma();
  for (const user_id of opts.banned ?? []) people.seed('communityWorkspaceBan', { workspace_id: WS, user_id, lifted_at: null });
  const access = stub<CommunityAccessService>({
    findCohort: async (id: string) => cohorts[id] ?? null,
    canAccessCohort: async (c: { id: string }) => canAccess(c.id),
    assertCanPost: async () => undefined,
    isWorkspaceCoach: async () => false,
  });
  const objects = new Map<string, Obj>();
  const { store, removed, reads } = fakeStorage(objects);
  const repo = new CommunityMessagesRepository(stub<PrismaService>(prisma));
  const service = new CommunityMessagesService(
    access,
    repo,
    stub<CommunityRealtimeService>({ channels: { cohort: () => 'c' }, cohortShard: () => 0, broadcastCommunityEvent: async () => undefined }),
    stub<PlanContextService>({ validate: async (_u: User, tag: unknown) => tag }),
    safetyWithBlocks(opts.blocks ?? [], people),
    stub<CommunityNotificationsService>({ pushEnabled: () => false }),
    store,
  );
  const controller = new CommunityImagesController(access, store, stub<PrismaService>(prisma));
  const cron = new VoiceErasureService(stub<PrismaService>(prisma), stub<VoiceUploadProvider>({}), store);
  return { service, controller, cron, store, objects, removed, reads, messages, images, erasures };
}

const req = stub<AuthedRequest>({ user: me });
/** PHOTO-GPS: a clean photo's head (SOI, JFIF, SOS); the send check reads up to SOS. */
const JPEG = jpeg(JFIF);

beforeEach(() => {
  process.env.FEATURE_COMMUNITY_IMAGES = 'true';
  process.env.VOICE_KEY_SIGNING_SECRET = 'sc-be3-test-secret';
});
afterEach(() => {
  delete process.env.FEATURE_COMMUNITY_IMAGES;
  delete process.env.VOICE_KEY_SIGNING_SECRET;
  delete process.env.FEATURE_COMMUNITY_PLAN_TAGS;
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
    expect(out).not.toHaveProperty('sweep_at');
  });

  it('records the upload object erasure before the link leaves, due 5 minutes after the link token expires (FX-1139)', async () => {
    const w = world();
    const { key } = await w.controller.uploadUrl(req, SPACE, dto);
    expect(w.erasures).toEqual([expect.objectContaining({ kind: 'image_upload', target: key, reason: 'upload_expiry' })]);
    expect((w.erasures[0].next_attempt_at as Date).getTime()).toBe(LINK_EXP_MS + 5 * 60 * 1000);
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
    expect(sent.message.image).toMatchObject({ width: 1200, height: 900, url: expect.stringContaining(sentImageKey(key)) });
    expect(w.images).toEqual([
      expect.objectContaining({ storage_key: sentImageKey(key), size_bytes: MB, author_id: ME, cohort_id: SPACE }),
    ]);
    expect(w.objects.get(sentImageKey(key))).toEqual(w.objects.get(key));
    const listed = await w.service.list(me, SPACE, {});
    expect(listed.messages[0].image?.url).toContain(sentImageKey(key));
    expect(Date.parse(listed.messages[0].image?.expires_at ?? '')).toBeGreaterThan(Date.now());
  });

  it('refuses a wrong key, a missing object, a non-JPEG, an oversize object and a used key (422)', async () => {
    const w = world();
    const send = (key: string) => w.service.send(me, SPACE, '', undefined, undefined, { key, width: 10, height: 10 });
    expect(await code(send(mintImageKey(MATE, SPACE)))).toBe('community.image.key_invalid');
    expect(await code(send(mintImageKey(ME, FOREIGN_SPACE)))).toBe('community.image.key_invalid');
    expect(await code(send(`${ME}/../x.jpg`))).toBe('community.image.key_invalid');
    expect(await code(send(mintImageKey(ME, SPACE, Date.now() - 11 * 60 * 1000)))).toBe('community.image.key_invalid');
    expect(await code(send(sentImageKey(mintImageKey(ME, SPACE))))).toBe('community.image.key_invalid');
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

  it('hides the photos of a person banned from the community in every space, for everyone, and a quote of one reads gone (#170-1)', async () => {
    const w = world({ banned: [BANNED] });
    const key = await uploaded(w);
    await w.service.send(me, SPACE, 'mine', undefined, undefined, { key, width: 1, height: 1 });
    const theirs = (id: string, cohort_id: string) =>
      w.messages.push(stub<CommunityMessage>({ ...w.messages[0], id, cohort_id, sender_id: BANNED }));
    theirs('eeeeeeee-0000-4000-8000-0000000000b1', SPACE);
    theirs('eeeeeeee-0000-4000-8000-0000000000b2', SPACE_2);
    w.messages.push(stub<CommunityMessage>({ ...w.messages[0], id: 'eeeeeeee-0000-4000-8000-0000000000b3', kind: 'text', parent_message_id: 'eeeeeeee-0000-4000-8000-0000000000b1' }));
    const listed = await w.service.list(me, SPACE, {});
    expect(listed.messages.map((m) => m.id)).toEqual(['eeeeeeee-0000-4000-8000-0000000000b3', w.messages[0].id]);
    expect(listed.messages[0].parent).toEqual(expect.objectContaining({ id: 'eeeeeeee-0000-4000-8000-0000000000b1', gone: true, kind: null }));
    expect((await w.service.list(me, SPACE_2, {})).messages).toEqual([]);
    for (const id of ['eeeeeeee-0000-4000-8000-0000000000b1', 'eeeeeeee-0000-4000-8000-0000000000b2']) {
      await expect(w.service.getOne(me, id)).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('hides a photo between two people in a block, either way (#170-1)', async () => {
    for (const blocks of [[[ME, BLOCKED]], [[BLOCKED, ME]]] as Array<Array<[string, string]>>) {
      const w = world({ blocks });
      const key = await uploaded(w);
      await w.service.send(me, SPACE, 'mine', undefined, undefined, { key, width: 1, height: 1 });
      w.messages.push(stub<CommunityMessage>({ ...w.messages[0], id: 'eeeeeeee-0000-4000-8000-0000000000c1', sender_id: BLOCKED }));
      expect((await w.service.list(me, SPACE, {})).messages.map((m) => m.sender_user_id)).toEqual([ME]);
      await expect(w.service.getOne(me, 'eeeeeeee-0000-4000-8000-0000000000c1')).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('a caption edit answers the live photo, as get-one does (FX-1139 C-2)', async () => {
    const w = world();
    const key = await uploaded(w);
    const sent = await w.service.send(me, SPACE, 'old', undefined, undefined, { key, width: 4, height: 3 });
    w.messages[0].created_at = new Date(); // inside the edit window
    const edited = await w.service.edit(me, sent.message.id, 'new');
    expect(edited.message.body).toBe('new');
    expect(edited.message.image).toEqual({ url: expect.stringContaining(sentImageKey(key)), width: 4, height: 3, expires_at: expect.any(String) });
    expect((await w.service.getOne(me, sent.message.id)).message.image).toEqual({ ...edited.message.image, expires_at: expect.any(String) });
  });

  it("FR-1139 (Sol B2): the chat signs only a message's own photo, never a row naming another message or space", async () => {
    const w = world();
    await w.service.send(me, SPACE, 'mine', undefined, undefined, { key: await uploaded(w), width: 1, height: 1 });
    const [text, theirs] = ['eeeeeeee-0000-4000-8000-0000000000d1', 'eeeeeeee-0000-4000-8000-0000000000d2'];
    w.messages.push(stub<CommunityMessage>({ ...w.messages[0], id: text, kind: 'text', sender_id: MATE }));
    w.messages.push(stub<CommunityMessage>({ ...w.messages[0], id: theirs, sender_id: MATE }));
    for (const message_id of [text, theirs]) w.images.push({ ...w.images[0], message_id, storage_key: `${ME}/${message_id}.sent.jpg` });
    w.images[0].cohort_id = SPACE_2; // my own row, naming another space
    const listed = await w.service.list(me, SPACE, {});
    expect(listed.messages.map((m) => [m.id, 'image' in m ? m.image : 'no key'])).toEqual([[theirs, null], [text, 'no key'], [w.messages[0].id, null]]);
  });

  it('FR-1139 (Opus C2): a reply quoting a photo carries that photo, signed', async () => {
    const w = world();
    const photo = (await w.service.send(me, SPACE, '', undefined, undefined, { key: await uploaded(w), width: 4, height: 3 })).message;
    w.messages.push(stub<CommunityMessage>({ ...w.messages[0], id: 'eeeeeeee-0000-4000-8000-0000000000d3', kind: 'text', body: 'nice', parent_message_id: photo.id }));
    const [reply] = (await w.service.list(me, SPACE, {})).messages;
    expect(reply.parent).toMatchObject({ id: photo.id, kind: 'image', image: { url: expect.stringContaining('.sent.jpg'), width: 4, height: 3 } });
    expect(reply.parent?.image?.url).toBe(photo.image?.url);
  });

  it('FR-1139 (Sol C): a photo keeps its plan tag, as a text message does', async () => {
    process.env.FEATURE_COMMUNITY_PLAN_TAGS = 'true';
    const w = world();
    const tag = { type: 'workout', workout_plan_id: 'cccccccc-0000-4000-8000-000000000001', week_index: 2 };
    const sent = await w.service.send(me, SPACE, '', tag, undefined, { key: await uploaded(w), width: 1, height: 1 });
    expect(sent.message).toMatchObject({ kind: 'image', plan_context: tag });
    expect((await w.service.list(me, SPACE, {})).messages[0].plan_context).toEqual(tag);
    expect(await code(w.service.send(me, SPACE, '', { type: 'workout' }, undefined, { key: await uploaded(w), width: 1, height: 1 }))).toBe('community.plan_context.malformed');
  });

  it('FX-1156-R75: a photo stores every plan tag arm exactly as a text send stores it; untagged or flag-off stores null', async () => {
    process.env.FEATURE_COMMUNITY_PLAN_TAGS = 'true';
    const photo = async (w: ReturnType<typeof world>, tag?: object) =>
      (await w.service.send(me, SPACE, '', tag, undefined, { key: await uploaded(w), width: 1, height: 1 })).message;
    const stored = (w: ReturnType<typeof world>, id: string) => w.messages.find((m) => m.id === id)?.plan_context_payload;
    const id = (n: number) => `cccccccc-0000-4000-8000-00000000000${n}`;
    for (const tag of [
      { type: 'workout', workout_plan_id: id(1), week_index: 3, day_index: 6, exercise_id: id(2) },
      { type: 'meal', meal_plan_id: id(3), meal_id: 'breakfast-1' },
      { type: 'package', package_id: id(4) },
      { type: 'check_in', check_in_id: id(5) },
    ]) {
      const w = world();
      const sent = await photo(w, tag);
      const text = (await w.service.send(me, SPACE, 'same tag', tag)).message;
      expect(stored(w, sent.id)).toEqual(tag);
      expect(stored(w, sent.id)).toEqual(stored(w, text.id));
      expect([sent.plan_context, (await w.service.getOne(me, sent.id)).message.plan_context]).toEqual([tag, tag]);
    }
    const w = world();
    expect(stored(w, (await photo(w)).id)).toBeNull();
    delete process.env.FEATURE_COMMUNITY_PLAN_TAGS;
    expect(stored(w, (await photo(w, { type: 'package', package_id: id(4) })).id)).toBeNull();
  });

  it('delete erases the sent copy and the upload, and verifies both are gone', async () => {
    const w = world();
    const key = await uploaded(w);
    const sent = await w.service.send(me, SPACE, '', undefined, undefined, { key, width: 1, height: 1 });
    const out = await w.service.remove(me, sent.message.id);
    expect(out.message.image).toBeNull();
    expect(w.erasures.slice(1)).toEqual([
      expect.objectContaining({ kind: 'image_object', target: sentImageKey(key), reason: 'author_delete', completed_at: expect.any(Date) }),
      expect.objectContaining({ kind: 'image_object', target: key, reason: 'author_delete', completed_at: expect.any(Date) }),
    ]);
    expect(w.removed).toEqual([[sentImageKey(key)], [key]]);
    expect(w.objects.size).toBe(0);
  });

  it('a replayed upload link after a delete never re-publishes and is erased once the link is dead (FX-1139)', async () => {
    const w = world();
    const key = await uploaded(w);
    const sent = await w.service.send(me, SPACE, '', undefined, undefined, { key, width: 1, height: 1 });
    await w.service.remove(me, sent.message.id);
    w.objects.set(key, { size: MB, contentType: 'image/jpeg', head: JPEG }); // the still-live link, used again
    expect(await code(w.service.send(me, SPACE, '', undefined, undefined, { key, width: 1, height: 1 }))).toBe('community.image.key_used');
    expect(w.objects.has(sentImageKey(key))).toBe(false);
    expect((await w.service.list(me, SPACE, {})).messages).toEqual([]);
    expect(await w.cron.retryDue(new Date(Date.now() + HOUR))).toEqual({ completed: 0, pending: 0 });
    expect(w.objects.has(key)).toBe(true);
    expect(await w.cron.retryDue(new Date(LINK_EXP_MS + 6 * 60 * 1000))).toEqual({ completed: 1, pending: 0 });
    expect(w.objects.size).toBe(0);
  });

  it('an upload never sent is erased once its link is dead (FX-1139)', async () => {
    const w = world();
    const key = await uploaded(w);
    expect(await w.cron.retryDue(new Date(LINK_EXP_MS + 6 * 60 * 1000))).toEqual({ completed: 1, pending: 0 });
    expect(w.objects.has(key)).toBe(false);
  });

  describe('PHOTO-GPS: a photo that carries a location is refused', () => {
    const LINK_DEAD = new Date(LINK_EXP_MS + 6 * 60 * 1000);
    const sendPhoto = (w: ReturnType<typeof world>, key: string) =>
      w.service.send(me, SPACE, 'from the trail', undefined, undefined, { key, width: 4, height: 3 });

    it.each(Object.entries(LOCATED))('%s: 422 community.image.has_location, nothing written, the upload erased', async (_name, head) => {
      const w = world();
      const key = await uploaded(w, { head, size: head.length });
      expect(await code(sendPhoto(w, key))).toBe('community.image.has_location');
      expect([w.messages, w.images]).toEqual([[], []]);
      expect(w.removed).toEqual([[key]]);
      expect(w.objects.size).toBe(0); // no upload, no sent copy
      expect((await w.service.list(me, SPACE, {})).messages).toEqual([]);
      expect(await w.cron.retryDue(LINK_DEAD)).toEqual({ completed: 1, pending: 0 });
    });

    it.each(Object.entries(CLEAN))('%s: still sends, after reading the whole small photo', async (_name, head) => {
      const w = world();
      const key = await uploaded(w, { head, size: head.length });
      expect((await sendPhoto(w, key)).message).toMatchObject({ kind: 'image', body: 'from the trail' });
      expect(w.images).toEqual([expect.objectContaining({ storage_key: sentImageKey(key), size_bytes: head.length })]);
      expect(w.reads).toEqual([`bytes=0-${head.length - 1}`]);
      expect(w.removed).toEqual([]);
    });

    it('reads only the first 256 KB of a larger photo; a shorter download is 503 and the upload is kept', async () => {
      const w = world();
      expect(await code(sendPhoto(w, await uploaded(w)))).toBe('ok');
      expect(w.reads).toEqual(['bytes=0-262143']);
      const short = await uploaded(w, { served: 1000 });
      const e = await sendPhoto(w, short).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      expect((e as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'community.image.storage_unavailable' });
      expect(w.objects.has(short)).toBe(true);
      expect(w.removed).toEqual([]);
    });

    it('if the erase fails it still refuses, logs erase=deferred_to_link_expiry (no key), and the erasure row erases it at link death', async () => {
      // FR-1164R: the second round sends LS-1164 B1's photo (a GPS name split across ExtendedXMP chunks).
      // FR-1164R2: the third sends LS-1164R B1's photo (DJI's location names in XMP, its EXIF without GPS).
      for (const [failing, photo] of [
        ['failed', 'GPS in EXIF, little endian'],
        ['threw', 'a GPS name split across two ExtendedXMP chunks'],
        ['failed', "DJI's GpsLatitude and GpsLongitude in XMP"],
      ] as const) {
        const w = world();
        const head = LOCATED[photo];
        const key = await uploaded(w, { head, size: head.length });
        const remove = jest.spyOn(w.store, 'removeObjects');
        if (failing === 'failed') remove.mockResolvedValueOnce({ removed: 0, failed: true });
        else remove.mockRejectedValueOnce(new Error('storage down'));
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        expect(await code(sendPhoto(w, key))).toBe('community.image.has_location');
        expect(warn.mock.calls).toEqual([['community.image outcome=has_location erase=deferred_to_link_expiry']]);
        expect([w.messages, w.images, w.objects.has(key)]).toEqual([[], [], true]);
        expect(await w.cron.retryDue(LINK_DEAD)).toEqual({ completed: 1, pending: 0 });
        expect(w.objects.size).toBe(0);
        jest.restoreAllMocks(); // the next world installs its own storage fake
      }
    });
  });
});
