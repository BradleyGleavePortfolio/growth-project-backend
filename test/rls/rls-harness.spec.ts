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
  disableHarnessRls,
  enableHarnessRls,
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

    it('isolation assertions accept an acting-identity selector (student / role)', async () => {
      // A7's role-scoped RLS reuses the same assertion pair by selecting which
      // provisioned identity acts and under which role GUC. The harness's gym
      // policy is identity-agnostic, so acting as the student under a gym_owner
      // role GUC must isolate exactly as the default coach/student path does.
      const acting = { as: 'student', role: 'gym_owner' } as const;
      await expect(
        iso.expectCanSeeOwnTenant(tenants[0], acting),
      ).resolves.toBeUndefined();
      await expect(
        iso.expectCannotSeeOtherTenant(tenants[0], tenants[1], acting),
      ).resolves.toBeUndefined();
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
        // if a test above failed before its own restore ran. enableHarnessRls is
        // the harness's own definition of "RLS on" (and is idempotent), so this
        // restore can never drift from the SQL the harness actually owns.
        await enableHarnessRls(prisma);
      });

      it('expectCanSeeOwnTenant THROWS when the acting tenant cannot see its own row', async () => {
        // Symmetric to the negative proof below: prove the POSITIVE assertion is
        // not a tautology either. We act scoped to tenants[0].gymId but ask the
        // assertion to find tenants[1]'s row (own gym authorization, other tenant's
        // rowId) — with RLS on, that row is hidden, so expectCanSeeOwnTenant must
        // reject with its "should see own row" message rather than silently pass.
        const ownGymOtherRow: HarnessTenant = {
          ...tenants[0],
          rowId: tenants[1].rowId,
        };
        await expect(
          iso.expectCanSeeOwnTenant(ownGymOtherRow),
        ).rejects.toThrow(/should see own row/);
      });

      it('with RLS disabled, expectCannotSeeOtherTenant THROWS (cross-tenant row leaks)', async () => {
        // Drive the table into the "missing/broken policy" state a downstream RLS
        // PR must be caught committing — via the harness's own disableHarnessRls,
        // so the failability proof exercises the REAL policy lifecycle SQL.
        await disableHarnessRls(prisma);

        // The negative assertion must now FAIL: without the policy, the acting
        // tenant sees the other tenant's row, so expectCannotSeeOtherTenant
        // rejects. This is the proof the harness is failable, not a tautology.
        await expect(
          iso.expectCannotSeeOtherTenant(tenants[0], tenants[1]),
        ).rejects.toThrow(/RLS is not isolating tenants/);
      });

      it('after restoring RLS, the negative assertion passes again', async () => {
        // Restore via the harness's own enableHarnessRls and assert the round-trip
        // is clean so a later suite (or a re-run) starts from an isolating table.
        await enableHarnessRls(prisma);
        await expect(
          iso.expectCannotSeeOtherTenant(tenants[0], tenants[1]),
        ).resolves.toBeUndefined();
      });
    });
  },
);
