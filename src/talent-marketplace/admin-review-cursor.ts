// TM-7 keyset tuple cursor for the owner-only moderation review queues
// (listings + applications). Paginates on (created_at, id) — the exact tuple
// backing @@index([status, created_at, id]) on JobListing and
// @@index([listing_id, status, created_at, id]) on Application — so a page
// boundary stays stable when new rows arrive mid-review (no offset drift).
//
// Mirrors TM-5's application-cursor.ts / TM-3's public-listing.cursor.ts: an
// opaque base64url blob of `created_at|id`, malformed input degrades to
// "page 1" rather than throwing (tamper-tolerant), and a hard page-size cap.

export const ADMIN_REVIEW_DEFAULT_LIMIT = 20;
export const ADMIN_REVIEW_MAX_LIMIT = 50;

export interface ReviewCursor {
  created_at: Date;
  id: string;
}

export function buildReviewCursor(row: ReviewCursor): string {
  const payload = `${row.created_at.toISOString()}|${row.id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

// Decode an opaque cursor back to its (created_at, id) tuple. Returns null for
// any malformed/tampered input so a hand-crafted cursor degrades to "page 1"
// rather than throwing.
export function parseReviewCursor(cursor: string): ReviewCursor | null {
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

// Clamp a client-supplied limit into [1, ADMIN_REVIEW_MAX_LIMIT], defaulting
// when omitted. The hard cap stops a caller from pulling an unbounded page.
export function clampReviewLimit(limit: number | undefined): number {
  if (limit === undefined) return ADMIN_REVIEW_DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), ADMIN_REVIEW_MAX_LIMIT);
}
