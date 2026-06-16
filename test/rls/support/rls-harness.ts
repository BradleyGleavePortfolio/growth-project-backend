/**
 * W1.5-A4 — reusable RLS live-DB test harness.
 *
 * Every downstream RLS PR (A5 Redis, A6 FeatureFlags, A7 gym_owner role, A8
 * termination cascade, all of Chain B's schema PRs) must prove tenant isolation
 * against a REAL Postgres — never a mock. Before A4 each RLS suite re-implemented
 * role/tenant setup by hand. This module is the shared primitive: a downstream
 * suite provisions tenants in two lines and proves cross-tenant denial + own-tenant
 * access in one helper call each.
 *
 * What it gives you:
 *   - {@link provisionTenants}: idempotent tenant/role fixture factory — creates an
 *     `app_user` NOBYPASSRLS login role (so RLS is genuinely enforced, not bypassed
 *     by a superuser/BYPASSRLS connection), N gyms each with a coach + student, and
 *     seeds one gym-scoped row per tenant. Tears down cleanly so suites never
 *     pollute each other.
 *   - {@link makeAsUser}: builds an `asUser(userId, gymIds, fn)` helper bound to a
 *     PrismaClient. It runs `fn` inside the A1 {@link withRlsContext} transaction —
 *     GUCs are stamped on the SAME tx handle via `set_config(..., true)`, then the
 *     session drops to `app_user` via `SET LOCAL ROLE` for the duration of the tx.
 *     This is the ONLY pgbouncer-safe shape (handoff §13.3/§13.4): under Supabase
 *     transaction-pool mode a GUC set on the base client would be routed to a
 *     different backend than the reading query and vanish. `withRlsContext` opens
 *     the `$transaction` and stamps on `tx`, so production-shaped code behaves
 *     identically here.
 *   - {@link makeIsolationAssertions}: `expectCanSeeOwnTenant` /
 *     `expectCannotSeeOtherTenant` — the two-line proof a downstream suite writes.
 *
 * Connection: the live lane connects as `postgres` (superuser, which is BYPASSRLS).
 * BYPASSRLS would make every isolation assertion pass vacuously, so the harness
 * NEVER asserts on the base connection — it `SET LOCAL ROLE app_user` inside each
 * `withRlsContext` transaction so the policies actually gate the query. The role
 * reset is transaction-local, so it cannot leak across pooled connections.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { withRlsContext } from '../../../src/database/rls-context';
import { RlsContext } from '../../../src/database/prisma.context';

/** Resolve the live-DB URL using the repo's established precedence/skip gate. */
export function liveDbUrl(): string {
  const url =
    process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.startsWith('postgresql://test:test@')
      ? process.env.DATABASE_URL
      : '');
  if (!url) return '';
  return url.includes('connection_limit=')
    ? url
    : url + (url.includes('?') ? '&' : '?') + 'connection_limit=1';
}

/** The non-bypass login role the harness drops to so RLS is genuinely enforced. */
export const HARNESS_ROLE = 'app_user';

/** Gym-scoped table the harness owns end-to-end (no collision with other suites). */
export const HARNESS_TABLE = 'HarnessGymScoped';

/** One provisioned tenant: its gym plus the coach + student that belong to it. */
export interface HarnessTenant {
  readonly gymId: string;
  readonly coachId: string;
  readonly studentId: string;
  /** Primary key of the single gym-scoped row seeded for this tenant. */
  readonly rowId: string;
}

/**
 * Bootstrap the schema the harness needs, idempotently. Creates the `app` helper
 * (`app.current_gym_ids()` — the A3 new-namespace gym reader), the `app_user`
 * NOBYPASSRLS login role, and the gym-scoped table with ENABLE + FORCE RLS and a
 * tenant SELECT policy. Safe to run on every `beforeAll` (drops + recreates the
 * table so a second run starts clean).
 */
async function bootstrapSchema(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS app`);
  // The A3 new-namespace gym reader. Created here so the harness is self-
  // sufficient against a bare throwaway Postgres; CREATE OR REPLACE is a no-op
  // when the real migration already defined it. search_path = '' matches the
  // hardened-helper convention (every reference fully schema-qualified).
  await prisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION app.current_gym_ids()
       RETURNS text[] LANGUAGE sql STABLE SET search_path = '' AS $fn$
       SELECT CASE
         WHEN NULLIF(pg_catalog.current_setting('app.gym_ids', true), '') IS NULL
           THEN NULL
         ELSE pg_catalog.string_to_array(
                pg_catalog.current_setting('app.gym_ids', true), ',')
       END
     $fn$`,
  );
  // NOBYPASSRLS is the whole point: a BYPASSRLS role would see every tenant's
  // rows and make isolation assertions pass vacuously. NOLOGIN is fine — the
  // harness reaches the role via SET LOCAL ROLE, never a direct login.
  await prisma.$executeRawUnsafe(
    `DO $boot$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${HARNESS_ROLE}') THEN
         CREATE ROLE ${HARNESS_ROLE} NOLOGIN NOINHERIT NOBYPASSRLS;
       END IF;
     END $boot$`,
  );
  // Recreate the table fresh so the suite is idempotent across consecutive runs.
  await prisma.$executeRawUnsafe(
    `DROP TABLE IF EXISTS public."${HARNESS_TABLE}" CASCADE`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE public."${HARNESS_TABLE}" (
       "id" text PRIMARY KEY,
       "gym_id" text NOT NULL,
       "label" text NOT NULL DEFAULT 'row'
     )`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE public."${HARNESS_TABLE}" ENABLE ROW LEVEL SECURITY`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE public."${HARNESS_TABLE}" FORCE ROW LEVEL SECURITY`,
  );
  // Tenant-scoped SELECT policy on the A3 new namespace. Empty-gyms DENY is
  // handled by app.current_gym_ids() returning NULL (gym_id = ANY(NULL) is
  // never true), so an empty authorization sees nothing.
  await prisma.$executeRawUnsafe(
    `CREATE POLICY p_${HARNESS_TABLE.toLowerCase()}_select ON public."${HARNESS_TABLE}"
       FOR SELECT USING ("gym_id" = ANY(app.current_gym_ids()))`,
  );
  // app_user is non-owner, so FORCE RLS + this GRANT are what let it read at all;
  // the policy then gates which rows. Owner (postgres) seeds rows below.
  await prisma.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."${HARNESS_TABLE}" TO ${HARNESS_ROLE}`,
  );
}

/**
 * Provision `count` isolated tenants (gyms), each with a coach, a student, and one
 * gym-scoped row, after bootstrapping the harness schema. Seeds as the table owner
 * (RLS does not gate the owner's INSERT here because the policy is SELECT-only and
 * the seed runs before any role drop). Returns the tenants in order so a caller can
 * pick `tenants[0]` as "own" and `tenants[1]` as "other".
 *
 * @param prisma - a connected PrismaClient (single-connection live URL).
 * @param count - number of tenants to create (default 2 — enough for cross-tenant).
 */
export async function provisionTenants(
  prisma: PrismaClient,
  count = 2,
): Promise<HarnessTenant[]> {
  await bootstrapSchema(prisma);
  const tenants: HarnessTenant[] = [];
  for (let i = 0; i < count; i += 1) {
    const gymId = `harness-gym-${i}-${randomSuffix()}`;
    tenants.push({
      gymId,
      coachId: `harness-coach-${i}-${randomSuffix()}`,
      studentId: `harness-student-${i}-${randomSuffix()}`,
      rowId: `harness-row-${i}-${randomSuffix()}`,
    });
  }
  // Seed one gym-scoped row per tenant on the owner connection (no role drop).
  for (const t of tenants) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO public."${HARNESS_TABLE}"("id","gym_id") VALUES ($1,$2)`,
      t.rowId,
      t.gymId,
    );
  }
  return tenants;
}

/** Tear down the harness table so no fixture state survives the suite. */
export async function teardownTenants(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DROP TABLE IF EXISTS public."${HARNESS_TABLE}" CASCADE`,
  );
}

/** The signature of the `asUser` helper {@link makeAsUser} returns. */
export type AsUser = <T>(
  userId: string,
  gymIds: readonly string[],
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts?: { role?: string },
) => Promise<T>;

/**
 * Build an `asUser(userId, gymIds, fn)` helper bound to `prisma`.
 *
 * It runs `fn` inside {@link withRlsContext} — the A1 primitive that opens a
 * `$transaction`, stamps BOTH GUC namespaces (legacy `app.current_user_id` /
 * `app.current_user_role` AND new `app.user_id` / `app.gym_ids`) on the tx handle
 * via `set_config(..., true)`, and hands `fn` the tx handle. Before `fn` runs we
 * `SET LOCAL ROLE app_user`, so every query in `fn` executes as the NOBYPASSRLS
 * role and the policies actually gate it. The role reset and the GUCs are all
 * transaction-local, so concurrent `asUser` calls cannot pollute each other.
 *
 * Caller contract (inherited from {@link withRlsContext}): `fn` MUST use the
 * supplied `tx` handle for every query. A query against the outer `prisma` client
 * runs on a different connection with no GUCs and no role drop — bypassing tenant
 * isolation entirely.
 */
export function makeAsUser(prisma: PrismaClient): AsUser {
  return function asUser<T>(
    userId: string,
    gymIds: readonly string[],
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { role?: string },
  ): Promise<T> {
    const ctx: RlsContext = { userId, gymIds, role: opts?.role ?? 'student' };
    return withRlsContext(prisma, ctx, async (tx) => {
      // Drop to the NOBYPASSRLS role for the rest of this transaction. SET LOCAL
      // is transaction-scoped (reset on commit/rollback) like the GUCs above, so
      // it is pgbouncer-safe and cannot leak to the next pooled borrower.
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${HARNESS_ROLE}`);
      return fn(tx);
    });
  };
}

/** Count rows of {@link HARNESS_TABLE} visible to the current tx by primary key. */
async function visibleRowCount(
  tx: Prisma.TransactionClient,
  rowId: string,
): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM public."${HARNESS_TABLE}" WHERE "id" = $1`,
    rowId,
  );
  return Number(rows[0].n);
}

/** The isolation assertion pair {@link makeIsolationAssertions} returns. */
export interface IsolationAssertions {
  /** Assert the acting user CAN see their own tenant's row (RLS allows). */
  expectCanSeeOwnTenant(own: HarnessTenant): Promise<void>;
  /** Assert the acting user CANNOT see another tenant's row (RLS denies). */
  expectCannotSeeOtherTenant(
    own: HarnessTenant,
    other: HarnessTenant,
  ): Promise<void>;
}

/**
 * Build the isolation assertion helpers bound to an `asUser`. A downstream RLS PR
 * proves both halves of tenant isolation in two lines:
 *
 *   await iso.expectCanSeeOwnTenant(tenants[0]);
 *   await iso.expectCannotSeeOtherTenant(tenants[0], tenants[1]);
 *
 * The acting identity is `own`'s coach scoped to ONLY `own.gymId`, so the
 * cross-tenant check is a true negative: the row exists (proven by the own-tenant
 * positive) and is hidden solely by the policy, not by being absent.
 */
export function makeIsolationAssertions(asUser: AsUser): IsolationAssertions {
  return {
    async expectCanSeeOwnTenant(own: HarnessTenant): Promise<void> {
      const n = await asUser(own.coachId, [own.gymId], (tx) =>
        visibleRowCount(tx, own.rowId),
      );
      if (n !== 1) {
        throw new Error(
          `expectCanSeeOwnTenant: acting user ${own.coachId} scoped to gym ` +
            `${own.gymId} should see own row ${own.rowId} (expected 1, got ${n})`,
        );
      }
    },
    async expectCannotSeeOtherTenant(
      own: HarnessTenant,
      other: HarnessTenant,
    ): Promise<void> {
      const n = await asUser(own.coachId, [own.gymId], (tx) =>
        visibleRowCount(tx, other.rowId),
      );
      if (n !== 0) {
        throw new Error(
          `expectCannotSeeOtherTenant: acting user ${own.coachId} scoped to gym ` +
            `${own.gymId} must NOT see other tenant row ${other.rowId} ` +
            `(gym ${other.gymId}) — expected 0, got ${n}. RLS is not isolating tenants.`,
        );
      }
    },
  };
}

/** Short collision-resistant suffix for fixture ids (avoids crypto import churn). */
function randomSuffix(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}
