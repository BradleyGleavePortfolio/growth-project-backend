/**
 * v3-3 Community Voice Notes — Row-Level Security regression.
 *
 * The voice slice adds ONE new table (community_voice_notes) with ENABLE +
 * FORCE ROW LEVEL SECURITY and two policies (workspace-coach FOR ALL + member
 * SELECT). This suite proves that coverage two ways, mirroring
 * test/rls/community-classroom-rls.spec.ts:
 *
 *  1. STATIC assertions (always run): the v3-3 migration SQL declares the exact
 *     policies the read/write paths rely on — workspace-coach FOR ALL (USING +
 *     WITH CHECK) and a member SELECT gated on not-soft-deleted + (channel note
 *     with workspace/cohort membership) OR (DM note authored by the caller).
 *  2. LIVE assertions (run only when COMMUNITY_TEST_DATABASE_URL + `pg` are
 *     available): real coach-tenancy, cohort scoping, soft-delete exclusion, DM
 *     author-only visibility, and non-member storage_key denial through a
 *     non-privileged (NOBYPASSRLS) role.
 *
 * Application-layer note: the app connects as service_role (BYPASSRLS), so the
 * PRIMARY tenancy gate is CommunityVoiceService (see the *.service.spec.ts
 * suite, which exercises the 403/404 paths). These DB policies are
 * defence-in-depth for any non-service-role connection and the empirical proof
 * of the brief's bucket-binding + DM-author-only + member-scoping rules.
 *
 * The voice migration lives in its OWN file (additive to v1-1); the shared
 * support helper applies only the v1-1 migration, so this spec additionally
 * applies the voice migration SQL after the base, and drops its table before
 * the base teardown.
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

const VOICE_MIGRATION_SQL_PATH = join(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261217000000_community_voice_notes',
  'migration.sql',
);

function readVoiceMigrationSql(): string {
  return readFileSync(VOICE_MIGRATION_SQL_PATH, 'utf8');
}

/** Apply the voice migration on top of the v1-1 base. */
async function applyVoiceMigration(client: LiveClient): Promise<void> {
  await client.query(readVoiceMigrationSql());
}

/** Drop the voice objects before the base v1-1 teardown. */
async function dropVoiceObjects(client: LiveClient): Promise<void> {
  await client.query('DROP TABLE IF EXISTS "community_voice_notes" CASCADE');
}

// ── Layer 1: static policy-coverage assertions (always run) ────────────────

describe('v3-3 voice RLS — static policy coverage', () => {
  const sql = readVoiceMigrationSql();

  function policy(name: string): string {
    const idx = sql.indexOf(`CREATE POLICY "${name}"`);
    expect(idx).toBeGreaterThan(-1);
    return sql.slice(idx, sql.indexOf(';', idx));
  }

  it('enables AND forces RLS on the new table', () => {
    expect(sql).toContain(
      'ALTER TABLE "community_voice_notes" ENABLE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'ALTER TABLE "community_voice_notes" FORCE ROW LEVEL SECURITY;',
    );
  });

  it('coach FOR ALL carries USING + WITH CHECK keyed off workspace coach', () => {
    const stmt = policy('community_voice_notes_coach_all');
    expect(stmt).toContain('FOR ALL');
    expect(stmt).toContain('app.is_community_workspace_coach("workspace_id")');
    expect(stmt).toContain('USING');
    expect(stmt).toContain('WITH CHECK');
  });

  it('member SELECT requires not-deleted + channel-membership OR DM-author', () => {
    const stmt = policy('community_voice_notes_member_select');
    expect(stmt).toContain('FOR SELECT');
    expect(stmt).toContain('"soft_deleted_at" IS NULL');
    // Channel/cohort branch: workspace hall (cohort NULL) or shared cohort.
    expect(stmt).toContain('"conversation_id" IS NULL');
    expect(stmt).toContain('app.is_community_workspace_member("workspace_id")');
    expect(stmt).toContain('app.shares_community_cohort("cohort_id")');
    // DM branch: author-only at the DB layer.
    expect(stmt).toContain('"conversation_id" IS NOT NULL');
    expect(stmt).toContain('"author_id" = app.current_user_id()');
  });

  it('is additive only — no ALTER/DROP of an existing community table', () => {
    // Guardrail (R69 / R77): the slice must not mutate any pre-existing table.
    expect(sql).not.toMatch(/ALTER TABLE "community_posts"/);
    expect(sql).not.toMatch(/ALTER TABLE "community_messages"/);
    expect(sql).not.toMatch(/DROP TABLE "community_(?!voice_notes)/);
  });
});

// ── Layer 2: live enforcement (gated on a disposable Postgres) ──────────────

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn(
    '[community-voice-rls] COMMUNITY_TEST_DATABASE_URL not set — live RLS suite skipped (static coverage still runs).',
  );
}

itLive('v3-3 voice RLS — live enforcement', () => {
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

  // Notes: workspace-hall, cohort-A1, soft-deleted, workspace-B (cross-tenant),
  // and a DM note authored by memberA1.
  let noteWsHall = '';
  let noteCohortA1 = '';
  let noteSoftDeleted = '';
  let noteWorkspaceB = '';
  let noteDmByA1 = '';

  beforeAll(async () => {
    owner = await connect(url);
    if (!owner) {
      // eslint-disable-next-line no-console
      console.warn(
        '[community-voice-rls] live DB configured but `pg` missing — skipping live assertions.',
      );
      return;
    }
    await applyMigration(owner);
    await applyVoiceMigration(owner);
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

    const mkWorkspace = async (coach: string, slug: string): Promise<string> => {
      const r = await owner!.query(
        `INSERT INTO "community_workspaces" (id, coach_id, name, slug, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $2, now()) RETURNING id`,
        [coach, slug],
      );
      return r.rows[0].id as string;
    };
    workspaceA = await mkWorkspace(coachA, 'voice-tenant-a');
    workspaceB = await mkWorkspace(coachB, 'voice-tenant-b');

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
    await mkMembership(workspaceA, cohortA1, memberA1);
    await mkMembership(workspaceA, cohortA2, memberA2);

    const mkNote = async (opts: {
      ws: string;
      cohort: string | null;
      conversation: string | null;
      author: string;
      softDeleted?: boolean;
    }): Promise<string> => {
      const r = await owner!.query(
        `INSERT INTO "community_voice_notes"
           (id, workspace_id, cohort_id, conversation_id, author_id, storage_key, duration_ms, bytes, mime_type, soft_deleted_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 5000, 120000, 'audio/mp4', $6)
         RETURNING id`,
        [
          opts.ws,
          opts.cohort,
          opts.conversation,
          opts.author,
          `${opts.author}/key-${Math.random().toString(16).slice(2)}.m4a`,
          opts.softDeleted ? 'now()' : null,
        ],
      );
      return r.rows[0].id as string;
    };
    noteWsHall = await mkNote({
      ws: workspaceA,
      cohort: null,
      conversation: null,
      author: coachA,
    });
    noteCohortA1 = await mkNote({
      ws: workspaceA,
      cohort: cohortA1,
      conversation: null,
      author: memberA1,
    });
    noteSoftDeleted = await mkNote({
      ws: workspaceA,
      cohort: null,
      conversation: null,
      author: coachA,
      softDeleted: true,
    });
    noteWorkspaceB = await mkNote({
      ws: workspaceB,
      cohort: null,
      conversation: null,
      author: coachB,
    });
    noteDmByA1 = await mkNote({
      ws: workspaceA,
      cohort: null,
      conversation: '00000000-0000-0000-0000-0000000000d1',
      author: memberA1,
    });

    rls = await connect(url);
    if (rls) await assumeRlsRole(rls);
  });

  afterAll(async () => {
    if (rls) {
      await resetRole(rls);
      await rls.end();
    }
    if (owner) {
      await dropVoiceObjects(owner);
      await migrationDown(owner);
      await owner.end();
    }
  });

  // ── Coach tenancy ─────────────────────────────────────────────────────────

  it('coach A sees every note in workspace A (soft-deleted included)', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `SELECT id FROM "community_voice_notes" WHERE workspace_id = $1`,
      [workspaceA],
    );
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(noteWsHall);
    expect(ids).toContain(noteCohortA1);
    expect(ids).toContain(noteSoftDeleted);
    expect(ids).toContain(noteDmByA1);
  });

  it('coach A cannot SELECT a workspace-B note', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    const res = await rls.query(
      `SELECT id FROM "community_voice_notes" WHERE id = $1`,
      [noteWorkspaceB],
    );
    expect(res.rowCount).toBe(0);
  });

  it('coach A cannot INSERT a note into workspace B', async () => {
    if (!rls) return;
    await setSessionUser(rls, coachA);
    await expect(
      rls.query(
        `INSERT INTO "community_voice_notes"
           (id, workspace_id, cohort_id, conversation_id, author_id, storage_key, duration_ms, bytes, mime_type)
         VALUES (gen_random_uuid(), $1, NULL, NULL, $2, $3, 5000, 1000, 'audio/mp4')`,
        [workspaceB, coachA, `${coachA}/intruder.m4a`],
      ),
    ).rejects.toBeTruthy();
  });

  // ── Member SELECT: channel scoping + soft-delete ────────────────────────────

  it('member A1 CAN read a workspace-hall note', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_voice_notes" WHERE id = $1`,
      [noteWsHall],
    );
    expect(res.rowCount).toBe(1);
  });

  it('member A1 (cohort A1) CAN read a cohort-A1 note', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_voice_notes" WHERE id = $1`,
      [noteCohortA1],
    );
    expect(res.rowCount).toBe(1);
  });

  it('member A2 (cohort A2) CANNOT read a cohort-A1 note', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA2);
    const res = await rls.query(
      `SELECT id FROM "community_voice_notes" WHERE id = $1`,
      [noteCohortA1],
    );
    expect(res.rowCount).toBe(0);
  });

  it('member A1 CANNOT read a soft-deleted note', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_voice_notes" WHERE id = $1`,
      [noteSoftDeleted],
    );
    expect(res.rowCount).toBe(0);
  });

  it('an outsider sees zero workspace-A notes (no storage_key leak)', async () => {
    if (!rls) return;
    await setSessionUser(rls, outsider);
    const res = await rls.query(
      `SELECT id, storage_key FROM "community_voice_notes" WHERE workspace_id = $1`,
      [workspaceA],
    );
    expect(res.rowCount).toBe(0);
  });

  // ── DM author-only visibility ───────────────────────────────────────────────

  it('member A1 CAN read their own DM note', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA1);
    const res = await rls.query(
      `SELECT id FROM "community_voice_notes" WHERE id = $1`,
      [noteDmByA1],
    );
    expect(res.rowCount).toBe(1);
  });

  it('member A2 CANNOT read another member’s DM note', async () => {
    if (!rls) return;
    await setSessionUser(rls, memberA2);
    const res = await rls.query(
      `SELECT id FROM "community_voice_notes" WHERE id = $1`,
      [noteDmByA1],
    );
    expect(res.rowCount).toBe(0);
  });

  it('member A1 cannot INSERT into another principal’s namespace via RLS write', async () => {
    if (!rls) return;
    // A member is not a workspace coach, so the FOR ALL write policy denies
    // any INSERT regardless of namespace — proving members never durably write
    // through a non-service-role connection.
    await setSessionUser(rls, memberA1);
    await expect(
      rls.query(
        `INSERT INTO "community_voice_notes"
           (id, workspace_id, cohort_id, conversation_id, author_id, storage_key, duration_ms, bytes, mime_type)
         VALUES (gen_random_uuid(), $1, NULL, NULL, $2, $3, 5000, 1000, 'audio/mp4')`,
        [workspaceA, memberA1, `${memberA1}/member-made.m4a`],
      ),
    ).rejects.toBeTruthy();
  });

  it('an unauthenticated session sees no voice notes', async () => {
    if (!rls) return;
    await clearSessionUser(rls);
    const res = await rls.query(`SELECT id FROM "community_voice_notes"`);
    expect(res.rowCount).toBe(0);
  });
});
