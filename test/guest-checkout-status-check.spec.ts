import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  GUEST_CHECKOUT_STATUSES,
  isGuestCheckoutStatus,
} from '../src/storefront/guest-checkout-status';

// A276 P0-1 — DB / code consistency for GuestCheckout_status_check.
//
// The auditor caught a P0 because 164 tests passed against a fully
// mocked Prisma: nothing exercised the Postgres CHECK constraint that
// `tx.guestCheckout.updateMany({ data: { status: 'refunded' } })` would
// violate in production. This spec restores the missing structural
// guarantee — it doesn't run Postgres, but it verifies the only two
// artefacts that have to stay in lockstep:
//
//   1. The migration files DEFINE the allowed status set.
//   2. The TypeScript literal GUEST_CHECKOUT_STATUSES MIRRORS it.
//   3. Every status literal the service writes is IN that set.
//
// If a future PR adds a status without a matching migration (or vice
// versa), this spec fails locally + in CI without needing a real DB
// harness. When a real Postgres harness lands (testcontainers,
// `prisma migrate dev` on a throwaway DB), the SQL-level CHECK can be
// exercised end-to-end without changing this spec's contract.

const MIGRATIONS_DIR = join(__dirname, '..', 'prisma', 'migrations');

function readAllMigrations(): { path: string; sql: string }[] {
  const out: { path: string; sql: string }[] = [];
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    const dir = join(MIGRATIONS_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const sqlPath = join(dir, 'migration.sql');
    try {
      out.push({ path: sqlPath, sql: readFileSync(sqlPath, 'utf-8') });
    } catch {
      // Not every dir has a migration.sql (e.g. scaffold .md files).
      continue;
    }
  }
  // Sort by timestamp prefix so the last entry is the latest migration.
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Naive parser: pull the `status IN (...)` value list out of the
// most-recent migration that touches the CHECK constraint name.
function parseStatusCheckValues(sql: string): string[] {
  // Match the ADD CONSTRAINT ... CHECK (status IN ('a','b',...))
  // The match is intentionally non-greedy and tolerant of whitespace
  // and trailing commas.
  const re =
    /ADD\s+CONSTRAINT\s+"GuestCheckout_status_check"\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i;
  const m = re.exec(sql);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, '').trim())
    .filter((s) => s.length > 0);
}

describe('GuestCheckout_status_check (A276-P0-1 refix)', () => {
  it('the latest migration that defines the constraint admits exactly GUEST_CHECKOUT_STATUSES', () => {
    const migrations = readAllMigrations();
    // Find the LAST migration whose SQL re-adds the constraint.
    const adders = migrations.filter((m) =>
      /ADD\s+CONSTRAINT\s+"GuestCheckout_status_check"/i.test(m.sql),
    );
    expect(adders.length).toBeGreaterThan(0);
    const latest = adders[adders.length - 1];
    const values = parseStatusCheckValues(latest.sql);
    expect(values.length).toBeGreaterThan(0);
    // Set equality — order in the CHECK list does not matter.
    expect(new Set(values)).toEqual(new Set(GUEST_CHECKOUT_STATUSES));
  });

  it('the A276-P0-1 refix migration drops the old constraint and re-adds it with refunded + disputed', () => {
    const target = join(
      MIGRATIONS_DIR,
      '20260921000000_add_refunded_disputed_to_guest_checkout_status',
      'migration.sql',
    );
    const sql = readFileSync(target, 'utf-8');
    // It MUST drop the previous shape.
    expect(sql).toMatch(/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+"GuestCheckout_status_check"/i);
    // And the new shape MUST contain the two new states.
    const values = parseStatusCheckValues(sql);
    expect(values).toEqual(
      expect.arrayContaining(['refunded', 'disputed']),
    );
    // And it must NOT silently drop any previously-admitted state.
    expect(values).toEqual(
      expect.arrayContaining([
        'pending',
        'paid',
        'failed',
        'converted',
        'conversion_failed_retryable',
        'conversion_failed_terminal',
      ]),
    );
  });

  it('every status literal the refund handler writes is admitted by the constraint', () => {
    // The literal values handleChargeRefunded + handleDisputeOpened
    // pass to data.status. Mirror them here.
    const refundHandlerLiterals = ['refunded', 'paid', 'converted'];
    const disputeHandlerLiterals = ['disputed'];
    for (const v of [...refundHandlerLiterals, ...disputeHandlerLiterals]) {
      expect(isGuestCheckoutStatus(v)).toBe(true);
    }
  });

  it('isGuestCheckoutStatus rejects values outside the set', () => {
    expect(isGuestCheckoutStatus('reverted')).toBe(false);
    expect(isGuestCheckoutStatus('')).toBe(false);
    expect(isGuestCheckoutStatus('PENDING')).toBe(false);
  });
});
