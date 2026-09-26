/**
 * S10-B G2 proof target guard: derived by literal substitution from the S9-C guard
 * test/utils/g2-s9c-db.ts (d3a9-s9c-r2; itself from the accepted S8-G guard), which stays
 * byte-identical and keeps governing the S9-C proof. One dedicated disposable database on an
 * S10-B-only disposable PostgreSQL 17 cluster; a further identity, separate from the E, T/Q0, S5,
 * B, R, N/Q1, C, S7-L, S8-B, S8-C, S8-G, S9-B and S9-C targets, so no earlier proof state is
 * reused and no earlier fixture is recreated.
 *
 * S1 chooses the loopback port, so the port is not hard-coded here. Instead
 * the operator must double-enter it in the confirmation (`<database>:<port>`),
 * and well-known application/pooler ports are refused unconditionally.
 * Validation happens before any connection is opened.
 */
export const G2_S10B_DATABASE = 'g2_s10b_disposable';
/**
 * Explicit fixture role matrix (mirrors the accepted S5 Supabase-like PG17 fixture shape):
 *  - admin      s10b_super    cluster superuser: CREATE DATABASE/ROLE, lock observation only
 *  - migration  postgres      LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS, owns objects,
 *                             runs `prisma migrate deploy` (accepted history + the S10-B expand) and all harness DDL/data
 *  - runtime    service_role  BYPASSRLS runtime role used by the candidate observation/lifecycle worker processes
 *  - api        anon/authenticated  NOLOGIN, exercised only via SET ROLE for RLS denial
 */
export const G2_S10B_ROLE = 's10b_super';
export const G2_S10B_ADMIN_ROLE = G2_S10B_ROLE;
export const G2_S10B_MIGRATION_ROLE = 'postgres';
export const G2_S10B_RUNTIME_ROLE = 'service_role';
export const G2_S10B_LOGIN_ROLES = new Set([
  G2_S10B_ADMIN_ROLE,
  G2_S10B_MIGRATION_ROLE,
  G2_S10B_RUNTIME_ROLE,
]);
/** Fixture password is supplied only through this environment variable, never in a URL or file. */
export const G2_S10B_PASSWORD_ENV = 'G2_S10B_PASSWORD';
/**
 * Distinctive S10-B fixture markers. Both are pinned literals, deliberately NOT read from the
 * environment, so no operator variable can re-point a destructive step at another server:
 *  - cluster marker: the lane must be initialised with `cluster_name = 's10b-disposable-pg17'`
 *    (postgresql.conf). A blank or foreign `cluster_name` is refused before any mutation.
 *  - database marker: bootstrap stamps `COMMENT ON DATABASE g2_s10b_disposable` with this
 *    literal at creation; `DROP DATABASE` (runner `reset`) and bootstrap reuse are refused unless
 *    the existing database carries exactly this comment.
 * test/utils/g2-s10b-bootstrap.sh and the S10-B binding under execution/d3a9f701/s10b/ must carry the same literals.
 */
export const G2_S10B_CLUSTER_MARKER = 's10b-disposable-pg17';
export const G2_S10B_DATABASE_MARKER =
  's10b-g2-run-observation-synthetic-disposable-fixture-safe-to-drop';
// 54321 is S1's own cluster; 55439 is the retained stopped C1 lane; 54325 is the (absent) S5 lane;
// 55461 is the retained stopped B lane (accepted proof at 0d69c7ba); 55471 is the retained stopped
// R lane (accepted proof at 7d2895e1); 55481 is the N/Q1 lane; 55491 is the C lane; 55501 is the
// S7-L lane; 55511 is the accepted S8-B lane; 55641 is the accepted S7-L (64e33dc7) lane; 55642 is
// the accepted S8-C lane; 55643 is the retained S8-F lane; 55644 is the accepted S8-G lane
// (1910a060/s8g); 55645 is the S9-B lane (1910a060/s9b); 55646 is the S9-C lane (d3a9f701/s9c).
// The S10-B lane port is chosen by the parent (55647 suggested, execution/d3a9f701),
// double-entered in the confirmation, never hard-coded.
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
  '55511',
  '55641',
  '55642',
  '55643',
  '55644',
  '55645',
  '55646',
]);
const PRISMA_ONLY = new Set(['schema', 'connection_limit']);

export function g2S10bTestTarget(raw: string, confirmation?: string) {
  const url = new URL(raw);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    !/^[1-9][0-9]{3,4}$/.test(url.port) ||
    REFUSED_PORTS.has(url.port) ||
    Number(url.port) > 65535 ||
    url.pathname !== `/${G2_S10B_DATABASE}` ||
    url.username !== G2_S10B_ROLE ||
    url.password ||
    url.hash ||
    confirmation !== `${G2_S10B_DATABASE}:${url.port}`
  ) {
    throw new Error(
      'S10-B G2 proof requires its explicitly confirmed loopback disposable database and port',
    );
  }
  for (const [key, value] of url.searchParams) {
    if (
      !['schema', 'connection_limit', 'connect_timeout'].includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      (key === 'schema' && value !== 'public') ||
      (key !== 'schema' && (!/^[1-9][0-9]?$/.test(value) || Number(value) > 10))
    ) {
      throw new Error('S10-B G2 proof unsupported or ambiguous connection option');
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
  username = G2_S10B_ROLE,
): string {
  if (!password || /[\s@/:?#]/.test(password))
    throw new Error('S10-B G2 proof requires a plain fixture password in the environment');
  if (!G2_S10B_LOGIN_ROLES.has(username))
    throw new Error('S10-B G2 proof connects only as a fixture matrix login role');
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}

/**
 * Candidate binding. The one-run S10-B proof is granted against ONE attested final head, so the
 * driver refuses to run against anything else: the operator double-enters the attested head in
 * G2_S10B_CANDIDATE_HEAD, and it must equal the checked-out HEAD of the runtime root exactly,
 * that head must not be the base itself (a candidate, not the accepted tree), and the tree must
 * be clean (an uncommitted edit would make the proof about bytes no attestation covers). Pure:
 * the callers supply `git rev-parse HEAD` and `git status --porcelain` output.
 */
export const G2_S10B_CANDIDATE_HEAD_ENV = 'G2_S10B_CANDIDATE_HEAD';
export const G2_S10B_BASE_HEAD = 'a4af8e330bd4d6f882f0aebd411200b76d651aba';
export function g2S10bCandidateHead(
  declared: string | undefined,
  checkedOut: string,
  porcelain: string,
): string {
  if (!declared || !/^[0-9a-f]{40}$/.test(declared))
    throw new Error(
      `S10-B G2 proof requires the attested candidate head in ${G2_S10B_CANDIDATE_HEAD_ENV}`,
    );
  if (declared === G2_S10B_BASE_HEAD)
    throw new Error('S10-B G2 proof target is a candidate head, not the accepted base');
  if (checkedOut.trim() !== declared)
    throw new Error(
      `S10-B G2 proof runtime root is at ${checkedOut.trim()}, not the attested candidate ${declared}`,
    );
  if (porcelain.trim() !== '')
    throw new Error(
      'S10-B G2 proof runtime root has uncommitted changes; the attested head must be checked out clean',
    );
  return declared;
}
