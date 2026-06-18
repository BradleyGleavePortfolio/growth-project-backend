// TM-3 keyset tuple cursor. Paginates on (created_at, id) — the tuple backing
// @@index([status, created_at, id]) — so boundaries stay stable across inserts
// (no offset drift). Opaque base64url blob; callers only echo back next_cursor.

export interface TupleCursor {
  created_at: Date;
  id: string;
}

// Encode the (created_at, id) tuple of the last row on a page into an opaque
// base64url string. created_at is serialized as an ISO-8601 instant so the
// round-trip preserves millisecond precision.
export function buildTupleCursor(row: TupleCursor): string {
  const payload = `${row.created_at.toISOString()}|${row.id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

// Decode an opaque cursor back to its (created_at, id) tuple. Returns null for
// any malformed input (bad base64, missing separator, unparseable date, empty
// id) so a hand-crafted cursor degrades to "page 1" rather than throwing.
export function parseTupleCursor(cursor: string): TupleCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf('|');
  if (sep <= 0 || sep === decoded.length - 1) return null;
  const isoPart = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (id.length === 0) return null;
  const ms = Date.parse(isoPart);
  if (Number.isNaN(ms)) return null;
  return { created_at: new Date(ms), id };
}
