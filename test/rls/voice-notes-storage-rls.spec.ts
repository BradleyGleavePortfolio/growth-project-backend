/**
 * RLSSTORAGE (RLSDRIFT D-S1, D-S2, D-S3): voice-note objects are reachable only
 * through the server, and the four hand-made storage.objects policies are
 * replaced by the migration-owned fence voice_notes_api_roles_fence.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay. That
 * database has no storage schema, so the first case proves the migration and
 * down.sql are no-ops there. The rest builds a Supabase-shaped storage schema
 * (buckets + objects, RLS on, Supabase's broad grants, storage.foldername, the
 * data-exports fence from 20270221000000), applies down.sql to get production's
 * four policies (exact text, 2026-10-14 catalog), then migration.sql, and checks
 * real reads and writes. Principals are non-bypass roles:
 *   dataApi(k)  role authenticated, JWT sub = the login id, no app GUC (the
 *               Storage API / Data API model)
 *   backend(k)  the same plus app.current_user_id/_role (the backend model)
 *   anon        role anon, no JWT
 *   server      role service_role (BYPASSRLS), the key the backend signs with
 * A is coach K's client, B is K's other client. Every User.id differs from its
 * supabase_id (RLSINV Y04). The server object lives at voice-notes/<A.id>/...
 * as the backend mints it. Every 0 or refusal follows a control of 1.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('voice-notes-storage-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const read = (dir: string, file: string) => readFileSync(join(MIGRATIONS, dir, file), 'utf8');
const MIGRATION = read('20270502001600_voice_notes_storage_rules', 'migration.sql');
const DOWN = read('20270502001600_voice_notes_storage_rules', 'down.sql');
const EXPORT_FENCE = read('20270221000000_data_export_storage_bucket', 'migration.sql');
const MARK = 'tgp-ci-fixture: voice-notes storage suite';

/** Top-level statements of a SQL script: comments dropped, dollar-quoted bodies kept whole. */
const statements = (sql: string): string[] => {
  const text = sql.replace(/^\s*--.*$/gm, '');
  const out: string[] = [];
  const re = /\$\w*\$|;/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0] !== ';') re.lastIndex = text.indexOf(m[0], re.lastIndex) + m[0].length;
    else {
      out.push(text.slice(start, m.index));
      start = m.index + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
};

// Supabase's storage shape as far as row security goes: RLS on, ALL granted to
// the API roles, owner supabase_storage_admin with ALL on the schema (as
// Supabase grants it; the bucket_id foreign-key check runs as that owner),
// Supabase's own foldername(), a private size-limited voice-notes bucket and a
// public bucket with a normal scoped policy (the control that the fence touches
// only voice-notes).
const STORAGE_FIXTURE = `
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
    CREATE ROLE supabase_storage_admin NOLOGIN NOINHERIT;
  END IF;
END $roles$;
CREATE SCHEMA storage;
COMMENT ON SCHEMA storage IS '${MARK}';
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets (id),
  name text, owner uuid, created_at timestamptz DEFAULT now(), metadata jsonb);
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql AS $f$
DECLARE _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1:array_length(_parts, 1) - 1];
END $f$;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA storage TO supabase_storage_admin;
GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;
ALTER TABLE storage.buckets OWNER TO supabase_storage_admin;
ALTER TABLE storage.objects OWNER TO supabase_storage_admin;
INSERT INTO storage.buckets (id, name, public, file_size_limit) VALUES
  ('voice-notes', 'voice-notes', false, 5242880), ('avatars', 'avatars', true, NULL);
CREATE POLICY avatars_public_read ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'avatars');
`;

// Production's text (2026-10-14 catalog, policies_prod_20261014.json), whitespace collapsed.
const OWN = `((bucket_id = 'voice-notes'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text))`;
const COACH_READ = `((bucket_id = 'voice-notes'::text) AND (EXISTS ( SELECT 1 FROM "User" u WHERE ((u.coach_id = (auth.uid())::text) AND (u.supabase_id = (storage.foldername(u.name))[1])))))`;
const auth = (cmd: string, qual: string | null, check: string | null) =>
  ({ permissive: 'PERMISSIVE', cmd, roles: '{authenticated}', qual, check });
const PRODUCTION = {
  voice_notes_coach_read: auth('SELECT', COACH_READ, null),
  voice_notes_delete_own: auth('DELETE', OWN, null),
  voice_notes_insert_own: auth('INSERT', null, OWN),
  voice_notes_select_own: auth('SELECT', OWN, null),
};
const OFF = `(bucket_id IS DISTINCT FROM 'voice-notes'::text)`;
const FENCE = { permissive: 'RESTRICTIVE', cmd: 'ALL', roles: '{public}', qual: OFF, check: OFF };

type Key = 'A' | 'B' | 'K';
type Who = { role: 'anon' | 'authenticated' | 'service_role'; key?: Key; guc?: boolean };
const dataApi = (key: Key): Who => ({ role: 'authenticated', key });
const backend = (key: Key): Who => ({ role: 'authenticated', key, guc: true });
const anon: Who = { role: 'anon' };
const server: Who = { role: 'service_role' };
const ROLE: Record<Key, string> = { A: 'student', B: 'student', K: 'coach' };
const DENIED = '42501 rls'; // a row-security refusal, never a missing grant

(DB_URL ? describe : describe.skip)('voice-note objects are reachable only through the server', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const id = { A: randomUUID(), B: randomUUID(), K: randomUUID() };
  const sub = { A: randomUUID(), B: randomUUID(), K: randomUUID() };
  const minted = `${id.A}/1760400000000-0a1b2c3d-mac.m4a`; // where the server puts A's recording
  const planted = `${sub.A}/planted.m4a`; // what the hand-made rules let A's login upload

  const run = async (sql: string) => {
    for (const s of statements(sql)) await prisma.$executeRawUnsafe(s);
  };
  const as = <T>(who: Who, query: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${who.role}`);
      if (who.key) {
        await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`,
          JSON.stringify({ sub: sub[who.key], role: 'authenticated' }));
      }
      if (who.key && who.guc) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, id[who.key]);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, ROLE[who.key]);
      }
      return query(tx);
    });
  /** Rows written, or the SQLSTATE of the refusal (+ ' rls' when row security refused it). */
  const write = async (who: Who, sql: string, ...params: unknown[]): Promise<number | string> => {
    try {
      return await as(who, (tx) => tx.$executeRawUnsafe(sql, ...params));
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      const state = String(err.code === 'P2010' ? err.meta?.code : err.code);
      return /violates row-level security policy/.test(String(err.message)) ? `${state} rls` : state;
    }
  };
  const sees = (who: Who, name: string, bucket = 'voice-notes') =>
    as(who, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS "n" FROM storage.objects WHERE bucket_id = $1 AND name = $2`, bucket, name))
      .then((r) => r[0].n);
  const upload = (who: Who, name: string) =>
    write(who, `INSERT INTO storage.objects (bucket_id, name) VALUES ('voice-notes', $1)`, name);
  const rename = (who: Who, name: string) =>
    write(who, `UPDATE storage.objects SET name = name || '-moved' WHERE bucket_id = 'voice-notes' AND name = $1`, name);
  const remove = (who: Who, name: string) =>
    write(who, `DELETE FROM storage.objects WHERE bucket_id = 'voice-notes' AND name = $1`, name);
  const policies = () => prisma.$queryRawUnsafe<{ name: string; permissive: string; cmd: string; roles: string; qual: string | null; check: string | null }[]>(
    `SELECT policyname AS "name", permissive, cmd, roles::text AS "roles", qual, with_check AS "check"
       FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY 1`)
    .then((list) => Object.fromEntries(list.map(({ name, qual, check, ...p }) =>
      [name, { ...p, qual: qual && qual.replace(/\s+/g, ' '), check: check && check.replace(/\s+/g, ' ') }])));
  const storageSchema = async () => {
    const rows = await prisma.$queryRawUnsafe<{ c: string | null }[]>(
      `SELECT obj_description(oid, 'pg_namespace') AS "c" FROM pg_namespace WHERE nspname = 'storage'`);
    return rows.length === 0 ? 'absent' : rows[0].c === MARK ? 'fixture' : 'foreign';
  };

  beforeAll(async () => {
    await prisma.$connect();
    if ((await storageSchema()) !== 'absent') throw new Error('expected no storage schema on the CI database');
    for (const k of ['K', 'A', 'B'] as Key[]) {
      await prisma.$executeRaw`INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id")
        VALUES (${id[k]}, ${sub[k]}, ${`vnsr-${id[k]}`}, 'RLS user', ${ROLE[k]}::"Role", ${k === 'K' ? null : id.K})`;
    }
  });
  afterAll(async () => {
    try {
      if ((await storageSchema()) === 'fixture') await run('DROP SCHEMA storage CASCADE');
    } finally {
      await prisma.$disconnect();
    }
  });

  it('the CI database has no storage schema: migration.sql and down.sql are no-ops there', async () => {
    await run(MIGRATION);
    await run(DOWN);
    expect(await storageSchema()).toBe('absent');
    const left = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS "n" FROM pg_policies WHERE policyname LIKE 'voice_notes%'`);
    expect(left[0].n).toBe(0);
  });

  describe('on a Supabase-shaped storage schema', () => {
    beforeAll(async () => {
      await run(STORAGE_FIXTURE);
      await run(EXPORT_FENCE);
      await run(DOWN); // production today: the four hand-made policies, no voice-notes fence
      await run(`INSERT INTO storage.objects (bucket_id, name) VALUES ('voice-notes', '${minted}'), ('avatars', 'face.png')`);
    });

    it('down.sql gives production\'s four policies with their exact text, and seeds keep supabase_id <> id', async () => {
      for (const k of ['A', 'B', 'K'] as Key[]) expect(id[k]).not.toBe(sub[k]);
      const p = await policies();
      expect(p).toMatchObject(PRODUCTION);
      expect(Object.keys(p)).toEqual(['avatars_public_read', 'data_exports_api_roles_fence', ...Object.keys(PRODUCTION)]);
    });

    it('production today: a login uploads and lists in its own login folder, but never reaches a server-minted object', async () => {
      expect(await upload(dataApi('A'), planted)).toBe(1); // D-S3: the only live effect
      expect(await sees(dataApi('A'), planted)).toBe(1);
      expect(await sees(server, minted)).toBe(1);
      expect(await sees(dataApi('A'), minted)).toBe(0); // D-S1: keys on the login id, objects on User.id
      expect(await sees(backend('K'), minted)).toBe(0); // D-S2: coach_read reads u.name
    });

    it('the migration leaves exactly the two fences; re-running it changes nothing', async () => {
      await run(MIGRATION);
      await run(MIGRATION);
      const p = await policies();
      expect(Object.keys(p)).toEqual(['avatars_public_read', 'data_exports_api_roles_fence', 'voice_notes_api_roles_fence']);
      expect(p.voice_notes_api_roles_fence).toEqual(FENCE);
    });

    it('anon and signed-in users read, upload, move and delete no voice-notes object; the server still does', async () => {
      expect(await sees(anon, 'face.png', 'avatars')).toBe(1); // RLS is not simply closed
      for (const who of [dataApi('A'), backend('A'), backend('K'), dataApi('B'), anon]) {
        for (const name of [minted, planted]) {
          expect(await sees(server, name)).toBe(1);
          expect(await sees(who, name)).toBe(0);
          expect(await rename(who, name)).toBe(0);
          expect(await remove(who, name)).toBe(0);
        }
        expect(await upload(who, `${who.key ? sub[who.key] : 'anon'}/new.m4a`)).toBe(DENIED);
      }
      expect(await sees(server, minted)).toBe(1);
      expect(await sees(server, planted)).toBe(1);
      expect(await upload(server, `${id.B}/server.m4a`)).toBe(1);
      expect(await remove(server, `${id.B}/server.m4a`)).toBe(1);
    });

    it('a broad permissive policy still exposes nothing (the fence is restrictive)', async () => {
      await run(`CREATE POLICY tgp_probe_all ON storage.objects FOR ALL USING (true) WITH CHECK (true)`);
      try {
        expect(await sees(server, minted)).toBe(1);
        expect(await sees(dataApi('A'), minted)).toBe(0);
        expect(await upload(dataApi('A'), `${sub.A}/probe.m4a`)).toBe(DENIED);
      } finally {
        await run('DROP POLICY tgp_probe_all ON storage.objects');
      }
    });

    it('down.sql restores production\'s four policies exactly and drops the fence; the migration puts it back', async () => {
      await run(DOWN);
      const p = await policies();
      expect(p).toMatchObject(PRODUCTION);
      expect(p.voice_notes_api_roles_fence).toBeUndefined();
      expect(await sees(dataApi('A'), planted)).toBe(1);
      await run(MIGRATION);
      expect((await policies()).voice_notes_api_roles_fence).toEqual(FENCE);
      expect(await sees(server, planted)).toBe(1);
      expect(await sees(dataApi('A'), planted)).toBe(0);
    });
  });
});
