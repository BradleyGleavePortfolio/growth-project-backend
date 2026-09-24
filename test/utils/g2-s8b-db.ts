/**
 * S8-B G2 proof target guard: derived by literal substitution from the committed N/Q1 guard
 * test/utils/g2-nq1-db.ts (blob dbe10bcb at 61b93cff), which stays byte-identical and keeps
 * governing the N/Q1 proof (the S7-L1 draft guard is the same derivation on its own lane). One
 * dedicated disposable database on an S8-B-only disposable PostgreSQL 17 cluster; a NINTH
 * identity, separate from the E, T/Q0, S5, B, R, N/Q1, C and S7-L targets, so no earlier proof
 * state is reused and no earlier fixture is recreated.
 *
 * S1 chooses the loopback port, so the port is not hard-coded here. Instead
 * the operator must double-enter it in the confirmation (`<database>:<port>`),
 * and well-known application/pooler ports are refused unconditionally.
 * Validation happens before any connection is opened.
 */
export const G2_S8B_DATABASE = 'g2_s8b_disposable';
/**
 * Explicit fixture role matrix (mirrors the accepted S5 Supabase-like PG17 fixture shape):
 *  - admin      s8b_super    cluster superuser: CREATE DATABASE/ROLE, lock observation only
 *  - migration  postgres      LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS, owns objects,
 *                             runs `prisma migrate deploy`, S8-B up/down and all harness DDL/data
 *  - runtime    service_role  BYPASSRLS runtime role used by the old/candidate reconstruct writer processes
 *  - api        anon/authenticated  NOLOGIN, exercised only via SET ROLE for RLS denial
 */
export const G2_S8B_ROLE = 's8b_super';
export const G2_S8B_ADMIN_ROLE = G2_S8B_ROLE;
export const G2_S8B_MIGRATION_ROLE = 'postgres';
export const G2_S8B_RUNTIME_ROLE = 'service_role';
export const G2_S8B_LOGIN_ROLES = new Set([
  G2_S8B_ADMIN_ROLE,
  G2_S8B_MIGRATION_ROLE,
  G2_S8B_RUNTIME_ROLE,
]);
/** Fixture password is supplied only through this environment variable, never in a URL or file. */
export const G2_S8B_PASSWORD_ENV = 'G2_S8B_PASSWORD';
/**
 * Distinctive S8-B fixture markers. Both are pinned literals, deliberately NOT read from the
 * environment, so no operator variable can re-point a destructive step at another server:
 *  - cluster marker: the lane must be initialised with `cluster_name = 's8b-disposable-pg17'`
 *    (postgresql.conf). A blank or foreign `cluster_name` is refused before any mutation.
 *  - database marker: bootstrap stamps `COMMENT ON DATABASE g2_s8b_disposable` with this
 *    literal at creation; `DROP DATABASE` (runner `reset`) and bootstrap reuse are refused unless
 *    the existing database carries exactly this comment.
 * test/utils/g2-s8b-bootstrap.sh and the S8-B fixture binding under execution/ce3748cb/s8b/ must carry the same literals.
 */
export const G2_S8B_CLUSTER_MARKER = 's8b-disposable-pg17';
export const G2_S8B_DATABASE_MARKER = 's8b-g2-provenance-synthetic-disposable-fixture-safe-to-drop';
// 54321 is S1's own cluster; 55439 is the retained stopped C1 lane; 54325 is the (absent) S5 lane;
// 55461 is the retained stopped B lane (accepted proof at 0d69c7ba); 55471 is the retained stopped
// R lane (accepted proof at 7d2895e1); 55481 is the N/Q1 lane; 55491 is the C lane; 55501 is the
// S7-L lane.
const REFUSED_PORTS = new Set([
  '5432',
  '5433',
  '6543',
  '54321',
  '54322',
  '55439',
  '54325',
  '55461',
  '55471',
  '55481',
  '55491',
  '55501',
]);
const PRISMA_ONLY = new Set(['schema', 'connection_limit']);

export function g2S8bTestTarget(raw: string, confirmation?: string) {
  const url = new URL(raw);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    !/^[1-9][0-9]{3,4}$/.test(url.port) ||
    REFUSED_PORTS.has(url.port) ||
    Number(url.port) > 65535 ||
    url.pathname !== `/${G2_S8B_DATABASE}` ||
    url.username !== G2_S8B_ROLE ||
    url.password ||
    url.hash ||
    confirmation !== `${G2_S8B_DATABASE}:${url.port}`
  ) {
    throw new Error(
      'S8-B G2 proof requires its explicitly confirmed loopback disposable database and port',
    );
  }
  for (const [key, value] of url.searchParams) {
    if (
      !['schema', 'connection_limit', 'connect_timeout'].includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      (key === 'schema' && value !== 'public') ||
      (key !== 'schema' && (!/^[1-9][0-9]?$/.test(value) || Number(value) > 10))
    ) {
      throw new Error('S8-B G2 proof unsupported or ambiguous connection option');
    }
  }
  if (!url.searchParams.has('connect_timeout')) url.searchParams.set('connect_timeout', '5');
  const prismaUrl = url.toString();
  for (const key of PRISMA_ONLY) url.searchParams.delete(key);
  const psqlUrl = url.toString();
  // Maintenance database on the same server, used only to CREATE the disposable DB.
  url.pathname = '/postgres';
  return { prismaUrl, psqlUrl, maintenanceUrl: url.toString(), port: Number(url.port) };
}

/** Attach the fixture password for a client that cannot read PGPASSWORD (Prisma). */
export function withFixturePassword(
  url: string,
  password: string | undefined,
  username = G2_S8B_ROLE,
): string {
  if (!password || /[\s@/:?#]/.test(password))
    throw new Error('S8-B G2 proof requires a plain fixture password in the environment');
  if (!G2_S8B_LOGIN_ROLES.has(username))
    throw new Error('S8-B G2 proof connects only as a fixture matrix login role');
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}
