/**
 * SC-BE3 live RLS: community_message_images and the community-images objects,
 * across two workspaces, as a role that does not bypass row security. Every 0
 * follows a control read of 1 by the same caller on a row it may see.
 * Migration 20270502009200_community_message_images (FR-1139: rows are the
 * server's to write; a moved client's photos leave with them).
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('community-message-images-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}
const MIGRATION = readFileSync(
  join(__dirname, '../../prisma/migrations/20270502009200_community_message_images/migration.sql'),
  'utf8',
);
const BUCKET_BLOCK = /DO \$community_images_bucket\$[\s\S]*?\$community_images_bucket\$;/.exec(MIGRATION)?.[0] ?? '';
const MARK = 'sc-be3 storage fixture';
const STORAGE_FIXTURE = [
  `DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
     CREATE ROLE supabase_storage_admin NOLOGIN NOINHERIT; END IF; END $r$`,
  `CREATE SCHEMA storage`,
  `COMMENT ON SCHEMA storage IS '${MARK}'`,
  `CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
     file_size_limit bigint, allowed_mime_types text[])`,
  `CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets (id),
     name text, owner uuid)`,
  `ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY`,
  `GRANT USAGE ON SCHEMA storage TO anon, authenticated`,
  `GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated`,
  `ALTER TABLE storage.objects OWNER TO supabase_storage_admin`,
  `INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true)`,
  `CREATE POLICY tgp_probe_all ON storage.objects FOR ALL USING (true) WITH CHECK (true)`,
];

type Key = 'A' | 'B' | 'O' | 'N' | 'X';
const PEOPLE: Key[] = ['A', 'B', 'O', 'N', 'X'];
const COACH: Record<Key, 'A' | 'B' | null> = { A: null, B: null, O: 'A', N: 'A', X: 'B' };
const ROLE = (k: Key) => (k === 'A' || k === 'B' ? 'coach' : 'student');

(DB_URL ? describe : describe.skip)('SC-BE3: photo rows and photo objects stay in their space', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const fresh = <K extends string>(list: readonly K[]) => Object.fromEntries(list.map((k) => [k, randomUUID()])) as Record<K, string>;
  const id = fresh(PEOPLE);
  const sub = fresh(PEOPLE);
  const ws = fresh(['A', 'B'] as const);
  const space = fresh(['A', 'B'] as const);
  const photo = fresh(['A', 'B'] as const);
  const spare = fresh(['mine', 'text', 'coach'] as const); // space A: O's photo message with no row, O's text, the coach's text
  const run = randomUUID().slice(0, 8);
  const as = <T>(k: Key | 'anon', query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${k === 'anon' ? 'anon' : 'authenticated'}`);
      if (k !== 'anon') {
        await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: sub[k], role: 'authenticated' }));
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[k]);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE(k));
      }
      return query(tx);
    });
  const count = (k: Key | 'anon', sql: string, ...params: unknown[]) =>
    as(k, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(sql, ...params)).then((r) => r[0].n);
  const rows = (k: Key, m: string) => count(k, `SELECT count(*)::int AS "n" FROM "community_message_images" WHERE "message_id" = $1::uuid`, m);
  const insert = (k: Key, s: 'A' | 'B', author: Key, message: string = randomUUID()) =>
    as(k, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO "community_message_images" ("message_id", "cohort_id", "author_id", "storage_key", "width", "height", "size_bytes", "mime")
         VALUES ($1::uuid, $2::uuid, $3, $4, 4, 3, 100, 'image/jpeg')`,
        message, space[s], id[author], `${id[author]}/${randomUUID()}.jpg`,
      ),
    ).catch((e: { code?: string; meta?: { code?: string } }) => String(e.code === 'P2010' ? e.meta?.code : e.code));
  const objects = (k: Key | 'anon', bucket: string) =>
    count(k, `SELECT count(*)::int AS "n" FROM storage.objects WHERE bucket_id = $1 AND name = $2`, bucket, bucket === 'avatars' ? 'a.png' : `${id.O}/p.jpg`);
  const putObject = (k: Key, bucket: string) =>
    as(k, (tx) => tx.$executeRawUnsafe(`INSERT INTO storage.objects (bucket_id, name) VALUES ($1, $2)`, bucket, `${id[k]}/${randomUUID()}.jpg`))
      .catch((e: { code?: string; meta?: { code?: string } }) => String(e.code === 'P2010' ? e.meta?.code : e.code));
  const storageSchema = async () => {
    const r = await prisma.$queryRawUnsafe<{ c: string | null }[]>(`SELECT obj_description(oid, 'pg_namespace') AS "c" FROM pg_namespace WHERE nspname = 'storage'`);
    return r.length === 0 ? 'absent' : r[0].c === MARK ? 'fixture' : 'foreign';
  };

  beforeAll(async () => {
    for (const k of PEOPLE) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`images-${id[k]}`}, 'RLS user', ${ROLE(k)}::"Role", ${COACH[k] ? id[COACH[k] as 'A' | 'B'] : null})`;
    }
    for (const [c, member] of [['A', 'O'], ['B', 'X']] as const) {
      await prisma.$executeRaw`INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at")
        VALUES (${ws[c]}::uuid, ${id[c]}, 'RLS workspace', ${`images-${run}-${c}`}, now())`;
      await prisma.$executeRawUnsafe(`INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, 'RLS photos', 'members'::"CommunitySpaceVisibility", 'active', now())`, space[c], ws[c]);
      await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, randomUUID(), ws[c], space[c], id[member]);
      const m = await prisma.communityMessage.create({
        data: { workspace_id: ws[c], cohort_id: space[c], scope: 'cohort', kind: 'image', sender_id: id[member], body: '' },
      });
      photo[c] = m.id;
      await prisma.communityMessageImage.create({
        data: { message_id: m.id, cohort_id: space[c], author_id: id[member], storage_key: `${id[member]}/${m.id}.jpg`, width: 4, height: 3, size_bytes: 100, mime: 'image/jpeg' },
      });
    }
    for (const [k, sender, kind] of [['mine', 'O', 'image'], ['text', 'O', 'text'], ['coach', 'A', 'text']] as const) {
      spare[k] = (await prisma.communityMessage.create({ data: { workspace_id: ws.A, cohort_id: space.A, scope: 'cohort', kind, sender_id: id[sender], body: 'x' } })).id;
    }
  });
  afterAll(async () => {
    try {
      if ((await storageSchema()) === 'fixture') await prisma.$executeRawUnsafe('DROP SCHEMA storage CASCADE');
    } finally {
      await prisma.$disconnect();
    }
  });

  it('runs as a role that does not bypass row security, on a table that forces it', async () => {
    expect(await as('O', (tx) => tx.$queryRaw<{ b: boolean }[]>`SELECT "rolbypassrls" AS "b" FROM pg_roles WHERE "rolname" = current_user`)).toEqual([{ b: false }]);
    expect(await prisma.$queryRaw`SELECT "relrowsecurity" AS "on", "relforcerowsecurity" AS "forced" FROM pg_class
      WHERE "oid" = 'public.community_message_images'::regclass`).toEqual([{ on: true, forced: true }]);
  });

  it('a photo row is read only inside its space', async () => {
    expect(await rows('O', photo.A)).toBe(1);
    expect(await rows('A', photo.A)).toBe(1);
    expect(await rows('N', photo.A)).toBe(0); // the coach's client outside the space
    expect(await rows('X', photo.B)).toBe(1);
    expect(await rows('X', photo.A)).toBe(0); // another workspace
    expect(await rows('B', photo.B)).toBe(1);
    expect(await rows('B', photo.A)).toBe(0);
    expect(await count('anon', `SELECT count(*)::int AS "n" FROM "community_message_images"`).catch((e: { meta?: { code?: string } }) => e.meta?.code)).toBe('42501');
  });

  it('FX-1139 B2: no member writes a photo row; the server writes it with its own photo message', async () => {
    expect(await insert('O', 'A', 'O', spare.mine)).toBe('42501'); // even O's own photo message
    expect(await insert('O', 'A', 'O', spare.coach)).toBe('42501'); // another member's message
    expect(await insert('O', 'A', 'O', spare.text)).toBe('42501'); // a text message
    expect(await insert('O', 'B', 'O', spare.mine)).toBe('42501'); // another space
    expect(await insert('O', 'A', 'O')).toBe('42501'); // an id that does not exist
    expect(await insert('O', 'A', 'N')).toBe('42501'); // someone else as author
    expect(await insert('X', 'B', 'X')).toBe('42501');
    expect(await insert('X', 'A', 'X')).toBe('42501'); // another workspace
    expect(await insert('N', 'A', 'N')).toBe('42501'); // not in the space
    expect(await rows('O', spare.mine)).toBe(0);
    await prisma.communityMessageImage.create({
      data: { message_id: spare.mine, cohort_id: space.A, author_id: id.O, storage_key: `${id.O}/${spare.mine}.jpg`, width: 4, height: 3, size_bytes: 100, mime: 'image/jpeg' },
    });
    expect(await rows('O', spare.mine)).toBe(1); // control: the server's write is the one that lands
  });

  it("FR-1139 (Opus C1): a client who moves takes their photos out of the former coach's space", async () => {
    const mate = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "role", "status", "updated_at")
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'student', 'active', now())`, mate, ws.A, space.A, id.N); // N joins as a teammate
    const coachOfO = (coach: string) => prisma.$executeRaw`UPDATE "User" SET "coach_id" = ${coach} WHERE "id" = ${id.O}`;
    try {
      expect([await rows('A', photo.A), await rows('N', photo.A)]).toEqual([1, 1]); // control: the coach and a teammate
      await coachOfO(id.B);
      expect([await rows('A', photo.A), await rows('N', photo.A)]).toEqual([0, 0]);
      expect(await rows('X', photo.B)).toBe(1); // another space's photo is untouched
    } finally {
      await coachOfO(id.A);
      await prisma.$executeRawUnsafe(`DELETE FROM "community_memberships" WHERE "id" = $1::uuid`, mate);
    }
    expect(await rows('A', photo.A)).toBe(1);
  });

  it('no storage schema: the bucket block is a no-op', async () => {
    expect(BUCKET_BLOCK).toContain('community_images_api_roles_fence');
    expect(await storageSchema()).toBe('absent');
    await prisma.$executeRawUnsafe(BUCKET_BLOCK);
    expect(await storageSchema()).toBe('absent');
  });

  it('on a Supabase-shaped storage schema the bucket is private, JPEG, 10 MB, and no API role reaches its objects', async () => {
    for (const s of STORAGE_FIXTURE) await prisma.$executeRawUnsafe(s);
    await prisma.$executeRawUnsafe(BUCKET_BLOCK);
    await prisma.$executeRawUnsafe(BUCKET_BLOCK); // re-running changes nothing
    expect(await prisma.$queryRawUnsafe(`SELECT public, file_size_limit::int AS "limit", allowed_mime_types AS "mime" FROM storage.buckets WHERE id = 'community-images'`))
      .toEqual([{ public: false, limit: 10485760, mime: ['image/jpeg'] }]);
    await prisma.$executeRawUnsafe(`INSERT INTO storage.objects (bucket_id, name) VALUES ('avatars', 'a.png'), ('community-images', '${id.O}/p.jpg')`);
    for (const k of ['O', 'X'] as const) {
      expect(await objects(k, 'avatars')).toBe(1); // control: the broad probe policy lets them read
      expect(await objects(k, 'community-images')).toBe(0);
      expect(await putObject(k, 'avatars')).toBe(1);
      expect(await putObject(k, 'community-images')).toBe('42501');
    }
    expect(await objects('anon', 'avatars')).toBe(1);
    expect(await objects('anon', 'community-images')).toBe(0);
  });
});
