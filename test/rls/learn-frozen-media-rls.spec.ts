/**
 * LEARN-FROZEN-MEDIA: a client's kept lesson keeps its video when the coach is deleted, live on
 * the replayed migration chain. Coach K: published course C (week W, lesson X playing video V)
 * that client B is enrolled in, course D that nobody is enrolled in (week DW, lesson DX playing
 * file DV), single lesson G playing file GV that client P completed, and video U on no lesson.
 * K's clients A and P are not enrolled in C. Coach L: video LM; L's client Z once bought K's
 * video V. Grants: B on V and U, A on V and GV, P on V and GV, Z on V and LM. The real deletion
 * pieces run on one transaction, as the finalizer does: AccountDeletionStorageService.collect,
 * the erasure manifest's steps for these tables, and withoutRetainedMedia (the purge list).
 * Lesson reads run as the non-bypass `authenticated` role; media reads go through the real
 * CoachMediaService.getBuyerSignedUrl (GET /v1/client/media/:id/signed-url), the only read path
 * of these server-only tables. Every 0 or refusal follows a read of the same row that returned
 * 1. The tests run in order. Gate: TEST_DATABASE_URL; no URL -> skip, except under CI=true
 * (hard failure).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { CoachMediaService } from '../../src/coach-media/coach-media.service';
import {
  AccountDeletionStorageService,
  type StorageObject,
} from '../../src/account-deletion/account-deletion.storage';
import {
  ERASURE_MANIFEST,
  executeErasureManifest,
} from '../../src/account-deletion/account-deletion.manifest';
import type { SupabaseService } from '../../src/supabase/supabase.service';
import type { MuxService } from '../../src/video/mux.service';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('learn-frozen-media-rls: CI=true but no TEST_DATABASE_URL; not skipping.');
}

function stub<T>(value: unknown): T {
  return value as T;
}

(DB_URL ? describe : describe.skip)('LEARN-FROZEN-MEDIA: kept lessons keep their media', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const run = randomUUID().slice(0, 8);
  const [K, L, A, B, P, Z, C, D, W, DW, X, DX, G, V, DV, GV, U, LM] = [
    'K', 'L', 'A', 'B', 'P', 'Z', 'C', 'D', 'W', 'DW', 'X', 'DX', 'G', 'V', 'DV', 'GV', 'U', 'LM',
  ].map((tag) => `${tag}-${run}`);
  const coaches = new Set([K, L]);
  const set = (...xs: string[]) => xs.sort();
  const pair = (who: string, media: string) => `${who}:${media}`;
  const media = new CoachMediaService(
    stub<ConstructorParameters<typeof CoachMediaService>[0]>(prisma),
    stub<ConstructorParameters<typeof CoachMediaService>[1]>({
      isConfigured: () => true,
      createSignedDownloadUrl: async (key: string) => `signed:${key}`,
    }),
    stub<ConstructorParameters<typeof CoachMediaService>[2]>({
      mintPlaybackUrl: ({ playbackId }: { playbackId: string }) => `mux:${playbackId}`,
    }),
    stub<ConstructorParameters<typeof CoachMediaService>[3]>({}),
    stub<ConstructorParameters<typeof CoachMediaService>[4]>({ get: () => undefined }),
  );
  const storage = new AccountDeletionStorageService(
    stub<ConfigService>({ get: () => undefined }),
    stub<SupabaseService>({
      getClient: () => ({
        storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) },
      }),
    }),
    stub<MuxService>({}),
  );
  /** The URL the signed-url route returns to `who` for `asset`; 'refused' for its single 404. */
  const open = (who: string, asset: string) =>
    media.getBuyerSignedUrl(who, asset).then(
      (r) => r.url,
      (e: unknown) => {
        if (e instanceof NotFoundException) return 'refused';
        throw e;
      },
    );
  const url = { V: `mux:play-${V}`, GV: `signed:coach/${GV}.pdf`, U: `mux:play-${U}`, LM: `mux:play-${LM}` };

  beforeAll(async () => {
    const people = [[K, null], [L, null], [A, K], [B, K], [P, K], [Z, L]] as const;
    for (const [id, coach_id] of people) {
      const role = coaches.has(id) ? 'coach' : 'student';
      await prisma.user.create({ data: { id, supabase_id: id, email: `media-${id}`, name: 'Live person', role, coach_id } });
    }
    const assets = [[V, K, 'video'], [U, K, 'video'], [DV, K, 'pdf'], [GV, K, 'pdf'], [LM, L, 'video']] as const;
    for (const [id, coach_id, kind] of assets) {
      const video = kind === 'video';
      await prisma.coachMediaAsset.create({
        data: {
          id, coach_id, kind, title: 'Media', status: 'ready',
          provider: video ? 'mux' : 'supabase',
          storage_key: video ? `mux-${id}` : `coach/${id}.pdf`,
          mux_playback_id: video ? `play-${id}` : null,
        },
      });
    }
    for (const id of [C, D]) {
      await prisma.course.create({ data: { id, coach_id: K, title: 'Course', status: 'published' } });
    }
    for (const [id, course_id] of [[W, C], [DW, D]] as const) {
      await prisma.courseModule.create({ data: { id, course_id, coach_id: K, position: 0, title: 'Week' } });
    }
    for (const [id, module_id, media_asset_id] of [[X, W, V], [DX, DW, DV], [G, null, GV]] as const) {
      await prisma.lesson.create({
        data: { id, coach_id: K, module_id, media_asset_id, kind: 'video', title: 'Lesson', tags: [], goal_tags: [] },
      });
    }
    await prisma.courseEnrolment.create({
      data: { course_id: C, user_id: B, starts_on: new Date(Date.now() - 86_400_000), source: 'direct' },
    });
    await prisma.lessonCompletion.create({ data: { lesson_id: G, user_id: P } });
    const grants = [[B, V], [B, U], [A, V], [A, GV], [P, V], [P, GV], [Z, V], [Z, LM]] as const;
    await prisma.clientAssetGrant.createMany({
      data: grants.map(([client_id, media_asset_id]) => ({ client_id, media_asset_id })),
    });
  });
  afterAll(() => prisma.$disconnect());

  /** `query` as the signed-in API role (app.current_user_id = who). */
  const as = <T>(who: string, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, coaches.has(who) ? 'coach' : 'student');
      await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who, role: 'authenticated' }));
      return query(tx);
    });
  /** Lesson X as `who` reads it: its id and the media it plays. */
  const lessonX = (who: string) =>
    as(who, (tx) => tx.lesson.findMany({ where: { id: X }, select: { id: true, media_asset_id: true } }));
  /** Media row V read directly as `who`: the row count, or the SQLSTATE of a refused read. */
  const mediaRow = (who: string) =>
    as(who, (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CoachMediaAsset" WHERE "id" = ${V}`).then(
      (rows): number | string => rows.length,
      (e: unknown) => {
        const err = e as { code?: string; meta?: { code?: string }; message?: string };
        return String(err.code === 'P2010' ? err.meta?.code : /\b42501\b/.exec(String(err.message))?.[0] ?? err.message);
      },
    );
  // Server-only table (20261224000000): zero rows (RESTRICTIVE false) or 42501, both a denial.
  const DENIED: Array<number | string> = [0, '42501'];
  /** Every grant left on K's media, as client:media. */
  const grantsOnK = async () =>
    set(...(await prisma.clientAssetGrant.findMany({ where: { media_asset_id: { in: [V, U, DV, GV] } } }))
      .map((g) => pair(g.client_id, g.media_asset_id)));

  it('runs as a role that does not bypass row security', async () => {
    expect(await as(B, (tx) => tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ bypass: false }]);
  });

  it('before the deletion: B reads lesson X and its video; every grant opens its media', async () => {
    expect(await lessonX(B)).toEqual([{ id: X, media_asset_id: V }]);
    for (const who of [A, P, Z, L]) expect(await lessonX(who)).toEqual([]);
    // The media table is server-only: the backend reads the row, no signed-in client does.
    expect(await prisma.coachMediaAsset.count({ where: { id: V } })).toBe(1);
    for (const who of [B, A, Z]) expect(DENIED).toContain(await mediaRow(who));
    for (const who of [B, A, P, Z]) expect(await open(who, V)).toBe(url.V);
    for (const who of [A, P]) expect(await open(who, GV)).toBe(url.GV);
    expect(await open(B, U)).toBe(url.U);
    expect(await open(Z, LM)).toBe(url.LM);
    expect(await open(L, V)).toBe('refused');
    expect(await grantsOnK()).toEqual(set(pair(B, V), pair(B, U), pair(A, V), pair(A, GV), pair(P, V), pair(P, GV), pair(Z, V)));
  });

  it("deleting K keeps the media of kept lessons, row and bytes, and purges the rest", async () => {
    const steps = ERASURE_MANIFEST.filter((e) =>
      ['User', 'LessonCompletion', 'CourseEnrolment', 'Lesson', 'CourseModule', 'Course', 'ClientAssetGrant', 'CoachMediaAsset']
        .includes(e.model));
    const { collected, purge } = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const objects = await storage.collect(tx, K);
      await executeErasureManifest(tx, { userId: K, email: `media-${K}`, tombstoneEmail: `deleted-${K}`, now: new Date() }, steps);
      return { collected: objects, purge: await storage.withoutRetainedMedia(tx, K, objects) };
    }, { timeout: 30_000 });
    const keys = (objects: StorageObject[]) => set(...objects.map((o) => JSON.stringify(o)));
    const mux = (id: string) => JSON.stringify({ kind: 'mux', assetId: `mux-${id}` });
    const pdf = (id: string) => JSON.stringify({ kind: 'supabase', bucket: 'coach-media', key: `coach/${id}.pdf` });
    expect(keys(collected)).toEqual(set(mux(V), mux(U), pdf(DV), pdf(GV)));
    // Bytes of V (lesson X, course C, B enrolled) and GV (lesson G, completed by P) stay.
    expect(keys(purge)).toEqual(set(mux(U), pdf(DV)));
    const ids = (rows: Array<{ id: string }>) => set(...rows.map((r) => r.id));
    expect(ids(await prisma.coachMediaAsset.findMany({ where: { coach_id: K }, select: { id: true } }))).toEqual(set(V, GV));
    expect(await prisma.lesson.findMany({ where: { coach_id: K }, select: { id: true, media_asset_id: true }, orderBy: { id: 'asc' } }))
      .toEqual([{ id: G, media_asset_id: GV }, { id: X, media_asset_id: V }]);
    expect(await grantsOnK()).toEqual(set(pair(B, V), pair(P, GV)));
    expect(await prisma.user.count({ where: { id: { in: [A, B, P] }, coach_id: null } })).toBe(3);
  });

  it('after the deletion: B still reads lesson X and opens its video; nobody without the lesson does', async () => {
    expect(await lessonX(B)).toEqual([{ id: X, media_asset_id: V }]);
    for (const who of [A, P, Z, L]) expect(await lessonX(who)).toEqual([]);
    expect(await prisma.coachMediaAsset.count({ where: { id: V } })).toBe(1);
    for (const who of [B, A, Z]) expect(DENIED).toContain(await mediaRow(who));
    expect(await open(B, V)).toBe(url.V);
    for (const who of [A, P, Z, L]) expect(await open(who, V)).toBe('refused');
    expect(await open(P, GV)).toBe(url.GV);
    expect(await open(A, GV)).toBe('refused');
    // U had no lesson: its row is gone, so B's grant on it is too.
    expect(await open(B, U)).toBe('refused');
    // Another coach's media is untouched.
    expect(await open(Z, LM)).toBe(url.LM);
  });
});
