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
import { CommunityAccessService } from '../../../src/community/community-access.service';
import type { CommunityRealtimeService } from '../../../src/community/realtime/community-realtime.service';
import type { PlanContextService } from '../../../src/community/plan-context/plan-context.service';
import type { CommunityNotificationsService } from '../../../src/community/notifications/community-notifications.service';
import type { PrismaService } from '../../../src/prisma.service';
import type { SupabaseService } from '../../../src/supabase/supabase.service';
import { assertEnv, PHOTO_CHECK_KEY_GHOST } from '../../../src/common/env-validation';
import { safetyWithBlocks } from '../safety/safety-test-helpers';
import { egressWithGrants } from '../../ai-egress/ai-egress.fakes';
import {
  JFIF, SCAN, SOI, jpeg, exifApp1, xmpApp1, segment, tiff,
  extendedXmpApp1, EXTENDED_GUID, LOCATED,
} from './jpeg-fixtures';
import { REAL_PHOTOS } from './real-photos';

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
// A real JPEG layout with no location (main's PHOTO-GPS upload check reads to SOS first).
const PHOTO = Buffer.from(jpeg(JFIF));
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

// A Prisma where over plain rows: equality, `in` and a nested relation.
const fits = (row: unknown, where: unknown): boolean =>
  Object.entries((where ?? {}) as Record<string, unknown>).every(([k, c]) => {
    const v = (row as Record<string, unknown>)[k];
    if (c === null || typeof c !== 'object') return v === c;
    const o = c as Record<string, unknown>;
    return 'in' in o ? (o.in as unknown[]).includes(v) : fits(v, o);
  });

type SpaceOpts = { visibility: string; owner: string; team: Array<Record<string, unknown>> };

function world(
  opts: {
    reply?: Reply;
    shortBody?: boolean;
    alerts?: Partial<CoachAlertsService> | null;
    stallSignAt?: number;
    stallBody?: boolean;
    space?: SpaceOpts; // the space's visibility, workspace owner and memberships
    blocks?: Array<[string, string]>;
    photo?: Buffer;
  } = {},
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
        ? { data: { size: o.length, contentType: 'image/jpeg' }, error: null }
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
    // The upload check's ranged read sees the whole file; the photo check's own download comes up one byte short.
    if (opts.shortBody && !new Headers(init?.headers).has('range')) return new Response(whole.subarray(0, whole.length - 1));
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
    communityWorkspace: { findUnique: async () => ({ coach_id: opts.space?.owner ?? 'coach-1' }) },
    user: { findMany: async () => [] },
    communityMembership: {
      findMany: async (args?: { where?: unknown }) => (opts.space?.team ?? []).filter((m) => fits(m, args?.where)),
    },
    communityCohort: { findMany: async () => [] },
    $queryRaw: async () => [],
  };
  // The real access service over the fake rows, with the post checks stubbed.
  const access = stub<CommunityAccessService>(
    Object.assign(Object.create(new CommunityAccessService(stub<PrismaService>(prisma))), {
      findCohort: async (id: string) =>
        id === SPACE ? { id, workspace_id: WS, kind: 'group', ...(opts.space ? { visibility: opts.space.visibility } : {}) } : null,
      canAccessCohort: async () => true,
      assertCanPost: async () => undefined,
      isWorkspaceCoach: async () => false,
    }),
  );
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
    safetyWithBlocks(opts.blocks),
    stub<CommunityNotificationsService>({ pushEnabled: () => false }),
    store,
    undefined, // main's space push (SC-PUSH): not under test here
    egress,
    moduleRef,
  );
  const key = mintImageKey(ME, SPACE);
  objects.set(key, opts.photo ?? PHOTO);
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
  // LS-1187 B1: ordinary creator metadata is not location. The public policy
  // now promises that the photo reaches OpenAI with no name attached.
  const creator = 'Example Photo Author';
  const nameBytes = [...Buffer.from(`${creator}\0`, 'ascii')];
  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n: number) => [...u16(n), ...u16(n >>> 16)];
  const entry = (tag: number, type: number, count: number, value: number) =>
    [...u16(tag), ...u16(type), ...u32(count), ...u32(value)];
  const tiffHeader = [0x49, 0x49, ...u16(42), ...u32(8)];
  const artist = exifApp1([
    ...tiffHeader, ...u16(1), ...entry(0x013b, 2, nameBytes.length, 26), ...u32(0), ...nameBytes,
  ]);
  const ownerName = exifApp1([
    ...tiffHeader, ...u16(1), ...entry(0x8769, 4, 1, 26), ...u32(0),
    ...u16(1), ...entry(0xa430, 2, nameBytes.length, 44), ...u32(0), ...nameBytes,
  ]);
  const xmpCreator = xmpApp1(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq>' +
    `<rdf:li>${creator}</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`,
  );
  it.each([
    ['EXIF Artist', artist],
    ['EXIF OwnerName', ownerName],
    ['XMP creator', xmpCreator],
  ])('LS-1187 B1: accepted photo with %s does not send the embedded name to OpenAI', async (_label, segment) => {
    const w = world({ photo: Buffer.from(jpeg(JFIF, segment)) });
    await w.send();
    const photoInput = w.checks.find((c) => c.part === 'image')?.body.input[0] as
      { image_url: { url: string } };
    const wireBytes = Buffer.from(photoInput.image_url.url.split(',')[1], 'base64');
    expect(wireBytes.toString('latin1')).not.toContain(creator);
  });

  // LS-1187R2 B1: APP0 is not necessarily just a fixed JFIF header. A JFXX
  // extension can hold a complete JPEG thumbnail, including its own writer
  // details. Only the primary picture belongs in the moderation copy.
  // JFIF 1.02 extension 0x10: https://www.w3.org/Graphics/JPEG/jfif3.pdf
  // A real 16x8 baseline JPEG generated by Pillow; not synthetic scan bytes.
  const validPicture = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjtJ+HXT9z+leh6T8O/u/uf0oormwebYn9573b9Ty+Gc8xnu+8f//Z',
    'base64',
  );
  validPicture[12] = 2; // JFIF 1.02 supports JFXX; identical encoded picture.
  it.each<[string, number[]]>([
    ['EXIF Artist', artist],
    ['EXIF OwnerName', ownerName],
    ['XMP creator', xmpCreator],
    ['COM author', segment(0xfe, [...Buffer.from(creator, 'latin1')])],
  ])('LS-1187R2 B1: a JFXX JPEG thumbnail with %s does not send its creator to OpenAI', async (_label, writer) => {
    // The thumbnail has no JFIF/JFXX segment of its own. It is a JPEG stream
    // bounded by SOI/EOI inside the enclosing APP0's declared length.
    const thumb = [...SOI, ...writer, ...validPicture.subarray(20)];
    const jfxx = segment(0xe0, [...Buffer.from('JFXX\0', 'latin1'), 0x10, ...thumb]);
    const upload = Buffer.from([...validPicture.subarray(0, 20), ...jfxx, ...validPicture.subarray(20)]);
    const w = world({ photo: upload });
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
    const photoInput = w.checks.find((c) => c.part === 'image')?.body.input[0] as { image_url: { url: string } };
    const wire = Buffer.from(photoInput.image_url.url.split(',')[1], 'base64');
    expect(wire.toString('latin1')).not.toContain(creator);
    expect(wire).toEqual(validPicture);
  });

  // Independent round-2 transport matrix. All assertions use the real shared
  // service -> store -> egress -> SDK path, not a second stripper.
  const progressivePicture = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAIABADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAUG/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwT/2gAMAwEAAhADEAAAAY2iCl//xAAWEAADAAAAAAAAAAAAAAAAAAAAAwX/2gAIAQEAAQUCVOFTj//EABgRAAIDAAAAAAAAAAAAAAAAAAAhAwQF/9oACAEDAQE/Acy9Mmf/xAAYEQACAwAAAAAAAAAAAAAAAAAAAwQhIv/aAAgBAgEBPwFMtmrP/8QAFRABAQAAAAAAAAAAAAAAAAAAADH/2gAIAQEABj8CiP/EABUQAQEAAAAAAAAAAAAAAAAAAAAx/9oACAEBAAE/IVk//9oADAMBAAIAAwAAABCL/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxAD/8QAFhEAAwAAAAAAAAAAAAAAAAAAAJHB/9oACAECAQE/EESn/8QAFxABAAMAAAAAAAAAAAAAAAAAADHB8f/aAAgBAQABPxCGjAf/2Q==',
    'base64',
  );
  const u16le = (n: number) => [n & 0xff, n >>> 8 & 0xff];
  const u32le = (n: number) => [...u16le(n), ...u16le(n >>> 16)];
  const u32be = (n: number) => [n >>> 24 & 0xff, n >>> 16 & 0xff, n >>> 8 & 0xff, n & 0xff];
  const creatorBytes = [...Buffer.from(creator, 'latin1')];
  it('LS-1187R2 B1: Canon APP0 CIFF OwnerName is absent from the SDK copy', async () => {
    // Canon's real APP0 CIFF family, not an arbitrary extra payload:
    // https://exiftool.org/TagNames/CanonRaw.html (OwnerName tag 0x0810).
    // Header length 26; owner data 32 bytes; directory has one 10-byte
    // entry, then its block-relative directory offset. Independently
    // decoded as OwnerName by ExifTool 13.50; pixels decoded by Pillow.
    const owner = [...creatorBytes, ...Array<number>(32 - creatorBytes.length).fill(0)];
    const ciff = segment(0xe0, [
      ...Buffer.from('II', 'latin1'), ...u32le(26),
      ...Buffer.from('HEAPJPGM', 'latin1'), ...Array<number>(12).fill(0),
      ...owner, ...u16le(1), ...u16le(0x0810), ...u32le(32), ...u32le(0), ...u32le(32),
    ]);
    const upload = Buffer.from([...validPicture.subarray(0, 20), ...ciff, ...validPicture.subarray(20)]);
    const w = world({ photo: upload });
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
    expect(wirePhoto(w).toString('latin1')).not.toContain(creator);
    expect(wirePhoto(w)).toEqual(validPicture);
  });
  const byline = [0x1c, 2, 80, 0, creatorBytes.length, ...creatorBytes];
  const iptcBlock = segment(0xed, [
    ...Buffer.from('Photoshop 3.0\0', 'latin1'), ...Buffer.from('8BIM', 'latin1'), 4, 4, 0, 0,
    ...u32be(byline.length), ...byline, ...(byline.length % 2 ? [0] : []),
  ]);
  const description = [...Buffer.from('desc\0\0\0\0', 'latin1'), ...u32be(creatorBytes.length + 1), ...creatorBytes, 0];
  const profileHeader = Array<number>(128).fill(0);
  profileHeader.splice(0, 4, ...u32be(144 + description.length));
  profileHeader.splice(36, 4, ...Buffer.from('acsp', 'latin1'));
  const iccBlock = segment(0xe2, [
    ...Buffer.from('ICC_PROFILE\0', 'latin1'), 1, 1,
    ...profileHeader, ...u32be(1), ...Buffer.from('desc', 'latin1'),
    ...u32be(144), ...u32be(description.length), ...description,
  ]);
  const namedThumbnail = [...SOI, ...artist, ...validPicture.subarray(20)];
  const thumbnailExif = exifApp1([
    0x49, 0x49, ...u16le(42), ...u32le(8),
    ...u16le(0), ...u32le(14), // IFD0: no tags; next IFD at offset 14.
    ...u16le(2),
    ...u16le(0x0201), ...u16le(4), ...u32le(1), ...u32le(44),
    ...u16le(0x0202), ...u16le(4), ...u32le(1), ...u32le(namedThumbnail.length),
    ...u32le(0),
    ...namedThumbnail,
  ]);
  const independentBlocks: Array<[string, number[]]> = [
    ['EXIF Artist', artist],
    ['EXIF OwnerName', ownerName],
    ['EXIF thumbnail with its own creator', thumbnailExif],
    ['XMP creator', xmpCreator],
    ['IPTC By-line', iptcBlock],
    ['ICC description', iccBlock],
    ['MPF index', segment(0xe2, [...Buffer.from(`MPF\0MM\0*${creator}`, 'latin1')])],
    ['COM creator', segment(0xfe, [...Buffer.from(creator, 'latin1')])],
    ['APP15 writer data', segment(0xef, [...Buffer.from(creator, 'latin1')])],
  ];
  const wirePhoto = (w: ReturnType<typeof world>) => {
    const part = w.checks.find((c) => c.part === 'image')?.body.input[0] as { image_url: { url: string } };
    return Buffer.from(part.image_url.url.split(',')[1], 'base64');
  };
  // LS-1187R2 B2: the health page promises no precise location collection.
  // These are real GPS latitude/longitude RATIONAL values, not an author
  // string or place name. The full JPEG remains a valid decoded picture.
  const preciseGps = Buffer.from(
    '/+EAiEV4aWYAAE1NACoAAAAIAAGIJQAEAAAAAQAAABoAAAAAAAQAAQACAAAAAk4AAAAAAgAFAAAAAwAAAFAAAwACAAAAAkUAAAAABAAFAAAAAwAAAGgAAAAAAAAAAQAAAAEAAAAOAAAAAQAAABUAAAAFAAAAAgAAAAEAAAAUAAAAAQAABFAAAAAZ',
    'base64',
  );
  // LS-1187R3 B1: the same location families are retained in an EXIF JPEG
  // thumbnail, not only a JFXX thumbnail. IFD1's JPEGInterchangeFormat and
  // JPEGInterchangeFormatLength index the complete thumbnail at offset 156.
  // The surrounding TIFF has no GPSInfo, and the thumbnail carries XMP only.
  const thumbnailPacket = (attrs: string) =>
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" ' +
    `xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpNote="http://ns.adobe.com/xmp/note/" ${attrs}/>` +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const thumbnailGpsXml = thumbnailPacket('exif:GPSLatitude="1,14.07036N" exif:GPSLongitude="2,20.74068E"');
  const extendedCut = thumbnailGpsXml.indexOf('GPSLatitude') + 'GPSLati'.length;
  const thumbnailLocations: Array<[string, number[]]> = [
    ['StandardXMP precise GPS', xmpApp1(thumbnailGpsXml)],
    ['HasExtendedXMP', xmpApp1(thumbnailPacket(`xmpNote:HasExtendedXMP="${EXTENDED_GUID}"`))],
    ['split ExtendedXMP precise GPS', [
      ...extendedXmpApp1(EXTENDED_GUID, thumbnailGpsXml.length, 0, thumbnailGpsXml.slice(0, extendedCut)),
      ...extendedXmpApp1(EXTENDED_GUID, thumbnailGpsXml.length, extendedCut, thumbnailGpsXml.slice(extendedCut)),
    ]],
  ];
  const exifWithJpegThumbnail = (blocks: number[]) => {
    const thumb = [...SOI, ...blocks, ...validPicture.subarray(20)];
    const long = (tag: number, value: number) => [...u16le(tag), ...u16le(4), ...u32le(1), ...u32le(value)];
    const short = (tag: number, value: number) => [...u16le(tag), ...u16le(3), ...u32le(1), ...u16le(value), 0, 0];
    const rational = (tag: number, offset: number) => [...u16le(tag), ...u16le(5), ...u32le(1), ...u32le(offset)];
    return exifApp1([
      0x49, 0x49, ...u16le(42), ...u32le(8),
      ...u16le(4),
      ...rational(0x011a, 140), ...rational(0x011b, 148),
      ...short(0x0128, 2), ...short(0x0213, 1),
      ...u32le(62),
      ...u16le(6),
      ...short(0x0103, 6),
      ...rational(0x011a, 140), ...rational(0x011b, 148), ...short(0x0128, 2),
      ...long(0x0201, 156), ...long(0x0202, thumb.length),
      ...u32le(0), ...u32le(72), ...u32le(1), ...u32le(72), ...u32le(1), ...thumb,
    ]);
  };
  it.each(thumbnailLocations.flatMap(([kind, block]) =>
    ['before the frame', 'between progressive scans'].map((place): [string, string, number[]] => [kind, place, block]),
  ))('LS-1187R3 B1: %s in an EXIF JPEG thumbnail %s must not be retained and served', async (_kind, place, block) => {
    const nested = exifWithJpegThumbnail(block);
    const firstScan = progressivePicture.indexOf(Buffer.from([0xff, 0xda]));
    const nextTable = progressivePicture.indexOf(Buffer.from([0xff, 0xc4]), firstScan + 2);
    const upload = place === 'before the frame'
      ? Buffer.from([...validPicture.subarray(0, 20), ...nested, ...validPicture.subarray(20)])
      : Buffer.from([...progressivePicture.subarray(0, nextTable), ...nested, ...progressivePicture.subarray(nextTable)]);
    const w = world({ photo: upload });
    let publishedUrl: string | null | undefined;
    const outcome = await codeOf(w.send('').then((sent) => {
      publishedUrl = sent.message.image?.url;
      return sent;
    }));
    if (outcome === 'ok') {
      // Establish the user-visible consequence before asserting refusal.
      expect(w.messages).toHaveLength(1);
      expect(w.rows).toEqual([expect.objectContaining({ storage_key: sentImageKey(w.key) })]);
      expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
      expect(w.objects.get(sentImageKey(w.key))?.includes(Buffer.from(block))).toBe(true);
      expect(publishedUrl).toContain(sentImageKey(w.key));
      expect(wirePhoto(w)).toEqual(place === 'before the frame' ? validPicture : progressivePicture);
    }
    expect(outcome).toBe('422 community.image.has_location');
    expect(w.checks).toEqual([]);
    expect(w.messages).toEqual([]);
  });
  it.each(thumbnailLocations)('LS-1187R3 B1 control: the same %s at the top level is refused', async (_kind, block) => {
    const w = world({ photo: Buffer.from([...validPicture.subarray(0, 20), ...block, ...validPicture.subarray(20)]) });
    expect(await codeOf(w.send(''))).toBe('422 community.image.has_location');
    expect(w.checks).toEqual([]);
  });
  it('LS-1187R3 B1 control: a properly indexed EXIF thumbnail with non-location XMP still posts', async () => {
    const block = exifWithJpegThumbnail(xmpApp1(thumbnailPacket('xmp:CreatorTool="TGP"')));
    const upload = Buffer.from([...validPicture.subarray(0, 20), ...block, ...validPicture.subarray(20)]);
    const w = world({ photo: upload });
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(wirePhoto(w)).toEqual(validPicture);
    expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
  });
  it.each(['between progressive scans', 'inside a JFXX JPEG thumbnail'])(
    'LS-1187R2 B2: precise GPS %s is refused rather than retained and served to members',
    async (placement) => {
      const firstScan = progressivePicture.indexOf(Buffer.from([0xff, 0xda]));
      const nextTable = progressivePicture.indexOf(Buffer.from([0xff, 0xc4]), firstScan + 2);
      const nested = [...SOI, ...preciseGps, ...validPicture.subarray(20)];
      const jfxx = segment(0xe0, [...Buffer.from('JFXX\0', 'latin1'), 0x10, ...nested]);
      const upload = placement === 'between progressive scans'
        ? Buffer.from([...progressivePicture.subarray(0, nextTable), ...preciseGps, ...progressivePicture.subarray(nextTable)])
        : Buffer.from([...validPicture.subarray(0, 20), ...jfxx, ...validPicture.subarray(20)]);
      const w = world({ photo: upload });
      const code = await codeOf(w.send(''));
      if (code === 'ok') {
        expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
        expect(w.objects.get(sentImageKey(w.key))?.includes(preciseGps)).toBe(true);
      }
      expect(code).toBe('422 community.image.has_location');
      expect(w.checks).toEqual([]);
      expect(w.messages).toEqual([]);
    },
  );
  it('LS-1187R2 B2 control: the same precise GPS before the frame is refused', async () => {
    const w = world({ photo: Buffer.from([...validPicture.subarray(0, 20), ...preciseGps, ...validPicture.subarray(20)]) });
    expect(await codeOf(w.send(''))).toBe('422 community.image.has_location');
    expect(w.checks).toEqual([]);
    expect(w.messages).toEqual([]);
  });
  // LO-1187R4 (new, outside the fix): a FLIR ONE thermal camera on a phone writes its own GPS record (FFF record
  // type 0x2B GPSInfo: latitude and longitude as little-endian doubles) inside "FLIR\0" APP1 chunks, beside a raw
  // thermal frame that pushes the segments before SOS past 256 KB. Main's reader stopped at 256 KB and refused it;
  // the whole-photo reader (FR-1187R2) reads every APP1 but finds no EXIF header or XMP name there, so the photo
  // posts and the bucket stores and serves the FLIR record with the position in it.
  // Layout from metadata-extractor-images jpg/FLIR iPhone device.jpg (FLIR ONE Pro gen 3); exiftool FLIR GPSLatitude.
  it('LO-1187R4: a FLIR ONE photo with a GPS position in its FLIR record is refused before any SDK call, as on main', async () => {
    const be32 = (n: number) => [n >>> 24 & 0xff, n >>> 16 & 0xff, n >>> 8 & 0xff, n & 0xff];
    const be16 = (n: number) => [n >>> 8 & 0xff, n & 0xff];
    const gps = Buffer.alloc(184);
    gps.writeUInt32LE(1, 0); // GPSValid
    gps.write('N', 8, 'latin1');
    gps.write('W', 10, 'latin1');
    gps.writeDoubleLE(34.07542615928911, 16); // latitude
    gps.writeDoubleLE(118.25426816553305, 24); // longitude
    const raw = Buffer.alloc(300 * 1024); // the raw thermal frame (record type 0x01), zeros here
    const index = (type: number, offset: number, length: number) => [...be16(type), ...be16(1), ...be32(100), ...be32(1), ...be32(offset), ...be32(length), ...new Array(12).fill(0)];
    const rawAt = 64 + 2 * 32;
    const gpsAt = rawAt + raw.length;
    const fff = Buffer.from([
      ...Buffer.from('FFF\0', 'latin1'), ...new Array(16).fill(0), ...be32(100), ...be32(64), ...be32(2), ...new Array(32).fill(0),
      ...index(0x01, rawAt, raw.length), ...index(0x2b, gpsAt, gps.length), ...raw, ...gps,
    ]);
    const chunk = 65524;
    const count = Math.ceil(fff.length / chunk);
    const chunks: number[] = [];
    for (let k = 0; k < count; k += 1) {
      const body = [...Buffer.from('FLIR\0', 'latin1'), 0x01, k, count - 1, ...fff.subarray(k * chunk, (k + 1) * chunk)];
      chunks.push(0xff, 0xe1, ...be16(body.length + 2), ...body);
    }
    expect(chunks.length).toBeGreaterThan(256 * 1024);
    const w = world({ photo: Buffer.from([...validPicture.subarray(0, 20), ...chunks, ...validPicture.subarray(20)]) });
    expect(await codeOf(w.send(''))).toBe('422 community.image.has_location');
    expect(w.checks).toEqual([]);
    expect(w.messages).toEqual([]);
  });
  // LS-1189 B1: the pre-b#1187 reader refused these valid JPEG segment layouts because
  // the pre-SOS metadata exceeds 256 KB. The FLIR-only replacement still posts all
  // three with readable coordinates. ExifTool independently reads GPS from each carrier.
  it.each(['Photoshop 1058 EXIF', 'UTF16 XMP', 'GoPro GPMF GPS5'])(
    'LS-1189 B1: oversized %s location metadata is refused before SDK and publication',
    async (carrier) => {
      const be32 = (n: number): Buffer => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(n);
        return b;
      };
      let payload: Buffer;
      let marker: number;
      if (carrier === 'Photoshop 1058 EXIF') {
        const rawTiff = preciseGps.subarray(10); // remove JPEG marker/length and Exif\0\0
        marker = 0xed;
        payload = Buffer.concat([
          Buffer.from('Photoshop 3.0\0'), Buffer.from('8BIM'), Buffer.from([0x04, 0x22, 0, 0]),
          be32(rawTiff.length), rawTiff, ...(rawTiff.length % 2 ? [Buffer.from([0])] : []),
        ]);
      } else if (carrier === 'UTF16 XMP') {
        marker = 0xe1;
        const xml = '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
          '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
          '<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" ' +
          'exif:GPSLatitude="1,14.07036N" exif:GPSLongitude="2,20.74068E"/>' +
          '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
        payload = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xml, 'utf16le')]);
      } else {
        marker = 0xe6;
        payload = Buffer.concat([
          Buffer.from('GoPro\0SCALl'), Buffer.from([4, 0, 5]),
          ...[10000000, 10000000, 1000, 1000, 100].map(be32),
          Buffer.from('GPS5l'), Buffer.from([20, 0, 1]),
          ...[12345678, 23456789, 100, 0, 0].map(be32),
        ]);
      }
      const filler = Buffer.from(segment(0xe2, Array<number>(65533).fill(0)));
      const location = Buffer.from(segment(marker, [...payload]));
      const upload = Buffer.concat([
        validPicture.subarray(0, 20), filler, filler, filler, filler, location, validPicture.subarray(20),
      ]);
      const w = world({ photo: upload });
      const code = await codeOf(w.send(''));
      if (code === 'ok') {
        // Prove the privacy impact, rather than merely asserting a scanner boolean:
        // the clean moderation wire is not what members get; the original is published.
        expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
        expect(w.objects.get(sentImageKey(w.key))?.includes(payload)).toBe(true);
        expect(wirePhoto(w)).toEqual(validPicture);
      }
      expect(code).toBe('422 community.image.has_location');
      expect(w.checks).toEqual([]);
      expect(w.messages).toEqual([]);
    },
  );
  it('LS-1189 B1 control: an oversized JPEG without location still posts with clean SDK bytes', async () => {
    const filler = Buffer.from(segment(0xe2, Array<number>(65533).fill(0)));
    const upload = Buffer.concat([
      validPicture.subarray(0, 20), filler, filler, filler, filler, validPicture.subarray(20),
    ]);
    const w = world({ photo: upload });
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(wirePhoto(w)).toEqual(validPicture);
    expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
  });
  it.each(independentBlocks)('LS-1187R2 matrix: %s before the frame is absent from the wire only', async (_label, block) => {
    const upload = Buffer.from([...validPicture.subarray(0, 20), ...block, ...validPicture.subarray(20)]);
    const w = world({ photo: upload });
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(wirePhoto(w)).toEqual(validPicture);
    expect(w.objects.get(w.key)).toEqual(upload);
    expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
  });
  // FR-1187R2: ExtendedXMP between the scans is refused like ExtendedXMP before them (LS-1187R2 B2: every APP1 is read);
  // see the ExtendedXMP placement test below.
  it.each(independentBlocks)('LS-1187R2 matrix: %s between real progressive scans is absent from the wire only', async (_label, block) => {
    const firstScan = progressivePicture.indexOf(Buffer.from([0xff, 0xda]));
    const nextTable = progressivePicture.indexOf(Buffer.from([0xff, 0xc4]), firstScan + 2);
    expect(firstScan).toBeGreaterThan(0);
    expect(nextTable).toBeGreaterThan(firstScan);
    const upload = Buffer.from([...progressivePicture.subarray(0, nextTable), ...block, ...progressivePicture.subarray(nextTable)]);
    const w = world({ photo: upload });
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(wirePhoto(w)).toEqual(progressivePicture);
    expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
  });
  it('LS-1187R2 matrix: a two-picture MPF index and second JPEG are both absent from the SDK copy', async () => {
    const makeIndex = (primarySize: number) => segment(0xe2, [
      ...Buffer.from('MPF\0II', 'latin1'), ...u16le(42), ...u32le(8), ...u16le(2),
      ...u16le(0xb001), ...u16le(4), ...u32le(1), ...u32le(2),
      ...u16le(0xb002), ...u16le(7), ...u32le(32), ...u32le(38),
      ...u32le(0),
      ...u32le(0x20000000), ...u32le(primarySize), ...u32le(0), ...u16le(0), ...u16le(0),
      ...u32le(0), ...u32le(namedThumbnail.length), ...u32le(primarySize - 28), ...u16le(0), ...u16le(0),
    ]);
    const index = makeIndex(validPicture.length + makeIndex(0).length);
    const upload = Buffer.from([
      ...validPicture.subarray(0, 20), ...index, ...validPicture.subarray(20), ...namedThumbnail,
    ]);
    const w = world({ photo: upload });
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(wirePhoto(w)).toEqual(validPicture);
    expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
  });
  it.each([
    ['second MPF JPEG and creator', [...namedThumbnail]],
    ['unframed trailing creator', [...Buffer.from(creator, 'latin1')]],
  ])('LS-1187R2 matrix: %s after primary EOI is not sent', async (_label, trailing) => {
    const upload = Buffer.from([...validPicture, ...trailing]);
    const w = world({ photo: upload });
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(wirePhoto(w)).toEqual(validPicture);
    expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
  });
  it('FR-1187R2: ExtendedXMP between real progressive scans is refused before any SDK call, as it is before them', async () => {
    const firstScan = progressivePicture.indexOf(Buffer.from([0xff, 0xda]));
    const nextTable = progressivePicture.indexOf(Buffer.from([0xff, 0xc4]), firstScan + 2);
    const block = extendedXmpApp1(EXTENDED_GUID, creator.length, 0, creator);
    const w = world({ photo: Buffer.from([...progressivePicture.subarray(0, nextTable), ...block, ...progressivePicture.subarray(nextTable)]) });
    expect(await codeOf(w.send(''))).toBe('422 community.image.has_location');
    expect(w.checks).toEqual([]);
    expect(w.messages).toEqual([]);
    expect(w.objects.has(w.key)).toBe(false);
  });
  // FR-1187R2: ordinary photos from a real encoder, no location (real-photos.ts): still accepted, and OpenAI gets the same
  // picture (each `sent` decodes to the photo's pixels, Pillow); the stored copy is the upload.
  it.each(REAL_PHOTOS)('FR-1187R2: a real %s photo is accepted and sent as the same picture', async (_label, { photo, sent }) => {
    const upload = Buffer.from(photo, 'base64');
    const w = world({ photo: upload });
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(wirePhoto(w)).toEqual(Buffer.from(sent, 'base64'));
    expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
  });
  it('LS-1187R2 matrix: pre-scan ExtendedXMP remains refused before any SDK call', async () => {
    const block = extendedXmpApp1(EXTENDED_GUID, creator.length, 0, creator);
    const w = world({ photo: Buffer.from([...validPicture.subarray(0, 20), ...block, ...validPicture.subarray(20)]) });
    expect(await codeOf(w.send(''))).toBe('422 community.image.has_location');
    expect(w.checks).toEqual([]);
    expect(w.messages).toEqual([]);
    expect(w.objects.has(w.key)).toBe(false);
  });
  it.each(Object.entries(LOCATED))('LS-1187R2 matrix: %s location remains refused before any SDK call', async (_label, bytes) => {
    const w = world({ photo: Buffer.from(bytes) });
    expect(await codeOf(w.send(''))).toBe('422 community.image.has_location');
    expect(w.checks).toEqual([]);
    expect(w.messages).toEqual([]);
  });
  it.each<[string, number[]]>([
    ['APP1 length past object end', [...SOI, ...JFIF, ...SCAN.slice(0, -2), 0xff, 0xe1, 0x7f, 0xff, 0]],
    ['partial table length after scan', [...SOI, ...JFIF, ...SCAN.slice(0, -2), 0xff, 0xdb, 0]],
    ['zero APP1 length', [...SOI, ...JFIF, ...SCAN.slice(0, -2), 0xff, 0xe1, 0, 0]],
  ])('LS-1187R2 matrix: %s returns 503 and sends no image', async (_label, bytes) => {
    const w = world({ photo: Buffer.from(bytes) });
    expect(await codeOf(w.send(''))).toBe('503 PHOTO_CHECK_UNAVAILABLE');
    expect(w.checks).toEqual([]);
    expect(w.messages).toEqual([]);
  });
  it('LS-1187R2 characterises orientation: source remains oriented but SDK copy has no EXIF and unchanged frame', async () => {
    const exif = exifApp1(tiff('MM'));
    // tiff fixture's final inline SHORT is the orientation value.
    exif[exif.length - 8] = 0;
    exif[exif.length - 7] = 6;
    const upload = Buffer.from([...validPicture.subarray(0, 20), ...exif, ...validPicture.subarray(20)]);
    const w = world({ photo: upload });
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(wirePhoto(w)).toEqual(validPicture);
    expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
  });
  it('LS-1187R2 characterises scan EOF: missing EOI is repaired and forwarded, not refused', async () => {
    const w = world({ photo: validPicture.subarray(0, -2) });
    expect(await codeOf(w.send(''))).toBe('ok');
    expect(wirePhoto(w)).toEqual(validPicture);
  });

  // FR-1187 (operator ruling on LS-1187 B1): what reaches OpenAI is the photo with no metadata, for every
  // kind of block a JPEG can carry; the stored and sent copies are the upload, unchanged.
  const ADOBE = segment(0xee, [...Buffer.from('Adobe', 'latin1'), 0, 100, 0, 0, 0, 0, 1]);
  const nameIn = (marker: number, prefix: string) => segment(marker, [...Buffer.from(`${prefix}${creator}\0`, 'latin1')]);
  it.each<[string, number[]]>([
    ['EXIF Artist (APP1)', artist],
    ['XMP creator (APP1)', xmpCreator],
    ['an ICC profile (APP2)', nameIn(0xe2, 'ICC_PROFILE\0\x01\x01desc')],
    ['IPTC By-line (APP13)', nameIn(0xed, 'Photoshop 3.0\x008BIM\x04\x04')],
    ['APP15', nameIn(0xef, '')],
    ['a comment (COM)', nameIn(0xfe, '')],
  ])('FR-1187: a photo with %s reaches OpenAI as the bare JPEG; the stored copy is the upload', async (_label, meta) => {
    const upload = Buffer.from(jpeg(JFIF, ADOBE, meta));
    const w = world({ photo: upload });
    expect(await codeOf(w.send())).toBe('ok');
    const photoInput = w.checks.find((c) => c.part === 'image')?.body.input[0] as { image_url: { url: string } };
    expect(photoInput.image_url.url).toBe(`data:image/jpeg;base64,${Buffer.from(jpeg(JFIF, ADOBE)).toString('base64')}`);
    expect(w.objects.get(sentImageKey(w.key))).toEqual(upload);
  });

  it('FR-1187: an extra image after EOI (MPF) with its own EXIF never reaches OpenAI', async () => {
    const w = world({ photo: Buffer.from([...jpeg(JFIF), ...SOI, ...artist, ...SCAN]) });
    expect(await codeOf(w.send())).toBe('ok');
    const photoInput = w.checks.find((c) => c.part === 'image')?.body.input[0] as { image_url: { url: string } };
    expect(photoInput.image_url.url).toBe(`data:image/jpeg;base64,${PHOTO.toString('base64')}`);
  });

  it('FR-1187: a JPEG whose segments cannot be walked after the scan is 503, with no photo sent to OpenAI', async () => {
    const w = world({ photo: Buffer.from([...SOI, ...JFIF, ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0xff, 0xd8, 0x34, 0xff, 0xd9]) });
    expect(await codeOf(w.send())).toBe('503 PHOTO_CHECK_UNAVAILABLE');
    expect(w.checks.filter((c) => c.part === 'image')).toEqual([]);
    expect(w.rows).toEqual([]);
  });

  // The check accepts JPEG only: every other photo format is refused by the upload check, before any call to OpenAI,
  // even when the stored content type says image/jpeg (the fake store always does).
  it.each<[string, number[]]>([
    ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...Buffer.from('IHDR', 'latin1')]],
    ['HEIC', [0, 0, 0, 0x18, ...Buffer.from('ftypheic', 'latin1'), 0, 0, 0, 0]],
    ['WebP', [...Buffer.from('RIFF', 'latin1'), 0x24, 0, 0, 0, ...Buffer.from('WEBPVP8 ', 'latin1')]],
    ['GIF', [...Buffer.from('GIF89a', 'latin1'), 1, 0, 1, 0, 0, 0, 0]],
    ['TIFF', [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]],
    ['AVIF', [0, 0, 0, 0x1c, ...Buffer.from('ftypavif', 'latin1'), 0, 0, 0, 0]],
  ])('FR-1187: a %s file is refused before any call to OpenAI', async (_label, bytes) => {
    const w = world({ photo: Buffer.from([...bytes, ...Buffer.from(creator, 'latin1')]) });
    expect(await codeOf(w.send())).toBe('422 community.image.not_jpeg');
    expect(w.checks).toEqual([]);
    expect(w.rows).toEqual([]);
  });

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

  const unavailable: Array<[string, { reply?: Reply; shortBody?: boolean; key?: string }]> = [
    ['no key is set', { key: '' }],
    ['the key is still the ghost value', { key: PHOTO_CHECK_KEY_GHOST }],
    ['the check times out', { reply: () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')) }],
    ['OpenAI answers 429', { reply: () => new Response('{}', { status: 429 }) }],
    ['OpenAI answers 500', { reply: () => new Response('{}', { status: 500 }) }],
    ['the network fails', { reply: () => Promise.reject(new TypeError('fetch failed')) }],
    ['the answer has no results', { reply: () => respond([]) }],
    ['the answer is missing a score', { reply: (part) => respond([{ ...result(part), category_scores: {} }]) }],
    ['only the caption check fails', { reply: (part) => (part === 'text' ? new Response('{}', { status: 500 }) : scoring()(part)) }],
    ['the download is not the whole checked upload', { shortBody: true }],
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

  it('outside a public space: no coach, no alert, and the refusal stands; the same for a coach or a failed alert write', async () => {
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

// FR-1152R3 B1 (LS-1152R3; owner rule D, 10-26): "ALL alerts and information go to the space
// owner and their team, plus your resident coach (or just the space owner if coachless)".
describe('B1 (rule D): in a public space the owner and the team get the alert too', () => {
  const OWNER = 'dddddddd-0000-4000-8000-000000000001';
  const TEAM = 'dddddddd-0000-4000-8000-000000000002';
  const OTHER = 'dddddddd-0000-4000-8000-000000000003'; // another coach; not in the space
  const member = (user_id: string, role: string, userRole = 'coach', status = 'active') =>
    ({ cohort_id: SPACE, user_id, role, status, user: { role: userRole } });
  const PUBLIC: SpaceOpts = { visibility: 'public', owner: OWNER, team: [member(TEAM, 'assistant')] };
  // Wording row SPACE-PUSH (owner rule 137-2).
  const SPACE_PUSH = 'Urgent safety alert in one of your spaces. Open TGP to see details.';
  const spaceCopy = (coachId: string) =>
    ({ coachId, clientId: ME, alertType: 'community_photo_safety', severity: 'critical', message: SPACE_PUSH, payload: { space_id: SPACE } });
  const resident = (coachId: string) =>
    ({ coachId, clientId: ME, alertType: 'community_photo_safety', severity: 'critical', message: URGENT_PUSH });
  const SELF_HARM = scoring({ 'self-harm/intent': 0.9 });
  const poster = (coach_id: string | null) => stub<User>({ id: ME, role: 'student', coach_id });
  const byCoach = (xs: Array<Record<string, unknown>>) => [...xs].sort((a, b) => String(a.coachId).localeCompare(String(b.coachId)));
  const written = (calls: Array<[Record<string, unknown>]>) => byCoach(calls.map(([input]) => input));

  it.each<[string, string | null, Array<Record<string, unknown>>]>([
    ['a coachless poster: the owner and the team', null, [spaceCopy(OWNER), spaceCopy(TEAM)]],
    ["another coach's client: that coach, the owner and the team", OTHER, [resident(OTHER), spaceCopy(OWNER), spaceCopy(TEAM)]],
    ["the owner's own client: one copy for the owner, a space copy", OWNER, [spaceCopy(OWNER), spaceCopy(TEAM)]],
    ["the team member's own client: one copy for them, a space copy", TEAM, [spaceCopy(OWNER), spaceCopy(TEAM)]],
  ])('%s', async (_who, coachId, want) => {
    const w = world({ reply: SELF_HARM, space: PUBLIC });
    expect(await codeOf(w.send(CAPTION, poster(coachId)))).toBe('422 PHOTO_NOT_ALLOWED');
    expect(written(w.createAlert.mock.calls)).toEqual(byCoach(want));
  });

  it('a caption edit refused for self-harm alerts them too', async () => {
    const w = world({ space: PUBLIC });
    const id = (await w.send(CAPTION, poster(null))).message.id;
    w.setReply(scoring({}, { 'self-harm/intent': 0.95 }));
    expect(await codeOf(w.edit(id, 'new caption', poster(null)))).toBe('422 CAPTION_NOT_ALLOWED');
    expect(written(w.createAlert.mock.calls)).toEqual(byCoach([spaceCopy(OWNER), spaceCopy(TEAM)]));
  });

  it('not to anyone in a block with the poster either way, a removed member, or a member who is a client', async () => {
    const [BLOCKED, BLOCKER, GONE, CLIENT] = ['4', '5', '6', '7'].map((n) => `dddddddd-0000-4000-8000-00000000000${n}`);
    const team = [member(TEAM, 'assistant'), member(BLOCKED, 'coach'), member(BLOCKER, 'assistant'), member(GONE, 'coach', 'coach', 'removed'), member(CLIENT, 'assistant', 'student')];
    const w = world({ reply: SELF_HARM, space: { ...PUBLIC, team }, blocks: [[ME, BLOCKED], [BLOCKER, ME]] });
    expect(await codeOf(w.send(CAPTION, poster(null)))).toBe('422 PHOTO_NOT_ALLOWED');
    expect(written(w.createAlert.mock.calls)).toEqual(byCoach([spaceCopy(OWNER), spaceCopy(TEAM)]));
    const ownerBlocked = world({ reply: SELF_HARM, space: PUBLIC, blocks: [[OWNER, ME]] });
    expect(await codeOf(ownerBlocked.send(CAPTION, poster(COACH)))).toBe('422 PHOTO_NOT_ALLOWED');
    expect(written(ownerBlocked.createAlert.mock.calls)).toEqual(byCoach([resident(COACH), spaceCopy(TEAM)]));
  });

  it('a space that is not public: the resident copy only, as before', async () => {
    for (const visibility of ['clients', 'package', 'members']) {
      const w = world({ reply: SELF_HARM, space: { ...PUBLIC, visibility } });
      expect(await codeOf(w.send())).toBe('422 PHOTO_NOT_ALLOWED');
      expect(w.createAlert.mock.calls).toEqual([[resident(COACH)]]);
    }
  });

  it('other refusals and a coach poster raise none; one failed copy does not stop the others or the refusal', async () => {
    const other = world({ reply: scoring({ sexual: 0.99, 'violence/graphic': 0.99 }, { hate: 0.99 }), space: PUBLIC });
    expect(await codeOf(other.send(CAPTION, poster(null)))).toBe('422 PHOTO_NOT_ALLOWED');
    const coach = world({ reply: SELF_HARM, space: PUBLIC });
    expect(await codeOf(coach.send(CAPTION, stub<User>({ id: ME, role: 'coach', coach_id: null })))).toBe('422 PHOTO_NOT_ALLOWED');
    expect([...other.createAlert.mock.calls, ...coach.createAlert.mock.calls]).toEqual([]);
    const createAlert = jest.fn(async (input: Record<string, unknown>) => {
      if (input.coachId === OWNER) throw new Error('db down');
      return { id: 'alert-2' };
    });
    const failing = world({ reply: SELF_HARM, space: PUBLIC, alerts: stub<CoachAlertsService>({ createAlert }) });
    expect(await codeOf(failing.send(CAPTION, poster(null)))).toBe('422 PHOTO_NOT_ALLOWED');
    expect(written(createAlert.mock.calls)).toEqual(byCoach([spaceCopy(OWNER), spaceCopy(TEAM)]));
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
    // After main's space push (slot 7), so main's positional constructions keep their slots.
    expect(params[8]).toBe(AiEgressService);
    expect(params[9]).toBe(ModuleRef);
    expect(Reflect.getMetadata('__module:global__', AiEgressModule)).toBe(true);
    expect(Reflect.getMetadata('exports', AiEgressModule)).toContain(AiEgressService);
    expect(Reflect.getMetadata('exports', CoachModule)).toContain(CoachAlertsService);
    const app = readFileSync(join(__dirname, '../../../src/app.module.ts'), 'utf8');
    expect(app).toMatch(/^\s+AiEgressModule,$/m);
    expect(app).toMatch(/^\s+CoachModule,$/m);
  });
});
