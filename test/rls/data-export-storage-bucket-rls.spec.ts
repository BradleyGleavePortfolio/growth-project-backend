/**
 * A-636-1 — data-exports bucket privacy: live Postgres proof of the fence and
 * of the release verifier.
 *
 * Runs against a REAL PostgreSQL (no mocks). It builds a Supabase-like
 * `storage` schema (buckets + objects, RLS on, the broad Supabase grants to
 * anon/authenticated/service_role, owner supabase_storage_admin, a normal
 * scoped policy for another bucket), applies
 * prisma/migrations/20270221000000_data_export_storage_bucket/{migration,verify,down}.sql
 * verbatim, and proves:
 *   - anon, authenticated and a custom JWT role read, insert, update and
 *     delete ZERO data-exports objects even with broad permissive policies
 *     (`bucket_id = 'avatars' OR true`, a PUBLIC `USING (true)` policy);
 *     service_role (the backend key) still reads and writes them;
 *   - the verifier passes on that state, and RAISEs (fails the release) on
 *     every state that exposes the bucket or could: fence dropped (anon then
 *     really reads the archive), fence altered (permissive / one role / one
 *     command / `true`), RLS disabled (anon then really reads), bucket public,
 *     bucket missing, anon/authenticated escaping RLS (BYPASSRLS or member of
 *     the owner), an RLS-escaping view selectable by anon, service_role
 *     without BYPASSRLS;
 *   - the migration is idempotent and repairs a public bucket and an altered
 *     fence; down.sql refuses while archives exist and removes the bucket and
 *     the fence when empty; without a storage schema both are no-ops.
 *
 * CI: the rls-live-tests job runs this file after the Supabase shim. It only
 * ever drops a `storage` schema it created itself (marked by a comment), and
 * restores every role attribute it changes.
 *
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true where a missing
 * URL is a hard failure (no green-by-skip). URL set but unreachable -> failure.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const MIGRATION_DIR = path.join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20270221000000_data_export_storage_bucket',
);
const MIGRATION = fs.readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8');
const VERIFY = fs.readFileSync(path.join(MIGRATION_DIR, 'verify.sql'), 'utf8');
const DOWN = fs.readFileSync(path.join(MIGRATION_DIR, 'down.sql'), 'utf8');
const FIXTURE_MARK = 'tgp-ci-fixture: data-exports fence suite';

const RAW_URL = process.env.TEST_DATABASE_URL || '';
if (!RAW_URL && process.env.CI === 'true') {
  throw new Error(
    '[A-636-1] data-export-storage-bucket-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.',
  );
}
const URL_WITH_LIMIT = !RAW_URL
  ? ''
  : RAW_URL.includes('connection_limit=')
    ? RAW_URL
    : RAW_URL + (RAW_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

const ROLES_SQL = `
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN CREATE ROLE supabase_storage_admin NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tgp_custom_jwt_role') THEN CREATE ROLE tgp_custom_jwt_role NOLOGIN NOINHERIT; END IF;
END $do$;
`;

// The Supabase storage shape that matters for privacy: RLS on, broad table
// grants to the API roles (Supabase grants ALL and relies on RLS), owner
// supabase_storage_admin, and a normal scoped policy for a public bucket.
const STORAGE_FIXTURE_SQL = `
CREATE SCHEMA storage;
COMMENT ON SCHEMA storage IS '${FIXTURE_MARK}';
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean DEFAULT false,
  allowed_mime_types text[],
  created_at timestamptz DEFAULT now()
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  metadata jsonb
);
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role, tgp_custom_jwt_role;
GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role, tgp_custom_jwt_role;
ALTER SCHEMA storage OWNER TO supabase_storage_admin;
ALTER TABLE storage.buckets OWNER TO supabase_storage_admin;
ALTER TABLE storage.objects OWNER TO supabase_storage_admin;
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true);
CREATE POLICY avatars_public_read ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'avatars');
`;

/** Top-level statement splitter honouring dollar quotes, single quotes and -- comments. */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let dollarTag: string | null = null;
  let inSingle = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (inSingle) {
      buf += ch;
      i += 1;
      if (ch === "'") {
        if (sql[i] === "'") {
          buf += sql[i];
          i += 1;
        } else inSingle = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 ? sql.length : eol + 1;
      buf += '\n';
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const describeLive = URL_WITH_LIMIT ? describe : describe.skip;

describeLive('data-exports bucket fence + release verifier (live Postgres, A-636-1)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL_WITH_LIMIT } } });

  type Tx = {
    $executeRawUnsafe: (sql: string) => Promise<number>;
    $queryRawUnsafe: (sql: string) => Promise<unknown[]>;
  };

  async function run(sql: string): Promise<void> {
    for (const stmt of splitSqlStatements(sql)) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(stmt)) continue;
      await prisma.$executeRawUnsafe(stmt);
    }
  }

  /** The verifier's RAISE text, or 'PASS'. */
  async function verify(): Promise<string> {
    try {
      await run(VERIFY);
      return 'PASS';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = /(MISSING|EXPOSURE|SERVICE): [^\n"]*/.exec(msg);
      return m ? m[0] : `UNEXPECTED: ${msg.slice(0, 300)}`;
    }
  }

  async function as<T>(role: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      return fn(tx);
    });
  }

  async function exportRowsSeenBy(role: string): Promise<number> {
    return as(role, async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = 'data-exports'`,
      )) as Array<{ n: number }>;
      return Number(rows[0].n);
    });
  }

  /** null when the statement succeeded (as `role`), else the error text. */
  async function attempt(role: string, stmt: string): Promise<string | null> {
    try {
      await as(role, async (tx) => {
        await tx.$executeRawUnsafe(stmt);
      });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async function changedRows(role: string, stmt: string): Promise<number> {
    return as(role, (tx) => tx.$executeRawUnsafe(stmt));
  }

  async function storageSchemaState(): Promise<'absent' | 'fixture' | 'foreign'> {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT obj_description(oid, 'pg_namespace') AS c FROM pg_namespace WHERE nspname = 'storage'`,
    )) as Array<{ c: string | null }>;
    if (rows.length === 0) return 'absent';
    return rows[0].c === FIXTURE_MARK ? 'fixture' : 'foreign';
  }

  async function seedArchive(name = 'export-1.json'): Promise<void> {
    await run(
      `INSERT INTO storage.objects (bucket_id, name) VALUES ('data-exports', '${name}'), ('avatars', 'a-${name}')`,
    );
  }

  beforeAll(async () => {
    await prisma.$connect();
    const state = await storageSchemaState();
    if (state === 'foreign') {
      throw new Error('A storage schema this suite did not create exists; refusing to touch it.');
    }
    if (state === 'fixture') await run('DROP SCHEMA storage CASCADE');
    await run(ROLES_SQL);
  });

  afterAll(async () => {
    try {
      await run('ALTER ROLE anon NOBYPASSRLS');
      await run('ALTER ROLE service_role BYPASSRLS');
      await run('DROP VIEW IF EXISTS public.tgp_fence_probe_view');
      if ((await storageSchemaState()) === 'fixture') await run('DROP SCHEMA storage CASCADE');
    } finally {
      await prisma.$disconnect();
    }
  });

  it('without a storage schema the migration, verifier and down.sql are no-ops', async () => {
    expect(await storageSchemaState()).toBe('absent');
    await run(MIGRATION);
    expect(await verify()).toBe('PASS');
    await run(DOWN);
    expect(await storageSchemaState()).toBe('absent');
  });

  describe('on a Supabase-like storage schema', () => {
    beforeAll(async () => {
      await run(STORAGE_FIXTURE_SQL);
      await run(MIGRATION);
      await seedArchive();
    });

    it('creates the private JSON-only bucket and exactly one restrictive fence; re-running is idempotent', async () => {
      await run(MIGRATION);
      const bucket = (await prisma.$queryRawUnsafe(
        `SELECT public, allowed_mime_types::text AS mimes FROM storage.buckets WHERE id = 'data-exports'`,
      )) as Array<{ public: boolean; mimes: string }>;
      expect(bucket).toEqual([{ public: false, mimes: '{application/json}' }]);
      const fences = (await prisma.$queryRawUnsafe(
        `SELECT permissive, cmd, roles::text AS roles FROM pg_policies
          WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'data_exports_api_roles_fence'`,
      )) as Array<{ permissive: string; cmd: string; roles: string }>;
      expect(fences).toEqual([{ permissive: 'RESTRICTIVE', cmd: 'ALL', roles: '{public}' }]);
      expect(await verify()).toBe('PASS');
    });

    it('API roles cannot list, read, write, update or delete data-exports objects; service_role can', async () => {
      expect(await exportRowsSeenBy('anon')).toBe(0);
      expect(await exportRowsSeenBy('authenticated')).toBe(0);
      // The scoped avatars policy still works: the fence touches only data-exports.
      const avatars = await as('anon', async (tx) => {
        const rows = (await tx.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = 'avatars'`,
        )) as Array<{ n: number }>;
        return Number(rows[0].n);
      });
      expect(avatars).toBeGreaterThan(0);
      for (const role of ['anon', 'authenticated']) {
        expect(
          await attempt(
            role,
            `INSERT INTO storage.objects (bucket_id, name) VALUES ('data-exports', 'planted-${role}.json')`,
          ),
        ).toMatch(/row-level security/i);
        expect(
          await changedRows(
            role,
            `UPDATE storage.objects SET name = 'renamed' WHERE bucket_id = 'data-exports'`,
          ),
        ).toBe(0);
        expect(
          await changedRows(role, `DELETE FROM storage.objects WHERE bucket_id = 'data-exports'`),
        ).toBe(0);
      }
      expect(await exportRowsSeenBy('service_role')).toBe(1);
      expect(
        await attempt(
          'service_role',
          `INSERT INTO storage.objects (bucket_id, name) VALUES ('data-exports', 'service-write.json')`,
        ),
      ).toBeNull();
      expect(
        await changedRows(
          'service_role',
          `DELETE FROM storage.objects WHERE bucket_id = 'data-exports' AND name = 'service-write.json'`,
        ),
      ).toBe(1);
    });

    it('broad permissive policies (OR true, PUBLIC USING true, a custom JWT role) still expose nothing, and the verifier passes', async () => {
      await run(
        `CREATE POLICY broad_or_true ON storage.objects FOR ALL TO anon, authenticated
           USING (bucket_id = 'avatars' OR true) WITH CHECK (bucket_id = 'avatars' OR true)`,
      );
      await run(`CREATE POLICY public_all ON storage.objects FOR SELECT USING (true)`);
      await run(
        `CREATE POLICY custom_role_all ON storage.objects FOR ALL TO tgp_custom_jwt_role USING (true) WITH CHECK (true)`,
      );
      try {
        expect(await exportRowsSeenBy('anon')).toBe(0);
        expect(await exportRowsSeenBy('authenticated')).toBe(0);
        expect(await exportRowsSeenBy('tgp_custom_jwt_role')).toBe(0);
        expect(
          await attempt(
            'authenticated',
            `INSERT INTO storage.objects (bucket_id, name) VALUES ('data-exports', 'planted.json')`,
          ),
        ).toMatch(/row-level security/i);
        expect(await verify()).toBe('PASS');

        // Without the fence the same policies really expose the archive, and
        // the verifier fails the release.
        await run('DROP POLICY data_exports_api_roles_fence ON storage.objects');
        expect(await exportRowsSeenBy('anon')).toBe(1);
        expect(await exportRowsSeenBy('tgp_custom_jwt_role')).toBe(1);
        expect(await verify()).toMatch(/^EXPOSURE: the restrictive fence .* is missing/);
      } finally {
        await run('DROP POLICY IF EXISTS broad_or_true ON storage.objects');
        await run('DROP POLICY IF EXISTS public_all ON storage.objects');
        await run('DROP POLICY IF EXISTS custom_role_all ON storage.objects');
        await run(MIGRATION);
      }
      expect(await verify()).toBe('PASS');
    });

    it.each([
      [
        'permissive instead of restrictive',
        `CREATE POLICY data_exports_api_roles_fence ON storage.objects AS PERMISSIVE FOR ALL TO PUBLIC
           USING (bucket_id IS DISTINCT FROM 'data-exports') WITH CHECK (bucket_id IS DISTINCT FROM 'data-exports')`,
      ],
      [
        'bound to anon only',
        `CREATE POLICY data_exports_api_roles_fence ON storage.objects AS RESTRICTIVE FOR ALL TO anon
           USING (bucket_id IS DISTINCT FROM 'data-exports') WITH CHECK (bucket_id IS DISTINCT FROM 'data-exports')`,
      ],
      [
        'SELECT only',
        `CREATE POLICY data_exports_api_roles_fence ON storage.objects AS RESTRICTIVE FOR SELECT TO PUBLIC
           USING (bucket_id IS DISTINCT FROM 'data-exports')`,
      ],
      [
        'USING (true)',
        `CREATE POLICY data_exports_api_roles_fence ON storage.objects AS RESTRICTIVE FOR ALL TO PUBLIC
           USING (true) WITH CHECK (true)`,
      ],
      [
        'scoped to another bucket',
        `CREATE POLICY data_exports_api_roles_fence ON storage.objects AS RESTRICTIVE FOR ALL TO PUBLIC
           USING (bucket_id IS DISTINCT FROM 'avatars') WITH CHECK (bucket_id IS DISTINCT FROM 'avatars')`,
      ],
    ])(
      'an altered fence (%s) fails the release; the migration restores it',
      async (_label, ddl) => {
        await run('DROP POLICY data_exports_api_roles_fence ON storage.objects');
        await run(ddl);
        try {
          expect(await verify()).toMatch(/^EXPOSURE: the restrictive fence .* was altered/);
        } finally {
          await run(MIGRATION);
        }
        expect(await verify()).toBe('PASS');
      },
    );

    it('row level security disabled on storage.objects fails the release (anon then reads the archive)', async () => {
      await run('ALTER TABLE storage.objects DISABLE ROW LEVEL SECURITY');
      try {
        expect(await exportRowsSeenBy('anon')).toBe(1);
        expect(await verify()).toMatch(/^EXPOSURE: row level security is disabled/);
      } finally {
        await run('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY');
      }
      expect(await verify()).toBe('PASS');
    });

    it('a public bucket fails the release; the migration forces it private again', async () => {
      await run(`UPDATE storage.buckets SET public = true WHERE id = 'data-exports'`);
      expect(await verify()).toMatch(/^EXPOSURE: storage bucket data-exports is not private/);
      await run(`UPDATE storage.buckets SET public = NULL WHERE id = 'data-exports'`);
      expect(await verify()).toMatch(/^EXPOSURE: storage bucket data-exports is not private/);
      await run(MIGRATION);
      expect(await verify()).toBe('PASS');
    });

    it('API roles that escape RLS fail the release (BYPASSRLS, member of the table owner)', async () => {
      await run('ALTER ROLE anon BYPASSRLS');
      try {
        expect(await verify()).toMatch(/^EXPOSURE: API role anon /);
      } finally {
        await run('ALTER ROLE anon NOBYPASSRLS');
      }
      await run('GRANT supabase_storage_admin TO authenticated');
      try {
        expect(await verify()).toMatch(/^EXPOSURE: API role authenticated /);
      } finally {
        await run('REVOKE supabase_storage_admin FROM authenticated');
      }
      expect(await verify()).toBe('PASS');
    });

    it('a view over storage.objects that anon may select fails the release unless it runs as the invoker', async () => {
      await run('CREATE VIEW public.tgp_fence_probe_view AS SELECT * FROM storage.objects');
      await run('GRANT SELECT ON public.tgp_fence_probe_view TO anon');
      try {
        // The view reads as its superuser owner, so the fence does not apply.
        const seen = await as('anon', async (tx) => {
          const rows = (await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM public.tgp_fence_probe_view WHERE bucket_id = 'data-exports'`,
          )) as Array<{ n: number }>;
          return Number(rows[0].n);
        });
        expect(seen).toBe(1);
        expect(await verify()).toMatch(/^EXPOSURE: view public\.tgp_fence_probe_view /);
        await run('ALTER VIEW public.tgp_fence_probe_view SET (security_invoker = true)');
        expect(await verify()).toBe('PASS');
      } finally {
        await run('DROP VIEW IF EXISTS public.tgp_fence_probe_view');
      }
    });

    it('service_role without BYPASSRLS fails the release (the fence would block the backend)', async () => {
      await run('ALTER ROLE service_role NOBYPASSRLS');
      try {
        expect(await verify()).toMatch(/^SERVICE: service_role/);
      } finally {
        await run('ALTER ROLE service_role BYPASSRLS');
      }
      expect(await verify()).toBe('PASS');
    });

    it('down.sql refuses while archives exist; when empty it removes the bucket and the fence; a missing bucket fails the release', async () => {
      let refused = '';
      try {
        await run(DOWN);
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err);
      }
      expect(refused).toMatch(/still holds archives; refusing to drop it/);
      expect(await verify()).toBe('PASS');

      await run(`DELETE FROM storage.objects WHERE bucket_id = 'data-exports'`);
      await run(DOWN);
      const left = (await prisma.$queryRawUnsafe(
        `SELECT (SELECT count(*)::int FROM storage.buckets WHERE id = 'data-exports') AS buckets,
                (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'storage'
                   AND policyname = 'data_exports_api_roles_fence') AS fences`,
      )) as Array<{ buckets: number; fences: number }>;
      expect(left).toEqual([{ buckets: 0, fences: 0 }]);
      expect(await verify()).toMatch(/^MISSING: storage bucket data-exports does not exist/);

      await run(MIGRATION);
      await seedArchive('export-2.json');
      expect(await verify()).toBe('PASS');
      expect(await exportRowsSeenBy('anon')).toBe(0);
      expect(await exportRowsSeenBy('service_role')).toBe(1);
    });
  });
});
