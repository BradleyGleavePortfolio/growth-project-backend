import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isCanonicalPlatform } from './scout-platform';

// Fits three 256-character JSON-escaped identifiers, the family and platform.
// Shared by HTTP DTOs and direct service calls; allocation is bounded pre-decode.
export const SCOUT_CURSOR_MAX_LENGTH = 8192;
const ORDER = 'source_id:asc,source_platform:asc';
const V2_PREFIX = 'v2.';

/** A decoded token: v2 carries the platform; legacy is source-only until resolved. */
export type ScoutCursorBoundary = { s: string; p?: string } | null;
/** A page boundary the readers page from: always the full (source_id, source_platform). */
export type ScoutCursorPosition = { s: string; p: string } | null;

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
const encode = (v: string) => Buffer.from(v, 'utf8').toString('base64url');

/** The one canonical v2 envelope, in the one key order; encoder and decoder share it. */
function canonicalV2(coach: string, intent: string, family: string, s: unknown, p: unknown) {
  return { v: 2, c: coach, i: intent, f: family, o: ORDER, s, p };
}

/**
 * Q1 emission: every boundary is the last ledger row of a page, so it always
 * carries its platform. Encoder and decoder share `canonicalV2`, so
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
): string {
  if (!value(coach) || !value(intent) || !value(s) || !isCanonicalPlatform(p)) {
    throw new InternalServerErrorException('cursor boundary not encodable');
  }
  const token = V2_PREFIX + encode(JSON.stringify(canonicalV2(coach, intent, family, s, p)));
  if (token.length > SCOUT_CURSOR_MAX_LENGTH) {
    throw new InternalServerErrorException('cursor boundary not encodable');
  }
  return token;
}

/** Legacy roster is a raw source id; legacy entities are scope-bound JSON. */
export function decodeScoutCursor(
  cursor: string | undefined,
  coach: string,
  intent: string,
  family: string,
): ScoutCursorBoundary {
  if (cursor === undefined || cursor === '') return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > SCOUT_CURSOR_MAX_LENGTH) throw new Error();
    const v2 = cursor.startsWith(V2_PREFIX);
    const token = v2 ? cursor.slice(V2_PREFIX.length) : cursor;
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    if (encode(decoded) !== token) throw new Error();
    if (!v2 && family === 'clients') {
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
    const canonical = v2
      ? canonicalV2(coach, intent, family, v.s, v.p)
      : { c: coach, i: intent, f: family, o: 'source_id:asc', s: v.s };
    if (v2 && (v.v !== 2 || !isCanonicalPlatform(v.p))) throw new Error();
    if (encode(JSON.stringify(canonical)) !== token) throw new Error();
    return v2 ? { s: v.s, p: v.p as string } : { s: v.s };
  } catch {
    throw new BadRequestException('malformed cursor');
  }
}

/**
 * Q1 legacy-boundary resolution. A legacy token names only a source id, so its
 * platform is looked up inside the caller's RepeatableRead transaction, after the
 * settled/ownership gate and before any page read, strictly within the requested
 * (coach, intent, family) scope — a roster token is never widened past `clients`.
 * Exactly one reconstructed ledger row with a canonical platform is the boundary.
 * Zero (forged, foreign, or absent) or two or more (a tie the legacy format cannot
 * name) is the existing 400 `malformed cursor`: the caller restarts pagination
 * from the first page. No page is read on that path.
 */
export async function resolveScoutCursor(
  tx: Prisma.TransactionClient,
  scope: { coach_id: string; intent_id: string; entity_type: string; status: string },
  after: ScoutCursorBoundary,
): Promise<ScoutCursorPosition> {
  if (!after) return null;
  if (after.p !== undefined) return { s: after.s, p: after.p };
  const rows = await tx.scoutReconstructionLedger.findMany({
    where: { ...scope, source_id: after.s },
    select: { source_platform: true },
    take: 2,
  });
  const p = rows.length === 1 ? rows[0].source_platform : undefined;
  if (!isCanonicalPlatform(p)) throw new BadRequestException('malformed cursor');
  return { s: after.s, p };
}

/** Lexicographic (source_id, source_platform) continuation; every page uses it. */
export function scoutCursorWhere(
  after: ScoutCursorPosition,
): Prisma.ScoutReconstructionLedgerWhereInput {
  if (!after) return {};
  return {
    OR: [{ source_id: { gt: after.s } }, { source_id: after.s, source_platform: { gt: after.p } }],
  };
}

/** Every page, including the first, is ordered by (source_id, source_platform). */
export function scoutCursorOrder(): Prisma.ScoutReconstructionLedgerOrderByWithRelationInput[] {
  return [{ source_id: 'asc' }, { source_platform: 'asc' }];
}
