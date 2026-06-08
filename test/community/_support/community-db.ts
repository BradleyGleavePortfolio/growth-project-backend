/**
 * Shared live-Postgres harness for the Community v1-1 schema + RLS specs.
 *
 * There is no pre-existing live-DB harness under `test/` in this repo — the
 * established RLS file (prisma/migrations/rls_fitness_backend.sql) is exercised
 * only against deployed Supabase, not in Jest. So this module provides a small,
 * self-contained harness that connects to a disposable Postgres ONLY when
 * `COMMUNITY_TEST_DATABASE_URL` is set AND the optional `pg` driver is
 * installed. When either is missing the live suites skip with a logged reason
 * (never a silent pass); the static-artifact assertions in the same spec files
 * still run and carry the schema verification.
 *
 * To run the live suites locally:
 *   1. Start a throwaway Postgres (e.g. `docker run -e POSTGRES_PASSWORD=pw -p
 *      55432:5432 postgres:16`).
 *   2. `npm i -D pg @types/pg`
 *   3. COMMUNITY_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres \
 *        npx jest test/community --runInBand
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const MIGRATION_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
  '20261212000000_community_v1_1_schema',
);

export const MIGRATION_SQL_PATH = join(MIGRATION_DIR, 'migration.sql');

/** Raw text of the v1-1 community migration. */
export function readCommunityMigrationSql(): string {
  return readFileSync(MIGRATION_SQL_PATH, 'utf8');
}

/** The full prisma schema text. */
export function readPrismaSchema(): string {
  return readFileSync(
    join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'),
    'utf8',
  );
}

/** Disposable Postgres URL for live tests, or null when not configured. */
export function liveDbUrl(): string | null {
  const url = process.env.COMMUNITY_TEST_DATABASE_URL;
  return url && url.length > 0 ? url : null;
}

/**
 * Minimal structural contract for the bits of `pg` we use. Declared locally so
 * the spec compiles without `@types/pg` installed; the real driver satisfies it
 * at runtime.
 */
export interface LiveQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}
export interface LiveClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<LiveQueryResult>;
  end(): Promise<void>;
}
interface PgClientCtor {
  new (config: { connectionString: string }): LiveClient;
}
interface PgModule {
  Client: PgClientCtor;
}

/**
 * Dynamically resolve the optional `pg` driver. Returns null (with a logged
 * reason) when it is not installed, so the live suite can skip cleanly instead
 * of failing to import. The require is wrapped because `pg` is intentionally
 * not a hard dependency of this schema-only PR.
 */
export function loadPg(): PgModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod: PgModule = require('pg');
    return mod;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      '[community-db] optional `pg` driver not installed — live DB suite skipped. ' +
        'Run `npm i -D pg` to enable it.',
    );
    return null;
  }
}

/** Connect a fresh live client to the disposable DB. */
export async function connect(url: string): Promise<LiveClient | null> {
  const pg = loadPg();
  if (!pg) {
    return null;
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** The 11 community table names, child→parent order for safe teardown. */
export const COMMUNITY_TABLES = [
  'community_moderation_actions',
  'community_challenge_participations',
  'community_challenges',
  'community_event_rsvps',
  'community_events',
  'community_responses',
  'community_posts',
  'community_messages',
  'community_memberships',
  'community_cohorts',
  'community_workspaces',
];

export const COMMUNITY_ENUMS = [
  'CommunityCohortStatus',
  'CommunityMembershipRole',
  'CommunityMembershipStatus',
  'CommunityMessageScope',
  'CommunityMessageKind',
  'CommunityPostScope',
  'CommunityPostType',
  'CommunityResponseTargetType',
  'CommunityEventState',
  'CommunityEventRsvpStatus',
  'CommunityChallengeStatus',
  'CommunityModerationTargetType',
  'CommunityModerationStatus',
];

/**
 * Apply the v1-1 migration into the disposable database's public schema and
 * replay the migration SQL verbatim. A minimal "User" table is created first so
 * the community FKs resolve (the real app User table is out of scope for a
 * schema-only disposable run). Intended for a THROWAWAY database/container
 * (see the file header); the matching migrationDown removes every community
 * object so the same DB can be reused across runs.
 */
export async function applyMigration(client: LiveClient): Promise<void> {
  await migrationDown(client); // start clean / idempotent
  // pgcrypto provides gen_random_uuid() used by the partitioned table default.
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  // Minimal User table so the community FKs resolve.
  await client.query(
    'CREATE TABLE IF NOT EXISTS "User" ("id" UUID PRIMARY KEY DEFAULT gen_random_uuid())',
  );
  await client.query(readCommunityMigrationSql());
}

/**
 * Reverse of applyMigration: drop every community table (CASCADE clears
 * partitions + FKs), the community enums, and the partition helper function.
 * The shared `app.current_user_id()` helper and `app` schema are left intact —
 * they are shared infrastructure also used by the fitness RLS file, matching
 * the documented rollback in rls_fitness_backend.sql.
 */
export async function migrationDown(client: LiveClient): Promise<void> {
  for (const table of COMMUNITY_TABLES) {
    await client.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  }
  await client.query(
    'DROP FUNCTION IF EXISTS community_messages_create_month_partition(DATE)',
  );
  await client.query(
    'DROP FUNCTION IF EXISTS app.is_community_workspace_coach(uuid)',
  );
  await client.query(
    'DROP FUNCTION IF EXISTS app.is_community_workspace_member(uuid)',
  );
  await client.query(
    'DROP FUNCTION IF EXISTS app.shares_community_cohort(uuid)',
  );
  for (const enumName of COMMUNITY_ENUMS) {
    await client.query(`DROP TYPE IF EXISTS "${enumName}"`);
  }
}

/** Set the RLS session identity (the authenticated User.id) for this client. */
export async function setSessionUser(
  client: LiveClient,
  userId: string,
): Promise<void> {
  // set_config with is_local=false so it persists for the session (each test
  // uses its own client connection). Parameterized to avoid injection.
  await client.query("SELECT set_config('app.current_user_id', $1, false)", [
    userId,
  ]);
}

/** Clear the RLS session identity (simulate an unauthenticated caller). */
export async function clearSessionUser(client: LiveClient): Promise<void> {
  await client.query("SELECT set_config('app.current_user_id', '', false)");
}

/**
 * Name of the non-privileged role RLS tests run as. A throwaway Postgres
 * container connects as the `postgres` superuser, which BYPASSES RLS even with
 * FORCE ROW LEVEL SECURITY — so RLS assertions would be meaningless on that
 * connection. We create a plain LOGIN role without BYPASSRLS, grant it DML +
 * usage, and run the policy assertions through a session that has SET ROLE to
 * it. This mirrors how the Supabase `authenticated`/`anon` roles (no BYPASSRLS)
 * see the deployed policies.
 */
export const RLS_TEST_ROLE = 'community_rls_test_role';

/**
 * Create (idempotently) the non-privileged RLS test role and grant it the
 * privileges needed to exercise the community tables. Must be run on a
 * superuser/owner connection (the disposable DB's default).
 */
export async function ensureRlsTestRole(client: LiveClient): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_TEST_ROLE}') THEN
        CREATE ROLE "${RLS_TEST_ROLE}" NOLOGIN NOBYPASSRLS;
      END IF;
    END
    $$;
  `);
  await client.query(`GRANT USAGE ON SCHEMA public TO "${RLS_TEST_ROLE}"`);
  await client.query(`GRANT USAGE ON SCHEMA app TO "${RLS_TEST_ROLE}"`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${RLS_TEST_ROLE}"`,
  );
  await client.query(
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO "${RLS_TEST_ROLE}"`,
  );
}

/** Enter the non-privileged role for subsequent RLS-checked statements. */
export async function assumeRlsRole(client: LiveClient): Promise<void> {
  await client.query(`SET ROLE "${RLS_TEST_ROLE}"`);
}

/** Return to the owning role (for setup/teardown that needs full privileges). */
export async function resetRole(client: LiveClient): Promise<void> {
  await client.query('RESET ROLE');
}
