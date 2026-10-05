/**
 * Bloodwork attachment storage references (B-608-8).
 *
 * `storage_ref`/`storage_backend` arrive from the client. A `supabase`
 * reference is only meaningful, and only ever acted on with the service-role
 * key, when it points into the bloodwork bucket under the owning client's own
 * prefix: `<bucket>/<client_id>/<file path>`. Registration rejects anything
 * else, and account deletion ignores (and counts) anything else, so a stored
 * reference can never make the server delete another person's object.
 */
export const DEFAULT_BLOODWORK_BUCKET = 'bloodwork';
export const SUPABASE_BACKEND = 'supabase';

export function bloodworkBucket(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SUPABASE_BLOODWORK_BUCKET ?? '').trim() || DEFAULT_BLOODWORK_BUCKET;
}

/**
 * The object key inside the bloodwork bucket when `ref` is
 * `<bucket>/<clientId>/<path>` with a non-empty, traversal-free path;
 * otherwise null.
 */
export function ownedBloodworkKey(
  ref: string | null | undefined,
  clientId: string,
  bucket: string = bloodworkBucket(),
): string | null {
  if (!ref || !clientId) return null;
  const prefix = `${bucket}/${clientId}/`;
  if (!ref.startsWith(prefix)) return null;
  const key = ref.slice(bucket.length + 1);
  const segments = key.split('/');
  if (segments.length < 2) return null;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null;
    if (segment.includes('\\') || [...segment].some((ch) => ch.charCodeAt(0) < 0x20)) return null;
  }
  return key;
}
