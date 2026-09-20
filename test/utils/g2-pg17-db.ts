/**
 * S5 G2 proof target guard: one dedicated disposable database on the shared
 * isolated PostgreSQL 17 server that S1 provisions. It is a THIRD database,
 * separate from the frozen E (`g2_ledger_expand_disposable`) and T/Q0
 * (`g2_tq0_disposable`) targets, so no earlier proof state is reused.
 *
 * S1 chooses the loopback port, so the port is not hard-coded here. Instead
 * the operator must double-enter it in the confirmation (`<database>:<port>`),
 * and well-known application/pooler ports are refused unconditionally.
 * Validation happens before any connection is opened.
 */
export const G2_PG17_DATABASE = 'g2_s5_etq0_disposable';
export const G2_PG17_ROLE = 's5_super';
/** Fixture password is supplied only through this environment variable, never in a URL or file. */
export const G2_PG17_PASSWORD_ENV = 'G2_PG17_PASSWORD';
// 54321 is S1's own cluster; 55439 was the earlier Agent83 environment.
const REFUSED_PORTS = new Set(['5432', '5433', '6543', '54321', '54322', '55439']);
const PRISMA_ONLY = new Set(['schema', 'connection_limit']);

export function g2Pg17TestTarget(raw: string, confirmation?: string) {
  const url = new URL(raw);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    !/^[1-9][0-9]{3,4}$/.test(url.port) ||
    REFUSED_PORTS.has(url.port) ||
    Number(url.port) > 65535 ||
    url.pathname !== `/${G2_PG17_DATABASE}` ||
    url.username !== G2_PG17_ROLE ||
    url.password ||
    url.hash ||
    confirmation !== `${G2_PG17_DATABASE}:${url.port}`
  ) {
    throw new Error('S5 G2 proof requires its explicitly confirmed loopback disposable database and port');
  }
  for (const [key, value] of url.searchParams) {
    if (
      !['schema', 'connection_limit', 'connect_timeout'].includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      (key === 'schema' && value !== 'public') ||
      (key !== 'schema' && (!/^[1-9][0-9]?$/.test(value) || Number(value) > 10))
    ) {
      throw new Error('S5 G2 proof unsupported or ambiguous connection option');
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
export function withFixturePassword(url: string, password: string | undefined, username = G2_PG17_ROLE): string {
  if (!password || /[\s@/:?#]/.test(password)) throw new Error('S5 G2 proof requires a plain fixture password in the environment');
  const parsed = new URL(url);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}
