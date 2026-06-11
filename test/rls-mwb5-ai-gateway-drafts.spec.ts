/**
 * MWB-5 — RLS tenant-isolation proof for the live-create gateway drafts
 * (brief Test matrix #11).
 *
 * MWB-5 adds NO new tables and NO new RLS policies (the slice is forbidden from
 * touching prisma/schema.prisma): the two live-create capabilities
 * (`draft.create_workout_plan` / `draft.edit_workout_plan`) ride on the EXISTING
 * `AiActionDraft` row + its policy set from migration
 * 20260607000000_rls_remaining_gaps. This suite is the integration-lane proof
 * that those existing policies still isolate a live-create draft by tenant —
 * i.e. the new capability strings cannot be used to smuggle a draft across a
 * tenant boundary. It verifies, against a REAL Postgres (no mocks):
 *
 *   - RLS is ENABLED and FORCED on AiActionDraft.
 *   - A draft with capability='draft.create_workout_plan' authored by coach A
 *     (requester=tenant=A) is SELECT-visible to A but NOT to a foreign coach B.
 *   - The subject client of the draft can read it (participant select).
 *   - An anon principal (no GUCs) sees ZERO rows.
 *   - service_role bypasses RLS (Primitive A) for the operational read path the
 *     approval service uses.
 *
 * Live-DB gating (mirrors test/rls-mwb2-clone-concurrency.spec.ts, R66): matched
 * by jest.rls.config.js and run ONLY in the rls-live-tests CI job. It connects
 * when RLS_MWB5_TEST_DATABASE_URL (or the shared RLS_FN_TEST_DATABASE_URL) is
 * set; otherwise it describe.skip()s with a logged reason — never a silent pass.
 *
 * To run locally:
 *   1. docker run -e POSTGRES_PASSWORD=pw -p 55432:5432 -d postgres:16
 *   2. RLS_MWB5_TEST_DATABASE_URL=postgresql://postgres:pw@localhost:55432/postgres \
 *        npx jest --config jest.rls.config.js test/rls-mwb5 --runInBand
 */

import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const TEST_DB_URL =
  process.env.RLS_MWB5_TEST_DATABASE_URL ||
  process.env.RLS_FN_TEST_DATABASE_URL ||
  '';

const SERVICE_ROLE = process.env.RLS_SERVICE_ROLE || 'service_role';
const AUTHED_ROLE = process.env.RLS_AUTHED_ROLE || 'app_authenticated';

const liveDescribe = TEST_DB_URL ? describe : describe.skip;

if (!TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[rls-mwb5-ai-gateway-drafts] RLS_MWB5_TEST_DATABASE_URL not set — live ' +
      'RLS suite skipped (point it at a throwaway Postgres to run).',
  );
}

const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260607000000_rls_remaining_gaps',
  'migration.sql',
);

// Helper functions + the minimal AiActionDraft table the policies read. The
// policy bodies only touch requester_id / subject_user_id / tenant_coach_id /
// decided_by_id + the app.current_user_id()/is_owner() GUC helpers, so we
// materialise just that surface (the migration ALTERs RLS onto an existing
// table; we recreate the table shape it expects).
const PREREQ_SQL = `
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_id', true), '')
$fn$;

CREATE OR REPLACE FUNCTION app.current_user_role()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(pg_catalog.current_setting('app.current_user_role', true), '')
$fn$;

CREATE OR REPLACE FUNCTION app.is_owner()
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$fn$;

CREATE TABLE IF NOT EXISTS public."AiActionDraft" (
  "id" text PRIMARY KEY,
  "capability" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "requester_id" text,
  "subject_user_id" text,
  "tenant_coach_id" text,
  "decided_by_id" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
`;

/** Extract ONLY the AiActionDraft-relevant statements from the migration. */
function aiActionDraftMigrationSql(): string {
  const full = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  // The migration enables+forces RLS and creates the four AiActionDraft
  // policies. We slice the statements that mention AiActionDraft so the
  // suite stays focused and does not require the other tables in the file.
  const statements = full
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.includes('"AiActionDraft"'));
  return statements.join(';\n') + ';\n';
}

const COACH_A = 'mwb5-coach-a';
const COACH_B = 'mwb5-coach-b';
const CLIENT = 'mwb5-client-1';
const DRAFT_ID = 'mwb5-draft-create-1';

liveDescribe('AiActionDraft RLS — MWB-5 live-create tenant isolation (#11)', () => {
  let prisma: PrismaClient;

  async function visibleCount(
    role: string,
    userId: string | null,
    userRole: string | null,
  ): Promise<number> {
    let n = 0;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_user_id', $1, true)`,
        userId ?? '',
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_user_role', $1, true)`,
        userRole ?? '',
      );
      const rows = await tx.$queryRawUnsafe<Array<{ c: bigint }>>(
        `SELECT count(*)::bigint AS c FROM public."AiActionDraft" WHERE id = $1`,
        DRAFT_ID,
      );
      n = Number(rows[0].c);
    });
    return n;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
    await prisma.$connect();

    // Ensure the two RLS roles exist (idempotent) and can read the table.
    await prisma.$executeRawUnsafe(`
      DO $do$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SERVICE_ROLE}') THEN
          CREATE ROLE "${SERVICE_ROLE}" BYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AUTHED_ROLE}') THEN
          CREATE ROLE "${AUTHED_ROLE}";
        END IF;
      END $do$;
    `);

    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS public."AiActionDraft" CASCADE`);
    // Run the prerequisite helpers + table, then the migration's RLS + policies.
    for (const stmt of PREREQ_SQL.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(stmt);
    }
    await prisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public."AiActionDraft" TO "${AUTHED_ROLE}"`,
    );
    for (const stmt of aiActionDraftMigrationSql().split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(stmt);
    }

    // Seed a live-create draft authored by coach A for their client, as the
    // service_role (bypasses RLS) — mirrors the gateway INSERT path.
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."AiActionDraft"
         (id, capability, status, requester_id, subject_user_id, tenant_coach_id, payload)
       VALUES ($1, 'draft.create_workout_plan', 'pending', $2, $3, $2, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      DRAFT_ID,
      COACH_A,
      CLIENT,
    );
  }, 120_000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it('RLS is ENABLED and FORCED on AiActionDraft', async () => {
    const rel = await prisma.$queryRawUnsafe<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = 'AiActionDraft'`,
    );
    expect(rel[0].relrowsecurity).toBe(true);
    expect(rel[0].relforcerowsecurity).toBe(true);
  });

  it('the authoring/tenant coach A can SELECT its own live-create draft', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH_A, 'coach')).toBe(1);
  });

  it('the subject client can SELECT the draft (participant policy)', async () => {
    expect(await visibleCount(AUTHED_ROLE, CLIENT, 'student')).toBe(1);
  });

  it('a FOREIGN coach B sees ZERO rows (tenant isolation — #11)', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH_B, 'coach')).toBe(0);
  });

  it('an anon principal (no GUCs) sees ZERO rows', async () => {
    expect(await visibleCount(AUTHED_ROLE, null, null)).toBe(0);
  });

  it('service_role bypasses RLS for the operational read path', async () => {
    expect(await visibleCount(SERVICE_ROLE, null, null)).toBe(1);
  });

  it('the participant-select policy exists on AiActionDraft', async () => {
    const policies = await prisma.$queryRawUnsafe<Array<{ polname: string }>>(
      `SELECT polname FROM pg_policy
         WHERE polrelid = 'public."AiActionDraft"'::regclass`,
    );
    const names = policies.map((p) => p.polname);
    expect(names).toContain('ai_action_draft_participant_select');
    expect(names).toContain('ai_action_draft_requester_insert');
  });
});
