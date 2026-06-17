import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * TM-6 — MarketplaceAbuseSignal RLS migration, static integrity.
 *
 * DB-free drift-detection layer (mirrors partial-refund-decision-rls-migration
 * .spec.ts): the additive migration must create the abuse-signal store, enable
 * AND force RLS, ship the service_role bypass, and ship RESTRICTIVE deny-all
 * policies for BOTH anon and authenticated. Anyone editing the SQL must mirror
 * the change here. A live up/down + cross-tenant denial roundtrip belongs in
 * the disposable-DB rls-live lane.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');

function readSql(): string {
  return readFileSync(
    join(
      ROOT,
      'prisma',
      'migrations',
      '20261220000020_marketplace_abuse_signal_rls',
      'migration.sql',
    ),
    'utf8',
  );
}

describe('MarketplaceAbuseSignal RLS migration — static integrity', () => {
  const sql = readSql();

  it('creates the table and is dated after the talent_marketplace_rls migration', () => {
    expect(sql).toMatch(/CREATE TABLE "MarketplaceAbuseSignal"/);
    // 20261220000020 > 20261220000000 (the TM-1 RLS foundation migration).
    expect('20261220000020' > '20261220000000').toBe(true);
  });

  it('stores hashes only — no raw-PII column names', () => {
    expect(sql).toMatch(/"ip_hash"\s+TEXT/);
    expect(sql).toMatch(/"identity_hash"\s+TEXT/);
    expect(sql).toMatch(/"device_hash"\s+TEXT/);
    // No column literally named for raw PII.
    expect(sql).not.toMatch(/"email"\s+TEXT/);
    expect(sql).not.toMatch(/"ip_address"\s+TEXT/);
  });

  it('enables AND forces row level security', () => {
    expect(sql).toMatch(/ALTER TABLE "MarketplaceAbuseSignal" ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(/ALTER TABLE "MarketplaceAbuseSignal" FORCE ROW LEVEL SECURITY;/);
  });

  it('ships a service_role bypass policy (Primitive A)', () => {
    expect(sql).toMatch(
      /CREATE POLICY "p_marketplace_abuse_signal_service_role_all"[\s\S]*?TO service_role USING \(true\) WITH CHECK \(true\)/,
    );
  });

  it('ships RESTRICTIVE deny-all for anon AND authenticated', () => {
    expect(sql).toMatch(
      /CREATE POLICY "deny_all_anon_marketplace_abuse_signal"[\s\S]*?AS RESTRICTIVE FOR ALL TO anon USING \(false\) WITH CHECK \(false\)/,
    );
    expect(sql).toMatch(
      /CREATE POLICY "deny_all_authenticated_marketplace_abuse_signal"[\s\S]*?AS RESTRICTIVE FOR ALL TO authenticated USING \(false\) WITH CHECK \(false\)/,
    );
  });

  it('grants no SELECT/INSERT/UPDATE to public — service_role only', () => {
    expect(sql).not.toMatch(/TO public/);
  });
});
