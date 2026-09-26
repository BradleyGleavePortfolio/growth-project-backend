/**
 * S11 G2 proof target guard (the ONE S11 harness, docs/decisions/2026-09-26-s11-journey.md
 * D-S11-6): derived by literal substitution from the landed S9-C guard test/utils/g2-s9c-db.ts
 * (unchanged; the donor as landed at 92b96715), which stays byte-identical and keeps governing the
 * S9-C proof. The S11 base pin is 711c1f8f (S10-A → S10-B → S10-D D1 → S11-0 record). Only the lane
 * descriptor differs: one dedicated disposable database on an S11-only disposable PostgreSQL 17
 * cluster, a further identity separate from every earlier lane (E, T/Q0, S5, B, R, N/Q1, C, S7-L,
 * S8-B, S8-C, S8-F, S8-G, S9-B, S9-C, S10-B), so no earlier proof state is reused and no earlier
 * fixture is recreated.
 *
 * S1 chooses the loopback port, so the port is not hard-coded here. Instead
 * the operator must double-enter it in the confirmation (`<database>:<port>`),
 * and well-known application/pooler ports are refused unconditionally.
 * Validation happens before any connection is opened.
 */
export const G2_S11_DATABASE = 'g2_s11_disposable';
/**
 * Explicit fixture role matrix (mirrors the accepted S5 Supabase-like PG17 fixture shape):
 *  - admin      s11_super    cluster superuser: CREATE DATABASE/ROLE, lock observation only
 *  - migration  postgres      LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS, owns objects,
 *                             runs `prisma migrate deploy` and all harness DDL/data (S11-A1 ships no migration)
 *  - runtime    service_role  BYPASSRLS runtime role used by the candidate lifecycle/reconstruct worker processes
 *  - api        anon/authenticated  NOLOGIN, exercised only via SET ROLE for RLS denial
 */
export const G2_S11_ROLE = 's11_super';
export const G2_S11_ADMIN_ROLE = G2_S11_ROLE;
export const G2_S11_MIGRATION_ROLE = 'postgres';
export const G2_S11_RUNTIME_ROLE = 'service_role';
export const G2_S11_LOGIN_ROLES = new Set([
  G2_S11_ADMIN_ROLE,
  G2_S11_MIGRATION_ROLE,
  G2_S11_RUNTIME_ROLE,
]);
/** Fixture password is supplied only through this environment variable, never in a URL or file. */
export const G2_S11_PASSWORD_ENV = 'G2_S11_PASSWORD';
/**
 * Distinctive S11 fixture markers. Both are pinned literals, deliberately NOT read from the
 * environment, so no operator variable can re-point a destructive step at another server:
 *  - cluster marker: the lane must be initialised with `cluster_name = 's11-disposable-pg17'`
 *    (postgresql.conf). A blank or foreign `cluster_name` is refused before any mutation.
 *  - database marker: bootstrap stamps `COMMENT ON DATABASE g2_s11_disposable` with this
 *    literal at creation; `DROP DATABASE` (runner `reset`) and bootstrap reuse are refused unless
 *    the existing database carries exactly this comment.
 * test/utils/g2-s11-bootstrap.sh and the S11 binding under execution/d3a9f701/s11/ must carry the same literals.
 */
export const G2_S11_CLUSTER_MARKER = 's11-disposable-pg17';
export const G2_S11_DATABASE_MARKER =
  's11-g2-journey-multi-host-synthetic-disposable-fixture-safe-to-drop';
// 54321 is S1's own cluster; 55439 is the retained stopped C1 lane; 54325 is the (absent) S5 lane;
// 55461 is the retained stopped B lane (accepted proof at 0d69c7ba); 55471 is the retained stopped
// R lane (accepted proof at 7d2895e1); 55481 is the N/Q1 lane; 55491 is the C lane; 55501 is the
// S7-L lane; 55511 is the accepted S8-B lane; 55641 is the accepted S7-L (64e33dc7) lane; 55642 is
// the accepted S8-C lane; 55643 is the retained S8-F lane; 55644 is the accepted S8-G lane
// (1910a060/s8g); 55645 is the S9-B lane (1910a060/s9b); 55646 is the S9-C lane; 55647 is the S10-B
// lane. The S11 lane port is chosen by the parent (55648, execution/d3a9f701), double-entered in the
// confirmation, never hard-coded.
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
  '55647',
]);
const PRISMA_ONLY = new Set(['schema', 'connection_limit']);

export function g2S11TestTarget(raw: string, confirmation?: string) {
  const url = new URL(raw);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    !/^[1-9][0-9]{3,4}$/.test(url.port) ||
    REFUSED_PORTS.has(url.port) ||
    Number(url.port) > 65535 ||
    url.pathname !== `/${G2_S11_DATABASE}` ||
    url.username !== G2_S11_ROLE ||
    url.password ||
    url.hash ||
    confirmation !== `${G2_S11_DATABASE}:${url.port}`
  ) {
    throw new Error(
      'S11 G2 proof requires its explicitly confirmed loopback disposable database and port',
    );
  }
  for (const [key, value] of url.searchParams) {
    if (
      !['schema', 'connection_limit', 'connect_timeout'].includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      (key === 'schema' && value !== 'public') ||
      (key !== 'schema' && (!/^[1-9][0-9]?$/.test(value) || Number(value) > 10))
    ) {
      throw new Error('S11 G2 proof unsupported or ambiguous connection option');
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
  username = G2_S11_ROLE,
): string {
  if (!password || /[\s@/:?#]/.test(password))
    throw new Error('S11 G2 proof requires a plain fixture password in the environment');
  if (!G2_S11_LOGIN_ROLES.has(username))
    throw new Error('S11 G2 proof connects only as a fixture matrix login role');
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}

/**
 * Candidate binding. The one-run S11 proof is granted against ONE attested final head, so the
 * driver refuses to run against anything else: the operator double-enters the attested head in
 * G2_S11_CANDIDATE_HEAD, and it must equal the checked-out HEAD of the runtime root exactly,
 * that head must not be the base itself (a candidate, not the accepted tree), and the tree must
 * be clean (an uncommitted edit would make the proof about bytes no attestation covers). Pure:
 * the callers supply `git rev-parse HEAD` and `git status --porcelain` output.
 */
export const G2_S11_CANDIDATE_HEAD_ENV = 'G2_S11_CANDIDATE_HEAD';
export const G2_S11_BASE_HEAD = '711c1f8f8b42157bca97f2a721557be7ef006667';
export function g2S11CandidateHead(
  declared: string | undefined,
  checkedOut: string,
  porcelain: string,
): string {
  if (!declared || !/^[0-9a-f]{40}$/.test(declared))
    throw new Error(
      `S11 G2 proof requires the attested candidate head in ${G2_S11_CANDIDATE_HEAD_ENV}`,
    );
  if (declared === G2_S11_BASE_HEAD)
    throw new Error('S11 G2 proof target is a candidate head, not the accepted base');
  if (checkedOut.trim() !== declared)
    throw new Error(
      `S11 G2 proof runtime root is at ${checkedOut.trim()}, not the attested candidate ${declared}`,
    );
  if (porcelain.trim() !== '')
    throw new Error(
      'S11 G2 proof runtime root has uncommitted changes; the attested head must be checked out clean',
    );
  return declared;
}
