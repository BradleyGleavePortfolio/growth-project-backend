/**
 * UX-FOOD-PRIV-124 — live RLS proof for 20270403000000_private_custom_foods.
 *
 * Runs against a REAL PostgreSQL (no mocks). Builds a minimal "FoodItem" with
 * its production RLS statements copied verbatim from
 * prisma/migrations/20261213000000_rls_tier3_nutrition/migration.sql (catalog
 * SELECT USING (true), owner-only writes, service_role bypass, FORCE), plus the
 * Supabase default API-role table grants, then applies this PR's migration.sql
 * verbatim. Principals are API shaped: `SET LOCAL ROLE authenticated|anon|
 * service_role` with the app.current_user_id / app.current_user_role GUCs.
 *
 * Proves: a custom food is readable only by its creator (and the owner role or
 * service_role); another client, a caller with no user GUC (PostgREST) and
 * anon read the shared catalog only and get no error; writes stay owner-only.
 *
 * CI: the rls-live-tests job runs this file after the Supabase shim and the
 * RLS-01 helper migration; the prerequisites below only fill in what is
 * missing, so the file also runs on an empty throwaway DB.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const MIGRATIONS = path.join(__dirname, '..', '..', 'prisma', 'migrations');
const PRIV_DIR = path.join(MIGRATIONS, '20270403000000_private_custom_foods');
const TIER3_SQL = path.join(MIGRATIONS, '20261213000000_rls_tier3_nutrition', 'migration.sql');

const RAW_URL = liveTestDatabaseUrl();
if (!RAW_URL && process.env.CI === 'true') {
  throw new Error('[UX-FOOD-PRIV-124] food-item-custom-privacy-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}
const URL_WITH_LIMIT = !RAW_URL
  ? ''
  : RAW_URL.includes('connection_limit=')
    ? RAW_URL
    : RAW_URL + (RAW_URL.includes('?') ? '&' : '?') + 'connection_limit=1';

/** Prerequisites, one statement each; only what an empty DB is missing. */
const PREREQ: string[] = [
  `DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
END $do$`,
  `CREATE SCHEMA IF NOT EXISTS app`,
  `DO $do$ BEGIN
  IF to_regprocedure('app.current_user_id()') IS NULL THEN
    EXECUTE $f$CREATE FUNCTION app.current_user_id() RETURNS text LANGUAGE sql STABLE AS 'SELECT NULLIF(current_setting(''app.current_user_id'', true), '''')'$f$;
  END IF;
  IF to_regprocedure('app.current_user_role()') IS NULL THEN
    EXECUTE $f$CREATE FUNCTION app.current_user_role() RETURNS text LANGUAGE sql STABLE AS 'SELECT NULLIF(current_setting(''app.current_user_role'', true), '''')'$f$;
  END IF;
  IF to_regprocedure('app.is_owner()') IS NULL THEN
    EXECUTE $f$CREATE FUNCTION app.is_owner() RETURNS boolean LANGUAGE sql STABLE AS 'SELECT app.current_user_id() IS NOT NULL AND app.current_user_role() = ''owner'''$f$;
  END IF;
END $do$`,
  `GRANT USAGE ON SCHEMA app TO anon, authenticated, service_role`,
  `GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role`,
  `CREATE TABLE IF NOT EXISTS public."User" ("id" text PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS public."FoodItem" ("id" text PRIMARY KEY, "name" text NOT NULL)`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON public."FoodItem" TO anon, authenticated, service_role`,
];

/** Statements of a migration file: `--` lines dropped, one statement per `;` line end. */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/;$/, ''))
    .filter(Boolean);
}

const describeLive = RAW_URL ? describe : describe.skip;

describeLive('20270403000000_private_custom_foods — live RLS (UX-FOOD-PRIV-124)', () => {
  let prisma: PrismaClient;

  type Who = { role: 'authenticated' | 'anon' | 'service_role'; userId?: string; userRole?: string };

  async function visibleIds(who: Who): Promise<string[]> {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${who.role}`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who.userId ?? '');
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, who.userRole ?? '');
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM public."FoodItem" ORDER BY "id"`);
      return rows.map((r) => r.id);
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: URL_WITH_LIMIT } } });
    for (const s of PREREQ) await prisma.$executeRawUnsafe(s);
    // Production FoodItem RLS (tier 3) verbatim, then reverse any earlier run, then this PR's migration.
    const tier3 = statements(fs.readFileSync(TIER3_SQL, 'utf8')).filter((s) => s.includes('"FoodItem"'));
    expect(tier3.some((s) => s.includes('"p_fooditem_select"') && s.includes('USING (true)'))).toBe(true);
    for (const s of tier3) await prisma.$executeRawUnsafe(s);
    for (const s of statements(fs.readFileSync(path.join(PRIV_DIR, 'down.sql'), 'utf8'))) await prisma.$executeRawUnsafe(s);
    for (const s of statements(fs.readFileSync(path.join(PRIV_DIR, 'migration.sql'), 'utf8'))) await prisma.$executeRawUnsafe(s);

    await prisma.$executeRawUnsafe(`DELETE FROM public."FoodItem" WHERE "id" IN ('priv-catalog','priv-mine-a')`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."User"("id") VALUES ('priv-a'),('priv-b'),('priv-owner') ON CONFLICT ("id") DO NOTHING`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."FoodItem"("id","name","created_by_user_id") VALUES ('priv-catalog','Lasagne',NULL),('priv-mine-a','Grandma Rosa''s lasagne','priv-a')`,
    );
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.$executeRawUnsafe(`DELETE FROM public."FoodItem" WHERE "id" IN ('priv-catalog','priv-mine-a')`);
    await prisma.$disconnect();
  });

  const mine = (ids: string[]) => ids.filter((id) => id.startsWith('priv-'));

  it('the creator reads their custom food and the catalog', async () => {
    expect(mine(await visibleIds({ role: 'authenticated', userId: 'priv-a', userRole: 'student' }))).toEqual([
      'priv-catalog',
      'priv-mine-a',
    ]);
  });

  it('another client reads the catalog only', async () => {
    expect(mine(await visibleIds({ role: 'authenticated', userId: 'priv-b', userRole: 'student' }))).toEqual([
      'priv-catalog',
    ]);
  });

  it('an API caller with no user context, and anon, read the catalog only without an error', async () => {
    expect(mine(await visibleIds({ role: 'authenticated' }))).toEqual(['priv-catalog']);
    expect(mine(await visibleIds({ role: 'anon' }))).toEqual(['priv-catalog']);
  });

  it('the owner role and service_role still read everything', async () => {
    const all = ['priv-catalog', 'priv-mine-a'];
    expect(mine(await visibleIds({ role: 'authenticated', userId: 'priv-owner', userRole: 'owner' }))).toEqual(all);
    expect(mine(await visibleIds({ role: 'service_role' }))).toEqual(all);
  });

  it('writes stay owner-only: the creator cannot insert a food through the API role', async () => {
    await expect(
      prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', 'priv-a', true)`);
        await tx.$executeRawUnsafe(
          `INSERT INTO public."FoodItem"("id","name","created_by_user_id") VALUES ('priv-forged','Forged','priv-a')`,
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });
});
