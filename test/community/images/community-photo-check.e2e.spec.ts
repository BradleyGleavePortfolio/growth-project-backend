/**
 * PHOTO-CHECK-BE: the automatic photo check on a space chat photo send and on
 * a caption edit, end to end through the real CommunityMessagesService,
 * repository, image store and AI egress, with the real OpenAI SDK on an
 * in-memory transport (storage reads and the moderation endpoint are both
 * answered by the fake fetch). FR-1152: the refusal table (#172-3 op 2), the
 * caption edit (Sol B1), the caption-only refusal (Opus C-3) and the coach
 * alert (#172-5 op 2).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { CommunityMessage, User } from '@prisma/client';
import { AiEgressService } from '../../../src/ai-egress/ai-egress.service';
import { AiEgressModule } from '../../../src/ai-egress/ai-egress.module';
import { CoachAlertsService } from '../../../src/coach/coach-alerts.service';
import { CoachModule } from '../../../src/coach/coach.module';
import { CommunityImageStore, mintImageKey, sentImageKey } from '../../../src/community/images/community-image-store';
import { PHOTO_CHECK_RULES } from '../../../src/community/images/community-photo-check';
import { CommunityMessagesService } from '../../../src/community/messages/community-messages.service';
import { CommunityMessagesRepository } from '../../../src/community/messages/community-messages.repository';
import type { CommunityAccessService } from '../../../src/community/community-access.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { PlanContextService } from '../../../src/community/plan-context/plan-context.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { PrismaService } from '../../../src/prisma.service';
import type { SupabaseService } from '../../../src/supabase/supabase.service';
import { assertEnv, PHOTO_CHECK_KEY_GHOST } from '../../../src/common/env-validation';
import { safetyWithBlocks } from '../safety/safety-test-helpers';
import { egressWithGrants } from '../../ai-egress/ai-egress.fakes';

function stub<T>(v: unknown): T {
  return v as T;
}

const WS = '22222222-2222-4222-8222-222222222222';
const SPACE = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '33333333-3333-4333-8333-333333333333';
const ME = 'aaaaaaaa-0000-4000-8000-000000000001';
const COACH = 'cccccccc-0000-4000-8000-000000000009';
const me = stub<User>({ id: ME, role: 'student', coach_id: COACH });
const CAPTION = 'after the long run';
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
const MODERATION_URL = 'https://api.openai.com/v1/moderations';
const URGENT_PUSH = 'Urgent safety alert for one of your clients. Open TGP to see details.';

// OpenAI omni-moderation's categories; a photo is scored only for IMAGE_SCORED.
const CATEGORIES = [
  'sexual', 'sexual/minors', 'harassment', 'harassment/threatening', 'hate', 'hate/threatening', 'illicit',
  'illicit/violent', 'self-harm', 'self-harm/intent', 'self-harm/instructions', 'violence', 'violence/graphic',
];
const IMAGE_SCORED = ['sexual', 'self-harm', 'self-harm/intent', 'self-harm/instructions', 'violence', 'violence/graphic'];

type Part = 'image' | 'text';
type Scores = Record<string, number>;
/** One moderation result as OpenAI answers it for a single input of this type. */
function result(part: Part, scores: Scores = {}, flags: Record<string, boolean> = {}) {
  const scored = (c: string) => part === 'text' || IMAGE_SCORED.includes(c);
  return {
    flagged: Object.values(flags).includes(true),
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, flags[c] ?? false])),
    category_scores: Object.fromEntries(CATEGORIES.map((c) => [c, scored(c) ? scores[c] ?? 0.0004 : 0])),
    category_applied_input_types: Object.fromEntries(CATEGORIES.map((c) => [c, scored(c) ? [part] : []])),
  };
}
const respond = (results: unknown[]) =>
  new Response(JSON.stringify({ id: 'modr-1', model: 'omni-moderation-latest', results }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

type Reply = (part: Part) => Response | Promise<Response>;
/** Answers the photo request with `photo` scores and the caption request with `caption`. */
const scoring = (photo: Scores = {}, caption: Scores = {}, flags: Record<string, boolean> = {}): Reply => (part) =>
  respond([result(part, part === 'image' ? photo : caption, part === 'text' ? flags : {})]);

function world(
  opts: { reply?: Reply; statSize?: number; alerts?: Partial<CoachAlertsService> | null; stallSignAt?: number; stallBody?: boolean } = {},
) {
  const objects = new Map<string, Buffer>();
  const messages: CommunityMessage[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const checks: Array<{ auth: string | null; part: Part; body: { model: string; input: Array<Record<string, unknown>> } }> = [];
  let reply: Reply = opts.reply ?? scoring();
  let signs = 0;
  const from = () => ({
    createSignedUrl: async (key: string) =>
      ++signs === opts.stallSignAt
        ? new Promise<never>(() => undefined)
        : { data: { signedUrl: `https://s.test/sign/community-images/${key}?t=1` }, error: null },
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
      const body = JSON.parse(String(init?.body));
      const part: Part = body.input[0]?.type === 'image_url' ? 'image' : 'text';
      checks.push({ auth: new Headers(init?.headers).get('authorization'), part, body });
      return reply(part);
    }
    const key = decodeURIComponent(String(url).split('/sign/community-images/')[1]?.split('?')[0] ?? '');
    const whole = Uint8Array.from(objects.get(key) ?? []);
    if (opts.stallBody && !new Headers(init?.headers).has('range')) {
      // The headers arrive, then the body never ends.
      return new Response(new ReadableStream({ start: (c) => c.enqueue(whole.subarray(0, 8)) }));
    }
    return new Response(whole);
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
      findFirst: async ({ where }: { where: { id: string } }) => messages.find((m) => m.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id_created_at: { id: string } }; data: { body: string } }) => {
        const m = messages.find((x) => x.id === where.id_created_at.id);
        if (!m) throw new Error('no row');
        Object.assign(m, data, { updated_at: new Date() });
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
  const createAlert = jest.fn(async (_input: Record<string, unknown>) => ({ id: 'alert-1' }));
  const alerts = opts.alerts === undefined ? { createAlert } : opts.alerts;
  const moduleRef = stub<ModuleRef>({
    get: (token: unknown) => {
      if (token !== CoachAlertsService || !alerts) throw new Error('not found');
      return alerts;
    },
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
    moduleRef,
  );
  const key = mintImageKey(ME, SPACE);
  objects.set(key, PHOTO);
  const send = (body = CAPTION, who: User = me) =>
    service.send(who, SPACE, body, undefined, undefined, { key, width: 1200, height: 900 });
  const edit = (id: string, body: string, who: User = me) => service.edit(who, id, body);
  return { service, send, edit, key, objects, messages, rows, checks, reader, createAlert, setReply: (r: Reply) => (reply = r) };
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
  process.env.PHOTO_CHECK_OPENAI_API_KEY = 'k-photo-check';
});
afterEach(() => {
  delete process.env.FEATURE_COMMUNITY_IMAGES;
  delete process.env.VOICE_KEY_SIGNING_SECRET;
  delete process.env.PHOTO_CHECK_OPENAI_API_KEY;
  jest.restoreAllMocks();
});

describe('the automatic photo check on a space chat photo send (PHOTO-CHECK-BE)', () => {
  it('a clean photo posts: the whole checked upload and its caption are each checked once, apart, then written', async () => {
    const w = world();
    const sent = await w.send();
    expect(sent.message).toMatchObject({ kind: 'image', body: CAPTION });
    const byPart = Object.fromEntries(w.checks.map((c) => [c.part, c]));
    expect(w.checks).toHaveLength(2);
    expect(byPart.image).toEqual({
      auth: 'Bearer k-photo-check',
      part: 'image',
      body: {
        model: 'omni-moderation-latest',
        input: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PHOTO.toString('base64')}` } }],
      },
    });
    expect(byPart.text).toEqual({
      auth: 'Bearer k-photo-check',
      part: 'text',
      body: { model: 'omni-moderation-latest', input: [{ type: 'text', text: CAPTION }] },
    });
    expect(JSON.stringify(w.checks)).not.toMatch(new RegExp(`${ME}|${SPACE}|${WS}|${w.key}|${COACH}`)); // no member, space or key
    expect(w.rows).toEqual([expect.objectContaining({ storage_key: sentImageKey(w.key), author_id: ME })]);
    expect(w.objects.get(sentImageKey(w.key))).toEqual(PHOTO);
    expect(w.createAlert).not.toHaveBeenCalled();
  });

  it('checks a photo with no caption on its own, for a member with no AI grant, without reading consent', async () => {
    const w = world();
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(w.checks.map((c) => c.body.input)).toEqual([[{ type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/jpeg;base64,/) } }]]);
    expect(w.reader.calls).toEqual([]);
  });

  describe('the refusal table (#172-3 op 2, moderate tolerance)', () => {
    it('refuses exactly sexual, graphic violence, self-harm intent or instructions, hate and threats; posts the rest', () => {
      const refuses = (part: 'photo' | 'caption') =>
        Object.entries(PHOTO_CHECK_RULES).filter(([, r]) => r[part] !== null).map(([c]) => c).sort();
      expect(refuses('photo')).toEqual(['self-harm/instructions', 'self-harm/intent', 'sexual', 'violence/graphic']);
      expect(refuses('caption')).toEqual([
        'harassment/threatening', 'hate', 'hate/threatening', 'self-harm/instructions', 'self-harm/intent',
        'sexual', 'sexual/minors', 'violence/graphic',
      ]);
      expect(Object.keys(PHOTO_CHECK_RULES).sort()).toEqual([...CATEGORIES].sort());
      for (const c of CATEGORIES.filter((x) => !IMAGE_SCORED.includes(x))) expect(PHOTO_CHECK_RULES[c].photo).toBeNull();
      expect(PHOTO_CHECK_RULES['sexual/minors'].caption).toBe('flag');
    });

    it('a swimwear photo posts, even when OpenAI itself flags it as sexual', async () => {
      const w = world({ reply: (part) => respond([result(part, part === 'image' ? { sexual: 0.62 } : {}, part === 'image' ? { sexual: true } : {})]) });
      expect(await codeOf(w.send('beach day'))).toBe('ok');
      expect(w.rows).toHaveLength(1);
    });

    it('a boxing or gym photo posts: violence alone never refuses', async () => {
      const w = world({ reply: scoring({ violence: 0.97, 'violence/graphic': 0.3 }) });
      expect(await codeOf(w.send('sparring day'))).toBe('ok');
    });

    it('a joking self-loathing caption posts', async () => {
      const w = world({ reply: scoring({}, { 'self-harm': 0.45, 'self-harm/intent': 0.12, hate: 0.08, harassment: 0.31 }) });
      expect(await codeOf(w.send('I hate my legs lol'))).toBe('ok');
      expect(w.createAlert).not.toHaveBeenCalled();
    });

    it.each([
      ['sexual', 0.85],
      ['violence/graphic', 0.7],
      ['self-harm/intent', 0.7],
      ['self-harm/instructions', 0.5],
    ])('a photo scored %s at %s is refused: 422 PHOTO_NOT_ALLOWED, nothing written, the upload erased', async (category, score) => {
      const w = world({ reply: scoring({ [category]: score }) });
      expect(await codeOf(w.send())).toBe('422 PHOTO_NOT_ALLOWED');
      expect([w.messages, w.rows, w.objects.size]).toEqual([[], [], 0]);
      const below = world({ reply: scoring({ [category]: score - 0.01 }) });
      expect(await codeOf(below.send())).toBe('ok');
    });

    it.each([
      ['sexual', 0.8],
      ['violence/graphic', 0.7],
      ['self-harm/intent', 0.7],
      ['self-harm/instructions', 0.5],
      ['hate', 0.7],
      ['hate/threatening', 0.5],
      ['harassment/threatening', 0.7],
    ])('a caption scored %s at %s is refused alone (Opus C-3): 422 CAPTION_NOT_ALLOWED, nothing written, the upload kept', async (category, score) => {
      const w = world({ reply: scoring({}, { [category]: score }) });
      expect(await codeOf(w.send())).toBe('422 CAPTION_NOT_ALLOWED');
      expect([w.messages, w.rows, [...w.objects.keys()]]).toEqual([[], [], [w.key]]);
      w.setReply(scoring());
      expect(await codeOf(w.send('another caption'))).toBe('ok'); // the same photo, a new caption
      const below = world({ reply: scoring({}, { [category]: score - 0.01 }) });
      expect(await codeOf(below.send())).toBe('ok');
    });

    it('sexual content involving minors in a caption refuses whenever OpenAI flags it, at any score', async () => {
      const w = world({ reply: scoring({}, { 'sexual/minors': 0.02 }, { 'sexual/minors': true }) });
      expect(await codeOf(w.send())).toBe('422 CAPTION_NOT_ALLOWED');
    });

    it.each(['violence', 'self-harm', 'harassment', 'illicit', 'illicit/violent'])(
      'a caption scored high only for %s posts (reporting is the backstop)',
      async (category) => {
        const w = world({ reply: scoring({ violence: 0.99, 'self-harm': 0.99 }, { [category]: 0.99 }, { [category]: true }) });
        expect(await codeOf(w.send())).toBe('ok');
      },
    );

    it('reads category_applied_input_types: a score that applies only to text never refuses the photo', async () => {
      const w = world({
        reply: (part) => {
          const r = result(part);
          if (part === 'image') {
            r.category_scores.sexual = 0.99;
            r.category_applied_input_types.sexual = ['text'];
          }
          return respond([r]);
        },
      });
      expect(await codeOf(w.send())).toBe('ok');
    });

    it('a refused photo with a refused caption is the photo refusal: the upload is erased', async () => {
      const w = world({ reply: scoring({ sexual: 0.99 }, { hate: 0.99 }) });
      expect(await codeOf(w.send())).toBe('422 PHOTO_NOT_ALLOWED');
      expect(w.objects.size).toBe(0);
    });

    it('a refused caption is refused even when the photo could not be checked; the upload is kept', async () => {
      const w = world({ reply: (part) => (part === 'image' ? new Response('{}', { status: 500 }) : scoring({}, { hate: 0.9 })(part)) });
      expect(await codeOf(w.send())).toBe('422 CAPTION_NOT_ALLOWED');
      expect([...w.objects.keys()]).toEqual([w.key]);
    });
  });

  const unavailable: Array<[string, { reply?: Reply; statSize?: number; key?: string }]> = [
    ['no key is set', { key: '' }],
    ['the key is still the ghost value', { key: PHOTO_CHECK_KEY_GHOST }],
    ['the check times out', { reply: () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')) }],
    ['OpenAI answers 429', { reply: () => new Response('{}', { status: 429 }) }],
    ['OpenAI answers 500', { reply: () => new Response('{}', { status: 500 }) }],
    ['the network fails', { reply: () => Promise.reject(new TypeError('fetch failed')) }],
    ['the answer has no results', { reply: () => respond([]) }],
    ['the answer is missing a score', { reply: (part) => respond([{ ...result(part), category_scores: {} }]) }],
    ['only the caption check fails', { reply: (part) => (part === 'text' ? new Response('{}', { status: 500 }) : scoring()(part)) }],
    ['the download is not the whole checked upload', { statSize: PHOTO.length + 1 }],
  ];
  it.each(unavailable)('fails closed when %s: 503 PHOTO_CHECK_UNAVAILABLE, nothing written, upload kept', async (_why, opts) => {
    const w = world(opts);
    if (opts.key !== undefined) process.env.PHOTO_CHECK_OPENAI_API_KEY = opts.key;
    expect(await codeOf(w.send())).toBe('503 PHOTO_CHECK_UNAVAILABLE');
    expect(w.checks.length).toBeLessThanOrEqual(2); // one per part, never a retry
    expect(w.messages).toEqual([]);
    expect(w.rows).toEqual([]);
    expect([...w.objects.keys()]).toEqual([w.key]);
  });

  it.each([
    ['signing the download link stalls', { stallSignAt: 2 }], // 1 is the upload check's own read
    ['the download body stalls after its headers', { stallBody: true }],
  ])('the 5-second download deadline holds when %s (Sol C, B2 class)', async (_why, opts) => {
    const w = world(opts);
    const started = Date.now();
    expect(await codeOf(w.send())).toBe('503 PHOTO_CHECK_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(w.checks.filter((c) => c.part === 'image')).toEqual([]);
  }, 15_000);

  it("never sends another member's upload, or a space the sender cannot see, to the check", async () => {
    const w = world();
    const theirs = mintImageKey('bbbbbbbb-0000-4000-8000-000000000002', SPACE);
    w.objects.set(theirs, PHOTO);
    expect(await codeOf(w.send())).toBe('ok'); // control: my own photo and caption are checked, once each
    const before = w.checks.length;
    expect(await codeOf(w.service.send(me, SPACE, CAPTION, undefined, undefined, { key: theirs, width: 1, height: 1 }))).not.toBe('ok');
    await expect(w.service.send(me, FOREIGN, CAPTION, undefined, undefined, { key: w.key, width: 1, height: 1 })).rejects.toThrow();
    expect([before, w.checks.length]).toEqual([2, 2]);
  });

  it('the same send goes through once the check answers again', async () => {
    const w = world({ reply: () => new Response('{}', { status: 503 }) });
    expect(await codeOf(w.send())).toBe('503 PHOTO_CHECK_UNAVAILABLE');
    w.setReply(scoring());
    expect(await codeOf(w.send())).toBe('ok');
    expect(w.rows).toHaveLength(1);
  });

  it('logs the outcome only: never the caption, the photo, the key, a category or who sent it', async () => {
    const lines: string[] = [];
    const keep = (...args: unknown[]): void => {
      lines.push(String(args[0]));
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(keep);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(keep);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(keep);
    await codeOf(world({ reply: scoring({ sexual: 0.99 }) }).send());
    await codeOf(world({ reply: scoring({}, { 'self-harm/intent': 0.9 }) }).send());
    await codeOf(world({ reply: () => new Response('{}', { status: 500 }) }).send());
    expect(lines.filter((l) => l.includes('photo_check'))).toEqual([
      'community.photo_check outcome=refused part=photo',
      'community.photo_check outcome=refused part=caption alert=raised',
      'community.photo_check outcome=check_failed',
    ]);
    for (const l of lines) expect(l).not.toMatch(new RegExp(`${CAPTION}|base64`));
    for (const l of lines.filter((x) => x.includes('photo_check'))) expect(l).not.toMatch(new RegExp(`${ME}|${COACH}|sexual|self-harm`));
  });
});

describe('a caption edit on a photo message (FR-1152, Sol B1)', () => {
  async function sentPhoto(w: ReturnType<typeof world>) {
    const sent = await w.send();
    w.checks.length = 0;
    return sent.message.id;
  }

  it('a clean new caption is checked on its own, then written', async () => {
    const w = world();
    const id = await sentPhoto(w);
    const edited = await w.edit(id, 'new caption');
    expect(edited.message).toMatchObject({ body: 'new caption' });
    expect(w.checks.map((c) => c.body.input)).toEqual([[{ type: 'text', text: 'new caption' }]]);
  });

  it('a refused caption is 422 CAPTION_NOT_ALLOWED: the old caption stays and the sent photo is untouched', async () => {
    const w = world();
    const id = await sentPhoto(w);
    w.setReply(scoring({}, { 'hate/threatening': 0.8 }));
    expect(await codeOf(w.edit(id, 'a threat'))).toBe('422 CAPTION_NOT_ALLOWED');
    expect(w.messages[0].body).toBe(CAPTION);
    expect(w.objects.get(sentImageKey(w.key))).toEqual(PHOTO);
  });

  it('an unavailable check is 503 PHOTO_CHECK_UNAVAILABLE and changes nothing', async () => {
    const w = world();
    const id = await sentPhoto(w);
    w.setReply(() => new Response('{}', { status: 500 }));
    expect(await codeOf(w.edit(id, 'new caption'))).toBe('503 PHOTO_CHECK_UNAVAILABLE');
    expect(w.messages[0].body).toBe(CAPTION);
  });

  it('a text message edit is not sent to the photo check', async () => {
    const w = world();
    const at = new Date();
    w.messages.push(
      stub<CommunityMessage>({ id: 'eeeeeeee-0000-4000-8000-0000000000aa', scope: 'cohort', kind: 'text', cohort_id: SPACE, workspace_id: WS, sender_id: ME, body: 'plain words', created_at: at, updated_at: at, deleted_at: null, plan_context_type: null, plan_context_payload: null }),
    );
    expect(await codeOf(w.edit('eeeeeeee-0000-4000-8000-0000000000aa', 'plain words, edited'))).toBe('ok');
    expect(w.messages[0].body).toBe('plain words, edited');
    expect(w.checks).toEqual([]);
  });
});

describe('the coach alert for a self-harm refusal (#172-5 op 2)', () => {
  const ALERT = { coachId: COACH, clientId: ME, alertType: 'community_photo_safety', severity: 'critical', message: URGENT_PUSH };

  it.each([
    ['the photo', scoring({ 'self-harm/intent': 0.9 }), '422 PHOTO_NOT_ALLOWED'],
    ['the caption', scoring({}, { 'self-harm/instructions': 0.6 }), '422 CAPTION_NOT_ALLOWED'],
    ['both', scoring({ 'self-harm/instructions': 0.9 }, { 'self-harm/intent': 0.9 }), '422 PHOTO_NOT_ALLOWED'],
  ])('a refusal for self-harm in %s raises one critical alert for the coach, with no content', async (_part, reply, code) => {
    const w = world({ reply });
    expect(await codeOf(w.send())).toBe(code);
    expect(w.createAlert.mock.calls).toEqual([[ALERT]]); // once; no photo, caption, category or payload
  });

  it('a caption edit refused for self-harm raises the alert too', async () => {
    const w = world();
    const id = (await w.send()).message.id;
    w.setReply(scoring({}, { 'self-harm/intent': 0.95 }));
    expect(await codeOf(w.edit(id, 'new caption'))).toBe('422 CAPTION_NOT_ALLOWED');
    expect(w.createAlert.mock.calls).toEqual([[ALERT]]);
  });

  it('other refusals raise no alert', async () => {
    const w = world({ reply: scoring({ sexual: 0.99, 'violence/graphic': 0.99 }, { hate: 0.99 }) });
    expect(await codeOf(w.send())).toBe('422 PHOTO_NOT_ALLOWED');
    expect(w.createAlert).not.toHaveBeenCalled();
  });

  it('no coach, no alert, and the refusal stands; the same for a coach or a failed alert write', async () => {
    const reply = scoring({ 'self-harm/intent': 0.9 });
    for (const who of [stub<User>({ id: ME, role: 'student', coach_id: null }), stub<User>({ id: ME, role: 'coach', coach_id: COACH })]) {
      const w = world({ reply });
      expect(await codeOf(w.send(CAPTION, who))).toBe('422 PHOTO_NOT_ALLOWED');
      expect(w.createAlert).not.toHaveBeenCalled();
    }
    const failing = world({ reply, alerts: { createAlert: jest.fn(async () => Promise.reject(new Error('db down'))) } });
    expect(await codeOf(failing.send())).toBe('422 PHOTO_NOT_ALLOWED');
    const missing = world({ reply, alerts: null });
    expect(await codeOf(missing.send())).toBe('422 PHOTO_NOT_ALLOWED');
  });

  it('rides FEATURE_COMMUNITY_IMAGES: with photos off, an edit refusal raises no alert', async () => {
    const w = world();
    const id = (await w.send()).message.id;
    process.env.FEATURE_COMMUNITY_IMAGES = 'false';
    w.setReply(scoring({}, { 'self-harm/intent': 0.95 }));
    expect(await codeOf(w.edit(id, 'new caption'))).toBe('422 CAPTION_NOT_ALLOWED');
    expect(w.createAlert).not.toHaveBeenCalled();
  });
});

describe('boot and wiring', () => {
  it('warns once at boot when photos are on without a real key, and never blocks boot', () => {
    const hard = {
      DATABASE_URL: 'postgres://x',
      DIRECT_URL: 'postgres://x:5432/db',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'srk',
      USDA_API_KEY: 'usda-test-key',
      RECENT_AUTH_SECRET: 'test-recent-auth-secret-at-least-32-chars-long',
      RECENT_AUTH_TTL_MS: '300000',
    };
    const warnings = (env: NodeJS.ProcessEnv) => {
      const warn = jest.fn();
      assertEnv({ ...hard, ...env }, { logger: { log: jest.fn(), error: jest.fn(), warn } });
      return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('PHOTO_CHECK_UNAVAILABLE'));
    };
    expect(warnings({ FEATURE_COMMUNITY_IMAGES: 'true' })).toHaveLength(1);
    expect(warnings({ FEATURE_COMMUNITY_IMAGES: 'true', PHOTO_CHECK_OPENAI_API_KEY: PHOTO_CHECK_KEY_GHOST })).toHaveLength(1);
    expect(warnings({ FEATURE_COMMUNITY_IMAGES: 'true', PHOTO_CHECK_OPENAI_API_KEY: 'k-real' })).toEqual([]);
    expect(warnings({ PHOTO_CHECK_OPENAI_API_KEY: '' })).toEqual([]);
  });

  it('the running server always injects the check and finds the coach alert service', () => {
    const params = Reflect.getMetadata('design:paramtypes', CommunityMessagesService);
    expect(params[7]).toBe(AiEgressService);
    expect(params[8]).toBe(ModuleRef);
    expect(Reflect.getMetadata('__module:global__', AiEgressModule)).toBe(true);
    expect(Reflect.getMetadata('exports', AiEgressModule)).toContain(AiEgressService);
    expect(Reflect.getMetadata('exports', CoachModule)).toContain(CoachAlertsService);
    const app = readFileSync(join(__dirname, '../../../src/app.module.ts'), 'utf8');
    expect(app).toMatch(/^\s+AiEgressModule,$/m);
    expect(app).toMatch(/^\s+CoachModule,$/m);
  });
});
