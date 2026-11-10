/**
 * MEAL-PHOTO-BE (LO-FOOD C7): a client's meal photo, kept with one of their own food entries and seen by
 * their coach now. DB-free: the real LogController, LogService, MealPhotoService, CoachService and
 * ConsentService, and the space chat's real photo store, over a fake Prisma and a fake storage client.
 * Fixtures are made-up JPEG bytes (jpeg-fixtures.ts). Live row rules: test/rls/food-entry-photos-rls.spec.ts.
 */
import { NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { LogController } from '../../src/log/log.controller';
import { LogService } from '../../src/log/log.service';
import { MealPhotoService } from '../../src/log/meal-photo.service';
import { CoachService } from '../../src/coach/coach.service';
import { ConsentService } from '../../src/consent/consent.service';
import {
  CommunityImageStore,
  IMAGE_UPLOAD_TTL_SEC,
  isAttachableMealKey,
  isImageStoreKey,
  isPublishableImageKey,
  mintImageKey,
  mintMealImageKey,
  sentImageKey,
} from '../../src/community/images/community-image-store';
import { attemptVoiceErasures, recordVoiceErasures } from '../../src/community/voice/voice-erasure';
import { ERASURE_MANIFEST } from '../../src/account-deletion/account-deletion.manifest';
import type { PrismaService } from '../../src/prisma.service';
import type { SupabaseService } from '../../src/supabase/supabase.service';
import type { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import type { AuditService } from '../../src/audit/audit.service';
import { JFIF, jpeg, LOCATED } from '../community/images/jpeg-fixtures';

function stub<T>(v: unknown): T {
  return v as T;
}

const A = 'aaaaaaaa-0000-4000-8000-00000000000a'; // client, coach K (moved from F)
const B = 'aaaaaaaa-0000-4000-8000-00000000000b'; // another client of K
const Z = 'aaaaaaaa-0000-4000-8000-00000000000c'; // a coachless client
const K = 'bbbbbbbb-0000-4000-8000-00000000000a'; // A's coach now
const F = 'bbbbbbbb-0000-4000-8000-00000000000f'; // A's former coach
const L = 'bbbbbbbb-0000-4000-8000-00000000000c'; // another coach
const S = 'bbbbbbbb-0000-4000-8000-00000000000d'; // K's sub-coach
const OWNER = 'cccccccc-0000-4000-8000-000000000001';
const SPACE = '11111111-1111-4111-8111-111111111111';
const MB = 1024 * 1024;
const LINK_TOKEN = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url')}.s`;
const JPEG = jpeg(JFIF);
const TODAY = new Date(new Date().toISOString().split('T')[0]);

interface Obj {
  size: number;
  contentType: string;
  head: number[];
}
type Row = Record<string, unknown>;

class Conflict extends Error {
  constructor(public code: string) {
    super(code);
  }
}

function world(opts: { storageDown?: boolean } = {}) {
  const objects = new Map<string, Obj>();
  const removed: string[] = [];
  const fetched: string[] = [];
  const order: string[] = [];
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
      if (opts.storageDown) throw new Error('storage down');
      const o = objects.get(key);
      return o
        ? { data: { size: o.size, contentType: o.contentType }, error: null }
        : { data: null, error: { message: 'Object not found', statusCode: '404' } };
    },
    remove: async (keys: string[]) => {
      for (const k of keys) {
        removed.push(k);
        objects.delete(k);
      }
      return { data: keys.map((name) => ({ name })), error: null };
    },
    list: async (folder: string) => ({
      data: [...objects.keys()].filter((k) => k.startsWith(`${folder}/`)).map((k) => ({ name: k.slice(folder.length + 1) })),
      error: null,
    }),
  });
  const client = { storage: { from, getBucket: async (id: string) => ({ data: { id, name: id }, error: null }) } };
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    fetched.push(String(url));
    const key = decodeURIComponent(String(url).split('/sign/community-images/')[1]?.split('?')[0] ?? '');
    const o = objects.get(key);
    const range = new Headers(init?.headers).get('range') ?? '';
    const last = /^bytes=0-(\d+)$/.exec(range)?.[1];
    const bytes = new Uint8Array(o ? Math.min(o.size, last === undefined ? o.size : Number(last) + 1) : 0);
    bytes.set((o?.head ?? []).slice(0, bytes.length));
    return new Response(bytes);
  });
  const store = new CommunityImageStore(stub<SupabaseService>({ getClient: () => client }));

  const users: Row[] = [
    { id: A, role: 'student', coach_id: K, name: 'A', archived_at: null },
    { id: B, role: 'student', coach_id: K, name: 'B', archived_at: null },
    { id: Z, role: 'student', coach_id: null, name: 'Z', archived_at: null },
    ...[K, F, L, S].map((id) => ({ id, role: 'coach', coach_id: null, name: 'Coach', archived_at: null })),
  ];
  const food = { id: 'food-1', calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5 };
  const entries: Row[] = [A, A, B, Z].map((user_id, i) => ({
    id: `entry-${i + 1}`,
    user_id,
    date: TODAY,
    meal_type: 'lunch',
    food_item_id: food.id,
    food_item: food,
    quantity_multiplier: 1,
    original_quantity: null,
    original_unit: null,
    notes: null,
    logged_at: new Date(Date.UTC(2026, 10, 9, 12, i)),
    client_uuid: null,
    plan_slot_id: null,
    fills_usual_meal: false,
  }));
  let photos: Row[] = [];
  let erasures: Row[] = [];
  const delegation = new Set<string>([A]); // S's open delegation over A
  const matchErasure = (r: Row, where: Row) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === 'object' && 'not' in (v as Row) ? r[k] !== null : r[k] === v,
    );
  const clientMatches = (u: Row, w: Row): boolean => {
    if (Array.isArray(w.AND)) return (w.AND as Row[]).every((x) => clientMatches(u, x));
    return Object.entries(w).every(([k, v]) =>
      v && typeof v === 'object' && 'in' in (v as Row) ? ((v as { in: string[] }).in).includes(String(u[k])) : u[k] === v,
    );
  };
  const prisma: Row = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      // A rolled-back transaction leaves nothing it wrote.
      const [p, e, snapshot] = [photos.map((r) => ({ ...r })), erasures.map((r) => ({ ...r })), [...entries]];
      return fn(prisma).catch((err: unknown) => {
        photos = p;
        erasures = e;
        entries.splice(0, entries.length, ...snapshot);
        throw err;
      });
    },
    $queryRaw: async () => [],
    user: {
      findFirst: async ({ where }: { where: Row }) => users.find((u) => clientMatches(u, where)) ?? null,
      findUnique: async ({ where }: { where: Row }) => users.find((u) => u.id === where.id) ?? null,
    },
    loggedFoodEntry: {
      findUnique: async ({ where }: { where: Row }) => entries.find((e) => e.id === where.id) ?? null,
      findMany: async ({ where }: { where: Row }) => entries.filter((e) => e.user_id === where.user_id),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const e = entries.find((x) => x.id === where.id) as Row;
        Object.assign(e, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
        return e;
      },
      delete: async ({ where }: { where: Row }) => {
        order.push('entry_delete');
        const i = entries.findIndex((e) => e.id === where.id);
        const [gone] = entries.splice(i, 1);
        photos = photos.filter((p) => p.entry_id !== where.id); // ON DELETE CASCADE
        return gone;
      },
    },
    foodEntryPhoto: {
      findUnique: async ({ where }: { where: Row }) =>
        photos.find((p) => (where.entry_id ? p.entry_id === where.entry_id : p.storage_key === where.storage_key)) ?? null,
      findMany: async ({ where }: { where: { entry_id?: { in: string[] }; user_id?: string } }) =>
        photos.filter((p) => (where.entry_id ? where.entry_id.in.includes(String(p.entry_id)) : p.user_id === where.user_id)),
      create: async ({ data }: { data: Row }) => {
        if (!entries.some((e) => e.id === data.entry_id)) throw new Conflict('P2003');
        if (photos.some((p) => p.entry_id === data.entry_id || p.storage_key === data.storage_key)) throw new Conflict('P2002');
        const row = { ...data, created_at: new Date() };
        photos.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = photos.length;
        photos = photos.filter((p) => p.entry_id !== where.entry_id);
        return { count: before - photos.length };
      },
    },
    communityVoiceErasure: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = erasures.filter((r) => matchErasure(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      upsert: async ({ where, create, update }: { where: { kind_target: Row }; create: Row; update: Row }) => {
        order.push('erasure_record');
        let row = erasures.find((r) => r.kind === where.kind_target.kind && r.target === where.kind_target.target);
        if (row) Object.assign(row, update);
        else {
          row = { id: `er-${erasures.length + 1}`, attempts: 0, completed_at: null, ...create };
          erasures.push(row);
        }
        return row;
      },
      findFirst: async ({ where }: { where: Row }) => erasures.find((r) => matchErasure(r, where)) ?? null,
    },
    userProfile: { findUnique: async () => null },
    macroTarget: { findFirst: async () => null },
    workoutSession: { findMany: async () => [] },
    weightLog: { findMany: async () => [] },
    checkIn: { findMany: async () => [] },
    clientWorkoutAssignment: { findMany: async () => [] },
    coachAlert: { findFirst: async () => null },
  };
  const db = stub<PrismaService>(prisma);
  const meal = new MealPhotoService(db, store);
  const logService = new LogService(
    db,
    stub({}),
    stub({ capture: jest.fn() }),
    stub({ emit: jest.fn() }),
    stub({ invalidateForUser: jest.fn() }),
    meal,
  );
  const controller = new LogController(logService, meal);
  // Who coaches whom now: K heads A and B; S is K's sub-coach with an open delegation over A.
  const scope = stub<SubCoachScopeService>({
    isSubCoach: async (id: string) => id === S,
    getAuthorizedClientIds: async (id: string) =>
      id === S ? [...delegation] : users.filter((u) => u.coach_id === id && u.role === 'student').map((u) => String(u.id)),
  });
  const audit = stub<AuditService>({ write: jest.fn(async () => undefined) });
  const consent = new ConsentService(db, audit, scope);
  const coach = new CoachService(db, audit, consent, scope, meal);
  const req = (id: string) => stub<AuthedRequest>({ user: { id, role: 'student' } });
  /** The phone's flow: an upload link, then the bytes at that key. */
  const upload = async (who: string, obj: Partial<Obj> = {}) => {
    const link = await controller.mealPhotoUploadUrl(req(who), { mime: 'image/jpeg', size_bytes: MB });
    objects.set(link.key, { size: JPEG.length, contentType: 'image/jpeg', head: JPEG, ...obj });
    return link.key;
  };
  const attach = (who: string, entry: string, key: string) =>
    controller.attachMealPhoto(req(who), entry, { key, width: 1200, height: 900 });
  const daily = async (who: string) =>
    stub<{ entries: Array<Row & { photo: Row | null }> }>(await logService.getDaily(who, TODAY.toISOString().split('T')[0]));
  const timeline = (who: string, client: string, role = 'coach') => coach.getClientTimeline(who, client, 90, role);
  const summary = (who: string, client: string, role = 'coach') => coach.getClientSummary(who, client, undefined, role);
  return {
    objects, removed, fetched, order, store, meal, controller, logService, coach, delegation,
    upload, attach, daily, timeline, summary,
    photos: () => photos,
    erasures: () => erasures,
    entries,
  };
}

/** Every photo a coach read returns, as [entry id, signed path]. */
async function coachSees(w: ReturnType<typeof world>, who: string, client: string, role = 'coach'): Promise<string[]> {
  const t = stub<{ meals?: Array<Row & { photo?: Row | null }>; events?: Array<{ ref: Row & { photo?: Row | null } }> }>(
    await w.timeline(who, client, role),
  );
  const s = stub<{ today?: { entries: Array<Row & { photo?: Row | null }> } }>(await w.summary(who, client, role));
  const seen = [
    ...(t.meals ?? []).map((m) => ['timeline.meals', m]),
    ...(t.events ?? []).map((e) => ['timeline.events', e.ref]),
    ...(s.today?.entries ?? []).map((m) => ['summary.entries', m]),
  ] as Array<[string, Row & { photo?: Row | null }]>;
  return seen.filter(([, m]) => m.photo).map(([where, m]) => `${where}:${m.id}:${String(m.photo?.url).split('?')[0]}`);
}

beforeEach(() => {
  process.env.VOICE_KEY_SIGNING_SECRET = 'meal-photo-test-secret';
});
afterEach(() => {
  delete process.env.VOICE_KEY_SIGNING_SECRET;
  jest.restoreAllMocks();
});

describe('MEAL-PHOTO-BE: upload, attach and the owner read', () => {
  it('case 1: a link for the caller alone, the bytes, the attach; GET /log/daily shows it, signed on the sent copy only', async () => {
    const w = world();
    const key = await w.upload(A);
    expect(key.startsWith(`${A}/`)).toBe(true);
    expect(isImageStoreKey(key, A)).toBe(true);
    expect(w.erasures()).toEqual([expect.objectContaining({ kind: 'image_upload', target: key, reason: 'upload_expiry' })]);
    const out = await w.attach(A, 'entry-1', key);
    expect(out.photo).toMatchObject({ width: 1200, height: 900 });
    expect(out.photo.url).toBe(`https://s.test/sign/community-images/${sentImageKey(key)}?t=1`);
    const day = await w.daily(A);
    const shown = day.entries.find((e) => e.id === 'entry-1');
    expect(shown?.photo).toMatchObject({ url: `https://s.test/sign/community-images/${sentImageKey(key)}?t=1`, width: 1200, height: 900 });
    expect(String(shown?.photo?.url)).toContain('.sent.jpg');
    expect(day.entries.find((e) => e.id === 'entry-2')?.photo).toBeNull();
    expect(w.photos()).toEqual([expect.objectContaining({ entry_id: 'entry-1', user_id: A, storage_key: sentImageKey(key), size_bytes: JPEG.length })]);
    expect(w.objects.has(sentImageKey(key))).toBe(true);
  });

  it('case 17: a coachless client attaches and reads their own; no coach sees it', async () => {
    const w = world();
    await w.attach(Z, 'entry-4', await w.upload(Z));
    expect((await w.daily(Z)).entries[0].photo).not.toBeNull();
    for (const c of [K, F, L, S]) expect(await coachSees(w, c, Z)).toEqual([]);
  });

  it('case 15 (egress): upload, attach and every read call storage only, never a model or any other host', async () => {
    const w = world();
    await w.attach(A, 'entry-1', await w.upload(A));
    await w.daily(A);
    await coachSees(w, K, A);
    expect(w.fetched.length).toBeGreaterThan(0);
    expect(w.fetched.every((u) => u.startsWith('https://s.test/sign/community-images/'))).toBe(true);
  });
});

describe('MEAL-PHOTO-BE: who sees it', () => {
  it('case 2: the client\'s coach now gets it on the summary\'s entries and on both timeline returns', async () => {
    const w = world();
    const key = await w.upload(A);
    await w.attach(A, 'entry-1', key);
    const sent = `https://s.test/sign/community-images/${sentImageKey(key)}`;
    expect((await coachSees(w, K, A)).sort()).toEqual(
      [`summary.entries:entry-1:${sent}`, `timeline.events:entry-1:${sent}`, `timeline.meals:entry-1:${sent}`].sort(),
    );
  });

  it('case 3: a sub-coach with an open delegation sees it; once the delegation ends, nothing', async () => {
    const w = world();
    await w.attach(A, 'entry-1', await w.upload(A));
    expect(await coachSees(w, S, A)).toHaveLength(3);
    w.delegation.clear();
    expect(await coachSees(w, S, A)).toEqual([]);
  });

  it('case 4: a former coach, another coach and another client see no photo; the owner account sees it, as it sees food', async () => {
    const w = world();
    await w.attach(A, 'entry-1', await w.upload(A));
    expect(await coachSees(w, F, A)).toEqual([]);
    expect(await coachSees(w, L, A)).toEqual([]);
    expect(await w.timeline(F, A)).toEqual({ error: 'Client not found' });
    expect((await w.daily(B)).entries.every((e) => e.photo === null)).toBe(true);
    expect(JSON.stringify(await w.daily(B))).not.toContain(A);
    // consent.service.ts coachCanAccess: the owner account reads every scope (named, not changed).
    expect(await coachSees(w, OWNER, A, 'owner')).toHaveLength(3);
  });

  it('case 5: attaching to another person\'s entry is 404 and stores nothing', async () => {
    const w = world();
    const key = await w.upload(B);
    await expect(w.attach(B, 'entry-1', key)).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.attach(B, 'entry-missing', key)).rejects.toBeInstanceOf(NotFoundException);
    expect(w.photos()).toEqual([]);
    expect(w.objects.has(sentImageKey(key))).toBe(false);
  });
});

describe('MEAL-PHOTO-BE: refused keys and objects', () => {
  const refusal = async (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: { getStatus?: () => number; getResponse?: () => unknown }) =>
        `${e.getStatus?.()} ${String((e.getResponse?.() as { code?: string })?.code ?? '')}`,
    );

  it('case 6: a key minted for another person, a space key, one past the window, one already used: 422, nothing stored', async () => {
    const w = world();
    const other = await w.upload(B);
    const space = mintImageKey(A, SPACE);
    w.objects.set(space, { size: JPEG.length, contentType: 'image/jpeg', head: JPEG });
    const late = mintMealImageKey(A, Date.now() - (IMAGE_UPLOAD_TTL_SEC + 1) * 1000);
    w.objects.set(late, { size: JPEG.length, contentType: 'image/jpeg', head: JPEG });
    for (const key of [other, space, late]) {
      expect(await refusal(w.attach(A, 'entry-1', key))).toBe('422 log.photo.key_invalid');
    }
    expect(w.photos()).toEqual([]);
    const used = await w.upload(A);
    await w.attach(A, 'entry-1', used);
    expect(await refusal(w.attach(A, 'entry-2', used))).toBe('422 log.photo.key_used');
    // A photo deleted keeps its key's erasure row: the key never attaches again.
    await w.controller.deleteMealPhoto(req(A), 'entry-1');
    w.objects.set(used, { size: JPEG.length, contentType: 'image/jpeg', head: JPEG });
    expect(await refusal(w.attach(A, 'entry-2', used))).toBe('422 log.photo.key_used');
    expect(w.photos()).toEqual([]);
  });

  it('case 6: a meal key sent as a space photo is refused as today, in any space', async () => {
    const meal = mintMealImageKey(A);
    const uuid = meal.split('/')[1].slice(0, 36);
    expect(isPublishableImageKey(meal, A, SPACE)).toBe(false);
    expect(isPublishableImageKey(meal, A, uuid)).toBe(false);
    expect(isAttachableMealKey(mintImageKey(A, SPACE), A)).toBe(false);
    expect(isPublishableImageKey(mintImageKey(A, SPACE), A, SPACE)).toBe(true);
    expect(isAttachableMealKey(meal, A)).toBe(true);
  });

  it.each([
    ['missing', null, 'missing'],
    ['not JPEG by type', { contentType: 'image/png' }, 'not_jpeg'],
    ['not JPEG by bytes', { head: [0x89, 0x50, 0x4e, 0x47] }, 'not_jpeg'],
    ['over 10 MB', { size: 10 * MB + 1 }, 'too_large'],
    ['carrying a location', { head: LOCATED['GPS in EXIF, little endian'], size: LOCATED['GPS in EXIF, little endian'].length }, 'has_location'],
  ] as const)('case 7: %s: 422 log.photo.%s and the upload erased now', async (_name, obj, code) => {
    const w = world();
    const key = await w.upload(A, obj ?? {});
    if (obj === null) w.objects.delete(key);
    expect(await refusal(w.attach(A, 'entry-1', key))).toBe(`422 log.photo.${code}`);
    expect(w.objects.has(key)).toBe(false);
    expect(w.removed).toContain(key);
    expect(w.photos()).toEqual([]);
    expect(w.objects.has(sentImageKey(key))).toBe(false);
  });

  it('case 7: storage down: 503, nothing stored', async () => {
    const w = world({ storageDown: true });
    const key = await w.upload(A);
    expect(await refusal(w.attach(A, 'entry-1', key))).toBe('503 log.photo.storage_unavailable');
    expect(w.photos()).toEqual([]);
    expect(w.objects.has(sentImageKey(key))).toBe(false);
  });

  it('no signing secret: the link is 503, never an unsigned key', async () => {
    const w = world();
    delete process.env.VOICE_KEY_SIGNING_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(await refusal(w.controller.mealPhotoUploadUrl(req(A), { mime: 'image/jpeg', size_bytes: MB }))).toBe(
      '503 log.photo.storage_unavailable',
    );
  });
});

const req = (id: string) => stub<AuthedRequest>({ user: { id, role: 'student' } });

describe('MEAL-PHOTO-BE: resend, replace and lifetime', () => {
  it('case 8: the same attach again after a lost answer: the stored photo, one row, one copy', async () => {
    const w = world();
    const key = await w.upload(A);
    const first = await w.attach(A, 'entry-1', key);
    const again = await w.attach(A, 'entry-1', key);
    expect(again.photo.url).toBe(first.photo.url);
    expect(w.photos()).toHaveLength(1);
    expect([...w.objects.keys()].filter((k) => k.endsWith('.sent.jpg'))).toEqual([sentImageKey(key)]);
  });

  it('case 9: replace is DELETE then PUT; a second photo is 409 and no object is left without a row or an open erasure row', async () => {
    const w = world();
    const old = await w.upload(A);
    await w.attach(A, 'entry-1', old);
    const next = await w.upload(A);
    await expect(w.attach(A, 'entry-1', next)).rejects.toMatchObject({ status: 409 });
    expect(w.photos().map((p) => p.storage_key)).toEqual([sentImageKey(old)]);
    const open = (k: string) => w.erasures().some((r) => r.target === k && r.completed_at === null);
    const live = (k: string) => w.photos().some((p) => p.storage_key === sentImageKey(k.replace(/\.sent\.jpg$/, '.jpg')));
    for (const k of w.objects.keys()) expect(live(k) || open(k)).toBe(true);
    await w.controller.deleteMealPhoto(req(A), 'entry-1');
    const out = await w.attach(A, 'entry-1', next);
    expect(out.photo.url).toContain(sentImageKey(next));
    for (const k of w.objects.keys()) expect(live(k) || open(k)).toBe(true);
  });

  it('case 10: DELETE /log/food/:id records the erasure in the delete\'s transaction, before the row goes; no read shows it after', async () => {
    const w = world();
    const key = await w.upload(A);
    await w.attach(A, 'entry-1', key);
    w.order.length = 0;
    await w.controller.deleteEntry(req(A), 'entry-1');
    expect(w.order).toEqual(['erasure_record', 'erasure_record', 'entry_delete']);
    expect(w.erasures().filter((r) => r.kind === 'image_object').map((r) => [r.target, r.reason, r.completed_at !== null])).toEqual([
      [sentImageKey(key), 'author_delete', true],
      [key, 'author_delete', true],
    ]);
    expect(w.objects.has(sentImageKey(key))).toBe(false);
    expect(w.objects.has(key)).toBe(false);
    expect(w.photos()).toEqual([]);
    expect(await coachSees(w, K, A)).toEqual([]);
    expect((await w.daily(A)).entries.some((e) => e.photo)).toBe(false);
  });

  it('case 10: an entry delete that fails rolls the erasure record back with it; one whose erasure fails leaves the rows open for the cron', async () => {
    const w = world();
    const key = await w.upload(A);
    await w.attach(A, 'entry-1', key);
    const before = w.erasures().length;
    const del = jest.spyOn(stub<{ loggedFoodEntry: { delete: () => Promise<unknown> } }>(Reflect.get(w.logService, 'prisma')).loggedFoodEntry, 'delete');
    del.mockRejectedValueOnce(new Error('db down'));
    await expect(w.controller.deleteEntry(req(A), 'entry-1')).rejects.toThrow('db down');
    expect(w.erasures()).toHaveLength(before);
    expect(w.photos()).toHaveLength(1);
    del.mockRestore();
    jest.spyOn(w.store, 'removeObjects').mockResolvedValue({ removed: 0, failed: true });
    jest.spyOn(w.store, 'objectGone').mockResolvedValue(false);
    await w.controller.deleteEntry(req(A), 'entry-1');
    expect(w.erasures().filter((r) => r.kind === 'image_object' && r.completed_at === null).map((r) => r.target).sort()).toEqual(
      [key, sentImageKey(key)].sort(),
    );
  });

  it('case 11: DELETE the photo only: erasure rows written, objects gone, the entry stays', async () => {
    const w = world();
    const key = await w.upload(A);
    await w.attach(A, 'entry-1', key);
    expect(await w.controller.deleteMealPhoto(req(A), 'entry-1')).toEqual({ entry_id: 'entry-1', photo: null });
    expect(w.erasures().filter((r) => r.kind === 'image_object').map((r) => r.target)).toEqual([sentImageKey(key), key]);
    expect(w.objects.has(sentImageKey(key))).toBe(false);
    expect(w.entries.some((e) => e.id === 'entry-1')).toBe(true);
    expect((await w.daily(A)).entries.find((e) => e.id === 'entry-1')?.photo).toBeNull();
    await expect(w.controller.deleteMealPhoto(req(B), 'entry-2')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('case 12: PUT /log/food/:id leaves the photo as it was', async () => {
    const w = world();
    const key = await w.upload(A);
    await w.attach(A, 'entry-1', key);
    const before = JSON.stringify(w.photos());
    await w.controller.updateEntry(req(A), 'entry-1', { quantity_multiplier: 2, meal_type: 'dinner' });
    expect(JSON.stringify(w.photos())).toBe(before);
    expect((await w.daily(A)).entries.find((e) => e.id === 'entry-1')?.photo?.url).toContain(sentImageKey(key));
  });

  it('case 13: account deletion: the rows go by the manifest, and the image_folder erasure removes every meal object', async () => {
    const w = world();
    const k1 = await w.upload(A);
    await w.attach(A, 'entry-1', k1);
    const k2 = await w.upload(A); // never attached
    const steps = ERASURE_MANIFEST.map((s) => `${s.model}.${s.field}`);
    expect(steps.indexOf('FoodEntryPhoto.user_id')).toBeGreaterThan(-1);
    expect(steps.indexOf('FoodEntryPhoto.user_id')).toBeLessThan(steps.indexOf('LoggedFoodEntry.user_id'));
    const mine = [...w.objects.keys()];
    expect(mine.sort()).toEqual([k1, sentImageKey(k1), k2].sort());
    expect(mine.every((k) => k.startsWith(`${A}/`))).toBe(true);
    const db = stub<PrismaService>({ communityVoiceErasure: Reflect.get(Reflect.get(w.meal, 'prisma'), 'communityVoiceErasure') });
    const rows = await recordVoiceErasures(db, [{ kind: 'image_folder', target: A }], 'account_deletion');
    expect(await attemptVoiceErasures(db, { images: w.store }, rows)).toEqual({ completed: 1, pending: 0 });
    expect([...w.objects.keys()]).toEqual([]);
  });
});

describe('MEAL-PHOTO-BE: no AI or Roman reader reaches the photo (case 15, class)', () => {
  // Every AI and Roman reader of LoggedFoodEntry (CLASS-FIRST A); none may include the photo relation,
  // read the photo table, or import the meal photo service.
  const READERS = [
    'src/ai/ai.service.ts',
    'src/ai/client-ai-context.service.ts',
    'src/ai/context/client-context.service.ts',
    'src/ai/coach/coach-ai.service.ts',
    'src/roman/context/roman-client-context.service.ts',
    'src/roman/memory/roman-timeline.reader.ts',
    'src/roman/tools/roman-baselines.ts',
    'src/roman/tools/roman-read-tools.ts',
  ];
  it.each(READERS)('%s never reads the photo', (file) => {
    const src = readFileSync(join(__dirname, '../..', file), 'utf8');
    expect(src).not.toMatch(/foodEntryPhoto|FoodEntryPhoto|food_entry_photos|meal-photo|photo:\s*true|photo:\s*\{/);
  });
});
