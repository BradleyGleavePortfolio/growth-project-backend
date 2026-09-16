/** Only two named loopback disposable targets, public schema, explicit consent. */
export function scoutIngestTestTarget(raw: string, confirmation?: string) {
  const url = new URL(raw);
  const database = url.pathname.slice(1);
  const allowed = new Set([
    'schema',
    'connection_limit',
    'connect_timeout',
    'sslmode',
    'sslrootcert',
  ]);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['scout_ingest_throwaway', 'tgp_importer_fix_r2'].includes(database) ||
    confirmation !== database ||
    url.hash ||
    (url.searchParams.get('schema') ?? 'public') !== 'public'
  ) {
    throw new Error(
      'Refusing destructive ingest test: require confirmed loopback disposable database/public schema',
    );
  }
  for (const [key, value] of url.searchParams) {
    if (
      !allowed.has(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      (key === 'sslmode' && !['disable', 'verify-full'].includes(value))
    ) {
      throw new Error('Unsupported or ambiguous ingest test connection option');
    }
  }
  for (const key of ['connection_limit', 'connect_timeout']) {
    const value = url.searchParams.get(key);
    if (value !== null && (!/^[1-9][0-9]?$/.test(value) || Number(value) > 10)) {
      throw new Error('Ingest test connection bounds must be 1..10');
    }
  }
  if (!url.searchParams.has('connect_timeout')) url.searchParams.set('connect_timeout', '5');
  const prisma = new URL(url);
  // Prisma's sslcert is a server CA; libpq's sslcert is a client cert.
  // Accept libpq verify-full + sslrootcert and translate explicitly. Reject
  // unsupported mutual-TLS options rather than silently dropping verification.
  if (url.searchParams.get('sslmode') === 'verify-full') {
    prisma.searchParams.set('sslmode', 'require');
    prisma.searchParams.set('sslaccept', 'strict');
    const ca = url.searchParams.get('sslrootcert');
    if (ca) prisma.searchParams.set('sslcert', ca);
    prisma.searchParams.delete('sslrootcert');
  } else if (url.searchParams.has('sslrootcert')) {
    throw new Error('A root certificate requires explicit verify-full');
  }
  const prismaUrl = prisma.toString();
  // Remove ONLY explicitly supported Prisma-only options, never TLS options.
  url.searchParams.delete('schema');
  url.searchParams.delete('connection_limit');
  if (!url.searchParams.has('connect_timeout')) url.searchParams.set('connect_timeout', '5');
  return { prismaUrl, psqlUrl: url.toString() };
}
