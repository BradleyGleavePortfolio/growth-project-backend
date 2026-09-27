import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isCanonicalPlatform } from './scout-platform';

// Fits three 256-character JSON-escaped identifiers, the family, the platform and a
// 128-character JSON-escaped token.
// Shared by HTTP DTOs and direct service calls; allocation is bounded pre-decode.
export const SCOUT_CURSOR_MAX_LENGTH = 8192;
const ORDER_V2 = 'source_id:asc,source_platform:asc';
/**
 * S11-E r2: the page order is the ledger's unique key order. Two step tokens of
 * ONE platform that map to the SAME family may share an id space (a source spec's
 * `sharedIdSpaces`), so two reconstructed rows can tie on (source_id,
 * source_platform) and differ only in `entity_type` (the ledger's own token). The
 * token is the tie-breaker, so ordering is total and a boundary names one row.
 */
const ORDER_V3 = 'source_id:asc,source_platform:asc,entity_type:asc';
const V2_PREFIX = 'v2.';
const V3_PREFIX = 'v3.';
/**
 * The token is the staged `entity_type`, bounded to 128 characters at ingest
 * (`scout-ingest.dto.ts`), so a v3 token of four maximal identifiers still fits
 * `SCOUT_CURSOR_MAX_LENGTH`: every valid ledger row is encodable.
 */
const TOKEN_MAX_LENGTH = 128;

/**
 * A decoded token. v3 (emitted) names the full row (source id, platform, token);
 * a v2 token minted before S11-E r2 names only the pair; legacy is source-only.
 * Both older shapes are resolved in-transaction by `resolveScoutCursor`.
 */
export type ScoutCursorBoundary = { s: string; p?: string; t?: string } | null;
/**
 * A page boundary the readers page from: the full (source_id, source_platform,
 * entity_type) row. `t: null` means "after every row of the pair" and arises only
 * from a pair-only v2 token whose pair matches NO reconstructed row in scope (so
 * no tie can exist and the pair itself is an unambiguous boundary).
 */
export type ScoutCursorPosition = { s: string; p: string; t: string | null } | null;

function value(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    Array.from(v).length <= 256 &&
    !v.includes('\u0000') &&
    !Array.from(v).some((c) => {
      const point = c.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff;
    })
  );
}
const tokenValue = (v: unknown): v is string =>
  value(v) && Array.from(v).length <= TOKEN_MAX_LENGTH;
const encode = (v: string) => Buffer.from(v, 'utf8').toString('base64url');

/** The canonical v2 (pair-only) envelope, in its one key order; the decoder still accepts it. */
function canonicalV2(coach: string, intent: string, family: string, s: unknown, p: unknown) {
  return { v: 2, c: coach, i: intent, f: family, o: ORDER_V2, s, p };
}
/** The one canonical v3 envelope, in the one key order; encoder and decoder share it. */
function canonicalV3(
  coach: string,
  intent: string,
  family: string,
  s: unknown,
  p: unknown,
  t: unknown,
) {
  return { v: 3, c: coach, i: intent, f: family, o: ORDER_V3, s, p, t };
}

/**
 * Emission: every boundary is the last ledger row of a page, so it always carries
 * its platform and its own token. Encoder and decoder share `canonicalV3`, so
 * `decodeScoutCursor(encodeScoutCursor(x)) === x` for every emitted token. A
 * boundary the decoder would refuse is never emitted: the reader fails closed
 * (no cursor is invented) rather than hand out an undecodable token.
 */
export function encodeScoutCursor(
  coach: string,
  intent: string,
  family: string,
  s: string,
  p: string,
  t: string,
): string {
  if (!value(coach) || !value(intent) || !value(s) || !isCanonicalPlatform(p) || !tokenValue(t)) {
    throw new InternalServerErrorException('cursor boundary not encodable');
  }
  const token = V3_PREFIX + encode(JSON.stringify(canonicalV3(coach, intent, family, s, p, t)));
  if (token.length > SCOUT_CURSOR_MAX_LENGTH) {
    throw new InternalServerErrorException('cursor boundary not encodable');
  }
  return token;
}

/**
 * Accepts, in order of precision: v3 (row), v2 (pair; minted before S11-E r2) and
 * the legacy formats (legacy roster is a raw source id; legacy entities are
 * scope-bound JSON). Every accepted token is bound to the caller's scope.
 */
export function decodeScoutCursor(
  cursor: string | undefined,
  coach: string,
  intent: string,
  family: string,
): ScoutCursorBoundary {
  if (cursor === undefined || cursor === '') return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > SCOUT_CURSOR_MAX_LENGTH) throw new Error();
    const v3 = cursor.startsWith(V3_PREFIX);
    const v2 = !v3 && cursor.startsWith(V2_PREFIX);
    const token = v3 || v2 ? cursor.slice(V3_PREFIX.length) : cursor;
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    if (encode(decoded) !== token) throw new Error();
    if (!v3 && !v2 && family === 'clients') {
      if (!value(decoded)) throw new Error();
      return { s: decoded };
    }
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const v = parsed as Record<string, unknown>;
    if (
      !value(v.c) ||
      !value(v.i) ||
      !value(v.s) ||
      v.c !== coach ||
      v.i !== intent ||
      v.f !== family
    )
      throw new Error();
    if (v3) {
      if (v.v !== 3 || !isCanonicalPlatform(v.p) || !tokenValue(v.t)) throw new Error();
      const canonical = canonicalV3(coach, intent, family, v.s, v.p, v.t);
      if (encode(JSON.stringify(canonical)) !== token) throw new Error();
      return { s: v.s, p: v.p, t: v.t };
    }
    if (v2) {
      if (v.v !== 2 || !isCanonicalPlatform(v.p)) throw new Error();
      const canonical = canonicalV2(coach, intent, family, v.s, v.p);
      if (encode(JSON.stringify(canonical)) !== token) throw new Error();
      return { s: v.s, p: v.p };
    }
    const canonical = { c: coach, i: intent, f: family, o: 'source_id:asc', s: v.s };
    if (encode(JSON.stringify(canonical)) !== token) throw new Error();
    return { s: v.s };
  } catch {
    throw new BadRequestException('malformed cursor');
  }
}

/**
 * Boundary resolution for the two older token shapes, inside the caller's
 * RepeatableRead transaction, after the settled/ownership gate and before any
 * page read, strictly within the requested (coach, intent, family) scope: the
 * scope arrives as the reader's `(source_platform, entity_type)` pair predicate
 * (`familyScopeWhere`) plus status, so a roster token is never widened past the
 * roster family and a token-mapped source resolves exactly like the legacy
 * token == family convention. One bounded `take: 2` lookup; no page is read on a
 * refusal.
 *
 * - v3 (row) needs no lookup.
 * - v2 (pair, minted before S11-E r2): the rows sharing the pair decide. Exactly
 *   one → the boundary is that row (its token completes the key). None → no tie
 *   can exist, the pair is the boundary (`t: null`, continue after the pair). Two
 *   or more → the pair is AMBIGUOUS (the page may have ended between the tied rows
 *   and the token cannot say where): fail closed, 400 `malformed cursor`, the
 *   caller restarts from the first page. Chosen over guessing a side, which would
 *   silently skip or repeat a row.
 * - legacy (source id only): exactly one reconstructed row with a canonical
 *   platform is the boundary; zero (forged, foreign, or absent) or two or more (a
 *   tie the legacy format cannot name) is the existing 400.
 */
export async function resolveScoutCursor(
  tx: Prisma.TransactionClient,
  scope: Prisma.ScoutReconstructionLedgerWhereInput & {
    coach_id: string;
    intent_id: string;
    status: string;
  },
  after: ScoutCursorBoundary,
): Promise<ScoutCursorPosition> {
  if (!after) return null;
  if (after.p !== undefined && after.t !== undefined) return { s: after.s, p: after.p, t: after.t };
  if (after.p !== undefined) {
    const rows = await tx.scoutReconstructionLedger.findMany({
      where: { ...scope, source_id: after.s, source_platform: after.p },
      select: { entity_type: true },
      take: 2,
    });
    if (rows.length > 1) throw new BadRequestException('malformed cursor');
    return { s: after.s, p: after.p, t: rows.length === 1 ? rows[0].entity_type : null };
  }
  const rows = await tx.scoutReconstructionLedger.findMany({
    where: { ...scope, source_id: after.s },
    select: { source_platform: true, entity_type: true },
    take: 2,
  });
  const p = rows.length === 1 ? rows[0].source_platform : undefined;
  if (!isCanonicalPlatform(p)) throw new BadRequestException('malformed cursor');
  return { s: after.s, p, t: rows[0].entity_type };
}

/**
 * Lexicographic (source_id, source_platform, entity_type) continuation; every
 * page uses it. A pair boundary (`t: null`) continues after every row of the pair.
 */
export function scoutCursorWhere(
  after: ScoutCursorPosition,
): Prisma.ScoutReconstructionLedgerWhereInput {
  if (!after) return {};
  const pair = { source_id: after.s, source_platform: after.p };
  return {
    OR: [
      { source_id: { gt: after.s } },
      { source_id: after.s, source_platform: { gt: after.p } },
      ...(after.t === null ? [] : [{ ...pair, entity_type: { gt: after.t } }]),
    ],
  };
}

/** Every page, including the first, is ordered by (source_id, source_platform, entity_type). */
export function scoutCursorOrder(): Prisma.ScoutReconstructionLedgerOrderByWithRelationInput[] {
  return [{ source_id: 'asc' }, { source_platform: 'asc' }, { entity_type: 'asc' }];
}
