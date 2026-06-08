/**
 * PR-RLS-05 — Tier 3 nutrition & hydration RLS policy enforcement.
 *
 * Verifies the migration 20261213000000_rls_tier3_nutrition end-to-end against a
 * REAL PostgreSQL instance (NO mocks). For each of the 7 covered tables it asserts
 * 8 behaviors:
 *   1. owner operator (app.is_owner()) can read
 *   2. the legitimate tenant (coach / client / logging user) can read
 *   3. the legitimate tenant can insert their own row
 *   4. the legitimate tenant can update their own row
 *   5. a foreign authenticated user cannot read another tenant's row
 *   6. a foreign authenticated user cannot write into another tenant (cross-tenant write denied)
 *   7. an unauthenticated caller is denied (except the public FoodItem catalog SELECT)
 *   8. the service_role bypass (Primitive A) sees and writes everything
 *
 * == How RLS is exercised honestly ==
 * The login role (`rls_tester`) is a member of the NOLOGIN roles `authenticated`
 * (an ordinary end-user with NO privileged policy grants) and `service_role`. Each
 * test narrows the effective role with `SET ROLE` so PostgreSQL evaluates only the
 * policies applicable to that role:
 *   - `SET ROLE authenticated`  → only the `TO public` per-row policies apply.
 *   - `SET ROLE service_role`   → the permissive `service_role_all` policy applies.
 * The "current user" identity inside the policies is supplied via the
 * `app.current_user_id` / `app.current_user_role` GUCs, matching the production
 * backend convention. Because the migration FORCEs RLS, the policies apply to the
 * table-owning role too, so even the bootstrap role is governed by them once it
 * narrows to `authenticated`.
 *
 * Connection: RLS_TIER3_TEST_DATABASE_URL (preferred) or DATABASE_URL, defaulting
 * to a throwaway local `rls_tier3_test` database owned by `rls_login`. The
 * PrismaClient is constructed against that URL via the `datasources` override so it
 * never touches the app's default database or production Supabase.
 *
 * Idempotent: the suite DELETEs and re-seeds its fixtures in beforeEach, and the
 * migration itself is DROP-IF-EXISTS guarded, so the file can be run repeatedly.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient, Prisma } from '@prisma/client';

// The interactive-transaction client. Typing the callback parameter lets the
// generic $queryRawUnsafe<...> / $executeRawUnsafe calls inside resolve (ts-jest
// rejects type arguments on an implicitly-`any` receiver).
type Tx = Prisma.TransactionClient;

const MIGRATION_SQL_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261213000000_rls_tier3_nutrition',
  'migration.sql',
);

const TEST_DB_URL =
  process.env.RLS_TIER3_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://rls_login:rls_login_pw@localhost:5432/rls_tier3_test';

// Prerequisite catalog objects mirroring the production columns the policies read.
// Applied (as the owning login role) before the migration so its ALTER/CREATE
// POLICY statements have valid targets and the helper functions resolve.
const PREREQ_SQL = `
CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public."User" (
  "id" text PRIMARY KEY,
  "coach_id" text,
  "role" text NOT NULL
);

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')
$fn$;
CREATE OR REPLACE FUNCTION app.current_user_role() RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT NULLIF(current_setting('app.current_user_role', true), '')
$fn$;
CREATE OR REPLACE FUNCTION app.is_owner() RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = 'owner'
$fn$;
CREATE OR REPLACE FUNCTION app.is_user_coached_by(client_user_id text, coach_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT client_user_id IS NOT NULL AND coach_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public."User" u
       WHERE u."id" = client_user_id AND u."coach_id" = coach_user_id AND u."role" = 'student'
     )
$fn$;
CREATE OR REPLACE FUNCTION app.is_current_coach_of(client_user_id text) RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $fn$
  SELECT app.current_user_id() IS NOT NULL AND app.is_user_coached_by(client_user_id, app.current_user_id())
$fn$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public."MealPlan" (
  "id" text PRIMARY KEY, "coach_id" text, "client_id" text, "title" text NOT NULL
);
CREATE TABLE IF NOT EXISTS public."MealTemplate" (
  "id" text PRIMARY KEY, "coach_id" text NOT NULL, "name" text NOT NULL
);
CREATE TABLE IF NOT EXISTS public."DailyMealPlan" (
  "id" text PRIMARY KEY, "coach_id" text NOT NULL, "name" text NOT NULL
);
CREATE TABLE IF NOT EXISTS public."DailyMealPlanSlot" (
  "id" text PRIMARY KEY, "daily_meal_plan_id" text NOT NULL, "meal_template_id" text NOT NULL,
  "slot_label" text NOT NULL, "order" integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS public."DailyMealPlanAssignment" (
  "id" text PRIMARY KEY, "daily_meal_plan_id" text NOT NULL, "client_id" text NOT NULL,
  "assigned_by_coach_id" text NOT NULL, "starts_on" date NOT NULL DEFAULT CURRENT_DATE
);
CREATE TABLE IF NOT EXISTS public."FoodItem" (
  "id" text PRIMARY KEY, "name" text NOT NULL
);
CREATE TABLE IF NOT EXISTS public."water_logs" (
  "id" text PRIMARY KEY, "user_id" text NOT NULL, "amount_ml" integer NOT NULL DEFAULT 0
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
`;

/**
 * Split a SQL file into top-level statements on semicolons that are NOT inside a
 * dollar-quoted block or single-quoted literal. Mirrors the splitter from
 * rls-helper-search-path.spec.ts so the migration applies exactly as Prisma would
 * while still being executable one statement at a time via $executeRawUnsafe.
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
  return statements.filter((s) => !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s.trim()));
}

function stripLeadingComments(stmt: string): string {
  return stmt
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .trim();
}

const SINGLE_CONN_URL = TEST_DB_URL.includes('connection_limit=')
  ? TEST_DB_URL
  : TEST_DB_URL + (TEST_DB_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

const prisma = new PrismaClient({
  datasources: { db: { url: SINGLE_CONN_URL } },
});

async function applyScript(sql: string): Promise<void> {
  for (const raw of splitSqlStatements(sql)) {
    const stmt = stripLeadingComments(raw);
    if (!stmt) continue;
    if (/^(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(stmt)) continue;
    // No swallowing: any failure here must fail the suite loudly (R0).
    await prisma.$executeRawUnsafe(stmt);
  }
}

/** Identity context. pgRole = 'authenticated' adopts the authenticated role; 'service' adopts service_role. */
type Ctx = { userId: string | null; userRole: string | null; pgRole: 'authenticated' | 'service' };

const OWNER: Ctx = { userId: 'op_owner', userRole: 'owner', pgRole: 'authenticated' };
const SERVICE: Ctx = { userId: null, userRole: null, pgRole: 'service' };
const ANON: Ctx = { userId: null, userRole: null, pgRole: 'authenticated' };
function coach(id: string): Ctx { return { userId: id, userRole: 'coach', pgRole: 'authenticated' }; }
function client(id: string): Ctx { return { userId: id, userRole: 'student', pgRole: 'authenticated' }; }

/**
 * Run `fn` under a given identity inside its own transaction, narrowing the
 * effective Postgres role and setting the GUC identity, then ROLLING BACK so
 * fixtures stay deterministic across tests. SET LOCAL ROLE + set_config(..., true)
 * are transaction-scoped, so the rollback fully restores the connection.
 */
async function asCtx<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let captured: T;
  let threw: unknown = null;
  try {
    await prisma.$transaction(async (tx) => {
      const pgRole = ctx.pgRole === 'service' ? 'service_role' : 'authenticated';
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${pgRole}`);
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_user_id', $1, true)`,
        ctx.userId ?? '',
      );
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_user_role', $1, true)`,
        ctx.userRole ?? '',
      );
      captured = await fn(tx);
      // Force rollback so writes performed by positive-path assertions do not
      // leak into sibling tests; we assert on the in-transaction result.
      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) {
      return captured!;
    }
    threw = e;
  }
  if (threw) throw threw;
  return captured!;
}

class Rollback extends Error {}

/** SELECT count from a table under a ctx. */
async function countAs(ctx: Ctx, table: string, whereId: string): Promise<number> {
  return asCtx(ctx, async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM public."${table}" WHERE "id" = $1`,
      whereId,
    );
    return Number(rows[0].n);
  });
}

/** Attempt a write under a ctx; resolves to true if it succeeded (affected>=0 without RLS error). */
async function tryExec(ctx: Ctx, sql: string, params: any[]): Promise<{ ok: boolean; affected: number; error?: string }> {
  return asCtx(ctx, async (tx) => {
    try {
      const affected = await tx.$executeRawUnsafe(sql, ...params);
      return { ok: true, affected: Number(affected) };
    } catch (e: any) {
      return { ok: false, affected: 0, error: String(e?.message ?? e) };
    }
  });
}

/**
 * Run a write under a ctx and re-throw the ORIGINAL Prisma error (preserving
 * `code` / `meta.code` SQLSTATE) so callers can assert the precise rejection.
 * Resolves to the affected-row count when the statement succeeds.
 */
async function execAs(ctx: Ctx, sql: string, params: any[] = []): Promise<number> {
  return asCtx(ctx, async (tx) => {
    const affected = await tx.$executeRawUnsafe(sql, ...params);
    return Number(affected);
  });
}

/**
 * Assert a query is rejected by RLS with a precise Postgres SQLSTATE.
 * Accepts Prisma's P2010 raw-query wrapper carrying meta.code === '42501'
 * (insufficient_privilege / RLS WITH CHECK violation) or '42P17'
 * (infinite recursion in policy), or a directly-exposed SQLSTATE on err.code.
 * Message-regex matching is NOT used as the primary signal.
 */
async function expectRlsDenied(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error('Expected RLS denial but query succeeded');
  } catch (err: unknown) {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    const sqlstate = e.meta?.code ?? '';
    if (e.code === 'P2010' && (sqlstate === '42501' || sqlstate === '42P17')) return;
    if (e.code === '42501' || e.code === '42P17') return;
    throw new Error(
      `Expected SQLSTATE 42501 (RLS denial); got code=${e.code ?? 'undefined'} ` +
      `meta.code=${sqlstate || 'undefined'} message=${e.message ?? ''}`,
    );
  }
}

beforeAll(async () => {
  await prisma.$connect();
  await applyScript(PREREQ_SQL);
  const migrationSql = fs.readFileSync(MIGRATION_SQL_PATH, 'utf8');
  await applyScript(migrationSql);

  // Fail loudly (R0) if the migration did not enable+force RLS on all 7 tables.
  const enforced = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM pg_class
      WHERE relname IN ('MealPlan','MealTemplate','DailyMealPlan','DailyMealPlanSlot','DailyMealPlanAssignment','FoodItem','water_logs')
        AND relrowsecurity AND relforcerowsecurity`,
  );
  if (Number(enforced[0].n) !== 7) {
    throw new Error(`bootstrap incomplete: expected 7 RLS-forced tables, found ${enforced[0].n}`);
  }
  const policies = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM pg_policies
      WHERE tablename IN ('MealPlan','MealTemplate','DailyMealPlan','DailyMealPlanSlot','DailyMealPlanAssignment','FoodItem','water_logs')`,
  );
  if (Number(policies[0].n) !== 35) {
    throw new Error(`bootstrap incomplete: expected 35 policies, found ${policies[0].n}`);
  }
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Seed a deterministic graph. Run as the bootstrap login role (BYPASS via the
 * service_role policy is NOT used here; we run plain, owner-level — but RLS is
 * FORCED, so we narrow to service_role to perform unconditional seeding).
 *
 *   coachX  — coach, coaches clientX
 *   clientX — student under coachX
 *   coachY  — unrelated coach (the "foreign" tenant)
 *   clientY — student under coachY
 */
async function reseed(): Promise<void> {
  // Narrow to service_role so the permissive Primitive A policy lets the seed
  // write unconditionally under FORCED RLS; each statement auto-commits on the
  // pool-pinned connection so fixtures persist for the assertion transactions.
  await prisma.$executeRawUnsafe(`SET ROLE service_role`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM public."DailyMealPlanSlot"`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."DailyMealPlanAssignment"`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."DailyMealPlan"`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."MealTemplate"`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."MealPlan"`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."FoodItem"`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."water_logs"`);
    await prisma.$executeRawUnsafe(`DELETE FROM public."User"`);

    await prisma.$executeRawUnsafe(
      `INSERT INTO public."User"("id","coach_id","role") VALUES
        ('coachX',NULL,'coach'),
        ('clientX','coachX','student'),
        ('coachY',NULL,'coach'),
        ('clientY','coachY','student')`,
    );

    // MealPlan: coachX's plan for clientX
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."MealPlan"("id","coach_id","client_id","title") VALUES ('mp_X','coachX','clientX','Plan X')`,
    );
    // MealTemplate owned by coachX
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."MealTemplate"("id","coach_id","name") VALUES ('mt_X','coachX','Template X')`,
    );
    // DailyMealPlan owned by coachX
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."DailyMealPlan"("id","coach_id","name") VALUES ('dmp_X','coachX','Daily X')`,
    );
    // DailyMealPlanSlot under coachX's plan, referencing coachX's template
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."DailyMealPlanSlot"("id","daily_meal_plan_id","meal_template_id","slot_label","order")
       VALUES ('slot_X','dmp_X','mt_X','breakfast',0)`,
    );
    // DailyMealPlanAssignment: coachX assigns dmp_X to clientX
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."DailyMealPlanAssignment"("id","daily_meal_plan_id","client_id","assigned_by_coach_id","starts_on")
       VALUES ('asg_X','dmp_X','clientX','coachX',CURRENT_DATE)`,
    );
    // FoodItem catalog entry (no owner column)
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."FoodItem"("id","name") VALUES ('food_1','Chicken Breast')`,
    );
    // water_logs for clientX
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."water_logs"("id","user_id","amount_ml") VALUES ('wl_X','clientX',500)`,
    );
  } finally {
    // Always restore the login role even if a seed statement fails (R0: no
    // silently-leaked elevated role on the shared connection).
    await prisma.$executeRawUnsafe(`RESET ROLE`);
  }
}

beforeEach(async () => {
  await reseed();
});

// ───────────────────────────────────────────────────────────────────────────
// MealPlan — client-self-or-coach (coach_id / client_id)
// ───────────────────────────────────────────────────────────────────────────
describe('PR-RLS-05: MealPlan (client-self-or-coach)', () => {
  it('owner operator can read', async () => {
    expect(await countAs(OWNER, 'MealPlan', 'mp_X')).toBe(1);
  });
  it('the plan coach can read (tenant access)', async () => {
    expect(await countAs(coach('coachX'), 'MealPlan', 'mp_X')).toBe(1);
  });
  it('the plan client can read (tenant access)', async () => {
    expect(await countAs(client('clientX'), 'MealPlan', 'mp_X')).toBe(1);
  });
  it('the plan coach can insert their own plan', async () => {
    const r = await tryExec(coach('coachX'),
      `INSERT INTO public."MealPlan"("id","coach_id","client_id","title") VALUES ('mp_new','coachX','clientX','New')`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('the plan coach can update their own plan', async () => {
    const r = await tryExec(coach('coachX'),
      `UPDATE public."MealPlan" SET "title"='Edited' WHERE "id"='mp_X'`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('a foreign coach is denied read', async () => {
    expect(await countAs(coach('coachY'), 'MealPlan', 'mp_X')).toBe(0);
  });
  it('a foreign coach cannot insert a cross-tenant plan (WITH CHECK → 42501)', async () => {
    await expectRlsDenied(execAs(coach('coachY'),
      `INSERT INTO public."MealPlan"("id","coach_id","client_id","title") VALUES ('mp_evil','coachX','clientX','Evil')`));
  });
  it('a foreign coach cannot UPDATE another coach\'s plan (USING filters to 0; row unchanged)', async () => {
    expect(await execAs(coach('coachY'),
      `UPDATE public."MealPlan" SET "title"='Hijacked' WHERE "id"='mp_X'`)).toBe(0);
    const row = await asCtx(SERVICE, async (tx) =>
      (await tx.$queryRawUnsafe<{ title: string }[]>(`SELECT "title" FROM public."MealPlan" WHERE "id"='mp_X'`))[0]);
    expect(row.title).toBe('Plan X');
  });
  it('a foreign coach cannot DELETE another coach\'s plan (USING filters to 0; row survives)', async () => {
    expect(await execAs(coach('coachY'),
      `DELETE FROM public."MealPlan" WHERE "id"='mp_X'`)).toBe(0);
    expect(await countAs(SERVICE, 'MealPlan', 'mp_X')).toBe(1);
  });
  it('an unauthenticated caller is denied; service_role bypasses', async () => {
    expect(await countAs(ANON, 'MealPlan', 'mp_X')).toBe(0);
    expect(await countAs(SERVICE, 'MealPlan', 'mp_X')).toBe(1);
  });
  // PR-05 regression: same coach, different client must NOT leak another client's plan.
  it('same-coach different-client cannot SELECT/UPDATE/DELETE the plan', async () => {
    // Make clientZ a second student under coachX; plan mp_X belongs to clientX.
    await prisma.$executeRawUnsafe(`SET ROLE service_role`);
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."User"("id","coach_id","role") VALUES ('clientZ','coachX','student') ON CONFLICT ("id") DO NOTHING`);
    } finally {
      await prisma.$executeRawUnsafe(`RESET ROLE`);
    }
    // clientZ shares coachX but is not the plan's client_id → no access.
    expect(await countAs(client('clientZ'), 'MealPlan', 'mp_X')).toBe(0);
    expect(await execAs(client('clientZ'),
      `UPDATE public."MealPlan" SET "title"='Z' WHERE "id"='mp_X'`)).toBe(0);
    expect(await execAs(client('clientZ'),
      `DELETE FROM public."MealPlan" WHERE "id"='mp_X'`)).toBe(0);
    expect(await countAs(SERVICE, 'MealPlan', 'mp_X')).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// MealTemplate — coach-self (coach_id)
// ───────────────────────────────────────────────────────────────────────────
describe('PR-RLS-05: MealTemplate (coach-self)', () => {
  it('owner operator can read', async () => {
    expect(await countAs(OWNER, 'MealTemplate', 'mt_X')).toBe(1);
  });
  it('the owning coach can read (tenant access)', async () => {
    expect(await countAs(coach('coachX'), 'MealTemplate', 'mt_X')).toBe(1);
  });
  it('the owning coach can insert their own template', async () => {
    const r = await tryExec(coach('coachX'),
      `INSERT INTO public."MealTemplate"("id","coach_id","name") VALUES ('mt_new','coachX','New')`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('the owning coach can update their own template', async () => {
    const r = await tryExec(coach('coachX'),
      `UPDATE public."MealTemplate" SET "name"='Edited' WHERE "id"='mt_X'`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it("a foreign coach is denied read", async () => {
    expect(await countAs(coach('coachY'), 'MealTemplate', 'mt_X')).toBe(0);
  });
  it('the owning coach cannot reassign a template to another coach (WITH CHECK → 42501)', async () => {
    await expectRlsDenied(execAs(coach('coachX'),
      `UPDATE public."MealTemplate" SET "coach_id"='coachY' WHERE "id"='mt_X'`));
  });
  it('a foreign coach cannot insert under another coach (WITH CHECK → 42501)', async () => {
    await expectRlsDenied(execAs(coach('coachY'),
      `INSERT INTO public."MealTemplate"("id","coach_id","name") VALUES ('mt_evil','coachX','Evil')`));
  });
  it('a foreign coach cannot UPDATE another coach\'s template (USING filters to 0; row unchanged)', async () => {
    expect(await execAs(coach('coachY'),
      `UPDATE public."MealTemplate" SET "name"='Hijacked' WHERE "id"='mt_X'`)).toBe(0);
    const row = await asCtx(SERVICE, async (tx) =>
      (await tx.$queryRawUnsafe<{ name: string }[]>(`SELECT "name" FROM public."MealTemplate" WHERE "id"='mt_X'`))[0]);
    expect(row.name).toBe('Template X');
  });
  it('a foreign coach cannot DELETE another coach\'s template (USING filters to 0; row survives)', async () => {
    expect(await execAs(coach('coachY'),
      `DELETE FROM public."MealTemplate" WHERE "id"='mt_X'`)).toBe(0);
    expect(await countAs(SERVICE, 'MealTemplate', 'mt_X')).toBe(1);
  });
  it('an unauthenticated caller is denied; service_role bypasses', async () => {
    expect(await countAs(ANON, 'MealTemplate', 'mt_X')).toBe(0);
    expect(await countAs(SERVICE, 'MealTemplate', 'mt_X')).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DailyMealPlan — coach-self (coach_id)
// ───────────────────────────────────────────────────────────────────────────
describe('PR-RLS-05: DailyMealPlan (coach-self)', () => {
  it('owner operator can read', async () => {
    expect(await countAs(OWNER, 'DailyMealPlan', 'dmp_X')).toBe(1);
  });
  it('the owning coach can read (tenant access)', async () => {
    expect(await countAs(coach('coachX'), 'DailyMealPlan', 'dmp_X')).toBe(1);
  });
  it('the owning coach can insert their own plan', async () => {
    const r = await tryExec(coach('coachX'),
      `INSERT INTO public."DailyMealPlan"("id","coach_id","name") VALUES ('dmp_new','coachX','New')`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('the owning coach can update their own plan', async () => {
    const r = await tryExec(coach('coachX'),
      `UPDATE public."DailyMealPlan" SET "name"='Edited' WHERE "id"='dmp_X'`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('a foreign coach is denied read', async () => {
    expect(await countAs(coach('coachY'), 'DailyMealPlan', 'dmp_X')).toBe(0);
  });
  it('a foreign coach cannot UPDATE another coach\'s plan (USING filters to 0; row unchanged)', async () => {
    expect(await execAs(coach('coachY'),
      `UPDATE public."DailyMealPlan" SET "name"='Hijacked' WHERE "id"='dmp_X'`)).toBe(0);
    const row = await asCtx(SERVICE, async (tx) =>
      (await tx.$queryRawUnsafe<{ name: string }[]>(`SELECT "name" FROM public."DailyMealPlan" WHERE "id"='dmp_X'`))[0]);
    expect(row.name).toBe('Daily X');
  });
  it('a foreign coach cannot DELETE another coach\'s plan (USING filters to 0; row survives)', async () => {
    expect(await execAs(coach('coachY'),
      `DELETE FROM public."DailyMealPlan" WHERE "id"='dmp_X'`)).toBe(0);
    expect(await countAs(SERVICE, 'DailyMealPlan', 'dmp_X')).toBe(1);
  });
  it('a foreign coach cannot insert under another coach (WITH CHECK → 42501)', async () => {
    await expectRlsDenied(execAs(coach('coachY'),
      `INSERT INTO public."DailyMealPlan"("id","coach_id","name") VALUES ('dmp_evil','coachX','Evil')`));
  });
  it('an unauthenticated caller is denied; service_role bypasses', async () => {
    expect(await countAs(ANON, 'DailyMealPlan', 'dmp_X')).toBe(0);
    expect(await countAs(SERVICE, 'DailyMealPlan', 'dmp_X')).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DailyMealPlanSlot — child-via-daily-meal-plan / meal-template
// ───────────────────────────────────────────────────────────────────────────
describe('PR-RLS-05: DailyMealPlanSlot (child-via-parent)', () => {
  it('owner operator can read', async () => {
    expect(await countAs(OWNER, 'DailyMealPlanSlot', 'slot_X')).toBe(1);
  });
  it('the parent-plan coach can read (tenant access via parent)', async () => {
    expect(await countAs(coach('coachX'), 'DailyMealPlanSlot', 'slot_X')).toBe(1);
  });
  it('the parent-plan coach can insert a slot into their plan', async () => {
    const r = await tryExec(coach('coachX'),
      `INSERT INTO public."DailyMealPlanSlot"("id","daily_meal_plan_id","meal_template_id","slot_label","order")
       VALUES ('slot_new','dmp_X','mt_X','lunch',1)`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('the parent-plan coach can update a slot in their plan', async () => {
    const r = await tryExec(coach('coachX'),
      `UPDATE public."DailyMealPlanSlot" SET "slot_label"='brunch' WHERE "id"='slot_X'`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('a foreign coach is denied read of the slot', async () => {
    expect(await countAs(coach('coachY'), 'DailyMealPlanSlot', 'slot_X')).toBe(0);
  });
  it('a foreign coach cannot insert a slot into another coach\'s plan (WITH CHECK → 42501)', async () => {
    await expectRlsDenied(execAs(coach('coachY'),
      `INSERT INTO public."DailyMealPlanSlot"("id","daily_meal_plan_id","meal_template_id","slot_label","order")
       VALUES ('slot_evil','dmp_X','mt_X','dinner',2)`));
  });
  it('a foreign coach cannot UPDATE another coach\'s slot (USING filters to 0; row unchanged)', async () => {
    expect(await execAs(coach('coachY'),
      `UPDATE public."DailyMealPlanSlot" SET "slot_label"='hijack' WHERE "id"='slot_X'`)).toBe(0);
    const row = await asCtx(SERVICE, async (tx) =>
      (await tx.$queryRawUnsafe<{ slot_label: string }[]>(`SELECT "slot_label" FROM public."DailyMealPlanSlot" WHERE "id"='slot_X'`))[0]);
    expect(row.slot_label).toBe('breakfast');
  });
  it('a foreign coach cannot DELETE another coach\'s slot (USING filters to 0; row survives)', async () => {
    expect(await execAs(coach('coachY'),
      `DELETE FROM public."DailyMealPlanSlot" WHERE "id"='slot_X'`)).toBe(0);
    expect(await countAs(SERVICE, 'DailyMealPlanSlot', 'slot_X')).toBe(1);
  });
  it('the client (non-coach) cannot read the plan composition', async () => {
    expect(await countAs(client('clientX'), 'DailyMealPlanSlot', 'slot_X')).toBe(0);
  });
  it('an unauthenticated caller is denied; service_role bypasses', async () => {
    expect(await countAs(ANON, 'DailyMealPlanSlot', 'slot_X')).toBe(0);
    expect(await countAs(SERVICE, 'DailyMealPlanSlot', 'slot_X')).toBe(1);
  });

  // PR-05 regression: prove BOTH parent paths independently and the mixed-parent
  // case where the slot's DailyMealPlan coach (X) and MealTemplate coach (Y) differ.
  // Seed: dmp_X is coachX's plan; mt_Y is coachY's template; slot_mixed joins them.
  async function seedMixedParentSlot(): Promise<void> {
    await prisma.$executeRawUnsafe(`SET ROLE service_role`);
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."MealTemplate"("id","coach_id","name") VALUES ('mt_Y','coachY','Template Y') ON CONFLICT ("id") DO NOTHING`);
      // slot whose plan-parent coach is X but template-parent coach is Y
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."DailyMealPlanSlot"("id","daily_meal_plan_id","meal_template_id","slot_label","order")
         VALUES ('slot_mixed','dmp_X','mt_Y','snack',9) ON CONFLICT ("id") DO NOTHING`);
    } finally {
      await prisma.$executeRawUnsafe(`RESET ROLE`);
    }
  }

  it('plan-parent path: the coach owning the parent DailyMealPlan can SELECT/UPDATE the slot', async () => {
    // slot_X: plan dmp_X (coachX) + template mt_X (coachX) → coachX matches via plan parent.
    expect(await countAs(coach('coachX'), 'DailyMealPlanSlot', 'slot_X')).toBe(1);
    expect(await execAs(coach('coachX'),
      `UPDATE public."DailyMealPlanSlot" SET "slot_label"='via_plan' WHERE "id"='slot_X'`)).toBe(1);
  });
  it('template-parent path: a coach owning ONLY the referenced MealTemplate can SELECT/UPDATE the slot', async () => {
    await seedMixedParentSlot();
    // slot_mixed: template mt_Y belongs to coachY → coachY matches via template parent only.
    expect(await countAs(coach('coachY'), 'DailyMealPlanSlot', 'slot_mixed')).toBe(1);
    expect(await execAs(coach('coachY'),
      `UPDATE public."DailyMealPlanSlot" SET "slot_label"='via_template' WHERE "id"='slot_mixed'`)).toBe(1);
  });
  it('mixed-parent: plan-coach X and template-coach Y can both access; unrelated coach Z cannot', async () => {
    await seedMixedParentSlot();
    await prisma.$executeRawUnsafe(`SET ROLE service_role`);
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."User"("id","coach_id","role") VALUES ('coachZ',NULL,'coach') ON CONFLICT ("id") DO NOTHING`);
    } finally {
      await prisma.$executeRawUnsafe(`RESET ROLE`);
    }
    // coachX matches via DailyMealPlan parent; coachY matches via MealTemplate parent.
    expect(await countAs(coach('coachX'), 'DailyMealPlanSlot', 'slot_mixed')).toBe(1);
    expect(await countAs(coach('coachY'), 'DailyMealPlanSlot', 'slot_mixed')).toBe(1);
    // coachZ owns neither parent → no access (read 0, write filtered to 0).
    expect(await countAs(coach('coachZ'), 'DailyMealPlanSlot', 'slot_mixed')).toBe(0);
    expect(await execAs(coach('coachZ'),
      `UPDATE public."DailyMealPlanSlot" SET "slot_label"='zzz' WHERE "id"='slot_mixed'`)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DailyMealPlanAssignment — client-self-or-assigned-coach
// ───────────────────────────────────────────────────────────────────────────
describe('PR-RLS-05: DailyMealPlanAssignment (client-self-or-assigned-coach)', () => {
  it('owner operator can read', async () => {
    expect(await countAs(OWNER, 'DailyMealPlanAssignment', 'asg_X')).toBe(1);
  });
  it('the assigned client can read (tenant access)', async () => {
    expect(await countAs(client('clientX'), 'DailyMealPlanAssignment', 'asg_X')).toBe(1);
  });
  it('the assigning coach can read (tenant access)', async () => {
    expect(await countAs(coach('coachX'), 'DailyMealPlanAssignment', 'asg_X')).toBe(1);
  });
  it('the assigning coach can insert an assignment for their client', async () => {
    const r = await tryExec(coach('coachX'),
      `INSERT INTO public."DailyMealPlanAssignment"("id","daily_meal_plan_id","client_id","assigned_by_coach_id","starts_on")
       VALUES ('asg_new','dmp_X','clientX','coachX',CURRENT_DATE)`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('the assigned client can update their assignment', async () => {
    const r = await tryExec(client('clientX'),
      `UPDATE public."DailyMealPlanAssignment" SET "starts_on"=CURRENT_DATE+1 WHERE "id"='asg_X'`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('a foreign coach is denied read', async () => {
    expect(await countAs(coach('coachY'), 'DailyMealPlanAssignment', 'asg_X')).toBe(0);
  });
  it('a foreign coach cannot insert a cross-tenant assignment (WITH CHECK → 42501)', async () => {
    await expectRlsDenied(execAs(coach('coachY'),
      `INSERT INTO public."DailyMealPlanAssignment"("id","daily_meal_plan_id","client_id","assigned_by_coach_id","starts_on")
       VALUES ('asg_evil','dmp_X','clientX','coachX',CURRENT_DATE)`));
  });
  it('a foreign coach cannot UPDATE another tenant\'s assignment (USING filters to 0; row unchanged)', async () => {
    expect(await execAs(coach('coachY'),
      `UPDATE public."DailyMealPlanAssignment" SET "starts_on"=CURRENT_DATE+10 WHERE "id"='asg_X'`)).toBe(0);
    expect(await countAs(SERVICE, 'DailyMealPlanAssignment', 'asg_X')).toBe(1);
  });
  it('a foreign coach cannot DELETE another tenant\'s assignment (USING filters to 0; row survives)', async () => {
    expect(await execAs(coach('coachY'),
      `DELETE FROM public."DailyMealPlanAssignment" WHERE "id"='asg_X'`)).toBe(0);
    expect(await countAs(SERVICE, 'DailyMealPlanAssignment', 'asg_X')).toBe(1);
  });
  // PR-05 regression: transitive current-coach access is intentionally EXCLUDED.
  // A coach who is the client's CURRENT coach but did NOT make the assignment
  // (assigned_by_coach_id != them) must NOT see or mutate it.
  it('client\'s current coach who did NOT assign cannot SELECT/UPDATE/DELETE the assignment', async () => {
    await prisma.$executeRawUnsafe(`SET ROLE service_role`);
    try {
      // Introduce coachW and make them clientX's current coach (overriding coach_id),
      // while assignment asg_X retains assigned_by_coach_id='coachX'.
      await prisma.$executeRawUnsafe(
        `INSERT INTO public."User"("id","coach_id","role") VALUES ('coachW',NULL,'coach') ON CONFLICT ("id") DO NOTHING`);
      await prisma.$executeRawUnsafe(
        `UPDATE public."User" SET "coach_id"='coachW' WHERE "id"='clientX'`);
    } finally {
      await prisma.$executeRawUnsafe(`RESET ROLE`);
    }
    // coachW is now clientX's current coach but is not the assigning coach → denied.
    expect(await countAs(coach('coachW'), 'DailyMealPlanAssignment', 'asg_X')).toBe(0);
    expect(await execAs(coach('coachW'),
      `UPDATE public."DailyMealPlanAssignment" SET "starts_on"=CURRENT_DATE+5 WHERE "id"='asg_X'`)).toBe(0);
    expect(await execAs(coach('coachW'),
      `DELETE FROM public."DailyMealPlanAssignment" WHERE "id"='asg_X'`)).toBe(0);
    expect(await countAs(SERVICE, 'DailyMealPlanAssignment', 'asg_X')).toBe(1);
  });
  it('an unauthenticated caller is denied; service_role bypasses', async () => {
    expect(await countAs(ANON, 'DailyMealPlanAssignment', 'asg_X')).toBe(0);
    expect(await countAs(SERVICE, 'DailyMealPlanAssignment', 'asg_X')).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FoodItem — public-catalog-read, owner-write (Primitive F)
// ───────────────────────────────────────────────────────────────────────────
describe('PR-RLS-05: FoodItem (public-catalog-read, owner-write)', () => {
  it('owner operator can read', async () => {
    expect(await countAs(OWNER, 'FoodItem', 'food_1')).toBe(1);
  });
  it('any authenticated user can read the catalog (public read)', async () => {
    expect(await countAs(client('clientX'), 'FoodItem', 'food_1')).toBe(1);
    expect(await countAs(coach('coachY'), 'FoodItem', 'food_1')).toBe(1);
  });
  it('an unauthenticated caller can also read the public catalog', async () => {
    expect(await countAs(ANON, 'FoodItem', 'food_1')).toBe(1);
  });
  it('the owner operator can insert a catalog entry', async () => {
    const r = await tryExec(OWNER,
      `INSERT INTO public."FoodItem"("id","name") VALUES ('food_owner','Rice')`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('the owner operator can update a catalog entry', async () => {
    const r = await tryExec(OWNER,
      `UPDATE public."FoodItem" SET "name"='Chicken Thigh' WHERE "id"='food_1'`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('a non-owner authenticated user cannot INSERT into the catalog (WITH CHECK → 42501)', async () => {
    await expectRlsDenied(execAs(coach('coachX'),
      `INSERT INTO public."FoodItem"("id","name") VALUES ('food_evil','Sneaky')`));
  });
  it('a non-owner authenticated user cannot UPDATE a catalog entry (USING filters to 0; row unchanged)', async () => {
    // FoodItem is a global catalog (USDA FDC + OpenFoodFacts upstream): no per-row
    // owner column. SELECT is public, so the row is visible, but the UPDATE USING
    // predicate is app.is_owner() only → a non-owner's UPDATE matches 0 rows.
    expect(await execAs(coach('coachX'),
      `UPDATE public."FoodItem" SET "name"='Hijacked' WHERE "id"='food_1'`)).toBe(0);
    const row = await asCtx(SERVICE, async (tx) =>
      (await tx.$queryRawUnsafe<{ name: string }[]>(`SELECT "name" FROM public."FoodItem" WHERE "id"='food_1'`))[0]);
    expect(row.name).toBe('Chicken Breast');
  });
  it('a non-owner authenticated user cannot DELETE a catalog entry (USING filters to 0; row survives)', async () => {
    expect(await execAs(coach('coachX'),
      `DELETE FROM public."FoodItem" WHERE "id"='food_1'`)).toBe(0);
    expect(await countAs(SERVICE, 'FoodItem', 'food_1')).toBe(1);
  });
  it('service_role bypasses for full read/write', async () => {
    expect(await countAs(SERVICE, 'FoodItem', 'food_1')).toBe(1);
    const r = await tryExec(SERVICE,
      `INSERT INTO public."FoodItem"("id","name") VALUES ('food_svc','Oats')`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// water_logs — user-self + current-coach read
// ───────────────────────────────────────────────────────────────────────────
describe('PR-RLS-05: water_logs (user-self-current-coach-read)', () => {
  it('owner operator can read', async () => {
    expect(await countAs(OWNER, 'water_logs', 'wl_X')).toBe(1);
  });
  it('the logging user can read their own log (tenant access)', async () => {
    expect(await countAs(client('clientX'), 'water_logs', 'wl_X')).toBe(1);
  });
  it("the user's current coach can read (tenant access)", async () => {
    expect(await countAs(coach('coachX'), 'water_logs', 'wl_X')).toBe(1);
  });
  it('the logging user can insert their own log', async () => {
    const r = await tryExec(client('clientX'),
      `INSERT INTO public."water_logs"("id","user_id","amount_ml") VALUES ('wl_new','clientX',250)`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('the logging user can update their own log', async () => {
    const r = await tryExec(client('clientX'),
      `UPDATE public."water_logs" SET "amount_ml"=750 WHERE "id"='wl_X'`, []);
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(1);
  });
  it('a foreign user is denied read', async () => {
    expect(await countAs(client('clientY'), 'water_logs', 'wl_X')).toBe(0);
  });
  it('a foreign user cannot INSERT a log for another user (WITH CHECK → 42501)', async () => {
    await expectRlsDenied(execAs(client('clientY'),
      `INSERT INTO public."water_logs"("id","user_id","amount_ml") VALUES ('wl_evil','clientX',999)`));
  });
  it('a foreign user cannot UPDATE another user\'s log (USING filters to 0; row unchanged)', async () => {
    expect(await execAs(client('clientY'),
      `UPDATE public."water_logs" SET "amount_ml"=1 WHERE "id"='wl_X'`)).toBe(0);
    const row = await asCtx(SERVICE, async (tx) =>
      (await tx.$queryRawUnsafe<{ amount_ml: number }[]>(`SELECT "amount_ml" FROM public."water_logs" WHERE "id"='wl_X'`))[0]);
    expect(Number(row.amount_ml)).toBe(500);
  });
  it('a foreign user cannot DELETE another user\'s log (USING filters to 0; row survives)', async () => {
    expect(await execAs(client('clientY'),
      `DELETE FROM public."water_logs" WHERE "id"='wl_X'`)).toBe(0);
    expect(await countAs(SERVICE, 'water_logs', 'wl_X')).toBe(1);
  });
  // PR-05 fix: coaches are SELECT-ONLY on client hydration logs. They may read
  // (proven above) but must NOT insert, update, or delete a client's water_logs.
  it('the client\'s current coach cannot INSERT a log for the client (owner-only → 42501)', async () => {
    await expectRlsDenied(execAs(coach('coachX'),
      `INSERT INTO public."water_logs"("id","user_id","amount_ml") VALUES ('wl_coach','clientX',123)`));
  });
  it('the client\'s current coach cannot UPDATE the client\'s log (USING filters to 0; row unchanged)', async () => {
    expect(await execAs(coach('coachX'),
      `UPDATE public."water_logs" SET "amount_ml"=42 WHERE "id"='wl_X'`)).toBe(0);
    const row = await asCtx(SERVICE, async (tx) =>
      (await tx.$queryRawUnsafe<{ amount_ml: number }[]>(`SELECT "amount_ml" FROM public."water_logs" WHERE "id"='wl_X'`))[0]);
    expect(Number(row.amount_ml)).toBe(500);
  });
  it('the client\'s current coach cannot DELETE the client\'s log (USING filters to 0; row survives)', async () => {
    expect(await execAs(coach('coachX'),
      `DELETE FROM public."water_logs" WHERE "id"='wl_X'`)).toBe(0);
    expect(await countAs(SERVICE, 'water_logs', 'wl_X')).toBe(1);
    // Coach SELECT still works after the failed writes.
    expect(await countAs(coach('coachX'), 'water_logs', 'wl_X')).toBe(1);
  });
  it('an unauthenticated caller is denied; service_role bypasses', async () => {
    expect(await countAs(ANON, 'water_logs', 'wl_X')).toBe(0);
    expect(await countAs(SERVICE, 'water_logs', 'wl_X')).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// service_role policies — catalog shape (structural pg_policy verification)
// ───────────────────────────────────────────────────────────────────────────
describe('PR-RLS-05: service_role policies — catalog shape', () => {
  it('every target table has exactly one service_role ALL policy with qual=true / withcheck=true', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{
      table_name: string;
      polname: string;
      cmd: string;
      rolname: string;
      qual: string | null;
      withcheck: string | null;
    }>>(`
      SELECT
        c.relname AS table_name,
        p.polname,
        p.polcmd::text AS cmd,
        r.rolname,
        pg_get_expr(p.polqual, p.polrelid) AS qual,
        pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = ANY(p.polroles)
      WHERE n.nspname = 'public'
        AND c.relname IN (
          'MealPlan','MealTemplate','DailyMealPlan','DailyMealPlanSlot',
          'DailyMealPlanAssignment','FoodItem','water_logs'
        )
        AND r.rolname = 'service_role'
      ORDER BY c.relname, p.polname
    `);
    expect(rows).toHaveLength(7); // exactly one service_role policy per target table
    const tables = rows.map((row) => row.table_name).sort();
    expect(tables).toEqual([
      'DailyMealPlan', 'DailyMealPlanAssignment', 'DailyMealPlanSlot',
      'FoodItem', 'MealPlan', 'MealTemplate', 'water_logs',
    ]);
    for (const row of rows) {
      expect(row.cmd).toBe('*');             // FOR ALL
      expect(row.rolname).toBe('service_role');
      expect(row.qual).toBe('true');         // USING (true)
      expect(row.withcheck).toBe('true');    // WITH CHECK (true)
    }
  });
});
