/**
 * rls-mwb3-autosave-undo.spec.ts — MWB-3 RLS + concurrency live proof.
 *
 * This spec belongs to the RLS lane (jest.rls.config.js: testMatch
 * `test/rls-*.spec.ts` + `test/rls/**`; the default lane ignores it). It has two
 * independent live-DB blocks, both gated on a live Postgres URL so they
 * `describe.skip` cleanly when none is provided:
 *
 *   Part A — MWB-3 matrix #13: WorkoutPlanRevision row-level security. Applies
 *     the MWB-1 migration SQL (the canonical policy set) against a real
 *     Postgres, then drives SET LOCAL ROLE + the app.* GUCs to prove a
 *     sub-coach on the head coach's team CAN read that coach's plan revision,
 *     a cross-tenant (foreign) coach/sub-coach CANNOT, and service_role
 *     bypasses RLS. This proves the DB-level tenant floor under which the
 *     application-layer 403 (Part B / controller spec #6) is a second wall.
 *
 *   Part B — MWB-3 matrix #1/#8: real autosave concurrency. Runs the actual
 *     WorkoutBuilderAutosaveService against a multi-connection pool and fires
 *     two parallel autosaves at the same base revision index. Exactly ONE
 *     commits and the other surfaces a TYPED ConflictException (409) — never a
 *     leaked raw Prisma 500 — and the head advances by exactly one (no
 *     double-commit). This is the optimistic-concurrency + Serializable proof.
 *
 * Live-DB gating: the rls-live-tests CI job exposes the throwaway DB as
 * DATABASE_URL; the local builder used MWB3_TEST_DATABASE_URL. Either drives
 * this suite; absent both, it skips with a logged reason (never silently).
 */

import { ConflictException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma.service';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { WorkoutBuilderService } from '../src/workout-builder/workout-builder.service';
import { WorkoutBuilderAutosaveService } from '../src/workout-builder/workout-builder-autosave.service';
import {
  MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV,
  computeLockToken,
} from '../src/workout-builder/lock-token.helper';
import { bootstrapTestSchema } from './utils/bootstrap-test-schema';
import { resetPublicSchema } from './utils/reset-public-schema';

// The rls-live-tests CI job exposes the DB as DATABASE_URL; locally the builder
// used MWB3_TEST_DATABASE_URL. Either drives this suite.
const RAW_TEST_DB_URL =
  process.env.MWB3_TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const liveDescribe = RAW_TEST_DB_URL ? describe : describe.skip;

if (!RAW_TEST_DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[rls-mwb3] neither MWB3_TEST_DATABASE_URL nor DATABASE_URL set — MWB-3 ' +
      'RLS + concurrency live suite skipped.',
  );
}

// SET LOCAL ROLE target names. service_role bypasses RLS (BYPASSRLS); the
// authenticated read role is RLS-bound. Overridable for a real Supabase target.
const SERVICE_ROLE = process.env.RLS_SERVICE_ROLE || 'service_role';
const AUTHED_ROLE = process.env.RLS_AUTHED_ROLE || 'app_authenticated';

const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261215000000_mwb_1_data_model',
  'migration.sql',
);

// Minimal prerequisite schema the MWB-1 policies reference. Mirrors the MWB-1
// RLS spec's PREREQ_SQL (the app.* helper deps + parent tables); the two NEW
// helpers (is_subcoach_of / is_subcoach_on_coach_team) are created BY the
// migration, so they are intentionally NOT defined here.
const PREREQ_SQL = `
CREATE SCHEMA IF NOT EXISTS app;

-- Supabase-convention roles. They pre-exist on a real Supabase database; we
-- create them defensively for this vanilla Postgres test instance so the MWB-1
-- migration's GRANT ... TO service_role, anon, authenticated statements apply.
-- NOSUPERUSER NOBYPASSRLS so RLS is genuinely enforced against them. (Mirrors
-- the canonical provisioning block in test/rls-tier2-sessions-policies.spec.ts.)
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$do$;

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

CREATE TABLE IF NOT EXISTS public."User" (
  "id" text PRIMARY KEY,
  "coach_id" text,
  "role" text NOT NULL
);

CREATE OR REPLACE FUNCTION app.is_user_coached_by(client_user_id text, coach_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT client_user_id IS NOT NULL AND coach_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public."User" u
       WHERE u."id" = client_user_id AND u."coach_id" = coach_user_id AND u."role" = 'student'
     )
$fn$;

CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL
     AND app.is_user_coached_by(client_user_id, app.current_user_id())
$fn$;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkoutPlanType') THEN
    CREATE TYPE "WorkoutPlanType" AS ENUM ('strength', 'cardio', 'mobility');
  END IF;
END
$do$;

CREATE TABLE IF NOT EXISTS public."SubCoachAssignment" (
  "id" text PRIMARY KEY,
  "head_coach_id" text NOT NULL,
  "sub_coach_id" text NOT NULL,
  "client_id" text NOT NULL,
  "unassigned_at" timestamp(3)
);

CREATE TABLE IF NOT EXISTS public."WorkoutPlan" (
  "id" text PRIMARY KEY,
  "coach_id" text NOT NULL,
  "name" text NOT NULL,
  "type" "WorkoutPlanType" NOT NULL DEFAULT 'strength',
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" timestamp(3)
);

CREATE TABLE IF NOT EXISTS public."ClientWorkoutAssignment" (
  "id" text PRIMARY KEY,
  "workout_plan_id" text NOT NULL,
  "client_id" text NOT NULL,
  "assigned_by_coach_id" text NOT NULL,
  "scheduled_for" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * Split a SQL file into top-level statements honoring dollar-quoted blocks and
 * single-quoted literals (copied verbatim from the MWB-1 RLS spec splitter so
 * the migration body parses identically).
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let i = 0;
  let dollarTag: string | null = null;
  let inSingleQuote = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }
    if (inSingleQuote) {
      buf += ch;
      i += 1;
      if (ch === "'") {
        if (sql[i] === "'") {
          buf += sql[i];
          i += 1;
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? sql.length : eol + 1;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '$') {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed) statements.push(trimmed);
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}

function stripLeadingComments(stmt: string): string {
  return stmt
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .trim();
}

function lit(v: string): string {
  // Single-quote a literal, doubling embedded quotes. Inputs here are static
  // test ids (no untrusted data), but we quote correctly regardless.
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Add a connection_limit param to a Prisma URL (preserving any existing query
 * string). Used to FORCE a multi-connection pool for the concurrency proof so
 * the two parallel autosaves actually run on distinct backends.
 */
function pinMultiConnection(url: string): string {
  if (/[?&]connection_limit=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'connection_limit=5';
}

type Tx = {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown[]>;
};

// ─── Part A — matrix #13: WorkoutPlanRevision RLS ────────────────────────────

liveDescribe('MWB-3 #13 — WorkoutPlanRevision RLS (sub-coach cross-tenant)', () => {
  // Single-connection pool so SET LOCAL ROLE / set_config session state is
  // deterministic across statements (mirrors the MWB-1 RLS spec).
  const SINGLE_CONN_URL = RAW_TEST_DB_URL.includes('connection_limit=')
    ? RAW_TEST_DB_URL
    : RAW_TEST_DB_URL +
      (RAW_TEST_DB_URL.includes('?') ? '&' : '?') +
      'connection_limit=1';

  const prisma = new PrismaClient({
    datasources: { db: { url: SINGLE_CONN_URL } },
  });

  async function applyScript(sql: string): Promise<void> {
    for (const raw of splitSqlStatements(sql)) {
      const stmt = stripLeadingComments(raw);
      if (!stmt) continue;
      if (/^(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(stmt)) continue;
      await prisma.$executeRawUnsafe(stmt);
    }
  }

  async function asPrincipal<T>(
    role: string,
    identity: { id?: string; userRole?: string },
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_user_id', ${lit(identity.id ?? '')}, true)`,
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_user_role', ${lit(identity.userRole ?? '')}, true)`,
      );
      return fn(tx as unknown as Tx);
    });
  }

  async function visibleCount(
    role: string,
    identity: { id?: string; userRole?: string },
    whereId?: string,
  ): Promise<number> {
    const where = whereId ? ` WHERE "id" = ${lit(whereId)}` : '';
    const rows = await asPrincipal(role, identity, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT count(*)::bigint AS n FROM public."WorkoutPlanRevision"${where}`,
      ),
    );
    return Number((rows[0] as { n: bigint }).n);
  }

  async function seed(stmts: string[]): Promise<void> {
    await asPrincipal(SERVICE_ROLE, {}, async (tx) => {
      for (const s of stmts) await tx.$executeRawUnsafe(s);
      return null;
    });
  }

  // u_coach owns plan_coach; u_coach2 owns plan_foreign. u_subcoach is on
  // u_coach's team (User.coach_id = u_coach).
  const COACH = { id: 'u_coach', userRole: 'coach' };
  const COACH2 = { id: 'u_coach2', userRole: 'coach' };
  const SUBCOACH = { id: 'u_subcoach', userRole: 'coach' };

  beforeAll(async () => {
    await prisma.$connect();
    // Clean slate so the MWB-1 migration SQL applies onto an empty schema
    // regardless of prior run state or which RLS-lane block ran first.
    await resetPublicSchema(prisma);
    await applyScript(PREREQ_SQL);
    const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
    await applyScript(migrationSql);

    // Table-level DML grants for the Supabase-convention roles. BYPASSRLS on
    // service_role only bypasses ROW policies; it does NOT confer table
    // privileges, and `anon`/`authenticated` have none by default either. The
    // prereq stub tables (User, SubCoachAssignment, WorkoutPlan) and the
    // migration-created WorkoutPlanRevision therefore need explicit grants so
    // the service_role seed can INSERT and the RLS-bound roles can attempt the
    // reads RLS then filters. (Same posture as the tier2 sessions RLS spec.)
    // app_authenticated is THIS instance's RLS-bound login-less role (the
    // default for AUTHED_ROLE); include it alongside the Supabase-convention
    // names so the SELECT-as-principal reads reach RLS rather than tripping a
    // bare table-privilege denial before any policy is evaluated.
    await applyScript(`
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON public."User", public."SubCoachAssignment",
           public."WorkoutPlan", public."WorkoutPlanRevision"
        TO service_role, authenticated, anon, app_authenticated;
    `);

    // The RLS policies evaluate app.* helper functions (is_subcoach_on_coach_team,
    // is_current_coach_of, ...). The role the policy runs as therefore needs
    // USAGE on schema app + EXECUTE on those helpers, or the SELECT fails with a
    // bare "permission denied for schema app" before the policy can decide. The
    // migration grants EXECUTE to the Supabase-convention roles only; grant the
    // same to app_authenticated (this instance's RLS-bound read role).
    await applyScript(`
      GRANT USAGE ON SCHEMA app TO app_authenticated;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app
        TO service_role, authenticated, anon, app_authenticated;
    `);

    // Fail loudly if WorkoutPlanRevision is not RLS enabled+forced (the floor).
    const rel = (await prisma.$queryRawUnsafe(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'WorkoutPlanRevision'`,
    )) as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
    if (!rel[0] || !rel[0].relrowsecurity || !rel[0].relforcerowsecurity) {
      throw new Error('WorkoutPlanRevision is not RLS enabled+forced');
    }
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean as the connection's own (superuser/table-owner) role rather than
    // under SET LOCAL ROLE service_role: TRUNCATE requires table ownership or an
    // explicit TRUNCATE grant, which service_role (SELECT/INSERT/UPDATE/DELETE +
    // BYPASSRLS only) does not hold. DELETE FROM in FK-child-first order is the
    // repo convention (see test/rls-tier2-sessions-policies.spec.ts) and is
    // grant-covered, so the reset never depends on TRUNCATE privileges.
    await prisma.$executeRawUnsafe('DELETE FROM public."WorkoutPlanRevision"');
    await prisma.$executeRawUnsafe('DELETE FROM public."WorkoutPlan"');
    await prisma.$executeRawUnsafe('DELETE FROM public."SubCoachAssignment"');
    await prisma.$executeRawUnsafe('DELETE FROM public."User"');
    await seed([
      `INSERT INTO public."User"("id","coach_id","role") VALUES
         ('u_coach',    NULL,      'coach'),
         ('u_coach2',   NULL,      'coach'),
         ('u_subcoach', 'u_coach', 'coach')`,
      `INSERT INTO public."WorkoutPlan"("id","coach_id","name","type") VALUES
         ('plan_coach','u_coach','Coach Plan','strength'),
         ('plan_foreign','u_coach2','Foreign Plan','strength')`,
      // A revision on the head coach's plan and one on the foreign coach's plan.
      `INSERT INTO public."WorkoutPlanRevision"
         ("id","workout_plan_id","revision_index","exercises_json","plan_meta_json","author_id","author_kind","cause")
       VALUES
         ('rev_coach','plan_coach',1,'[]'::jsonb,'{}'::jsonb,'u_coach','coach','autosave'),
         ('rev_foreign','plan_foreign',1,'[]'::jsonb,'{}'::jsonb,'u_coach2','coach','autosave')`,
    ]);
  });

  it('a sub-coach on the team CAN read its head coach plan revision', async () => {
    expect(await visibleCount(AUTHED_ROLE, SUBCOACH, 'rev_coach')).toBe(1);
  });

  it('a sub-coach CANNOT read another tenant (foreign coach) revision', async () => {
    expect(await visibleCount(AUTHED_ROLE, SUBCOACH, 'rev_foreign')).toBe(0);
  });

  it('the head coach cannot read the foreign tenant revision either', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'rev_foreign')).toBe(0);
  });

  it('the foreign coach cannot read the head coach revision', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH2, 'rev_coach')).toBe(0);
  });

  it('service_role bypasses RLS and sees both revisions', async () => {
    expect(await visibleCount(SERVICE_ROLE, {})).toBe(2);
  });

  it('the head coach CAN read its own plan revision', async () => {
    expect(await visibleCount(AUTHED_ROLE, COACH, 'rev_coach')).toBe(1);
  });
});

// ─── Part B — matrix #1/#8: real autosave concurrency ────────────────────────

const COACH_ID = 'mwb3-conc-coach';
const PLAN_ID = 'mwb3-conc-plan';
// Deterministic HMAC test secret for the optimistic-lock token (§6.2). The
// token is no longer a static literal: it is computeLockToken(planId, version,
// head_revision_id), so each test derives the EXPECTED token from the persisted
// plan state it just created.
const LOCK_SECRET = 'mwb3-test-lock-secret-0123456789abcdef';

function insertOp(externalId: string) {
  // Insert (no row_id) one exercise row — matches UpsertExerciseOpSchema /
  // UpsertExerciseRowSchema in workout-builder-autosave.dto.ts exactly.
  return {
    op: 'upsert_exercise' as const,
    payload: {
      exercise_external_id: externalId,
      order: 1,
      sets: 3,
      reps_or_duration_seconds: 10,
    },
  };
}

const settle = (p: Promise<unknown>) =>
  p.then(
    (r) => ({ ok: true as const, r }),
    (e) => ({ ok: false as const, e }),
  );

liveDescribe('MWB-3 #1/#8 — autosave concurrency (real service, live DB)', () => {
  let prisma: PrismaClient;
  let autosave: WorkoutBuilderAutosaveService;
  // The valid optimistic-lock token for the freshly-seeded plan at version 1
  // with head = rev0 (revision_index 0). Recomputed each beforeEach from the
  // actual persisted state so the parallel autosaves below pass the lock gate
  // and the conflict is decided purely by the base-index / Serializable race.
  let validToken: string;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: pinMultiConnection(RAW_TEST_DB_URL) } },
    });
    await prisma.$connect();
    await resetPublicSchema(prisma);
    await bootstrapTestSchema(prisma);

    const scope = new SubCoachScopeService(prisma as unknown as PrismaService);
    const builder = new WorkoutBuilderService(
      prisma as unknown as PrismaService,
      undefined,
      scope,
    );
    autosave = new WorkoutBuilderAutosaveService(
      prisma as unknown as PrismaService,
      builder,
      new AnalyticsService(),
      scope,
    );
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = LOCK_SECRET;
  }, 120_000);

  afterAll(async () => {
    delete process.env.FEATURE_MWB_AUTOSAVE_UNDO;
    delete process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV];
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    process.env.FEATURE_MWB_AUTOSAVE_UNDO = 'true';
    process.env[MWB_AUTOSAVE_LOCK_TOKEN_SECRET_ENV] = LOCK_SECRET;
    // Clean slate, children first (FK order).
    await prisma.workoutPlanRevision.deleteMany({});
    await prisma.workoutPlanExercise.deleteMany({});
    await prisma.workoutPlan.deleteMany({});
    await prisma.user.deleteMany({ where: { id: COACH_ID } });

    await prisma.user.create({
      data: {
        id: COACH_ID,
        supabase_id: `sb-${COACH_ID}`,
        email: `${COACH_ID}@example.test`,
        name: 'Concurrency Coach',
        role: 'coach',
      },
    });
    await prisma.workoutPlan.create({
      data: {
        id: PLAN_ID,
        coach_id: COACH_ID,
        name: 'Concurrency Plan',
        type: 'strength',
      },
    });
    const rev0 = await prisma.workoutPlanRevision.create({
      data: {
        workout_plan_id: PLAN_ID,
        revision_index: 0,
        exercises_json: [],
        plan_meta_json: {},
        author_id: COACH_ID,
        author_kind: 'coach',
        cause: 'autosave',
      },
    });
    await prisma.workoutPlan.update({
      where: { id: PLAN_ID },
      data: { head_revision_id: rev0.id, version: 1 },
    });
    // Derive the valid token for the seeded state (version 1, head = rev0).
    validToken = computeLockToken(PLAN_ID, 1, rev0.id);
  });

  it('#1/#8 two parallel autosaves at base 0: exactly one commits, the other gets a typed 409', async () => {
    const [a, b] = await Promise.all([
      settle(
        autosave.applyAutosave(
          PLAN_ID,
          { userId: COACH_ID },
          {
            base_revision_index: 0,
            lock_token: validToken,
            ops: [insertOp('squat')],
            cause: 'manual_edit',
          },
        ),
      ),
      settle(
        autosave.applyAutosave(
          PLAN_ID,
          { userId: COACH_ID },
          {
            base_revision_index: 0,
            lock_token: validToken,
            ops: [insertOp('bench')],
            cause: 'manual_edit',
          },
        ),
      ),
    ]);

    const outcomes = [a, b];
    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);

    // Exactly one commit, exactly one rejection.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // The loser is a TYPED ConflictException (409), whether the loss came from
    // the optimistic base-index assert (the FOR-UPDATE winner advanced the head
    // first) or a Serializable write-conflict coerced from Prisma P2034 (#8) —
    // both paths must surface the same typed conflict, never a leaked 500.
    const loser = losers[0];
    if (!loser.ok) {
      expect(loser.e).toBeInstanceOf(ConflictException);
    }

    // The DB advanced the head by exactly ONE (head 0 -> 1): no double-commit.
    const plan = await prisma.workoutPlan.findUniqueOrThrow({
      where: { id: PLAN_ID },
      select: { head_revision_id: true, version: true },
    });
    const head = await prisma.workoutPlanRevision.findUniqueOrThrow({
      where: { id: plan.head_revision_id! },
      select: { revision_index: true },
    });
    expect(head.revision_index).toBe(1);

    // Exactly two revisions exist total (index 0 initial + index 1 winner) —
    // the loser wrote nothing.
    const count = await prisma.workoutPlanRevision.count({
      where: { workout_plan_id: PLAN_ID },
    });
    expect(count).toBe(2);
  }, 60_000);
});
