/**
 * R81 PR #401 F3 — PartialRefundDecision RLS migration, static integrity.
 *
 * STATIC assertions (always run, no database required): the NEW additive
 * migration 20261218000100_rls_partial_refund_decision enables AND forces RLS
 * on the PartialRefundDecision table (created in the earlier, untouched
 * 20261215000300 migration) and ships the operator Decision-2 coach-only
 * policy set: a service_role bypass (Primitive A), a coach-of-purchase SELECT,
 * and a coach-of-purchase UPDATE — all keyed on the parent
 * ClientPurchase.coach_user_id = app.current_user_id(), with NO client policy
 * and NO client column added.
 *
 * This mirrors the DB-free drift-detection layer in
 * roman-coach-reviewed-migration.spec.ts and rls-b5-contracts-policies.spec.ts:
 * anyone editing the RLS SQL must mirror the change here. A genuine Postgres
 * up/down + cross-tenant denial roundtrip belongs in the disposable-DB live
 * lane (rls-live-tests, jest.rls.config.js) alongside the other policy suites;
 * this lane ships the always-on static layer.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

function readNewMigrationSql(): string {
  return readFileSync(
    join(
      ROOT,
      'prisma',
      'migrations',
      '20261218000100_rls_partial_refund_decision',
      'migration.sql',
    ),
    'utf8',
  );
}

function readOriginalMigrationSql(): string {
  return readFileSync(
    join(
      ROOT,
      'prisma',
      'migrations',
      '20261215000300_named_regimes_and_partial_refund_decision',
      'migration.sql',
    ),
    'utf8',
  );
}

describe('PartialRefundDecision RLS migration — static integrity (F3)', () => {
  const sql = readNewMigrationSql();

  it('is a NEW additive migration that does not alter the original DDL file', () => {
    // F3 contract: do not edit the migration that created the table. The new
    // file performs ONLY RLS DDL — no CREATE TABLE / ADD COLUMN / DROP.
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/ADD COLUMN/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);

    // The original migration must remain client-column-free and untouched
    // (Decision 2: coach-only, no client_id column).
    const original = readOriginalMigrationSql();
    expect(original).toMatch(/CREATE TABLE "PartialRefundDecision"/);
    expect(original).not.toMatch(/client_id/);
  });

  it('wraps the policy changes in a single transaction', () => {
    expect(sql).toMatch(/BEGIN;/);
    expect(sql).toMatch(/COMMIT;/);
  });

  it('enables AND forces RLS on PartialRefundDecision', () => {
    expect(sql).toMatch(
      /ALTER TABLE "PartialRefundDecision" ENABLE ROW LEVEL SECURITY;/,
    );
    expect(sql).toMatch(
      /ALTER TABLE "PartialRefundDecision" FORCE ROW LEVEL SECURITY;/,
    );
  });

  it('ships a service_role bypass policy (Primitive A / owner-bypass)', () => {
    expect(sql).toMatch(
      /CREATE POLICY "p_partialrefunddecision_service_role_all" ON "PartialRefundDecision" AS PERMISSIVE FOR ALL TO service_role USING \(true\) WITH CHECK \(true\)/,
    );
  });

  it('ships a coach-of-purchase SELECT policy keyed on the parent ClientPurchase.coach_user_id', () => {
    expect(sql).toMatch(
      /CREATE POLICY "p_partialrefunddecision_select" ON "PartialRefundDecision" AS PERMISSIVE FOR SELECT TO public/,
    );
    // owner bypass + current-user coach-of-purchase join.
    expect(sql).toMatch(/app\.is_owner\(\)/);
    expect(sql).toMatch(
      /EXISTS \(SELECT 1 FROM public\."ClientPurchase" cp WHERE cp\."id" = "PartialRefundDecision"\."client_purchase_id" AND cp\."coach_user_id" = app\.current_user_id\(\)\)/,
    );
  });

  it('ships a coach-of-purchase UPDATE policy with a matching WITH CHECK', () => {
    const updatePolicy = sql
      .split('\n')
      .find((line) =>
        line.includes('CREATE POLICY "p_partialrefunddecision_update"'),
      );
    expect(updatePolicy).toBeDefined();
    expect(updatePolicy).toMatch(/FOR UPDATE TO public/);
    // Both USING and WITH CHECK gate on the same coach-of-purchase predicate so
    // a decision can never be re-pointed at another coach's purchase.
    expect(updatePolicy).toMatch(/USING \(/);
    expect(updatePolicy).toMatch(/WITH CHECK \(/);
    expect(updatePolicy).toMatch(/cp\."coach_user_id" = app\.current_user_id\(\)/);
  });

  it('grants NO tenant INSERT/DELETE and NO client policy (coach-only, Decision 2)', () => {
    // Inserts are service_role-only (the webhook path). No FOR INSERT / FOR
    // DELETE policy is granted TO public, and there is no client-scoped policy.
    expect(sql).not.toMatch(/FOR INSERT TO public/);
    expect(sql).not.toMatch(/FOR DELETE TO public/);
    expect(sql).not.toMatch(/client_id/);
  });

  it('uses a timestamp strictly after the original table migration (append-only ordering)', () => {
    expect('20261218000100' > '20261215000300').toBe(true);
  });
});
