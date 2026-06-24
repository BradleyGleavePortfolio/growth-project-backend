// TM-5 keyset tuple cursor for "my applications". Paginates on (created_at, id)
// — the exact tuple backing @@index([applicant_user_id, created_at, id]) on
// Application — so a page boundary stays stable when new applications are
// submitted mid-scroll (no offset drift). Cursor is an opaque base64url blob.
//
// NOTE (dedup): this is an inline local copy of TM-3's identical
// public-listing.cursor.ts helper (on feat/tm-3-public-browse, not yet merged).
// Once TM-3 lands, hoist both call-sites onto one shared marketplace cursor
// module and delete this file.

export interface TupleCursor {
  created_at: Date;
  id: string;
}

export function buildTupleCursor(row: TupleCursor): string {
  const payload = `${row.created_at.toISOString()}|${row.id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

// Decode an opaque cursor back to its (created_at, id) tuple. Returns null for
// any malformed input so a hand-crafted cursor degrades to "page 1" rather than
// throwing.
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
  // Strict round-trip: reject anything that is not the exact ISO string the
  // encoder would emit. Date.parse coerces partials like '2026' or '2026-01'
  // (and '99') to valid dates, which would let a hand-crafted cursor silently
  // reframe the keyset window instead of degrading to page 1 (A-P1-2).
  if (new Date(ms).toISOString() !== isoPart) return null;
  return { created_at: new Date(ms), id };
}
