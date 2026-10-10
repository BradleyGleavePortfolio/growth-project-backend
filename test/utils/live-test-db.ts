/**
 * The one way a destructive live-DB RLS suite finds its database (D5, REL-14).
 *
 * These suites DROP schemas, CREATE/ALTER tables and roles and rewrite policies,
 * so they must never reach the app's database. The rules:
 *   - Only TEST_DATABASE_URL is read. There is no fallback to DATABASE_URL or to
 *     a default URL, so a developer shell with DATABASE_URL pointed at a real
 *     project can never be picked up by accident.
 *   - The host must be localhost, 127.0.0.1, ::1 or `postgres` (the CI service
 *     container host), and the URL may carry only connection_limit, schema and
 *     connect_timeout, once each: libpq and `pg` let ?host=, ?hostaddr=,
 *     ?service= or ?port= override the URL's host. Anything else throws before
 *     any connection is opened. scripts/ci/local-db-url.mjs applies the same
 *     rules to the CI scripts (test/utils/live-test-db.spec.ts pins both).
 *   - Unset: returns '' so the suite can describe.skip, or throws when the suite
 *     passes { required: true }. In CI the rls-live-tests runner
 *     (scripts/ci/run-rls-suites.mjs) fails any suite that skips.
 */
export const LIVE_TEST_DB_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', 'postgres'];
export const LIVE_TEST_DB_OPTIONS: readonly string[] = ['connection_limit', 'schema', 'connect_timeout'];

function problem(raw: string): string | null {
  // Refuse anything libpq and WHATWG URL could read differently before parsing:
  // libpq does not end the database path at '#', so options after it would apply.
  if (!/^postgres(ql)?:\/\//.test(raw)) return 'does not start with postgresql:// or postgres://';
  if (!/^[\x21-\x7e]+$/.test(raw)) return 'contains whitespace, control or non-ASCII characters';
  if (raw.includes('#')) return 'has a # fragment';
  if (raw.split('@').length > 2) return 'has more than one @';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'is not a valid URL';
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!LIVE_TEST_DB_HOSTS.includes(host)) {
    return `host "${host}" is not a local test database (${LIVE_TEST_DB_HOSTS.join(', ')})`;
  }
  if (!/^\/[\w-]*$/.test(u.pathname)) return `database name "${u.pathname}" is not a plain name`;
  const seen = new Set<string>();
  for (const key of u.searchParams.keys()) {
    if (!LIVE_TEST_DB_OPTIONS.includes(key)) {
      return `option "${key}" is not allowed (only ${LIVE_TEST_DB_OPTIONS.join(', ')})`;
    }
    if (seen.has(key)) return `option "${key}" appears twice`;
    seen.add(key);
  }
  return null;
}

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
  const why = problem(raw);
  if (why) {
    throw new Error(`TEST_DATABASE_URL ${why}; refusing to run a destructive live-DB suite.`);
  }
  return raw;
}
