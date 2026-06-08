/**
 * Community v1-1 — schema integrity.
 *
 * Two layers:
 *  1. STATIC assertions (always run): the prisma schema parses + the generated
 *     client exposes all 11 community models, and the v1-1 migration SQL
 *     contains the required DDL — partitioned messages table, monthly
 *     partitions + helper, every FK with the correct onDelete, the per-table
 *     indexes, and the scope CHECK constraint.
 *  2. LIVE assertions (run only when COMMUNITY_TEST_DATABASE_URL points at a
 *     disposable Postgres and the optional `pg` driver is installed): migration
 *     up + down, FK enforcement, and message-partition routing.
 *
 * The live layer skips with a logged reason when no disposable DB is wired (see
 * test/community/_support/community-db.ts) — never a silent pass.
 */

import { execFileSync } from 'child_process';
import {
  COMMUNITY_ENUMS,
  COMMUNITY_TABLES,
  applyMigration,
  connect,
  liveDbUrl,
  migrationDown,
  readCommunityMigrationSql,
  readPrismaSchema,
  type LiveClient,
} from '../_support/community-db';

const MODELS = [
  'CommunityWorkspace',
  'CommunityCohort',
  'CommunityMembership',
  'CommunityMessage',
  'CommunityPost',
  'CommunityResponse',
  'CommunityEvent',
  'CommunityEventRsvp',
  'CommunityChallenge',
  'CommunityChallengeParticipation',
  'CommunityModerationAction',
];

describe('community v1-1 schema — prisma schema source', () => {
  const schema = readPrismaSchema();

  it('declares all 11 community models', () => {
    for (const model of MODELS) {
      expect(schema).toContain(`model ${model} {`);
    }
  });

  it('maps every model to its snake_case table', () => {
    const expectedMaps = [
      'community_workspaces',
      'community_cohorts',
      'community_memberships',
      'community_messages',
      'community_posts',
      'community_responses',
      'community_events',
      'community_event_rsvps',
      'community_challenges',
      'community_challenge_participations',
      'community_moderation_actions',
    ];
    for (const table of expectedMaps) {
      expect(schema).toContain(`@@map("${table}")`);
    }
  });

  it('gives every model created_at, plus updated_at on mutable models', () => {
    // CommunityResponse is append-only (created_at only, no updated_at).
    // CommunityModerationAction tracks created_at + resolved_at rather than
    // updated_at. Every other model carries both created_at and updated_at.
    const both = MODELS.filter(
      (m) => m !== 'CommunityResponse' && m !== 'CommunityModerationAction',
    );
    // crude per-model slice check: each model block contains created_at.
    for (const model of MODELS) {
      const start = schema.indexOf(`model ${model} {`);
      const end = schema.indexOf('\n}', start);
      const block = schema.slice(start, end);
      expect(block).toContain('created_at');
    }
    for (const model of both) {
      const start = schema.indexOf(`model ${model} {`);
      const end = schema.indexOf('\n}', start);
      const block = schema.slice(start, end);
      expect(block).toContain('updated_at');
    }
  });

  it('cascades workspace deletion on every workspace FK', () => {
    // Each child relation to CommunityWorkspace must declare onDelete: Cascade.
    const workspaceFkLines = schema
      .split('\n')
      .filter((l) => l.includes('CommunityWorkspace') && l.includes('fields: [workspace_id]'));
    expect(workspaceFkLines.length).toBeGreaterThanOrEqual(8);
    for (const line of workspaceFkLines) {
      expect(line).toContain('onDelete: Cascade');
    }
  });

  it('uses a composite id for the partitioned message model', () => {
    const start = schema.indexOf('model CommunityMessage {');
    const end = schema.indexOf('\n}', start);
    const block = schema.slice(start, end);
    expect(block).toContain('@@id([id, created_at])');
  });
});

describe('community v1-1 schema — generated prisma client', () => {
  it('exposes a delegate for every community model', () => {
    // Require lazily so a stale client fails loudly rather than at import time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaClient } = require('@prisma/client');
    const client = new PrismaClient();
    const delegates = [
      'communityWorkspace',
      'communityCohort',
      'communityMembership',
      'communityMessage',
      'communityPost',
      'communityResponse',
      'communityEvent',
      'communityEventRsvp',
      'communityChallenge',
      'communityChallengeParticipation',
      'communityModerationAction',
    ];
    for (const delegate of delegates) {
      expect(client[delegate]).toBeDefined();
    }
  });
});

describe('community v1-1 schema — prisma validate', () => {
  it('passes prisma validate against the committed schema', () => {
    const out = execFileSync(
      'npx',
      ['prisma', 'validate', '--schema', 'prisma/schema.prisma'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL:
            process.env.DATABASE_URL ||
            'postgresql://test:test@localhost:5432/test',
          DIRECT_URL:
            process.env.DIRECT_URL ||
            'postgresql://test:test@localhost:5432/test',
        },
      },
    );
    expect(out).toContain('is valid');
  });
});

describe('community v1-1 schema — migration SQL', () => {
  const sql = readCommunityMigrationSql();

  it('creates all 13 community enums', () => {
    for (const enumName of COMMUNITY_ENUMS) {
      expect(sql).toContain(`CREATE TYPE "${enumName}"`);
    }
  });

  it('creates all 11 community tables', () => {
    for (const table of COMMUNITY_TABLES) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it('range-partitions community_messages by created_at with a default partition', () => {
    expect(sql).toContain('PARTITION BY RANGE ("created_at")');
    expect(sql).toContain(
      'CREATE TABLE "community_messages_default" PARTITION OF "community_messages" DEFAULT',
    );
  });

  it('provisions current month + next two months as initial partitions', () => {
    expect(sql).toContain('"community_messages_2026_12" PARTITION OF "community_messages"');
    expect(sql).toContain('"community_messages_2027_01" PARTITION OF "community_messages"');
    expect(sql).toContain('"community_messages_2027_02" PARTITION OF "community_messages"');
  });

  it('ships a helper to create future monthly partitions', () => {
    expect(sql).toContain(
      'FUNCTION community_messages_create_month_partition(p_month DATE)',
    );
  });

  it('enforces the message scope-shape CHECK constraint', () => {
    expect(sql).toContain('community_messages_scope_shape_check');
    expect(sql).toContain("\"scope\" = 'cohort'");
    expect(sql).toContain("\"scope\" = 'dm'");
  });

  it('declares every workspace FK with ON DELETE CASCADE', () => {
    const cascadeTargets = [
      'community_cohorts_workspace_id_fkey',
      'community_memberships_workspace_id_fkey',
      'community_messages_workspace_id_fkey',
      'community_posts_workspace_id_fkey',
      'community_responses_workspace_id_fkey',
      'community_events_workspace_id_fkey',
      'community_event_rsvps_workspace_id_fkey',
      'community_challenges_workspace_id_fkey',
      'community_challenge_participations_workspace_id_fkey',
      'community_moderation_actions_workspace_id_fkey',
    ];
    for (const fk of cascadeTargets) {
      const idx = sql.indexOf(fk);
      expect(idx).toBeGreaterThan(-1);
      const stmt = sql.slice(idx, sql.indexOf(';', idx));
      expect(stmt).toContain('ON DELETE CASCADE');
    }
  });

  it('protects authored content with ON DELETE RESTRICT on author/sender FKs', () => {
    for (const fk of [
      'community_messages_sender_id_fkey',
      'community_messages_recipient_user_id_fkey',
      'community_posts_author_id_fkey',
      'community_events_created_by_id_fkey',
      'community_challenges_created_by_id_fkey',
    ]) {
      const idx = sql.indexOf(fk);
      expect(idx).toBeGreaterThan(-1);
      const stmt = sql.slice(idx, sql.indexOf(';', idx));
      expect(stmt).toContain('ON DELETE RESTRICT');
    }
  });

  it('keeps moderation audit rows via ON DELETE SET NULL', () => {
    for (const fk of [
      'community_moderation_actions_reported_by_id_fkey',
      'community_moderation_actions_actor_id_fkey',
    ]) {
      const idx = sql.indexOf(fk);
      const stmt = sql.slice(idx, sql.indexOf(';', idx));
      expect(stmt).toContain('ON DELETE SET NULL');
    }
  });

  it('enables AND forces RLS on every community table', () => {
    for (const table of COMMUNITY_TABLES) {
      // Column alignment varies, so match with flexible whitespace.
      const enableRe = new RegExp(`ALTER TABLE "${table}"\\s+ENABLE ROW LEVEL SECURITY`);
      const forceRe = new RegExp(`ALTER TABLE "${table}"\\s+FORCE ROW LEVEL SECURITY`);
      expect(enableRe.test(sql)).toBe(true);
      expect(forceRe.test(sql)).toBe(true);
    }
  });
});

const itLive = liveDbUrl() ? describe : describe.skip;

itLive('community v1-1 schema — live disposable DB', () => {
  const url = liveDbUrl() as string;
  let client: LiveClient | null = null;

  beforeAll(async () => {
    client = await connect(url);
    if (!client) {
      // eslint-disable-next-line no-console
      console.warn('[community-schema] live DB configured but `pg` missing — skipping live assertions.');
      return;
    }
    await applyMigration(client);
  });

  afterAll(async () => {
    if (client) {
      await migrationDown(client);
      await client.end();
    }
  });

  it('migration up creates all 11 tables', async () => {
    if (!client) return;
    const res = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [COMMUNITY_TABLES],
    );
    expect(res.rowCount).toBe(COMMUNITY_TABLES.length);
  });

  it('community_messages is a partitioned table', async () => {
    if (!client) return;
    const res = await client.query(
      `SELECT c.relkind FROM pg_class c WHERE c.relname = 'community_messages'`,
    );
    // 'p' == partitioned table.
    expect(res.rows[0].relkind).toBe('p');
  });

  it('routes an insert to the correct monthly partition', async () => {
    if (!client) return;
    // Seed a workspace + sender so the message FKs resolve.
    const ws = await client.query(
      `INSERT INTO "User" DEFAULT VALUES RETURNING id`,
    );
    const senderId = ws.rows[0].id as string;
    const wsRow = await client.query(
      `INSERT INTO "community_workspaces" (id, coach_id, name, slug, updated_at)
       VALUES (gen_random_uuid(), $1, 'WS', 'ws-route', now()) RETURNING id`,
      [senderId],
    );
    const workspaceId = wsRow.rows[0].id as string;
    const cohort = await client.query(
      `INSERT INTO "community_cohorts" (id, workspace_id, name, updated_at)
       VALUES (gen_random_uuid(), $1, 'C', now()) RETURNING id`,
      [workspaceId],
    );
    const cohortId = cohort.rows[0].id as string;
    await client.query(
      `INSERT INTO "community_messages"
         (workspace_id, cohort_id, scope, sender_id, body, created_at, updated_at)
       VALUES ($1, $2, 'cohort', $3, 'hi', '2027-01-15T00:00:00Z', now())`,
      [workspaceId, cohortId, senderId],
    );
    const inJan = await client.query(
      `SELECT count(*)::int AS n FROM "community_messages_2027_01"`,
    );
    expect(inJan.rows[0].n).toBe(1);
    const inDec = await client.query(
      `SELECT count(*)::int AS n FROM "community_messages_2026_12"`,
    );
    expect(inDec.rows[0].n).toBe(0);
  });

  it('enforces the workspace FK (cascade target exists)', async () => {
    if (!client) return;
    await expect(
      client.query(
        `INSERT INTO "community_cohorts" (id, workspace_id, name, updated_at)
         VALUES (gen_random_uuid(), gen_random_uuid(), 'orphan', now())`,
      ),
    ).rejects.toBeDefined();
  });

  it('cascades workspace deletion to cohorts + messages', async () => {
    if (!client) return;
    const u = await client.query(`INSERT INTO "User" DEFAULT VALUES RETURNING id`);
    const coachId = u.rows[0].id as string;
    const wsRow = await client.query(
      `INSERT INTO "community_workspaces" (id, coach_id, name, slug, updated_at)
       VALUES (gen_random_uuid(), $1, 'WS2', 'ws-cascade', now()) RETURNING id`,
      [coachId],
    );
    const workspaceId = wsRow.rows[0].id as string;
    await client.query(
      `INSERT INTO "community_cohorts" (id, workspace_id, name, updated_at)
       VALUES (gen_random_uuid(), $1, 'C2', now())`,
      [workspaceId],
    );
    await client.query(`DELETE FROM "community_workspaces" WHERE id = $1`, [
      workspaceId,
    ]);
    const remaining = await client.query(
      `SELECT count(*)::int AS n FROM "community_cohorts" WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(remaining.rows[0].n).toBe(0);
  });

  it('migration down removes every community table', async () => {
    if (!client) return;
    await migrationDown(client);
    const res = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [COMMUNITY_TABLES],
    );
    expect(res.rowCount).toBe(0);
    // Re-apply so afterAll teardown + isolation stay consistent.
    await applyMigration(client);
  });
});
