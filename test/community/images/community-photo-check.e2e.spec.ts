/**
 * PHOTO-CHECK-BE: the automatic photo check on a space chat photo send, end
 * to end through the real CommunityMessagesService, repository, image store
 * and AI egress, with the real OpenAI SDK on an in-memory transport (storage
 * reads and the moderation endpoint are both answered by the fake fetch).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { CommunityMessage, User } from '@prisma/client';
import { AiEgressService } from '../../../src/ai-egress/ai-egress.service';
import { AiEgressModule } from '../../../src/ai-egress/ai-egress.module';
import { CommunityImageStore, mintImageKey, sentImageKey } from '../../../src/community/images/community-image-store';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import type { CommunityAccessService } from '../../../src/community/community-access.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { PlanContextService } from '../../../src/community/plan-context/plan-context.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { PrismaService } from '../../../src/prisma.service';
import type { SupabaseService } from '../../../src/supabase/supabase.service';
import { safetyWithBlocks } from '../safety/safety-test-helpers';
import { egressWithGrants } from '../../ai-egress/ai-egress.fakes';

function stub<T>(v: unknown): T {
  return v as T;
}

const WS = '22222222-2222-4222-8222-222222222222';
const SPACE = '11111111-1111-4111-8111-111111111111';
const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const me = stub<User>({ id: ME, role: 'client' });
const CAPTION = 'after the long run';
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
const MODERATION_URL = 'https://api.openai.com/v1/moderations';
const answer = (flagged: boolean) =>
  new Response(JSON.stringify({ id: 'modr-1', model: 'omni-moderation-latest', results: [{ flagged, categories: {}, category_scores: {} }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

type Reply = () => Response | Promise<Response>;

function world(opts: { reply?: Reply; statSize?: number } = {}) {
  const objects = new Map<string, Buffer>();
  const messages: CommunityMessage[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const checks: Array<{ auth: string | null; body: { model: string; input: Array<Record<string, unknown>> } }> = [];
  let reply: Reply = opts.reply ?? (() => answer(false));
  const from = () => ({
    createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://s.test/sign/community-images/${key}?t=1` }, error: null }),
    info: async (key: string) => {
      const o = objects.get(key);
      return o
        ? { data: { size: opts.statSize ?? o.length, contentType: 'image/jpeg' }, error: null }
        : { data: null, error: { message: 'Object not found', statusCode: '404' } };
    },
    copy: async (src: string, dst: string) => {
      const o = objects.get(src);
      if (!o || objects.has(dst)) return { data: null, error: { message: 'copy refused' } };
      objects.set(dst, o);
      return { data: { path: dst }, error: null };
    },
    remove: async (keys: string[]) => {
      for (const k of keys) objects.delete(k);
      return { data: keys.map((name) => ({ name })), error: null };
    },
  });
  const client = { storage: { from, getBucket: async (id: string) => ({ data: { id, name: id }, error: null }) } };
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === MODERATION_URL) {
      checks.push({ auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
      return reply();
    }
    const key = decodeURIComponent(String(url).split('/sign/community-images/')[1]?.split('?')[0] ?? '');
    return new Response(Uint8Array.from(objects.get(key) ?? []));
  });
  const prisma = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
    communityMessage: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const at = new Date();
        const m = stub<CommunityMessage>({ id: `eeeeeeee-0000-4000-8000-00000000000${messages.length + 1}`, created_at: at, updated_at: at, deleted_at: null, plan_context_type: null, ...data, plan_context_payload: null });
        messages.push(m);
        return m;
      },
    },
    communityMessageImage: {
      create: async ({ data }: { data: Record<string, unknown> }) => (rows.push(data), data),
      findMany: async () => rows,
    },
    communityWorkspace: { findUnique: async () => ({ coach_id: 'coach-1' }) },
    user: { findMany: async () => [] },
    communityMembership: { findMany: async () => [] },
    communityCohort: { findMany: async () => [] },
    $queryRaw: async () => [],
  };
  const access = stub<CommunityAccessService>({
    findCohort: async (id: string) => (id === SPACE ? { id, workspace_id: WS, kind: 'group' } : null),
    canAccessCohort: async () => true,
    assertCanPost: async () => undefined,
    isWorkspaceCoach: async () => false,
  });
  const { egress, reader } = egressWithGrants(); // nobody holds an AI grant
  const store = new CommunityImageStore(stub<SupabaseService>({ getClient: () => client }));
  const service = new CommunityMessagesService(
    access,
    new CommunityMessagesRepository(stub<PrismaService>(prisma)),
    stub<CommunityRealtimeService>({ channels: { cohort: () => 'c' }, cohortShard: () => 0, broadcastCommunityEvent: async () => undefined }),
    stub<PlanContextService>({ validate: async () => null }),
    safetyWithBlocks(),
    stub<CommunityNotificationsService>({ pushEnabled: () => false }),
    store,
    egress,
  );
  const key = mintImageKey(ME, SPACE);
  objects.set(key, PHOTO);
  const send = (body = CAPTION) => service.send(me, SPACE, body, undefined, undefined, { key, width: 1200, height: 900 });
  return { send, key, objects, messages, rows, checks, reader, setReply: (r: Reply) => (reply = r) };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) =>
      e instanceof UnprocessableEntityException || e instanceof ServiceUnavailableException
        ? `${e.getStatus()} ${(e.getResponse() as { code: string }).code}`
        : String(e),
  );

beforeEach(() => {
  process.env.FEATURE_COMMUNITY_IMAGES = 'true';
  process.env.VOICE_KEY_SIGNING_SECRET = 'photo-check-test-secret';
  process.env.OPENAI_MODERATION_API_KEY = 'k-photo-check';
});
afterEach(() => {
  delete process.env.FEATURE_COMMUNITY_IMAGES;
  delete process.env.VOICE_KEY_SIGNING_SECRET;
  delete process.env.OPENAI_MODERATION_API_KEY;
  jest.restoreAllMocks();
});

describe('the automatic photo check on a space chat photo send (PHOTO-CHECK-BE)', () => {
  it('a clean photo posts: the whole checked upload and its caption are checked once, then written', async () => {
    const w = world();
    const sent = await w.send();
    expect(sent.message).toMatchObject({ kind: 'image', body: CAPTION });
    expect(w.checks).toEqual([
      {
        auth: 'Bearer k-photo-check',
        body: {
          model: 'omni-moderation-latest',
          input: [
            { type: 'text', text: CAPTION },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PHOTO.toString('base64')}` } },
          ],
        },
      },
    ]);
    expect(w.rows).toEqual([expect.objectContaining({ storage_key: sentImageKey(w.key), author_id: ME })]);
    expect(w.objects.get(sentImageKey(w.key))).toEqual(PHOTO);
  });

  it('checks a photo with no caption on its own, for a member with no AI grant, without reading consent', async () => {
    const w = world();
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(w.checks[0].body.input).toEqual([{ type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/jpeg;base64,/) } }]);
    expect(w.reader.calls).toEqual([]);
  });

  it('a flagged photo writes and publishes nothing, erases the upload and answers 422 PHOTO_NOT_ALLOWED', async () => {
    const w = world({ reply: () => answer(true) });
    expect(await codeOf(w.send())).toBe('422 PHOTO_NOT_ALLOWED');
    expect(w.messages).toEqual([]);
    expect(w.rows).toEqual([]);
    expect(w.objects.size).toBe(0); // no sent copy, and the upload is gone
  });

  const unavailable: Array<[string, Parameters<typeof world>[0], (() => void)?]> = [
    ['no key is set', {}, () => delete process.env.OPENAI_MODERATION_API_KEY],
    ['OpenAI answers 429', { reply: () => new Response('{}', { status: 429 }) }],
    ['OpenAI answers 500', { reply: () => new Response('{}', { status: 500 }) }],
    ['the network fails', { reply: () => Promise.reject(new TypeError('fetch failed')) }],
    ['the answer has no results', { reply: () => new Response('{"results":[]}', { status: 200, headers: { 'content-type': 'application/json' } }) }],
    ['the download is not the whole checked upload', { statSize: PHOTO.length + 1 }],
  ];
  it.each(unavailable)('fails closed when %s: 503 PHOTO_CHECK_UNAVAILABLE, nothing written, upload kept', async (_why, opts, before) => {
    const w = world(opts);
    before?.();
    expect(await codeOf(w.send())).toBe('503 PHOTO_CHECK_UNAVAILABLE');
    expect(w.checks.length).toBeLessThanOrEqual(1); // never a retry
    expect(w.messages).toEqual([]);
    expect(w.rows).toEqual([]);
    expect([...w.objects.keys()]).toEqual([w.key]);
  });

  it('the same send goes through once the check answers again', async () => {
    const w = world({ reply: () => new Response('{}', { status: 503 }) });
    expect(await codeOf(w.send())).toBe('503 PHOTO_CHECK_UNAVAILABLE');
    w.setReply(() => answer(false));
    expect(await codeOf(w.send())).toBe('ok');
    expect(w.rows).toHaveLength(1);
  });

  it('logs the outcome only: never the caption, the photo, the key or who sent it', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => void lines.push(String(m)));
    }
    await codeOf(world({ reply: () => answer(true) }).send());
    await codeOf(world({ reply: () => new Response('{}', { status: 500 }) }).send());
    expect(lines.filter((l) => l.includes('photo_check'))).toEqual([
      'community.photo_check outcome=flagged',
      'community.photo_check outcome=check_failed',
    ]);
    for (const l of lines) expect(l).not.toMatch(new RegExp(`${CAPTION}|base64`));
  });

  it('the running server always injects the check (it is never left out by the module graph)', () => {
    expect(Reflect.getMetadata('design:paramtypes', CommunityMessagesService)[7]).toBe(AiEgressService);
    expect(Reflect.getMetadata('__module:global__', AiEgressModule)).toBe(true);
    expect(Reflect.getMetadata('exports', AiEgressModule)).toContain(AiEgressService);
    expect(readFileSync(join(__dirname, '../../../src/app.module.ts'), 'utf8')).toMatch(/^\s+AiEgressModule,$/m);
  });
});
