/**
 * S7-3' G2 B/drain proof target guard: derived by literal substitution from the accepted
 * S5 guard test/utils/g2-pg17-db.ts (blob 0e73d76d), which stays byte-identical and keeps
 * governing the accepted S5 proof. One dedicated disposable database on a B-only
 * disposable PostgreSQL 17 cluster; a FOURTH identity, separate from the E, T/Q0 and
 * S5 targets, so no earlier proof state is reused and no S5 fixture is recreated.
 *
 * S1 chooses the loopback port, so the port is not hard-coded here. Instead
 * the operator must double-enter it in the confirmation (`<database>:<port>`),
 * and well-known application/pooler ports are refused unconditionally.
 * Validation happens before any connection is opened.
 */
export const G2_B_DATABASE = 'g2_b_drain_disposable';
/**
 * Explicit fixture role matrix (mirrors the accepted S5 Supabase-like PG17 fixture shape):
 *  - admin      b_super      cluster superuser: CREATE DATABASE/ROLE, lock observation only
 *  - migration  postgres      LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS, owns objects,
 *                             runs `prisma migrate deploy`, E up/down and all harness DDL/data
 *  - runtime    service_role  BYPASSRLS runtime role used by the O/T writer and Q0 reader processes
 *  - api        anon/authenticated  NOLOGIN, exercised only via SET ROLE for RLS denial
 */
export const G2_B_ROLE = 'b_super';
export const G2_B_ADMIN_ROLE = G2_B_ROLE;
export const G2_B_MIGRATION_ROLE = 'postgres';
export const G2_B_RUNTIME_ROLE = 'service_role';
export const G2_B_LOGIN_ROLES = new Set([G2_B_ADMIN_ROLE, G2_B_MIGRATION_ROLE, G2_B_RUNTIME_ROLE]);
/** Fixture password is supplied only through this environment variable, never in a URL or file. */
export const G2_B_PASSWORD_ENV = 'G2_B_PASSWORD';
/**
 * Distinctive B fixture markers. Both are pinned literals, deliberately NOT read from the
 * environment, so no operator variable can re-point a destructive step at another server:
 *  - cluster marker: the lane must be initialised with `cluster_name = 'b-disposable-pg17'`
 *    (postgresql.conf). A blank or foreign `cluster_name` is refused before any mutation.
 *  - database marker: bootstrap stamps `COMMENT ON DATABASE g2_b_drain_disposable` with this
 *    literal at creation; `DROP DATABASE` (runner `reset`) and bootstrap reuse are refused unless
 *    the existing database carries exactly this comment.
 * test/utils/g2-b-drain-bootstrap.sh and execution/95633079/s7-b-drain/fixture-proposal/binding/b-fixture.sh must carry the same literals.
 */
export const G2_B_CLUSTER_MARKER = 'b-disposable-pg17';
export const G2_B_DATABASE_MARKER = 'b-g2-drain-synthetic-disposable-fixture-safe-to-drop';
// 54321 is S1's own cluster; 55439 is the retained stopped C1 lane; 54325 is the (absent) S5 lane.
const REFUSED_PORTS = new Set(['5432', '5433', '6543', '54321', '54322', '55439', '54325']);
const PRISMA_ONLY = new Set(['schema', 'connection_limit']);

export function g2BDrainTestTarget(raw: string, confirmation?: string) {
  const url = new URL(raw);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    !/^[1-9][0-9]{3,4}$/.test(url.port) ||
    REFUSED_PORTS.has(url.port) ||
    Number(url.port) > 65535 ||
    url.pathname !== `/${G2_B_DATABASE}` ||
    url.username !== G2_B_ROLE ||
    url.password ||
    url.hash ||
    confirmation !== `${G2_B_DATABASE}:${url.port}`
  ) {
    throw new Error(
      'B/drain G2 proof requires its explicitly confirmed loopback disposable database and port',
    );
  }
  for (const [key, value] of url.searchParams) {
    if (
      !['schema', 'connection_limit', 'connect_timeout'].includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      (key === 'schema' && value !== 'public') ||
      (key !== 'schema' && (!/^[1-9][0-9]?$/.test(value) || Number(value) > 10))
    ) {
      throw new Error('B/drain G2 proof unsupported or ambiguous connection option');
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
  username = G2_B_ROLE,
): string {
  if (!password || /[\s@/:?#]/.test(password))
    throw new Error('B/drain G2 proof requires a plain fixture password in the environment');
  if (!G2_B_LOGIN_ROLES.has(username))
    throw new Error('B/drain G2 proof connects only as a fixture matrix login role');
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}
