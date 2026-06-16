/**
 * W1.5-A3.1 — live-DB proof of RLS spine convergence (EXPAND + VERIFY).
 *
 * This suite hits a REAL Postgres and exercises the REAL transaction path
 * (`withRlsContext` opening a `$transaction` and stamping GUCs on the tx handle),
 * which is the only faithful way to prove the pgbouncer-safe behaviour: a GUC set
 * with `set_config(..., is_local := true)` is only visible to queries on the SAME
 * transaction/connection. It pins:
 *
 *   1. F-1 / parity at the DB level. After `withRlsContext` stamps both
 *      namespaces, `app.current_user_id()` (legacy, authoritative) and
 *      `app.current_user_id_v2()` (new) resolve to the SAME user id, read back
 *      inside the same transaction.
 *   2. The new helpers exist and read the new namespace: current_user_id_v2()
 *      returns app.user_id, current_gym_ids() returns app.gym_ids as text[] and
 *      NULL (deny-all) for the empty authorization.
 *
 * Skip modes (matching the repo's live-DB convention, R69-exempt env gate):
 *   - no DB URL configured            -> describe.skip (clean skip)
 *   - DB URL configured but unreachable -> beforeAll throws (HARD FAIL)
 *
 * Self-bootstrapping: applies the A3.1 helper migration plus the prior
 * 20261212000000 helper definitions it converges with, against a throwaway DB.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { withRlsContext } from '../../src/database/rls-context';

const DB_URL =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL &&
  !process.env.DATABASE_URL.startsWith('postgresql://test:test@')
    ? process.env.DATABASE_URL
    : '');

const dbAvailable = Boolean(DB_URL);

const SINGLE_CONN_URL = !dbAvailable
  ? ''
  : DB_URL.includes('connection_limit=')
    ? DB_URL
    : DB_URL + (DB_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

const A3_MIGRATION = path.join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261220000000_rls_helpers_v2',
  'migration.sql',
);

// The append-only ACL follow-up that locks the v2 helpers down (REVOKE from
// PUBLIC/anon, GRANT to authenticated/service_role). The self-bootstrap below
// applies ONLY the helper migration, so this suite loads the ACL SQL itself
// before asserting the grant state — mirroring how the suite already loads the
// helper migration via applyScript (and how the PR-RLS-01 helper suite relies
// on its ACL migration being applied before its has_function_privilege checks).
const A3_ACL_MIGRATION = path.join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261221000000_rls_helpers_v2_acl',
  'migration.sql',
);

// v2-helper signatures, used for the catalog privilege assertions below.
const V2_HELPER_SIGS = [
  'app.current_user_id_v2()',
  'app.current_gym_ids()',
] as const;

// Prior helper migration this PR converges with: provides app.current_user_id()
// + app.current_user_role() reading the LEGACY namespace.
const LEGACY_HELPERS_SQL = `
CREATE SCHEMA IF NOT EXISTS app;
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')
$$;
CREATE OR REPLACE FUNCTION app.current_user_role()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_role', true), '')
$$;
`;

/** Apply a SQL script statement-by-statement, honoring $$-quoted function bodies. */
async function applyScript(prisma: PrismaClient, sql: string): Promise<void> {
  const statements: string[] = [];
  let buf = '';
  let dollar: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        buf += dollar;
        i += dollar.length - 1;
        dollar = null;
      } else {
        buf += sql[i];
      }
      continue;
    }
    // Skip `--` line comments so a `;` inside a comment is not mistaken for a
    // statement terminator (only meaningful outside a $$-quoted body).
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    // Copy single-quoted string literals verbatim (honoring the '' escape) so a
    // `;` inside e.g. a COMMENT ... IS '...' body is not a statement terminator.
    if (sql[i] === "'") {
      buf += sql[i];
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          buf += "''";
          i += 2;
          continue;
        }
        if (sql[i] === "'") break;
        buf += sql[i];
        i += 1;
      }
      buf += "'";
      continue;
    }
    if (sql[i] === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        dollar = m[0];
        buf += dollar;
        i += dollar.length - 1;
        continue;
      }
    }
    if (sql[i] === ';') {
      const t = buf.trim();
      if (t) statements.push(t);
      buf = '';
      continue;
    }
    buf += sql[i];
  }
  const tail = buf.trim();
  if (tail) statements.push(tail);
  for (const stmt of statements) {
    const noComments = stmt
      .split('\n')
      .filter((l) => !/^\s*--/.test(l))
      .join('\n')
      .trim();
    if (!noComments || /^(BEGIN|COMMIT|ROLLBACK)$/i.test(noComments)) continue;
    await prisma.$executeRawUnsafe(noComments);
  }
}

(dbAvailable ? describe : describe.skip)(
  'W1.5-A3.1 RLS spine convergence (live DB)',
  () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: SINGLE_CONN_URL } },
    });

    beforeAll(async () => {
      // Hard-fail (not skip) when a URL is configured but unreachable — prevents
      // the false-green where a bad URL yields "passed" without running SQL.
      await prisma.$connect();
      await applyScript(prisma, LEGACY_HELPERS_SQL);
      await applyScript(prisma, fs.readFileSync(A3_MIGRATION, 'utf8'));

      // The ACL migration GRANTs/REVOKEs to the Supabase convention roles. CI
      // provisions them via scripts/ci/supabase-shim.sql before this job, but
      // make the suite self-sufficient (and faithful to the migration's own
      // documented precondition) by creating them idempotently if absent — so
      // the v2-ACL SQL applies cleanly even against a bare throwaway Postgres.
      await applyScript(
        prisma,
        `DO $boot$ BEGIN
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
             CREATE ROLE anon NOLOGIN NOINHERIT;
           END IF;
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
             CREATE ROLE authenticated NOLOGIN NOINHERIT;
           END IF;
           IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
             CREATE ROLE service_role NOLOGIN NOINHERIT;
           END IF;
         END $boot$;`,
      );
      // Apply the v2 ACL migration verbatim so the privilege assertions below
      // exercise the REAL shipped grant block, not a hand-rolled copy.
      await applyScript(prisma, fs.readFileSync(A3_ACL_MIGRATION, 'utf8'));

      const helpers = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
          WHERE ns.nspname = 'app'
            AND p.proname IN ('current_user_id','current_user_id_v2','current_gym_ids')`,
      );
      if (Number(helpers[0].n) !== 3) {
        throw new Error(
          `bootstrap incomplete: expected 3 helpers, found ${helpers[0].n}`,
        );
      }
    }, 60_000);

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('parity: legacy app.current_user_id() == new app.current_user_id_v2() inside the real tx', async () => {
      const result = await withRlsContext(
        prisma,
        { userId: 'live-user-1', gymIds: ['gym-a', 'gym-b'], role: 'coach' },
        async (tx) => {
          const rows = await tx.$queryRawUnsafe<
            { legacy: string | null; v2: string | null; role: string | null }[]
          >(
            `SELECT app.current_user_id() AS legacy,
                    app.current_user_id_v2() AS v2,
                    app.current_user_role() AS role`,
          );
          return rows[0];
        },
      );
      expect(result.legacy).toBe('live-user-1');
      expect(result.v2).toBe('live-user-1');
      // Convergence invariant: both namespaces resolve to the same acting user.
      expect(result.legacy).toBe(result.v2);
      expect(result.role).toBe('coach');
    });

    it('current_gym_ids() returns the authorized gyms as text[] on the real tx', async () => {
      const gyms = await withRlsContext(
        prisma,
        { userId: 'live-user-2', gymIds: ['gym-x', 'gym-y'], role: 'student' },
        async (tx) => {
          const rows = await tx.$queryRawUnsafe<{ gyms: string[] | null }[]>(
            `SELECT app.current_gym_ids() AS gyms`,
          );
          return rows[0].gyms;
        },
      );
      expect(gyms).toEqual(['gym-x', 'gym-y']);
    });

    it('current_gym_ids() returns NULL (deny-all) for an empty authorization', async () => {
      const gyms = await withRlsContext(
        prisma,
        { userId: 'live-user-3', gymIds: [], role: 'student' },
        async (tx) => {
          const rows = await tx.$queryRawUnsafe<{ gyms: string[] | null }[]>(
            `SELECT app.current_gym_ids() AS gyms`,
          );
          return rows[0].gyms;
        },
      );
      expect(gyms).toBeNull();
    });

    // ────────────────────────────────────────────────────────────
    // F-1 (re-audit R2): v2-helper ACL lockdown. The original 5 helpers get
    // live has_function_privilege assertions (helper-functions.spec.ts); the
    // two v2 helpers' ACL (migration 20261221000000_rls_helpers_v2_acl) was
    // asserted nowhere. has_function_privilege reads the catalog grant state
    // directly, so the superuser connection that bypasses EXECUTE *checks* does
    // not mask a wrong grant here. Preconditions are established by applying the
    // ACL migration SQL in beforeAll (this suite self-bootstraps and does NOT
    // auto-apply 20261221), mirroring the existing helper privilege test.
    // ────────────────────────────────────────────────────────────
    describe('v2 helper ACL lockdown (post-20261221 migration)', () => {
      it('PUBLIC and anon have NO EXECUTE on either v2 helper', async () => {
        expect.hasAssertions();
        for (const sig of V2_HELPER_SIGS) {
          for (const role of ['public', 'anon']) {
            const row = await prisma.$queryRawUnsafe<
              { has_exec: boolean }[]
            >(
              `SELECT has_function_privilege($1, $2, 'EXECUTE') AS has_exec`,
              role,
              sig,
            );
            expect(row[0].has_exec).toBe(false);
          }
        }
      });

      it('authenticated and service_role HAVE EXECUTE on both v2 helpers', async () => {
        expect.hasAssertions();
        for (const sig of V2_HELPER_SIGS) {
          for (const role of ['authenticated', 'service_role']) {
            const row = await prisma.$queryRawUnsafe<
              { has_exec: boolean }[]
            >(
              `SELECT has_function_privilege($1, $2, 'EXECUTE') AS has_exec`,
              role,
              sig,
            );
            expect(row[0].has_exec).toBe(true);
          }
        }
      });
    });

    it('GUCs do not leak outside the transaction (pgbouncer is_local semantics)', async () => {
      await withRlsContext(
        prisma,
        { userId: 'live-user-4', gymIds: ['gym-z'], role: 'owner' },
        () => Promise.resolve(null),
      );
      // Outside the tx, on a fresh statement, the new-namespace GUC is unset.
      const rows = await prisma.$queryRawUnsafe<{ v2: string | null }[]>(
        `SELECT app.current_user_id_v2() AS v2`,
      );
      expect(rows[0].v2).toBeNull();
    });
  },
);
