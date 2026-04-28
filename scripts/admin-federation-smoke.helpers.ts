/**
 * Pure helpers for scripts/admin-federation-smoke.ts.
 *
 * Extracted into their own file so they can be unit-tested without
 * triggering the smoke script's module-load env check (which calls
 * process.exit when BACKEND_URL / OWNER_JWT / SMOKE_*_ID are unset).
 */

// Allowed finance federation status values, mirroring
// FinanceFederationStatus in src/admin/console/finance-federation.service.ts.
// Kept as a literal list (not imported from the Nest service) so the smoke
// script can run from a built tarball without dragging the framework
// dependency tree along with it.
export const FINANCE_OK_STATUSES: ReadonlySet<string> = new Set([
  'ok',
  'not_configured',
  'auth_unconfigured',
  'degraded',
  'not_found',
]);

// IDs are not secrets, but they identify real users in production logs.
// Default to a short prefix/suffix so the smoke output is readable without
// pasting raw ids into shared terminals; the full value is still sent on
// the wire. Pass verbose=true to keep the full id in the log line.
export function redactId(id: string, verbose = false): string {
  if (!id) return '<unset>';
  if (verbose) return id;
  if (id.length <= 8) return `${id[0]}…${id[id.length - 1]}`;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
