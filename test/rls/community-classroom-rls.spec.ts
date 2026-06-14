/**
 * v3-2 Community Classroom Posts — Row-Level Security regression.
 *
 * The classroom slice adds TWO new tables (community_classroom_posts +
 * community_classroom_media_assets) each with ENABLE + FORCE ROW LEVEL SECURITY
 * and four policies (coach FOR ALL + member SELECT, ×2 tables). This suite
 * proves that coverage two ways, mirroring test/rls/community-coach-rls.spec.ts:
 *
 *  1. STATIC assertions (always run): the v3-2 migration SQL declares the exact
 *     policies the read/write paths rely on, with the allow/deny shapes the
 *     planner needs — workspace-coach FOR ALL (USING + WITH CHECK), and a member
 *     SELECT gated on published + released (release_at NULL or past) + not
 *     soft-deleted + workspace/cohort membership. Media visibility inherits from
 *     the parent post through an EXISTS join.
 *  2. LIVE assertions (run only when COMMUNITY_TEST_DATABASE_URL + `pg` are
 *     available): real coach-tenancy, release-time-lock, soft-delete, cohort
 *     scoping, and non-member media-key denial through a non-privileged
 *     (NOBYPASSRLS) role.
 *
 * Application-layer note: the app connects as service_role (BYPASSRLS), so the
 * PRIMARY tenancy gate is CommunityClassroomService (see the *.service.spec.ts
 * suite, which exercises the 403/404 + release-lock paths). These DB policies
 * are defence-in-depth for any non-service-role connection and the empirical
 * proof of the brief's release-time-lock + media-access-by-membership rules.
 *
 * The classroom migration lives in its OWN file (additive to v1-1); the shared
 * support helper applies only the v1-1 migration, so this spec additionally
 * applies the classroom migration SQL after the base, and drops its two tables +
 * enum before the base teardown.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyMigration,
  assumeRlsRole,
  clearSessionUser,
  connect,
  ensureRlsTestRole,
  liveDbUrl,
  migrationDown,
  resetRole,
  setSessionUser,
  type LiveClient,
} from '../community/_support/community-db';

const CLASSROOM_MIGRATION_SQL_PATH = join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261216000200_community_classroom_posts',
  'migration.sql',
);

function readClassroomMigrationSql(): string {
  return readFileSync(CLASSROOM_MIGRATION_SQL_PATH, 'utf8');
}

/** Apply the classroom migration on top of the v1-1 base (idempotent drops). */
async function applyClassroomMigration(client: LiveClient): Promise<void> {
  await client.query(readClassroomMigrationSql());
}

/** Drop the classroom objects before the base v1-1 teardown. */
async function dropClassroomObjects(client: LiveClient): Promise<void> {
  await client.query(
    'DROP TABLE IF EXISTS "community_classroom_media_assets" CASCADE',
  );
  await client.query(
    'DROP TABLE IF EXISTS "community_classroom_posts" CASCADE',
  );
  await client.query('DROP TYPE IF EXISTS "CommunityClassroomPostStatus"');
}

// ── Layer 1: static policy-coverage assertions (always run) ────────────────

describe('v3-2 classroom RLS — static policy coverage', () => {
  const sql = readClassroomMigrationSql();

  function policy(name: string): string {
    const idx = sql.indexOf(`CREATE POLICY "${name}"`);
    expect(idx).toBeGreaterThan(-1);
    return sql.slice(idx, sql.indexOf(';', idx));
  }

  it('enables AND forces RLS on both new tables', () => {
    expect(sql).toContain(
      'ALTER TABLE "community_classroom_posts"        ENABLE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'ALTER TABLE "community_classroom_posts"        FORCE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'ALTER TABLE "community_classroom_media_assets" ENABLE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'ALTER TABLE "community_classroom_media_assets" FORCE ROW LEVEL SECURITY;',
    );
  });

  it('coach-owner FOR ALL on posts carries USING + WITH CHECK keyed off workspace coach', () => {
    const stmt = policy('community_classroom_posts_coach_all');
    expect(stmt).toContain('FOR ALL');
    expect(stmt).toContain('app.is_community_workspace_coach("workspace_id")');
    expect(stmt).toContain('USING');
    expect(stmt).toContain('WITH CHECK');
  });

  it('member SELECT on posts requires published + released + not-deleted + membership', () => {
    const stmt = policy('community_classroom_posts_member_select');
    expect(stmt).toContain('FOR SELECT');
    expect(stmt).toContain("\"status\" = 'published'");
    // Release-time lock: NULL (immediate) or release_at in the past.
    expect(stmt).toContain('"release_at" IS NULL OR "release_at" <= now()');
    // Soft-delete exclusion.
    expect(stmt).toContain('"soft_deleted_at" IS NULL');
    // Workspace-wide (cohort NULL) OR shared-cohort membership.
    expect(stmt).toContain('app.is_community_workspace_member("workspace_id")');
    expect(stmt).toContain('app.shares_community_cohort("cohort_id")');
  });

  it('coach-owner FOR ALL on media carries USING + WITH CHECK keyed off workspace coach', () => {
    const stmt = policy('community_classroom_media_assets_coach_all');
    expect(stmt).toContain('FOR ALL');
    expect(stmt).toContain('app.is_community_workspace_coach("workspace_id")');
    expect(stmt).toContain('WITH CHECK');
  });

  it('media SELECT inherits visibility from the parent post via EXISTS join', () => {
    const stmt = policy('community_classroom_media_assets_member_select');
    expect(stmt).toContain('FOR SELECT');
    expect(stmt).toContain('EXISTS');
    expect(stmt).toContain('FROM "community_classroom_posts" p');
    expect(stmt).toContain("p.\"status\" = 'published'");
    expect(stmt).toContain('p."soft_deleted_at" IS NULL');
  });

  it('is additive only — no ALTER/DROP of an existing community table', () => {
    // Guardrail (R69 / R77): the slice must not mutate any pre-existing table.
    expect(sql).not.toMatch(/ALTER TABLE "community_posts"/);
    expect(sql).not.toMatch(/ALTER TABLE "community_messages"/);
    expect(sql).not.toMatch(/DROP TABLE "community_/);
  });
});

// ── Layer 2: live enforcement (gated on a disposable Postgres) ──────────────

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-classroom-rls] COMMUNITY_TEST_DATABASE_URL not set — live RLS suite skipped (static coverage still runs).',
  );
}

itLive('v3-2 classroom RLS — live enforcement', () => {
  const url = liveDbUrl() as string;
  let owner: LiveClient | null = null;
  let rls: LiveClient | null = null;

  let coachA = '';
  let coachB = '';
  let memberA1 = '';
  let memberA2 = '';
  let outsider = '';
  let workspaceA = '';
  let workspaceB = '';
  let cohortA1 = '';
  let cohortA2 = '';

  // Posts: workspace-wide published, cohort-A1 published, future-release, draft,
  // soft-deleted, and a workspace-B post for cross-tenant checks.
  let postWsPublished = '';
  let postCohortA1Published = '';
  let postFutureRelease = '';
  let postDraft = '';
  let postSoftDeleted = '';
  let postWorkspaceB = '';
  let mediaOnWsPublished = '';
  let mediaOnFutureRelease = '';

  beforeAll(async () => {
    owner = await connect(url);
    if (!owner) {
      // eslint-disable-next-line no-console
      console.warn(
        '[community-classroom-rls] live DB configured but `pg` missing — skipping live assertions.',
      );
      return;
    }
    await applyMigration(owner);
    await applyClassroomMigration(owner);
    await ensureRlsTestRole(owner);

    const mkUser = async (): Promise<string> => {
      const r = await owner!.query(
        `INSERT INTO "User" DEFAULT VALUES RETURNING id`,
      );
      return r.rows[0].id as string;
    };
    coachA = await mkUser();
    coachB = await mkUser();
    memberA1 = await mkUser();
    memberA2 = await mkUser();
    outsider = await mkUser();

    const mkWorkspace = async (
      coach: string,
      slug: string,
    ): Promise<string> => {
      const r = await owner!.query(
        `INSERT INTO "community_workspaces" (id, coach_id, name, slug, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $2, now()) RETURNING id`,
        [coach, slug],
      );
      return r.rows[0].id as string;
    };
    workspaceA = await mkWorkspace(coachA, 'classroom-tenant-a');
    workspaceB = await mkWorkspace(coachB, 'classroom-tenant-b');

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

    const mkMembership = async (
      ws: string,
      cohort: string,
      user: string,
    ): Promise<void> => {
      await owner!.query(
        `INSERT INTO "community_memberships" (id, workspace_id, cohort_id, user_id, role, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'student', 'active', now())`,
        [ws, cohort, user],
      );
    };
    // memberA1 ∈ cohort A1; memberA2 ∈ cohort A2 (same workspace, other cohort).
    await mkMembership(workspaceA, cohortA1, memberA1);
    await mkMembership(workspaceA, cohortA2, memberA2);

    const mkPost = async (opts: {
      ws: string;
      coach: string;
      cohort: string | null;
      status: 'draft' | 'scheduled' | 'published' | 'archived';
      releaseAt?: string | null;
      softDeleted?: boolean;
    }): Promise<string> => {
      const r = await owner!.query(
        `INSERT INTO "community_classroom_posts"
           (id, workspace_id, cohort_id, coach_id, title, body_markdown, status, release_at, soft_deleted_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'lesson', 'body', $4, $5, $6, now())
         RETURNING id`,
        [
          opts.ws,
          opts.cohort,
          opts.coach,
          opts.status,
          opts.releaseAt ?? null,
          opts.softDeleted ? 'now()' : null,
        ],
      );
      return r.rows[0].id as string;
    };
    postWsPublished = await mkPost({
      ws: workspaceA,
      coach: coachA,
      cohort: null,
      status: 'published',
    });
    postCohortA1Published = await mkPost({
      ws: workspaceA,
      coach: coachA,
      cohort: cohortA1,
      status: 'published',
    });
    postFutureRelease = await mkPost({
      ws: workspaceA,
      coach: coachA,
      cohort: null,
      status: 'published',
      releaseAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    postDraft = await mkPost({
      ws: workspaceA,
      coach: coachA,
      cohort: null,
      status: 'draft',
    });
    postSoftDeleted = await mkPost({
      ws: workspaceA,
      coach: coachA,
      cohort: null,
      status: 'published',
      softDeleted: true,
    });
    postWorkspaceB = await mkPost({
      ws: workspaceB,
      coach: coachB,
      cohort: null,
      status: 'published',
    });

    const mkMedia = async (postId: string, ws: string): Promise<string> => {
      const r = await owner!.query(
        `INSERT INTO "community_classroom_media_assets"
           (id, post_id, workspace_id, kind, storage_key)
         VALUES (gen_random_uuid(), $1, $2, 'video', $3) RETURNING id`,
        [postId, ws, `ws/${ws}/post/${postId}/asset.mp4`],
      );
      return r.rows[0].id as string;
    };
    mediaOnWsPublished = await mkMedia(postWsPublished, workspaceA);
    mediaOnFutureRelease = await mkMedia(postFutureRelease, workspaceA);

    rls = await connect(url);
    if (rls) await assumeRlsRole(rls);
  });

  afterAll(async () => {
    if (rls) {
      await resetRole(rls);
      await rls.end();
    }
    if (owner) {
      await dropClassroomObjects(owner);
      await migrationDown(owner);
      await owner.end();
    }
  });

  // ── Coach tenancy ─────────────────────────────────────────────────────────

  it('coach A sees every post in workspace A (draft/future/soft-deleted included)', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `SELECT id FROM "community_classroom_posts" WHERE workspace_id = $1`,
      [workspaceA],
    );
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(postWsPublished);
    expect(ids).toContain(postDraft);
    expect(ids).toContain(postFutureRelease);
    expect(ids).toContain(postSoftDeleted);
  });

  it('coach A cannot SELECT a workspace-B post', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `SELECT id FROM "community_classroom_posts" WHERE id = $1`,
      [postWorkspaceB],
    );
    expect(res.rowCount).toBe(0);
  });

  it('coach A cannot INSERT a post into workspace B', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    await expect(
      rls.query(
        `INSERT INTO "community_classroom_posts"
           (id, workspace_id, cohort_id, coach_id, title, body_markdown, status, updated_at)
         VALUES (gen_random_uuid(), $1, NULL, $2, 'intruder', 'b', 'published', now())`,
        [workspaceB, coachA],
      ),
    ).rejects.toBeTruthy();
  });

  it('coach B cannot UPDATE a workspace-A post', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachB);
    const res = await rls.query(
      `UPDATE "community_classroom_posts" SET title = 'hijacked' WHERE id = $1`,
      [postWsPublished],
    );
    expect(res.rowCount).toBe(0);
  });

  // ── Member SELECT: release-time-lock + soft-delete + draft ──────────────────

  it('member A1 CAN read a published, released, workspace-wide post', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_classroom_posts" WHERE id = $1`,
      [postWsPublished],
    );
    expect(res.rowCount).toBe(1);
  });

  it('member A1 CANNOT read a future-release (locked) post', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_classroom_posts" WHERE id = $1`,
      [postFutureRelease],
    );
    expect(res.rowCount).toBe(0);
  });

  it('member A1 CANNOT read a draft post', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_classroom_posts" WHERE id = $1`,
      [postDraft],
    );
    expect(res.rowCount).toBe(0);
  });

  it('member A1 CANNOT read a soft-deleted post', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_classroom_posts" WHERE id = $1`,
      [postSoftDeleted],
    );
    expect(res.rowCount).toBe(0);
  });

  // ── Cohort scoping ──────────────────────────────────────────────────────────

  it('member A1 (cohort A1) CAN read a cohort-A1 published post', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_classroom_posts" WHERE id = $1`,
      [postCohortA1Published],
    );
    expect(res.rowCount).toBe(1);
  });

  it('member A2 (cohort A2) CANNOT read a cohort-A1 post', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA2);
    const res = await rls.query(
      `SELECT id FROM "community_classroom_posts" WHERE id = $1`,
      [postCohortA1Published],
    );
    expect(res.rowCount).toBe(0);
  });

  it('an outsider (no membership) sees zero workspace-A posts', async () => {
    if (!rls) return;
    await setSessionUser(rls, outsider);
    const res = await rls.query(
      `SELECT id FROM "community_classroom_posts" WHERE workspace_id = $1`,
      [workspaceA],
    );
    expect(res.rowCount).toBe(0);
  });

  it('member A1 cannot INSERT a post (coach-only write)', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    await expect(
      rls.query(
        `INSERT INTO "community_classroom_posts"
           (id, workspace_id, cohort_id, coach_id, title, body_markdown, status, updated_at)
         VALUES (gen_random_uuid(), $1, NULL, $2, 'member-made', 'x', 'published', now())`,
        [workspaceA, memberA1],
      ),
    ).rejects.toBeTruthy();
  });

  // ── Media inherits parent-post visibility ───────────────────────────────────

  it('member A1 CAN read a media row on a visible (released) post', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id, storage_key FROM "community_classroom_media_assets" WHERE id = $1`,
      [mediaOnWsPublished],
    );
    expect(res.rowCount).toBe(1);
  });

  it('member A1 CANNOT read a media row whose parent post is release-locked (no storage_key leak)', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT storage_key FROM "community_classroom_media_assets" WHERE id = $1`,
      [mediaOnFutureRelease],
    );
    // The brief's "non-member cannot fetch storageKey" guarantee, proven at the
    // DB layer: a locked lesson's media key never reaches a member for signing.
    expect(res.rowCount).toBe(0);
  });

  it('an outsider sees no media assets in workspace A', async () => {
    if (!rls) return;
    await setSessionUser(rls, outsider);
    const res = await rls.query(
      `SELECT id FROM "community_classroom_media_assets" WHERE workspace_id = $1`,
      [workspaceA],
    );
    expect(res.rowCount).toBe(0);
  });

  it('an unauthenticated session sees no classroom posts or media', async () => {
    if (!rls) return;
    await clearSessionUser(rls);
    const posts = await rls.query(
      `SELECT id FROM "community_classroom_posts"`,
    );
    const media = await rls.query(
      `SELECT id FROM "community_classroom_media_assets"`,
    );
    expect(posts.rowCount).toBe(0);
    expect(media.rowCount).toBe(0);
  });

  // ── Coach owns media in their workspace ─────────────────────────────────────

  it('coach A CAN read every media asset in workspace A', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `SELECT id FROM "community_classroom_media_assets" WHERE workspace_id = $1`,
      [workspaceA],
    );
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(mediaOnWsPublished);
    expect(ids).toContain(mediaOnFutureRelease);
  });
});
