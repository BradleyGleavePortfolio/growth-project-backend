// TM-9b keyset cursor for the specialty-alerts feed. Paginates on
// (published_at, id) — the feed's newest-first sort key — so a page boundary
// stays stable when new listings publish mid-scroll (no offset drift). The
// cursor is an opaque base64url blob. Mirrors application-cursor.ts; the alert
// query filters `published_at: { not: null }`, so the timestamp is always real.

export interface AlertCursor {
  published_at: Date;
  id: string;
}

export function buildAlertCursor(row: AlertCursor): string {
  const payload = `${row.published_at.toISOString()}|${row.id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

// Decode an opaque cursor back to its (published_at, id) tuple. Returns null for
// any malformed input so a hand-crafted cursor degrades to "page 1" rather than
// throwing.
export function parseAlertCursor(cursor: string): AlertCursor | null {
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
  // to valid dates, which would let a hand-crafted cursor silently reframe the
  // keyset window instead of degrading to page 1 (A-P1-2).
  if (new Date(ms).toISOString() !== isoPart) return null;
  return { published_at: new Date(ms), id };
}
