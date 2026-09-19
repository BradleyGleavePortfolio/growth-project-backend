/** This slice owns a different database from the frozen E migration proof. */
export function g2Tq0TestTarget(raw: string, confirmation?: string) {
  const url = new URL(raw);
  const database = 'g2_tq0_disposable';
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' ||
      url.port !== '55439' || url.pathname !== `/${database}` ||
      url.username !== 'user' || url.password || url.hash ||
      confirmation !== database) {
    throw new Error('T/Q0 requires its explicitly confirmed loopback disposable database');
  }
  for (const [key, value] of url.searchParams) {
    if (!['schema', 'connection_limit', 'connect_timeout'].includes(key) ||
        url.searchParams.getAll(key).length !== 1 ||
        (key === 'schema' && value !== 'public') ||
        (key !== 'schema' && (!/^[1-9][0-9]?$/.test(value) || Number(value) > 10))) {
      throw new Error('T/Q0 unsupported or ambiguous connection option');
    }
  }
  if (!url.searchParams.has('connect_timeout')) url.searchParams.set('connect_timeout', '5');
  const prismaUrl = url.toString();
  url.searchParams.delete('schema');
  url.searchParams.delete('connection_limit');
  return { prismaUrl, psqlUrl: url.toString() };
}
