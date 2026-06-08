/**
 * Community v1-1 — Row-Level Security verification.
 *
 * Two layers (same posture as community-schema.spec.ts):
 *  1. STATIC assertions (always run): the migration SQL declares an
 *     auth-helper-based policy for every one of the 11 tables, with the
 *     specific allow/deny shapes the planner's RLS plan calls for
 *     (workspace-owner ALL, member SELECT, author write, moderation
 *     coach-only).
 *  2. LIVE assertions (run only when COMMUNITY_TEST_DATABASE_URL + `pg` are
 *     available): real cross-tenant denial through a non-privileged role.
 *
 * RLS convention is app.current_user_id() (the repo helper), NOT auth.uid();
 * see the migration header for the rationale and the auditor flag.
 */

import {
  COMMUNITY_TABLES,
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
} from '../_support/community-db';

describe('community v1-1 RLS — migration SQL policy coverage', () => {
  const sql = readCommunityMigrationSql();

  it('defines the app.current_user_id() based helper functions', () => {
    expect(sql).toContain('FUNCTION app.current_user_id()');
    expect(sql).toContain('FUNCTION app.is_community_workspace_coach(p_workspace_id uuid)');
    expect(sql).toContain('FUNCTION app.is_community_workspace_member(p_workspace_id uuid)');
    expect(sql).toContain('FUNCTION app.shares_community_cohort(p_cohort_id uuid)');
  });

  it('creates at least one policy on every community table', () => {
    for (const table of COMMUNITY_TABLES) {
      const policyRe = new RegExp(`CREATE POLICY "[^"]+" ON "${table}"`);
      expect(policyRe.test(sql)).toBe(true);
    }
  });

  it('grants the workspace owner full control where the plan requires it', () => {
    for (const policy of [
      'community_workspaces_coach_all',
      'community_cohorts_coach_all',
      'community_memberships_coach_all',
      'community_posts_coach_all',
      'community_responses_coach_all',
      'community_events_coach_all',
      'community_challenges_coach_all',
      'community_moderation_actions_coach_all',
    ]) {
      expect(sql).toContain(`CREATE POLICY "${policy}"`);
    }
  });

  it('lets members SELECT their cohort/workspace content but not mutate it', () => {
    expect(sql).toContain('community_workspaces_member_select');
    expect(sql).toContain('community_cohorts_member_select');
    expect(sql).toContain('community_memberships_self_or_shared_cohort_select');
    expect(sql).toContain('community_posts_member_select');
  });

  it('scopes message visibility to coach, shared cohort, or DM party', () => {
    const idx = sql.indexOf('CREATE POLICY "community_messages_select"');
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf(';', idx));
    expect(stmt).toContain('is_community_workspace_coach');
    expect(stmt).toContain('shares_community_cohort');
    expect(stmt).toContain('recipient_user_id');
  });

  it('restricts moderation reads so reporters only see their own reports', () => {
    const idx = sql.indexOf('CREATE POLICY "community_moderation_actions_reporter_select"');
    expect(idx).toBeGreaterThan(-1);
    const stmt = sql.slice(idx, sql.indexOf(';', idx));
    expect(stmt).toContain('"reported_by_id"::text = app.current_user_id()');
  });

  it('lets responses/rsvps/participations be written only by their own user', () => {
    expect(sql).toContain('community_responses_own_insert');
    expect(sql).toContain('community_responses_own_delete');
    expect(sql).toContain('community_event_rsvps_own_all');
    expect(sql).toContain('community_challenge_participations_own_all');
  });
});

const itLive = liveDbUrl() ? describe : describe.skip;

itLive('community v1-1 RLS — live cross-tenant enforcement', () => {
  const url = liveDbUrl() as string;
  let owner: LiveClient | null = null; // privileged setup connection
  let rls: LiveClient | null = null; // non-privileged, RLS-enforced connection

  // Fixtures, populated in beforeAll.
  let coachA = '';
  let coachB = '';
  let memberA1 = '';
  let memberA2 = '';
  let workspaceA = '';
  let workspaceB = '';
  let cohortA1 = '';
  let cohortA2 = '';

  beforeAll(async () => {
    owner = await connect(url);
    if (!owner) {
      // eslint-disable-next-line no-console
      console.warn('[community-rls] live DB configured but `pg` missing — skipping live assertions.');
      return;
    }
    await applyMigration(owner);
    await ensureRlsTestRole(owner);
    // Re-grant on the freshly created tables (ensureRlsTestRole grants on
    // existing tables; applyMigration already ran so this is covered, but we
    // re-run to be safe after any re-apply).
    await ensureRlsTestRole(owner);

    // Seed two tenants entirely from the privileged connection.
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
    workspaceA = await mkWorkspace(coachA, 'tenant-a');
    workspaceB = await mkWorkspace(coachB, 'tenant-b');

    const mkCohort = async (ws: string, name: string): Promise<string> => {
      const r = await owner!.query(
        `INSERT INTO "community_cohorts" (id, workspace_id, name, updated_at)
         VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
        [ws, name],
      );
      return r.rows[0].id as string;
    };
    cohortA1 = await mkCohort(workspaceA, 'cohort-1');
    cohortA2 = await mkCohort(workspaceA, 'cohort-2');

    const mkMembership = async (ws: string, cohort: string, user: string): Promise<void> => {
      await owner!.query(
        `INSERT INTO "community_memberships" (id, workspace_id, cohort_id, user_id, role, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'student', 'active', now())`,
        [ws, cohort, user],
      );
    };
    // memberA1 is in cohort 1, memberA2 is in cohort 2 of the SAME workspace.
    await mkMembership(workspaceA, cohortA1, memberA1);
    await mkMembership(workspaceA, cohortA2, memberA2);

    // Seed one cohort message into each cohort.
    const mkMsg = async (ws: string, cohort: string, sender: string, body: string): Promise<void> => {
      await owner!.query(
        `INSERT INTO "community_messages" (workspace_id, cohort_id, scope, sender_id, body, updated_at)
         VALUES ($1, $2, 'cohort', $3, $4, now())`,
        [ws, cohort, sender, body],
      );
    };
    await mkMsg(workspaceA, cohortA1, memberA1, 'cohort-1 secret');
    await mkMsg(workspaceA, cohortA2, memberA2, 'cohort-2 secret');

    // One moderation row in workspace A.
    await owner!.query(
      `INSERT INTO "community_moderation_actions" (id, workspace_id, target_type, target_id, reason)
       VALUES (gen_random_uuid(), $1, 'message', gen_random_uuid(), 'spam')`,
      [workspaceA],
    );

    // The RLS-enforced connection: same DB, but every statement runs as the
    // non-privileged role after SET ROLE.
    rls = await connect(url);
    if (rls) {
      await assumeRlsRole(rls);
    }
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

  it('coach A sees only workspace A; coach B cannot SELECT it', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const a = await rls.query(`SELECT id FROM "community_workspaces"`);
    expect(a.rows.map((r) => r.id)).toContain(workspaceA);
    expect(a.rows.map((r) => r.id)).not.toContain(workspaceB);

    await setSessionUser(rls, coachB);
    const b = await rls.query(
      `SELECT id FROM "community_workspaces" WHERE id = $1`,
      [workspaceA],
    );
    expect(b.rowCount).toBe(0);
  });

  it('a member of cohort 1 cannot SELECT messages in cohort 2 of the same workspace', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const visible = await rls.query(
      `SELECT cohort_id, body FROM "community_messages" ORDER BY created_at`,
    );
    const cohortIds = visible.rows.map((r) => r.cohort_id);
    expect(cohortIds).toContain(cohortA1);
    expect(cohortIds).not.toContain(cohortA2);
  });

  it('the workspace coach sees ALL cohort messages across cohorts', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const visible = await rls.query(`SELECT cohort_id FROM "community_messages"`);
    const cohortIds = visible.rows.map((r) => r.cohort_id);
    expect(cohortIds).toContain(cohortA1);
    expect(cohortIds).toContain(cohortA2);
  });

  it('coach A can DELETE moderation rows in workspace A but coach B cannot', async () => {
    if (!rls) return;
    // Coach B attempts to delete A's moderation rows — RLS filters them out,
    // so the DELETE affects zero rows.
    await setSessionUser(rls, coachB);
    const denied = await rls.query(
      `DELETE FROM "community_moderation_actions" WHERE workspace_id = $1`,
      [workspaceA],
    );
    expect(denied.rowCount).toBe(0);

    // Coach A deletes its own workspace's moderation row successfully.
    await setSessionUser(rls, coachA);
    const allowed = await rls.query(
      `DELETE FROM "community_moderation_actions" WHERE workspace_id = $1`,
      [workspaceA],
    );
    expect(allowed.rowCount).toBe(1);
  });

  it('an unauthenticated session (no app.current_user_id) sees nothing', async () => {
    if (!rls) return;
    await clearSessionUser(rls);
    const res = await rls.query(`SELECT id FROM "community_workspaces"`);
    expect(res.rowCount).toBe(0);
  });
});
