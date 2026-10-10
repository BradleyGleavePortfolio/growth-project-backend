/**
 * The one way a destructive live-DB RLS suite finds its database (D5, REL-14).
 *
 * These suites DROP schemas, CREATE/ALTER tables and roles and rewrite policies,
 * so they must never reach the app's database. The rules:
 *   - Only TEST_DATABASE_URL is read. There is no fallback to DATABASE_URL or to
 *     a default URL, so a developer shell with DATABASE_URL pointed at a real
 *     project can never be picked up by accident.
 *   - The host must be localhost, 127.0.0.1, ::1 or `postgres` (the CI service
 *     container host). Anything else throws before any connection is opened.
 *   - Unset: returns '' so the suite can describe.skip, or throws when the suite
 *     passes { required: true }. In CI the rls-live-tests runner
 *     (scripts/ci/run-rls-suites.mjs) fails any suite that skips.
 */
export const LIVE_TEST_DB_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', 'postgres'];

export function liveTestDatabaseUrl(opts: { required?: boolean } = {}): string {
  const raw = process.env.TEST_DATABASE_URL ?? '';
  if (!raw) {
    if (opts.required) {
      throw new Error(
        'TEST_DATABASE_URL is not set; this destructive live-DB suite refuses to run without a local test database.',
      );
    }
    return '';
  }
  let host: string;
  try {
    host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL; refusing to run a destructive live-DB suite.',
    );
  }
  if (!LIVE_TEST_DB_HOSTS.includes(host)) {
    throw new Error(
      `TEST_DATABASE_URL host "${host}" is not a local test database (${LIVE_TEST_DB_HOSTS.join(', ')}); refusing to run a destructive live-DB suite.`,
    );
  }
  return raw;
}
