/**
 * PR-RLS-01 regression suite — RBAC helper functions.
 *
 * Asserts that every helper hardened with SECURITY DEFINER + pinned
 * search_path still returns the same observable value it did before the
 * migration, that the anon role cannot EXECUTE any of them, that a
 * hostile caller search_path cannot shadow built-ins, and that the
 * enforce_subcoach_head_cap trigger function fires under proper FK
 * fixtures at, below, and over the cap.
 *
 * The live-DB sections hit a real Postgres because the helpers read
 * session-level GUCs that no in-memory mock can faithfully simulate.
 * The suite uses two skip modes (P1-003):
 *
 *   - no DB URL configured           -> describe.skip (clean skip)
 *   - DB URL configured but unreachable -> beforeAll throws (HARD FAIL)
 *
 * This prevents the false-green observed in Audit #1 where a configured
 * but unreachable URL produced "passed" assertions without ever running
 * the live SQL.
 *
 * Activation: set TEST_DATABASE_URL (preferred) or DATABASE_URL to a
 * Postgres instance with the PR-RLS-01 migration applied.
 */

import { PrismaClient } from '@prisma/client';

const DB_URL =
  process.env.TEST_DATABASE_URL ||
  (process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('postgresql://test:test@')
    ? process.env.DATABASE_URL
    : '');

const dbAvailable = Boolean(DB_URL);

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const COACH_ID = 'rls01-test-coach-aaaaaaaaaaaaaaa1';
const STUDENT_OF_COACH_ID = 'rls01-test-student-bbbbbbbbbbbbbb2';
const OTHER_COACH_ID = 'rls01-test-other-coach-cccccccccc3';
const HEAD_A = 'rls01-test-head-a-dddddddddddddddd4';
const HEAD_B = 'rls01-test-head-b-eeeeeeeeeeeeeeee5';
const HEAD_C = 'rls01-test-head-c-ffffffffffffffff6';
const SUB = 'rls01-test-sub-coach-gggggggggggggg7';

const ALL_USER_IDS = [
  COACH_ID,
  STUDENT_OF_COACH_ID,
  OTHER_COACH_ID,
  HEAD_A,
  HEAD_B,
  HEAD_C,
  SUB,
];

(dbAvailable ? describe : describe.skip)(
  'PR-RLS-01 helper regression (live DB)',
  () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      // P1-003: distinguish "no URL = skip" from "URL set but unreachable =
      // HARD FAIL". The describe.skip gate above handles the no-URL path;
      // here we know DB_URL is truthy, so failure to probe is a real
      // configuration problem and must fail the suite loudly.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await prisma.$queryRawUnsafe<any>('SELECT 1');
      } catch (err) {
        throw new Error(
          `[PR-RLS-01] DATABASE_URL/TEST_DATABASE_URL is set but unreachable. ` +
            `Refusing to silently skip RLS regression tests. Underlying error: ${errorMessage(err)}`,
        );
      }

      // Seed minimal User fixtures so live tests that depend on FKs
      // (is_current_coach_of positive path, trigger fixtures per P1-004)
      // have valid rows. We use ON CONFLICT DO NOTHING so reruns are safe.
      // The supabase_id and email columns are unique; we derive deterministic
      // values from the id so re-runs collide cleanly.
      for (const uid of ALL_USER_IDS) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "User" (id, supabase_id, email, name, role)
           VALUES ($1, $2, $3, $4, 'coach')
           ON CONFLICT (id) DO NOTHING`,
          uid,
          `supabase-${uid}`,
          `${uid}@rls01.test`,
          `RLS01 ${uid}`,
        );
      }

      // Mark STUDENT_OF_COACH_ID as a student whose coach_id = COACH_ID, so
      // app.is_user_coached_by(STUDENT, COACH) returns true (P2-003).
      await prisma.$executeRawUnsafe(
        `UPDATE "User" SET role = 'student', coach_id = $1 WHERE id = $2`,
        COACH_ID,
        STUDENT_OF_COACH_ID,
      );
    });

    afterAll(async () => {
      if (prisma) {
        // Tear down in reverse dependency order so FK constraints hold.
        try {
          await prisma.$executeRawUnsafe(
            `DELETE FROM "TeamSubCoachAssignment" WHERE sub_coach_id = $1 OR head_coach_id = ANY($2::text[])`,
            SUB,
            [HEAD_A, HEAD_B, HEAD_C],
          );
        } catch {
          /* table may not exist in some test images */
        }
        // Null out the coach back-reference before deleting the coach.
        await prisma.$executeRawUnsafe(
          `UPDATE "User" SET coach_id = NULL WHERE id = $1`,
          STUDENT_OF_COACH_ID,
        );
        await prisma.$executeRawUnsafe(
          `DELETE FROM "User" WHERE id = ANY($1::text[])`,
          ALL_USER_IDS,
        );
        await prisma.$disconnect();
      }
    });

    async function setContext(userId: string | null, role: string | null) {
      // Sets the two app.* GUCs that the helpers read. Uses set_config with
      // is_local=false so the value persists for the lifetime of the
      // connection (a SET LOCAL would clear at COMMIT, but Prisma's
      // $queryRawUnsafe auto-commits each statement).
      if (userId === null) {
        await prisma.$executeRawUnsafe(`RESET "app.current_user_id"`);
      } else {
        await prisma.$executeRawUnsafe(
          `SELECT set_config('app.current_user_id', $1, false)`,
          userId,
        );
      }
      if (role === null) {
        await prisma.$executeRawUnsafe(`RESET "app.current_user_role"`);
      } else {
        await prisma.$executeRawUnsafe(
          `SELECT set_config('app.current_user_role', $1, false)`,
          role,
        );
      }
    }

    async function callScalar<T>(sql: string, ...params: unknown[]): Promise<T> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await prisma.$queryRawUnsafe<any>(sql, ...params)) as Array<
        Record<string, T>
      >;
      const firstRow = rows[0] ?? {};
      const firstKey = Object.keys(firstRow)[0];
      return firstRow[firstKey];
    }

    // ────────────────────────────────────────────────────────────
    // app.current_user_id()
    // ────────────────────────────────────────────────────────────
    describe('app.current_user_id()', () => {
      it('returns the configured user id when set', async () => {
        expect.hasAssertions();
        await setContext(COACH_ID, 'coach');
        const got = await callScalar<string>('SELECT app.current_user_id() AS id');
        expect(got).toBe(COACH_ID);
      });

      it('returns NULL under anonymous context', async () => {
        expect.hasAssertions();
        await setContext(null, null);
        const got = await callScalar<string | null>(
          'SELECT app.current_user_id() AS id',
        );
        expect(got).toBeNull();
      });

      it('returns NULL when the GUC is explicitly empty string', async () => {
        expect.hasAssertions();
        await setContext('', null);
        const got = await callScalar<string | null>(
          'SELECT app.current_user_id() AS id',
        );
        expect(got).toBeNull();
      });
    });

    // ────────────────────────────────────────────────────────────
    // app.current_user_role()
    // ────────────────────────────────────────────────────────────
    describe('app.current_user_role()', () => {
      it('returns the configured role when set', async () => {
        expect.hasAssertions();
        await setContext(COACH_ID, 'coach');
        const got = await callScalar<string>(
          'SELECT app.current_user_role() AS role',
        );
        expect(got).toBe('coach');
      });

      it('returns NULL under anonymous context', async () => {
        expect.hasAssertions();
        await setContext(null, null);
        const got = await callScalar<string | null>(
          'SELECT app.current_user_role() AS role',
        );
        expect(got).toBeNull();
      });

      it('reflects role changes within a session', async () => {
        expect.hasAssertions();
        await setContext(COACH_ID, 'student');
        const first = await callScalar<string>(
          'SELECT app.current_user_role() AS role',
        );
        expect(first).toBe('student');
        await setContext(COACH_ID, 'owner');
        const second = await callScalar<string>(
          'SELECT app.current_user_role() AS role',
        );
        expect(second).toBe('owner');
      });
    });

    // ────────────────────────────────────────────────────────────
    // app.is_owner()
    // ────────────────────────────────────────────────────────────
    describe('app.is_owner()', () => {
      it('returns true for an authenticated owner', async () => {
        expect.hasAssertions();
        await setContext(COACH_ID, 'owner');
        const got = await callScalar<boolean>(
          'SELECT app.is_owner() AS is_owner',
        );
        expect(got).toBe(true);
      });

      it('returns false for an authenticated non-owner', async () => {
        expect.hasAssertions();
        await setContext(COACH_ID, 'coach');
        const got = await callScalar<boolean>(
          'SELECT app.is_owner() AS is_owner',
        );
        expect(got).toBe(false);
      });

      it('returns false under anonymous context', async () => {
        expect.hasAssertions();
        await setContext(null, null);
        const got = await callScalar<boolean>(
          'SELECT app.is_owner() AS is_owner',
        );
        expect(got).toBe(false);
      });
    });

    // ────────────────────────────────────────────────────────────
    // app.is_current_coach_of(client_user_id)
    // ────────────────────────────────────────────────────────────
    describe('app.is_current_coach_of(text)', () => {
      it('returns false under anonymous context', async () => {
        expect.hasAssertions();
        await setContext(null, null);
        const got = await callScalar<boolean>(
          'SELECT app.is_current_coach_of($1) AS r',
          STUDENT_OF_COACH_ID,
        );
        expect(got).toBe(false);
      });

      it('returns false when no matching coach assignment exists', async () => {
        expect.hasAssertions();
        await setContext(OTHER_COACH_ID, 'coach');
        const got = await callScalar<boolean>(
          'SELECT app.is_current_coach_of($1) AS r',
          STUDENT_OF_COACH_ID,
        );
        expect(got).toBe(false);
      });

      it('returns false when client_user_id is NULL', async () => {
        expect.hasAssertions();
        await setContext(COACH_ID, 'coach');
        const got = await callScalar<boolean>(
          'SELECT app.is_current_coach_of(NULL) AS r',
        );
        expect(got).toBe(false);
      });

      // P2-003: positive coach-client path. Audit #1 explicitly noted that
      // the prior suite refused to seed a User row and treated the positive
      // branch as covered by another spec. Fix Round 1 seeds the fixtures
      // in beforeAll and proves the helper returns true under a real
      // coach-client linkage.
      it('returns true when the current user is the configured coach', async () => {
        expect.hasAssertions();
        await setContext(COACH_ID, 'coach');
        const got = await callScalar<boolean>(
          'SELECT app.is_current_coach_of($1) AS r',
          STUDENT_OF_COACH_ID,
        );
        expect(got).toBe(true);
      });
    });

    // ────────────────────────────────────────────────────────────
    // public.enforce_subcoach_head_cap() — trigger function
    // ────────────────────────────────────────────────────────────
    describe('public.enforce_subcoach_head_cap (trigger)', () => {
      const ROW_A = 'rls01-test-tsca-aaaa-0001';
      const ROW_B = 'rls01-test-tsca-aaaa-0002';
      const ROW_C = 'rls01-test-tsca-aaaa-0003';

      // P1-004: prior suite inserted assignments without ever seeding the
      // referenced User rows, which the FK constraint rejected before the
      // trigger could fire. The beforeAll up-stack now seeds HEAD_A/B/C
      // and SUB as User rows, so the trigger semantics actually execute.

      beforeEach(async () => {
        await prisma.$executeRawUnsafe(
          `DELETE FROM "TeamSubCoachAssignment" WHERE id IN ($1,$2,$3)`,
          ROW_A,
          ROW_B,
          ROW_C,
        );
      });

      afterEach(async () => {
        await prisma.$executeRawUnsafe(
          `DELETE FROM "TeamSubCoachAssignment" WHERE id IN ($1,$2,$3)`,
          ROW_A,
          ROW_B,
          ROW_C,
        );
      });

      it('allows the first two head-coach assignments for a sub-coach', async () => {
        expect.hasAssertions();
        await prisma.$executeRawUnsafe(
          `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1, $2, $3)`,
          ROW_A,
          SUB,
          HEAD_A,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1, $2, $3)`,
          ROW_B,
          SUB,
          HEAD_B,
        );
        const count = await callScalar<bigint>(
          `SELECT COUNT(*) AS c FROM "TeamSubCoachAssignment" WHERE sub_coach_id = $1 AND archived_at IS NULL`,
          SUB,
        );
        expect(Number(count)).toBe(2);
      });

      it('rejects a third active assignment past the cap', async () => {
        expect.hasAssertions();
        await prisma.$executeRawUnsafe(
          `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1, $2, $3)`,
          ROW_A,
          SUB,
          HEAD_A,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1, $2, $3)`,
          ROW_B,
          SUB,
          HEAD_B,
        );
        let raised: unknown;
        try {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1, $2, $3)`,
            ROW_C,
            SUB,
            HEAD_C,
          );
        } catch (err) {
          raised = err;
        }
        expect(raised).toBeDefined();
        expect(errorMessage(raised)).toContain('sub_coach_head_cap_exceeded');
      });

      it('allows an archived row to be inserted past the cap (archived branch short-circuits)', async () => {
        expect.hasAssertions();
        await prisma.$executeRawUnsafe(
          `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1, $2, $3)`,
          ROW_A,
          SUB,
          HEAD_A,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1, $2, $3)`,
          ROW_B,
          SUB,
          HEAD_B,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id, archived_at) VALUES ($1, $2, $3, NOW())`,
          ROW_C,
          SUB,
          HEAD_C,
        );
        const activeCount = await callScalar<bigint>(
          `SELECT COUNT(*) AS c FROM "TeamSubCoachAssignment" WHERE sub_coach_id = $1 AND archived_at IS NULL`,
          SUB,
        );
        expect(Number(activeCount)).toBe(2);
        const archivedCount = await callScalar<bigint>(
          `SELECT COUNT(*) AS c FROM "TeamSubCoachAssignment" WHERE sub_coach_id = $1 AND archived_at IS NOT NULL`,
          SUB,
        );
        expect(Number(archivedCount)).toBe(1);
      });
    });

    // ────────────────────────────────────────────────────────────
    // Security flags assertion — the migration outcome itself
    // ────────────────────────────────────────────────────────────
    describe('helper security flags (post-migration)', () => {
      it('reports SECURITY DEFINER + pinned search_path on every targeted helper', async () => {
        expect.hasAssertions();
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT n.nspname AS schema,
                  p.proname AS name,
                  p.prosecdef AS security_definer,
                  p.proconfig AS config
           FROM pg_proc p
           JOIN pg_namespace n ON p.pronamespace = n.oid
           WHERE (n.nspname = 'app' AND p.proname IN
                  ('current_user_id','current_user_role','is_owner','is_current_coach_of'))
              OR (n.nspname = 'public' AND p.proname = 'enforce_subcoach_head_cap')
           ORDER BY n.nspname, p.proname`,
        )) as Array<{
          schema: string;
          name: string;
          security_definer: boolean;
          config: string[] | null;
        }>;
        expect(rows).toHaveLength(5);
        for (const row of rows) {
          expect(row.security_definer).toBe(true);
          expect(row.config).not.toBeNull();
          const joined = (row.config || []).join(' ');
          expect(joined).toContain('search_path=');
          expect(joined).toContain('pg_catalog');
          expect(joined).toContain('public');
          expect(joined).toContain('app');
        }
      });
    });

    // ────────────────────────────────────────────────────────────
    // P1-001: anon role MUST NOT EXECUTE any hardened helper.
    // ────────────────────────────────────────────────────────────
    describe('anon role grant lockdown', () => {
      it('rejects anon role EXECUTE on every hardened helper', async () => {
        expect.hasAssertions();
        const helpers: Array<{ schema: string; name: string; args: string }> = [
          { schema: 'app', name: 'current_user_id', args: '' },
          { schema: 'app', name: 'current_user_role', args: '' },
          { schema: 'app', name: 'is_owner', args: '' },
          { schema: 'app', name: 'is_current_coach_of', args: 'text' },
          {
            schema: 'public',
            name: 'enforce_subcoach_head_cap',
            args: '',
          },
        ];

        for (const h of helpers) {
          // has_function_privilege returns true if EXECUTE is granted to
          // the named role. Per PR-RLS-01 fix-round-1, anon must report
          // false for every hardened helper.
          const sig = `${h.schema}.${h.name}(${h.args})`;
          const row = (await prisma.$queryRawUnsafe(
            `SELECT has_function_privilege('anon', $1, 'EXECUTE') AS has_exec`,
            sig,
          )) as Array<{ has_exec: boolean }>;
          expect(row[0].has_exec).toBe(false);
        }
      });

      it('grants EXECUTE on every hardened helper to authenticated and service_role', async () => {
        expect.hasAssertions();
        const helpers: Array<string> = [
          'app.current_user_id()',
          'app.current_user_role()',
          'app.is_owner()',
          'app.is_current_coach_of(text)',
          'public.enforce_subcoach_head_cap()',
        ];
        for (const sig of helpers) {
          for (const role of ['authenticated', 'service_role']) {
            const row = (await prisma.$queryRawUnsafe(
              `SELECT has_function_privilege($1, $2, 'EXECUTE') AS has_exec`,
              role,
              sig,
            )) as Array<{ has_exec: boolean }>;
            expect(row[0].has_exec).toBe(true);
          }
        }
      });
    });

    // ────────────────────────────────────────────────────────────
    // P2-002: hostile caller search_path must not shadow helper
    // resolution. The migration pins search_path = pg_catalog, public, app
    // on every helper, so even when the caller sets a malicious
    // search_path the helper still resolves built-ins canonically.
    // ────────────────────────────────────────────────────────────
    describe('hostile caller search_path resilience', () => {
      const ATTACKER_SCHEMA = 'rls01_attacker';

      beforeAll(async () => {
        await prisma.$executeRawUnsafe(
          `CREATE SCHEMA IF NOT EXISTS ${ATTACKER_SCHEMA}`,
        );
        // Plant a decoy current_setting that always returns a fixed
        // attacker-controlled string. If the helper resolved
        // current_setting under the caller's search_path it would call
        // this instead of pg_catalog.current_setting.
        await prisma.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION ${ATTACKER_SCHEMA}.current_setting(text, boolean)
           RETURNS text LANGUAGE sql IMMUTABLE
           AS $fn$ SELECT 'attacker-controlled-id'::text $fn$`,
        );
      });

      afterAll(async () => {
        await prisma.$executeRawUnsafe(
          `DROP SCHEMA IF EXISTS ${ATTACKER_SCHEMA} CASCADE`,
        );
      });

      it('app.current_user_id ignores attacker schema even when caller search_path is hostile', async () => {
        expect.hasAssertions();
        await setContext(COACH_ID, 'coach');
        // Point the caller search_path at the attacker schema first.
        await prisma.$executeRawUnsafe(
          `SELECT set_config('search_path', $1, false)`,
          `${ATTACKER_SCHEMA}, public, app`,
        );
        const got = await callScalar<string>(
          'SELECT app.current_user_id() AS id',
        );
        // Helper resolved current_setting via pg_catalog because the
        // pinned search_path overrides the caller's. If shadowing were
        // possible, got would be 'attacker-controlled-id'.
        expect(got).toBe(COACH_ID);
        // Restore the default for subsequent tests.
        await prisma.$executeRawUnsafe(`RESET search_path`);
      });
    });

    // ────────────────────────────────────────────────────────────
    // P1-005: Supabase JWT claim parsing validation.
    //
    // The live helper body reads the app.current_user_id GUC (per
    // audit1_pr268_live_function_defs.json), set by the NestJS
    // interceptor at request time. Audit #1 demanded a JWT-claim parsing
    // path test. This block proves two things:
    //   (a) Setting request.jwt.claims alone does NOT change the
    //       helper's return value — the helper is decoupled from raw
    //       JWT GUCs (intentional, since the NestJS interceptor parses
    //       the JWT and writes app.current_user_id explicitly).
    //   (b) When the interceptor pattern is faithfully reproduced
    //       (read claims, parse sub, write app.current_user_id), the
    //       helper returns that sub.
    //
    // If RLS-02..08 ever migrate to read request.jwt.claims directly,
    // this block must be updated; for now it locks in the canonical
    // GUC-based identity source.
    // ────────────────────────────────────────────────────────────
    describe('JWT claim path (Supabase identity source)', () => {
      const FAKE_SUB = '00000000-0000-0000-0000-000000000001';

      afterEach(async () => {
        // Reset GUCs so cross-test leakage does not occur.
        await prisma.$executeRawUnsafe(`RESET "request.jwt.claims"`);
        await setContext(null, null);
      });

      it('setting request.jwt.claims alone does not populate app.current_user_id() (helper is GUC-based)', async () => {
        expect.hasAssertions();
        await setContext(null, null);
        await prisma.$executeRawUnsafe(
          `SELECT set_config('request.jwt.claims', $1, false)`,
          JSON.stringify({ sub: FAKE_SUB, role: 'authenticated' }),
        );
        const got = await callScalar<string | null>(
          'SELECT app.current_user_id() AS id',
        );
        expect(got).toBeNull();
      });

      it('reproducing the NestJS interceptor pattern (parse jwt sub -> set app.current_user_id) yields the JWT sub', async () => {
        expect.hasAssertions();
        await prisma.$executeRawUnsafe(
          `SELECT set_config('request.jwt.claims', $1, false)`,
          JSON.stringify({ sub: FAKE_SUB, role: 'authenticated' }),
        );
        // Simulate the interceptor: parse JWT, write the GUC the helper
        // actually reads.
        await prisma.$executeRawUnsafe(
          `SELECT set_config(
             'app.current_user_id',
             current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
             false
           )`,
        );
        const got = await callScalar<string>(
          'SELECT app.current_user_id() AS id',
        );
        expect(got).toBe(FAKE_SUB);
      });

      it('JWT path with empty-string sub still returns NULL (NULLIF guard)', async () => {
        expect.hasAssertions();
        await prisma.$executeRawUnsafe(
          `SELECT set_config('request.jwt.claims', $1, false)`,
          JSON.stringify({ sub: '', role: 'authenticated' }),
        );
        await prisma.$executeRawUnsafe(
          `SELECT set_config(
             'app.current_user_id',
             COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', ''),
             false
           )`,
        );
        const got = await callScalar<string | null>(
          'SELECT app.current_user_id() AS id',
        );
        expect(got).toBeNull();
      });
    });
  },
);

// Always-runnable assertion: the migration file exists and contains the
// canonical hardening pattern for each helper. P2-001: this version strips
// SQL comments before counting so a future edit that moves SECURITY DEFINER
// into a comment cannot pass the gate via raw substring matches.
describe('PR-RLS-01 migration file (static checks)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  const migrationPath = path.resolve(
    __dirname,
    '..',
    '..',
    'prisma',
    'migrations',
    '20260704000000_rls01_helper_searchpath_hibp',
    'migration.sql',
  );

  function stripSqlCommentsAndStringLiterals(sql: string): string {
    // Remove line comments (-- ...).
    let out = sql.replace(/--[^\n]*/g, '');
    // Remove block comments /* ... */ (non-greedy, multi-line).
    out = out.replace(/\/\*[\s\S]*?\*\//g, '');
    // Remove single-quoted string literals (handles doubled quotes for
    // escaped quote characters inside strings).
    out = out.replace(/'(?:[^']|'')*'/g, "''");
    // Remove dollar-quoted string literals ($tag$ ... $tag$ and $$ ... $$).
    // We intentionally keep function bodies in the source — but for the
    // strict counting gate we want only the outer DDL pattern, so strip
    // dollar-quoted blocks too.
    out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, '');
    return out;
  }

  it('migration file is present', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('hardens every targeted helper with SECURITY DEFINER + pinned search_path (comment-stripped)', () => {
    const raw = fs.readFileSync(migrationPath, 'utf8');
    const sql = stripSqlCommentsAndStringLiterals(raw);

    const helpers = [
      'app.current_user_id()',
      'app.current_user_role()',
      'app.is_owner()',
      'app.is_current_coach_of(client_user_id text)',
      'public.enforce_subcoach_head_cap()',
    ];
    for (const h of helpers) {
      // CREATE OR REPLACE FUNCTION lines survive the strip because they
      // are bare DDL, not in comments.
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION ${h}`);
    }

    // Each helper has exactly one CREATE OR REPLACE FUNCTION + one
    // SET search_path + one SECURITY DEFINER outside of comments and
    // string literals. Five helpers => five matches each.
    const createMatches = sql.match(/CREATE OR REPLACE FUNCTION/g) || [];
    expect(createMatches.length).toBe(5);

    const pinnedSearchPath =
      sql.match(/SET search_path = pg_catalog, public, app/g) || [];
    expect(pinnedSearchPath.length).toBe(5);

    const securityDefiner = sql.match(/SECURITY DEFINER/g) || [];
    expect(securityDefiner.length).toBe(5);

    // ACL pattern (P1-001): five REVOKE-from-PUBLIC, five REVOKE-from-anon,
    // five GRANT-to-authenticated-service_role. is_user_coached_by is no
    // longer touched (P2-008).
    const revokePublic = sql.match(/REVOKE ALL ON FUNCTION/g) || [];
    expect(revokePublic.length).toBe(5);

    const revokeAnon = sql.match(/REVOKE EXECUTE ON FUNCTION[^;]+FROM anon/g) || [];
    expect(revokeAnon.length).toBe(5);

    const grantAuth =
      sql.match(/GRANT EXECUTE ON FUNCTION[^;]+TO authenticated, service_role/g) ||
      [];
    expect(grantAuth.length).toBe(5);

    // Defensive: no helper still grants to anon after the fix.
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]+TO[^;]*\banon\b/);
  });
});
