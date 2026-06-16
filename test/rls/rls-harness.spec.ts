/**
 * W1.5-A4 — self-test for the reusable RLS live-DB harness (test/rls/support).
 *
 * Proves the harness genuinely catches a broken/missing policy. This is the
 * FAILABILITY proof the brief demands: it is not enough that the assertions pass
 * with RLS on — the same assertion MUST flip red if RLS were disabled. We prove
 * that directly: with the tenant SELECT policy in force the cross-tenant row is
 * hidden (expectCannotSeeOtherTenant passes); after DROP POLICY + DISABLE FORCE
 * the cross-tenant row becomes visible to the same acting context and
 * expectCannotSeeOtherTenant throws. A harness whose negative assertion could
 * never fail would be a silent false-green (R65 / Failure #36).
 *
 * Hits a REAL Postgres via the A1 withRlsContext transaction path (GUCs stamped
 * on the tx handle, then SET LOCAL ROLE app_user), so it exercises the exact
 * pgbouncer-safe shape production code uses. Skip modes match the repo convention
 * (R69-exempt env gate): no DB URL -> describe.skip (clean skip); URL configured
 * but unreachable -> beforeAll throws (HARD FAIL, never a false-green).
 */
import { PrismaClient } from '@prisma/client';
import {
  AsUser,
  HARNESS_TABLE,
  HarnessTenant,
  IsolationAssertions,
  liveDbUrl,
  makeAsUser,
  makeIsolationAssertions,
  provisionTenants,
  teardownTenants,
} from './support/rls-harness';

const DB_URL = liveDbUrl();
const dbAvailable = Boolean(DB_URL);

(dbAvailable ? describe : describe.skip)(
  'W1.5-A4 RLS live-DB harness self-test',
  () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: DB_URL } },
    });
    let asUser: AsUser;
    let iso: IsolationAssertions;
    let tenants: HarnessTenant[];

    beforeAll(async () => {
      // Hard-fail (not skip) when a URL is configured but unreachable — a bad URL
      // must never read as a green "passed" without running any SQL.
      await prisma.$connect();
      tenants = await provisionTenants(prisma, 2);
      asUser = makeAsUser(prisma);
      iso = makeIsolationAssertions(asUser);
    }, 60_000);

    afterAll(async () => {
      try {
        await teardownTenants(prisma);
      } finally {
        await prisma.$disconnect();
      }
    });

    it('provisions the configured number of isolated tenants', () => {
      expect(tenants).toHaveLength(2);
      expect(tenants[0].gymId).not.toBe(tenants[1].gymId);
      expect(tenants[0].rowId).not.toBe(tenants[1].rowId);
    });

    it('asUser stamps the new gym namespace on the tx handle (pgbouncer-safe)', async () => {
      // Reading the GUC back on the SAME tx handle is the only faithful proof:
      // under transaction-pool mode a read on the base client would land on a
      // different backend with no GUC set. We confirm app.current_gym_ids()
      // resolves to exactly the authorized gym inside the tx.
      const gyms = await asUser(tenants[0].coachId, [tenants[0].gymId], async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ gyms: string[] | null }[]>(
          `SELECT app.current_gym_ids() AS gyms`,
        );
        return rows[0].gyms;
      });
      expect(gyms).toEqual([tenants[0].gymId]);
    });

    it('runs queries as the NOBYPASSRLS app_user role (RLS is genuinely enforced)', async () => {
      // current_user is the dropped role, not the BYPASSRLS superuser. If this
      // were still the superuser, every isolation assertion below would be vacuous.
      const role = await asUser(tenants[0].coachId, [tenants[0].gymId], async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ who: string }[]>(
          `SELECT current_user AS who`,
        );
        return rows[0].who;
      });
      expect(role).toBe('app_user');
    });

    it('expectCanSeeOwnTenant: the acting tenant reads its own gym-scoped row', async () => {
      await expect(iso.expectCanSeeOwnTenant(tenants[0])).resolves.toBeUndefined();
    });

    it('expectCannotSeeOtherTenant: the acting tenant cannot read another tenant row', async () => {
      await expect(
        iso.expectCannotSeeOtherTenant(tenants[0], tenants[1]),
      ).resolves.toBeUndefined();
    });

    it('empty authorization (no gyms) denies all rows — empty-gyms DENY contract', async () => {
      const n = await asUser(tenants[0].coachId, [], async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::bigint AS n FROM public."${HARNESS_TABLE}"`,
        );
        return Number(rows[0].n);
      });
      expect(n).toBe(0);
    });

    // ──────────────────────────────────────────────────────────────────────
    // FAILABILITY PROOF. The harness is only trustworthy if its negative
    // assertion can actually fail. We disable RLS on the table (DROP POLICY +
    // NO FORCE + DISABLE), re-run the SAME expectCannotSeeOtherTenant, and prove
    // it now THROWS because the cross-tenant row became visible. Then we restore
    // RLS and prove the assertion passes again. If expectCannotSeeOtherTenant
    // could not be made to throw here, it would be a tautology — a false-green.
    // ──────────────────────────────────────────────────────────────────────
    describe('failability: the same negative assertion flips red when RLS is off', () => {
      afterAll(async () => {
        // Always restore RLS so suite ordering cannot leave the table open, even
        // if a test above failed before its own restore ran. Idempotent: drop the
        // policy first so the CREATE never collides with an existing one.
        await prisma.$executeRawUnsafe(
          `ALTER TABLE public."${HARNESS_TABLE}" ENABLE ROW LEVEL SECURITY`,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE public."${HARNESS_TABLE}" FORCE ROW LEVEL SECURITY`,
        );
        await prisma.$executeRawUnsafe(
          `DROP POLICY IF EXISTS p_${HARNESS_TABLE.toLowerCase()}_select ON public."${HARNESS_TABLE}"`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE POLICY p_${HARNESS_TABLE.toLowerCase()}_select ON public."${HARNESS_TABLE}"
             FOR SELECT USING ("gym_id" = ANY(app.current_gym_ids()))`,
        );
      });

      it('with RLS disabled, expectCannotSeeOtherTenant THROWS (cross-tenant row leaks)', async () => {
        // Tear the policy down: this is exactly the "missing/broken policy" a
        // downstream RLS PR must be caught committing.
        await prisma.$executeRawUnsafe(
          `DROP POLICY IF EXISTS p_${HARNESS_TABLE.toLowerCase()}_select ON public."${HARNESS_TABLE}"`,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE public."${HARNESS_TABLE}" NO FORCE ROW LEVEL SECURITY`,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE public."${HARNESS_TABLE}" DISABLE ROW LEVEL SECURITY`,
        );

        // The negative assertion must now FAIL: without the policy, the acting
        // tenant sees the other tenant's row, so expectCannotSeeOtherTenant
        // rejects. This is the proof the harness is failable, not a tautology.
        await expect(
          iso.expectCannotSeeOtherTenant(tenants[0], tenants[1]),
        ).rejects.toThrow(/RLS is not isolating tenants/);
      });

      it('after restoring RLS, the negative assertion passes again', async () => {
        // The afterAll restores RLS; assert the round-trip is clean so a later
        // suite (or a re-run) starts from an isolating table.
        await prisma.$executeRawUnsafe(
          `ALTER TABLE public."${HARNESS_TABLE}" ENABLE ROW LEVEL SECURITY`,
        );
        await prisma.$executeRawUnsafe(
          `ALTER TABLE public."${HARNESS_TABLE}" FORCE ROW LEVEL SECURITY`,
        );
        await prisma.$executeRawUnsafe(
          `DROP POLICY IF EXISTS p_${HARNESS_TABLE.toLowerCase()}_select ON public."${HARNESS_TABLE}"`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE POLICY p_${HARNESS_TABLE.toLowerCase()}_select ON public."${HARNESS_TABLE}"
             FOR SELECT USING ("gym_id" = ANY(app.current_gym_ids()))`,
        );
        await expect(
          iso.expectCannotSeeOtherTenant(tenants[0], tenants[1]),
        ).resolves.toBeUndefined();
      });
    });
  },
);
