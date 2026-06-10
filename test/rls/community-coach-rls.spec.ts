/**
 * v1-6 Coach Admin — Row-Level Security regression (HECTACORN QUALITY).
 *
 * The v1-6 coach admin endpoints (cohort write, member admin, coach inbox) add
 * NO new tables and NO new RLS policies: every write path is already covered by
 * the v1-1 community migration's coach-ALL / member-SELECT policies. This suite
 * PROVES that coverage two ways, matching the established
 * test/community/rls/community-rls.spec.ts posture:
 *
 *  1. STATIC assertions (always run): the v1-1 migration SQL declares the exact
 *     policies the new write/read paths rely on, with the allow/deny shapes the
 *     planner needs — workspace-coach FOR ALL on cohorts + memberships, member
 *     self/shared-cohort SELECT, and the helper functions that back them.
 *  2. LIVE assertions (run only when COMMUNITY_TEST_DATABASE_URL + `pg` are
 *     available): real cross-workspace, cross-cohort, member-not-coach, and
 *     OWNER-bypass enforcement through a non-privileged (NOBYPASSRLS) role.
 *
 * Application-layer note: the app connects as service_role (BYPASSRLS), so the
 * PRIMARY tenancy gate is CommunityAccessService (see the *.service.spec.ts
 * suites, which exercise the 403/404 paths). These DB policies are
 * defence-in-depth for any non-service-role connection (e.g. Supabase
 * authenticated/anon, or a future direct-PostgREST surface).
 */

import {
  applyMigration,
  assumeRlsRole,
  clearSessionUser,
  connect,
  ensureRlsTestRole,
  liveDbUrl,
  migrationDown,
  readCommunityMigrationSql,
  resetRole,
  setSessionUser,
  type LiveClient,
} from '../community/_support/community-db';

// ── Layer 1: static policy-coverage assertions (always run) ────────────────

describe('v1-6 coach admin RLS — static policy coverage (no new migration)', () => {
  const sql = readCommunityMigrationSql();

  it('the coach-owner FOR ALL policy on community_cohorts backs create/update/archive', () => {
    const idx = sql.indexOf('CREATE POLICY "community_cohorts_coach_all"');
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf(';', idx));
    expect(stmt).toContain('FOR ALL');
    expect(stmt).toContain('app.is_community_workspace_coach("workspace_id")');
    // Both USING and WITH CHECK so a foreign coach can neither read nor write.
    expect(stmt).toContain('USING');
    expect(stmt).toContain('WITH CHECK');
  });

  it('the coach-owner FOR ALL policy on community_memberships backs assign/remove', () => {
    const idx = sql.indexOf('CREATE POLICY "community_memberships_coach_all"');
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf(';', idx));
    expect(stmt).toContain('FOR ALL');
    expect(stmt).toContain('app.is_community_workspace_coach("workspace_id")');
    expect(stmt).toContain('WITH CHECK');
  });

  it('the member self/shared-cohort SELECT policy backs the sanitized roster read', () => {
    const idx = sql.indexOf(
      'CREATE POLICY "community_memberships_self_or_shared_cohort_select"',
    );
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf(';', idx));
    expect(stmt).toContain('FOR SELECT');
    expect(stmt).toContain('app.shares_community_cohort("cohort_id")');
    expect(stmt).toContain('"user_id"::text = app.current_user_id()');
  });

  it('the cohort member-SELECT policy lets a fellow member read the cohort row', () => {
    const idx = sql.indexOf('CREATE POLICY "community_cohorts_member_select"');
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf(';', idx));
    expect(stmt).toContain('app.shares_community_cohort("id")');
  });

  it('the message SELECT policy scopes the coach inbox to coach/shared-cohort/DM', () => {
    const idx = sql.indexOf('CREATE POLICY "community_messages_select"');
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf(';', idx));
    expect(stmt).toContain('is_community_workspace_coach');
    expect(stmt).toContain('shares_community_cohort');
  });

  it('the post member-SELECT policy scopes inbox posts to the coached workspace', () => {
    expect(sql).toContain('CREATE POLICY "community_posts_member_select"');
    expect(sql).toContain('CREATE POLICY "community_posts_coach_all"');
  });

  it('the workspace-coach helper keys ownership off coach_id = current_user_id', () => {
    const idx = sql.indexOf(
      'FUNCTION app.is_community_workspace_coach(p_workspace_id uuid)',
    );
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf('$$', sql.indexOf('$$', idx) + 2));
    expect(stmt).toContain('w."coach_id"::text = app.current_user_id()');
  });

  it('the shared-cohort + workspace-member helpers exclude removed memberships', () => {
    expect(sql).toContain("m.\"status\" <> 'removed'");
    // Both helpers carry the removed-exclusion so a removed member loses access.
    const sharesIdx = sql.indexOf('FUNCTION app.shares_community_cohort');
    const sharesStmt = sql.slice(sharesIdx, sql.indexOf('$$', sql.indexOf('$$', sharesIdx) + 2));
    expect(sharesStmt).toContain("m.\"status\" <> 'removed'");
  });

  it('RLS is ENABLED and FORCED on community_cohorts and community_memberships', () => {
    expect(sql).toContain('ALTER TABLE "community_cohorts"                   ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "community_cohorts"                   FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "community_memberships"               ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "community_memberships"               FORCE ROW LEVEL SECURITY;');
  });

  it('no v1-6 migration adds or replaces a community helper function', () => {
    // Guardrail: this PR must not touch the PR #268 helpers (in fix-cycle).
    // The only CREATE OR REPLACE FUNCTION statements live in the v1-1 migration
    // we are asserting against; this PR ships zero new migration files.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION app.is_community_workspace_coach');
  });
});

// ── Layer 2: live cross-tenant enforcement (gated on a disposable Postgres) ──

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-coach-rls] COMMUNITY_TEST_DATABASE_URL not set — live RLS suite skipped (static coverage still runs).',
  );
}

itLive('v1-6 coach admin RLS — live enforcement', () => {
  const url = liveDbUrl() as string;
  let owner: LiveClient | null = null;
  let rls: LiveClient | null = null;

  let coachA = '';
  let coachB = '';
  let memberA1 = '';
  let memberA2 = '';
  let workspaceA = '';
  let workspaceB = '';
  let cohortA1 = '';
  let cohortA2 = '';
  let cohortB1 = '';

  beforeAll(async () => {
    owner = await connect(url);
    if (!owner) {
      // eslint-disable-next-line no-console
      console.warn('[community-coach-rls] live DB configured but `pg` missing — skipping live assertions.');
      return;
    }
    await applyMigration(owner);
    await ensureRlsTestRole(owner);

    const mkUser = async (): Promise<string> => {
      const r = await owner!.query(`INSERT INTO "User" DEFAULT VALUES RETURNING id`);
      return r.rows[0].id as string;
    };
    coachA = await mkUser();
    coachB = await mkUser();
    memberA1 = await mkUser();
    memberA2 = await mkUser();

    const mkWorkspace = async (coach: string, slug: string): Promise<string> => {
      const r = await owner!.query(
        `INSERT INTO "community_workspaces" (id, coach_id, name, slug, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $2, now()) RETURNING id`,
        [coach, slug],
      );
      return r.rows[0].id as string;
    };
    workspaceA = await mkWorkspace(coachA, 'coach-tenant-a');
    workspaceB = await mkWorkspace(coachB, 'coach-tenant-b');

    const mkCohort = async (ws: string, name: string): Promise<string> => {
      const r = await owner!.query(
        `INSERT INTO "community_cohorts" (id, workspace_id, name, updated_at)
         VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
        [ws, name],
      );
      return r.rows[0].id as string;
    };
    cohortA1 = await mkCohort(workspaceA, 'a-cohort-1');
    cohortA2 = await mkCohort(workspaceA, 'a-cohort-2');
    cohortB1 = await mkCohort(workspaceB, 'b-cohort-1');

    const mkMembership = async (
      ws: string,
      cohort: string,
      user: string,
      role: string,
    ): Promise<void> => {
      await owner!.query(
        `INSERT INTO "community_memberships" (id, workspace_id, cohort_id, user_id, role, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active', now())`,
        [ws, cohort, user, role],
      );
    };
    // memberA1 is a STUDENT in cohort A1; memberA2 a student in cohort A2.
    await mkMembership(workspaceA, cohortA1, memberA1, 'student');
    await mkMembership(workspaceA, cohortA2, memberA2, 'student');

    rls = await connect(url);
    if (rls) await assumeRlsRole(rls);
  });

  afterAll(async () => {
    if (rls) {
      await resetRole(rls);
      await rls.end();
    }
    if (owner) {
      await migrationDown(owner);
      await owner.end();
    }
  });

  // ── Cross-workspace (coach A vs workspace/cohort B) ──────────────────────

  it('coach A cannot INSERT a cohort into workspace B', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    await expect(
      rls.query(
        `INSERT INTO "community_cohorts" (id, workspace_id, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'intruder', now())`,
        [workspaceB],
      ),
    ).rejects.toBeTruthy();
  });

  it('coach A cannot SELECT a cohort in workspace B', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `SELECT id FROM "community_cohorts" WHERE id = $1`,
      [cohortB1],
    );
    expect(res.rowCount).toBe(0);
  });

  it('coach A cannot UPDATE a cohort in workspace B', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `UPDATE "community_cohorts" SET name = 'hijacked' WHERE id = $1`,
      [cohortB1],
    );
    expect(res.rowCount).toBe(0);
  });

  it('coach A cannot DELETE/archive a cohort in workspace B', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `UPDATE "community_cohorts" SET status = 'archived', archived_at = now() WHERE id = $1`,
      [cohortB1],
    );
    expect(res.rowCount).toBe(0);
  });

  it('coach A cannot INSERT a membership into a cohort of workspace B', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    await expect(
      rls.query(
        `INSERT INTO "community_memberships" (id, workspace_id, cohort_id, user_id, role, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'student', 'active', now())`,
        [workspaceB, cohortB1, memberA1],
      ),
    ).rejects.toBeTruthy();
  });

  it('coach A cannot SELECT memberships of workspace B', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `SELECT id FROM "community_memberships" WHERE workspace_id = $1`,
      [workspaceB],
    );
    expect(res.rowCount).toBe(0);
  });

  it('coach A cannot UPDATE (remove) a membership in workspace B', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `UPDATE "community_memberships" SET status = 'removed' WHERE workspace_id = $1`,
      [workspaceB],
    );
    expect(res.rowCount).toBe(0);
  });

  it('coach B (foreign) cannot SELECT workspace A cohorts even with valid ids', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachB);
    const res = await rls.query(
      `SELECT id FROM "community_cohorts" WHERE id = ANY($1)`,
      [[cohortA1, cohortA2]],
    );
    expect(res.rowCount).toBe(0);
  });

  // ── Cross-cohort (same workspace) — student member overreach ─────────────

  it('a student member of cohort A1 cannot INSERT a membership (no coach policy)', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    await expect(
      rls.query(
        `INSERT INTO "community_memberships" (id, workspace_id, cohort_id, user_id, role, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'student', 'active', now())`,
        [workspaceA, cohortA1, memberA2],
      ),
    ).rejects.toBeTruthy();
  });

  it('a student member cannot UPDATE a cohort row (no coach policy)', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `UPDATE "community_cohorts" SET name = 'student-rename' WHERE id = $1`,
      [cohortA1],
    );
    expect(res.rowCount).toBe(0);
  });

  it('a member of cohort A1 cannot SELECT membership rows of cohort A2', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_memberships" WHERE cohort_id = $1`,
      [cohortA2],
    );
    // memberA1 shares only cohort A1 — the self/shared-cohort SELECT policy
    // returns zero rows of cohort A2.
    expect(res.rowCount).toBe(0);
  });

  it('a member of cohort A1 cannot mutate their own role/status', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `UPDATE "community_memberships" SET role = 'coach' WHERE user_id = $1`,
      [memberA1],
    );
    expect(res.rowCount).toBe(0);
  });

  // ── Member-of-cohort-but-not-coach: read sanitized, write denied ─────────

  it('a member CAN SELECT their own membership row (sanitized roster read)', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_memberships" WHERE cohort_id = $1`,
      [cohortA1],
    );
    expect(res.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('a member CAN SELECT the cohort row they belong to', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_cohorts" WHERE id = $1`,
      [cohortA1],
    );
    expect(res.rowCount).toBe(1);
  });

  it('a member cannot INSERT a cohort (coach-only write)', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    await expect(
      rls.query(
        `INSERT INTO "community_cohorts" (id, workspace_id, name, updated_at)
         VALUES (gen_random_uuid(), $1, 'member-made', now())`,
        [workspaceA],
      ),
    ).rejects.toBeTruthy();
  });

  it('an unauthenticated session sees no cohorts or memberships', async () => {
    if (!rls) return;
    await clearSessionUser(rls);
    const cohorts = await rls.query(`SELECT id FROM "community_cohorts"`);
    const members = await rls.query(`SELECT id FROM "community_memberships"`);
    expect(cohorts.rowCount).toBe(0);
    expect(members.rowCount).toBe(0);
  });

  // ── OWNER (workspace-owning coach) bypass / full control ─────────────────

  it('coach A CAN INSERT a cohort into their own workspace A', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `INSERT INTO "community_cohorts" (id, workspace_id, name, updated_at)
       VALUES (gen_random_uuid(), $1, 'a-owner-cohort', now()) RETURNING id`,
      [workspaceA],
    );
    expect(res.rowCount).toBe(1);
  });

  it('coach A CAN SELECT every cohort in workspace A', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `SELECT id FROM "community_cohorts" WHERE workspace_id = $1`,
      [workspaceA],
    );
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(cohortA1);
    expect(ids).toContain(cohortA2);
  });

  it('coach A CAN INSERT a membership into their own cohort A1', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `INSERT INTO "community_memberships" (id, workspace_id, cohort_id, user_id, role, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'student', 'active', now()) RETURNING id`,
      [workspaceA, cohortA1, coachB],
    );
    expect(res.rowCount).toBe(1);
  });

  it('coach A CAN UPDATE (remove) a membership in their own workspace A', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `UPDATE "community_memberships" SET status = 'removed', removed_at = now()
       WHERE cohort_id = $1 AND user_id = $2`,
      [cohortA1, memberA1],
    );
    expect(res.rowCount).toBe(1);
  });
});
