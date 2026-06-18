import { createHmac, timingSafeEqual } from 'crypto';

// TM-3 keyset tuple cursor. Paginates on (created_at, id) — the tuple backing
// @@index([status, created_at, id]) — so boundaries stay stable across inserts
// (no offset drift). Sort key is created_at, NOT published_at: created_at is NOT
// NULL and indexed, giving a total keyset order; published_at is nullable and
// would make the boundary ambiguous. Opaque base64url blob; callers only echo
// back next_cursor.
//
// Threat model: the cursor is a pagination hint, NOT an authorization token.
// Even an attacker-forged (created_at, id) tuple can only reposition the keyset
// window over the SAME public, status='published' result set — it can never
// widen visibility (the published filter is applied independently of the
// cursor). We still HMAC-sign the payload so a tampered or hand-crafted cursor
// is rejected outright and degrades to page 1, keeping the surface tidy and the
// emitted token verifiable. The signature is truncated to 16 base64url chars
// (96 bits) — ample for a non-security pagination integrity check.

export interface TupleCursor {
  created_at: Date;
  id: string;
}

const SIG_LEN = 16;

// Per-env signing secret. A tampered cursor is non-exploitable (see threat model
// above), so a deterministic dev fallback is acceptable when the env var is
// unset — it keeps local/test runs working without a secret. Production should
// still set PUBLIC_LISTING_CURSOR_SECRET (documented in .env.example).
function cursorSecret(): string {
  return process.env.PUBLIC_LISTING_CURSOR_SECRET || 'tm3-public-cursor-dev';
}

function sign(payload: string): string {
  return createHmac('sha256', cursorSecret())
    .update(payload)
    .digest('base64url')
    .slice(0, SIG_LEN);
}

// Constant-time compare of two equal-purpose signatures. Falls back to a plain
// !== when lengths differ (timingSafeEqual throws on length mismatch).
function signaturesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Encode the (created_at, id) tuple of the last row on a page into an opaque,
// HMAC-signed base64url string. created_at is serialized as an ISO-8601 instant
// so the round-trip preserves millisecond precision. Layout (pre-base64url):
//   <iso8601>|<id>|<sig>
export function buildTupleCursor(row: TupleCursor): string {
  const payload = `${row.created_at.toISOString()}|${row.id}`;
  const blob = `${payload}|${sign(payload)}`;
  return Buffer.from(blob, 'utf8').toString('base64url');
}

// Decode an opaque cursor back to its (created_at, id) tuple. Returns null for
// any malformed input (bad base64, missing fields, unparseable date, empty id)
// OR an invalid/forged signature, so a tampered or hand-crafted cursor degrades
// to "page 1" rather than throwing or shifting the window on a forged tuple.
export function parseTupleCursor(cursor: string): TupleCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // Split off the trailing signature first (last segment); the id may itself
  // contain '|', so the iso prefix is everything up to the FIRST separator and
  // the signature is everything after the LAST.
  const firstSep = decoded.indexOf('|');
  const lastSep = decoded.lastIndexOf('|');
  if (firstSep <= 0 || lastSep <= firstSep) return null;
  const isoPart = decoded.slice(0, firstSep);
  const id = decoded.slice(firstSep + 1, lastSep);
  const sig = decoded.slice(lastSep + 1);
  if (id.length === 0 || sig.length === 0) return null;
  if (!signaturesMatch(sig, sign(`${isoPart}|${id}`))) return null;
  const ms = Date.parse(isoPart);
  if (Number.isNaN(ms)) return null;
  return { created_at: new Date(ms), id };
}
