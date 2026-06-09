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
      // P1-004 (fix round 1): the prior version only checked that
      // pg_catalog/public/app appeared SOMEWHERE in proconfig, which the
      // buggy missing-pg_temp string also satisfied. We now assert the
      // EXACT proconfig value with pg_temp LAST, plus the canonical
      // pg_get_functiondef() output.
      const EXPECTED_SEARCH_PATH = 'pg_catalog, public, app, pg_temp';

      it('reports SECURITY DEFINER + exact pinned search_path (pg_temp last) on every targeted helper', async () => {
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
          // proconfig is a text[] of GUC=value settings. Exactly one entry
          // must be the search_path, and it must equal the hardened string
          // verbatim — no more, no less.
          const searchPathEntries = (row.config || []).filter((c) =>
            c.startsWith('search_path='),
          );
          expect(searchPathEntries).toHaveLength(1);
          const value = searchPathEntries[0].slice('search_path='.length);
          expect(value).toBe(EXPECTED_SEARCH_PATH);

          // pg_temp must be the LAST element of the resolution order.
          const elements = value.split(',').map((s) => s.trim());
          expect(elements[elements.length - 1]).toBe('pg_temp');
          // ...and appear exactly once (no duplicate/earlier pg_temp).
          expect(elements.filter((e) => e === 'pg_temp')).toHaveLength(1);
        }
      });

      it('emits canonical pg_get_functiondef() search_path clause with pg_temp last for every helper', async () => {
        expect.hasAssertions();
        const helperRegclasses: Array<string> = [
          'app.current_user_id()',
          'app.current_user_role()',
          'app.is_owner()',
          'app.is_current_coach_of(text)',
          'public.enforce_subcoach_head_cap()',
        ];
        for (const sig of helperRegclasses) {
          const def = await callScalar<string>(
            `SELECT pg_get_functiondef($1::regprocedure) AS def`,
            sig,
          );
          // Postgres canonical form quotes EACH search_path element and
          // joins with ", ", using TO (older/newer servers may render `=`):
          //   SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
          // Normalize by stripping the per-element single quotes, then assert
          // the exact ordered clause with pg_temp last.
          const normalized = def.replace(/'/g, '');
          expect(normalized).toMatch(
            /SET search_path (?:TO|=) pg_catalog, public, app, pg_temp\b/,
          );
          // Negative guard: the unsafe (missing pg_temp) clause must be
          // absent — the app-terminated form NOT followed by pg_temp.
          expect(normalized).not.toMatch(
            /SET search_path (?:TO|=) pg_catalog, public, app(?!, pg_temp)/,
          );
          expect(def).toContain('SECURITY DEFINER');
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

        // P1-003 (fix round 1): plant a same-NAME decoy in the attacker
        // schema for EVERY hardened helper plus the built-ins their bodies
        // resolve. Each decoy returns an attacker-controlled value so that
        // if the hardened helper resolved any unqualified reference under
        // the caller's hostile search_path, the observable result would
        // change. The pinned `search_path = pg_catalog, public, app,
        // pg_temp` must make all of these inert.

        // Decoy built-in current_setting (chained by current_user_id /
        // current_user_role bodies).
        await prisma.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION ${ATTACKER_SCHEMA}.current_setting(text, boolean)
           RETURNS text LANGUAGE sql IMMUTABLE
           AS $fn$ SELECT 'attacker-controlled-id'::text $fn$`,
        );

        // Same-name decoy for each app.* helper. If a caller-controlled
        // search_path could win, an unqualified call to e.g. is_owner()
        // chained inside another helper would hit these and flip the result.
        await prisma.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION ${ATTACKER_SCHEMA}.current_user_id()
           RETURNS text LANGUAGE sql IMMUTABLE
           AS $fn$ SELECT 'attacker-controlled-id'::text $fn$`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION ${ATTACKER_SCHEMA}.current_user_role()
           RETURNS text LANGUAGE sql IMMUTABLE
           AS $fn$ SELECT 'owner'::text $fn$`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION ${ATTACKER_SCHEMA}.is_owner()
           RETURNS boolean LANGUAGE sql IMMUTABLE
           AS $fn$ SELECT true $fn$`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION ${ATTACKER_SCHEMA}.is_current_coach_of(text)
           RETURNS boolean LANGUAGE sql IMMUTABLE
           AS $fn$ SELECT true $fn$`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION ${ATTACKER_SCHEMA}.is_user_coached_by(text, text)
           RETURNS boolean LANGUAGE sql IMMUTABLE
           AS $fn$ SELECT true $fn$`,
        );
      });

      afterAll(async () => {
        await prisma.$executeRawUnsafe(
          `DROP SCHEMA IF EXISTS ${ATTACKER_SCHEMA} CASCADE`,
        );
        await prisma.$executeRawUnsafe(`RESET search_path`);
      });

      async function withHostileSearchPath<T>(fn: () => Promise<T>): Promise<T> {
        // Point the caller search_path at the attacker schema FIRST so any
        // unqualified resolution inside the helper would prefer the decoys.
        await prisma.$executeRawUnsafe(
          `SELECT set_config('search_path', $1, false)`,
          `${ATTACKER_SCHEMA}, public, app`,
        );
        try {
          return await fn();
        } finally {
          await prisma.$executeRawUnsafe(`RESET search_path`);
        }
      }

      it('app.current_user_id resists attacker-schema current_setting + same-name decoy', async () => {
        expect.hasAssertions();
        await setContext(COACH_ID, 'coach');
        const got = await withHostileSearchPath(() =>
          callScalar<string>('SELECT app.current_user_id() AS id'),
        );
        // If shadowing were possible, got would be 'attacker-controlled-id'.
        expect(got).toBe(COACH_ID);
      });

      it('app.current_user_role resists attacker-schema decoys', async () => {
        expect.hasAssertions();
        await setContext(COACH_ID, 'coach');
        const got = await withHostileSearchPath(() =>
          callScalar<string>('SELECT app.current_user_role() AS role'),
        );
        expect(got).toBe('coach');
      });

      it('app.is_owner resists attacker-schema decoys (does not return forced true)', async () => {
        expect.hasAssertions();
        // Authenticated NON-owner: a successful shadow of current_user_role
        // (decoy returns 'owner') or is_owner itself (decoy returns true)
        // would flip this to true.
        await setContext(COACH_ID, 'coach');
        const got = await withHostileSearchPath(() =>
          callScalar<boolean>('SELECT app.is_owner() AS is_owner'),
        );
        expect(got).toBe(false);
      });

      it('app.is_current_coach_of resists attacker-schema decoys (does not return forced true)', async () => {
        expect.hasAssertions();
        // OTHER_COACH has no coaching link to STUDENT_OF_COACH_ID; a shadow
        // of is_user_coached_by (decoy returns true) or is_current_coach_of
        // itself would flip this to true.
        await setContext(OTHER_COACH_ID, 'coach');
        const got = await withHostileSearchPath(() =>
          callScalar<boolean>(
            'SELECT app.is_current_coach_of($1) AS r',
            STUDENT_OF_COACH_ID,
          ),
        );
        expect(got).toBe(false);
      });

      it('public.enforce_subcoach_head_cap still enforces the cap under a hostile caller search_path', async () => {
        expect.hasAssertions();
        const R1 = 'rls01-test-tsca-hostile-0001';
        const R2 = 'rls01-test-tsca-hostile-0002';
        const R3 = 'rls01-test-tsca-hostile-0003';
        await prisma.$executeRawUnsafe(
          `DELETE FROM "TeamSubCoachAssignment" WHERE id IN ($1,$2,$3)`,
          R1,
          R2,
          R3,
        );
        try {
          await withHostileSearchPath(async () => {
            await prisma.$executeRawUnsafe(
              `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1,$2,$3)`,
              R1,
              SUB,
              HEAD_A,
            );
            await prisma.$executeRawUnsafe(
              `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1,$2,$3)`,
              R2,
              SUB,
              HEAD_B,
            );
          });
          let raised: unknown;
          try {
            await withHostileSearchPath(() =>
              prisma.$executeRawUnsafe(
                `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1,$2,$3)`,
                R3,
                SUB,
                HEAD_C,
              ),
            );
          } catch (err) {
            raised = err;
          }
          expect(raised).toBeDefined();
          expect(errorMessage(raised)).toContain('sub_coach_head_cap_exceeded');
        } finally {
          await prisma.$executeRawUnsafe(
            `DELETE FROM "TeamSubCoachAssignment" WHERE id IN ($1,$2,$3)`,
            R1,
            R2,
            R3,
          );
        }
      });
    });

    // ────────────────────────────────────────────────────────────
    // P1-003 (fix round 1): pg_temp relation-shadow test. This is the
    // test that proves pg_temp-LAST positioning matters. The trigger
    // function public.enforce_subcoach_head_cap() counts rows from the
    // UNQUALIFIED relation "TeamSubCoachAssignment". If pg_temp were
    // searched before public, a session that created a temp table of the
    // same name (seeded so the cap check reads 0 rows) could defeat the
    // cap. With pg_temp pinned LAST, the count must resolve against
    // public."TeamSubCoachAssignment" and the cap must still fire.
    // ────────────────────────────────────────────────────────────
    describe('pg_temp relation-shadow on enforce_subcoach_head_cap', () => {
      const R1 = 'rls01-test-tsca-temp-0001';
      const R2 = 'rls01-test-tsca-temp-0002';
      const R3 = 'rls01-test-tsca-temp-0003';

      afterEach(async () => {
        await prisma.$executeRawUnsafe(
          `DROP TABLE IF EXISTS pg_temp."TeamSubCoachAssignment"`,
        );
        await prisma.$executeRawUnsafe(`RESET search_path`);
        await prisma.$executeRawUnsafe(
          `DELETE FROM "TeamSubCoachAssignment" WHERE id IN ($1,$2,$3)`,
          R1,
          R2,
          R3,
        );
      });

      it('cap check resolves against public.TeamSubCoachAssignment, not a pg_temp decoy', async () => {
        expect.hasAssertions();

        // Two real (public) active assignments => sub-coach is AT the cap.
        await prisma.$executeRawUnsafe(
          `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1,$2,$3)`,
          R1,
          SUB,
          HEAD_A,
        );
        await prisma.$executeRawUnsafe(
          `INSERT INTO "TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1,$2,$3)`,
          R2,
          SUB,
          HEAD_B,
        );

        // Plant an EMPTY temp table of the same name. If the trigger body
        // resolved "TeamSubCoachAssignment" against pg_temp (i.e. pg_temp
        // were not last), it would count 0 rows and wrongly allow a 3rd.
        await prisma.$executeRawUnsafe(
          `CREATE TEMP TABLE "TeamSubCoachAssignment"
             (id text, sub_coach_id text, head_coach_id text, archived_at timestamptz)`,
        );
        // Make pg_temp explicitly first in the CALLER search_path; the
        // function's own pinned search_path (pg_temp last) must still win.
        await prisma.$executeRawUnsafe(
          `SELECT set_config('search_path', 'pg_temp, public, app', false)`,
        );

        let raised: unknown;
        try {
          await prisma.$executeRawUnsafe(
            `INSERT INTO public."TeamSubCoachAssignment" (id, sub_coach_id, head_coach_id) VALUES ($1,$2,$3)`,
            R3,
            SUB,
            HEAD_C,
          );
        } catch (err) {
          raised = err;
        }
        // Cap must still fire — proving public won resolution over pg_temp.
        expect(raised).toBeDefined();
        expect(errorMessage(raised)).toContain('sub_coach_head_cap_exceeded');
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

    // P1-004 (fix round 1): assert the EXACT hardened string with pg_temp
    // pinned LAST on all five helpers, not just the unsafe prefix. The old
    // gate matched `pg_catalog, public, app` which the buggy missing-pg_temp
    // string also satisfied.
    const pinnedSearchPath =
      sql.match(/SET search_path = pg_catalog, public, app, pg_temp\b/g) || [];
    expect(pinnedSearchPath.length).toBe(5);

    // Defensive: no active SET search_path clause may omit pg_temp. Any
    // `SET search_path = pg_catalog, public, app` NOT immediately followed
    // by `, pg_temp` is the regression this PR fixes.
    const missingPgTemp =
      sql.match(/SET search_path = pg_catalog, public, app(?!, pg_temp)/g) || [];
    expect(missingPgTemp.length).toBe(0);

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
