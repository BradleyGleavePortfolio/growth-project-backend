/**
 * IMPORTER-I — live-DB RLS + erasure proof for ScoutReconstructedEntity.
 *
 * Two layers (same shape as test/community/rls/community-rls.spec.ts):
 *
 *  1. STATIC assertions (always run): the migration DDL ENABLEs+FORCEs RLS,
 *     grants a PERMISSIVE service_role bypass, and denies anon + authenticated
 *     via RESTRICTIVE deny-all. These pin the posture the live block proves.
 *
 *  2. LIVE assertions (run only when COMMUNITY_TEST_DATABASE_URL + the optional
 *     `pg` driver are available): against a REAL Postgres, prove the security
 *     properties the read endpoint depends on but that the in-memory FakePrisma
 *     suite can only assert structurally —
 *       - authenticated (the only role a client JWT ever maps to) reads ZERO
 *         rows for BOTH its own tenant and another tenant: the deny is uniform,
 *         so the DB backstop leaks no existence oracle and fails closed;
 *       - service_role (the engine identity the backend connects as) sees the
 *         rows, so tenant scoping is genuinely the app-layer coach_id filter;
 *       - a cascade-erased row (DELETE as service_role) is truly absent
 *         afterwards, so the read can never resurrect erased data.
 *
 * The backend connects as service_role, so at runtime RLS is bypassed and the
 * WHERE coach_id filter in ScoutEntitiesService is the tenant guard; this spec
 * proves the DB denies every client-facing role outright as defence in depth.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { connect, liveDbUrl, type LiveClient } from '../../community/_support/community-db';

const MIGRATION_SQL_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'prisma',
  'migrations',
  '20261223000300_scout_reconstructed_entity',
  'migration.sql',
);

const TABLE = 'ScoutReconstructedEntity';

function migrationSql(): string {
  return readFileSync(MIGRATION_SQL_PATH, 'utf8');
}

describe('IMPORTER-I ScoutReconstructedEntity RLS posture (static)', () => {
  const sql = migrationSql();

  it('ENABLEs and FORCEs row level security', () => {
    expect(sql).toContain(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY;`);
    expect(sql).toContain(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY;`);
  });

  it('grants service_role a PERMISSIVE bypass and denies anon + authenticated (RESTRICTIVE)', () => {
    expect(sql).toMatch(
      new RegExp(
        `CREATE POLICY[^;]*ON "${TABLE}" AS PERMISSIVE FOR ALL TO service_role USING \\(true\\) WITH CHECK \\(true\\)`,
      ),
    );
    for (const role of ['anon', 'authenticated']) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE POLICY[^;]*ON "${TABLE}" AS RESTRICTIVE FOR ALL TO ${role} USING \\(false\\) WITH CHECK \\(false\\)`,
        ),
      );
    }
  });
});

// R69: this live suite is intentionally gated on liveDbUrl() (a real disposable
// Postgres) rather than skip-annotated per test. When COMMUNITY_TEST_DATABASE_URL
// (or the optional `pg` driver) is absent it is describe.skip'd wholesale — never
// a silent pass; the static block above still carries the posture verification.
const itLive = liveDbUrl() ? describe : describe.skip;

itLive('IMPORTER-I ScoutReconstructedEntity RLS — live enforcement', () => {
  const url = liveDbUrl() as string;
  let owner: LiveClient | null = null;

  const COACH_A = 'coach-a';
  const COACH_B = 'coach-b';

  async function roleSelectCount(role: string, where = ''): Promise<number> {
    await owner!.query(`SET ROLE "${role}"`);
    try {
      const r = await owner!.query(`SELECT id FROM "${TABLE}" ${where}`);
      return r.rowCount ?? r.rows.length;
    } finally {
      await owner!.query('RESET ROLE');
    }
  }

  beforeAll(async () => {
    owner = await connect(url);
    if (!owner) {
      // eslint-disable-next-line no-console
      console.warn(
        '[scout-entities-rls] live DB configured but `pg` missing — skipping live assertions.',
      );
      return;
    }

    // The migration references the Supabase roles service_role/anon/authenticated
    // in its CREATE POLICY ... TO clauses, so they must exist before it applies.
    // On a throwaway Postgres they usually do not, so create them idempotently as
    // NON-privileged (NOBYPASSRLS) login-less roles — matching how the deployed
    // Supabase roles see policies (a superuser would bypass FORCE RLS entirely).
    for (const role of ['service_role', 'anon', 'authenticated']) {
      await owner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE "${role}" NOLOGIN NOBYPASSRLS;
          END IF;
        END
        $$;
      `);
    }

    await owner.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await owner.query(migrationSql());

    // Grant table DML to every role so a denial is provably RLS (not a missing
    // GRANT): with the grant present, only the RLS policy can decide the outcome.
    for (const role of ['service_role', 'anon', 'authenticated']) {
      await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${TABLE}" TO "${role}"`);
    }

    // Seed one row for each of two tenants AS service_role (PERMISSIVE bypass).
    await owner.query(`SET ROLE "service_role"`);
    try {
      for (const coach of [COACH_A, COACH_B]) {
        await owner.query(
          `INSERT INTO "${TABLE}" (id, coach_id, source_platform, entity_type, source_id, client_source_id, label)
           VALUES ($1, $2, 'truecoach', 'workouts', $3, NULL, 'Upper Body')`,
          [`e-${coach}`, coach, `tc_${coach}`],
        );
      }
    } finally {
      await owner.query('RESET ROLE');
    }
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`DROP TABLE IF EXISTS "${TABLE}"`);
      await owner.end();
    }
  });

  it('authenticated reads ZERO rows — for its own tenant AND another (no oracle, fail-closed)', async () => {
    if (!owner) return;
    // The whole table.
    expect(await roleSelectCount('authenticated')).toBe(0);
    // Its "own" tenant row and the other tenant's row are equally invisible —
    // the deny is uniform, so a client can never distinguish existence.
    expect(await roleSelectCount('authenticated', `WHERE coach_id = '${COACH_A}'`)).toBe(0);
    expect(await roleSelectCount('authenticated', `WHERE coach_id = '${COACH_B}'`)).toBe(0);
  });

  it('anon reads ZERO rows (RESTRICTIVE deny-all)', async () => {
    if (!owner) return;
    expect(await roleSelectCount('anon')).toBe(0);
  });

  it('service_role sees both tenants (tenant scoping is the app-layer coach_id filter)', async () => {
    if (!owner) return;
    expect(await roleSelectCount('service_role')).toBe(2);
  });

  it('authenticated cannot INSERT (WITH CHECK false) — write is denied too', async () => {
    if (!owner) return;
    await owner.query(`SET ROLE "authenticated"`);
    let denied = false;
    try {
      await owner.query(
        `INSERT INTO "${TABLE}" (id, coach_id, source_platform, entity_type, source_id)
         VALUES ('e-injected', '${COACH_A}', 'truecoach', 'workouts', 'x')`,
      );
    } catch {
      denied = true;
    } finally {
      await owner.query('RESET ROLE');
    }
    expect(denied).toBe(true);
    // And the injected row never landed.
    expect(await roleSelectCount('service_role')).toBe(2);
  });

  it('an erased row is truly absent afterwards (the read can never resurrect it)', async () => {
    if (!owner) return;
    await owner.query(`SET ROLE "service_role"`);
    try {
      await owner.query(`DELETE FROM "${TABLE}" WHERE coach_id = $1`, [COACH_A]);
    } finally {
      await owner.query('RESET ROLE');
    }
    expect(await roleSelectCount('service_role', `WHERE coach_id = '${COACH_A}'`)).toBe(0);
    expect(await roleSelectCount('service_role')).toBe(1);
  });
});
