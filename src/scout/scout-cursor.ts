import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isCanonicalPlatform } from './scout-platform';

// Fits three 256-character JSON-escaped identifiers, the family and platform.
// Shared by HTTP DTOs and direct service calls; allocation is bounded pre-decode.
export const SCOUT_CURSOR_MAX_LENGTH = 8192;
const ORDER = 'source_id:asc,source_platform:asc';
type Boundary = { s: string; p?: string } | null;

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

/** Legacy roster is a raw source id; legacy entities are scope-bound JSON. */
export function decodeScoutCursor(
  cursor: string | undefined,
  coach: string,
  intent: string,
  family: string,
): Boundary {
  if (cursor === undefined || cursor === '') return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > SCOUT_CURSOR_MAX_LENGTH) throw new Error();
    const v2 = cursor.startsWith('v2.');
    const token = v2 ? cursor.slice(3) : cursor;
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
      ? { v: 2, c: coach, i: intent, f: family, o: ORDER, s: v.s, p: v.p }
      : { c: coach, i: intent, f: family, o: 'source_id:asc', s: v.s };
    if (v2 && (v.v !== 2 || !isCanonicalPlatform(v.p))) throw new Error();
    if (encode(JSON.stringify(canonical)) !== token) throw new Error();
    return v2 ? { s: v.s, p: v.p as string } : { s: v.s };
  } catch {
    throw new BadRequestException('malformed cursor');
  }
}

/** Q0 deliberately keeps source-only legacy boundaries on E/R narrow keys. */
export function scoutCursorWhere(after: Boundary): Prisma.ScoutReconstructionLedgerWhereInput {
  if (!after) return {};
  if (after.p === undefined) return { source_id: { gt: after.s } };
  return {
    OR: [{ source_id: { gt: after.s } }, { source_id: after.s, source_platform: { gt: after.p } }],
  };
}

export function scoutCursorOrder(
  after: Boundary,
):
  | Prisma.ScoutReconstructionLedgerOrderByWithRelationInput
  | Prisma.ScoutReconstructionLedgerOrderByWithRelationInput[] {
  return after?.p === undefined
    ? { source_id: 'asc' }
    : [{ source_id: 'asc' }, { source_platform: 'asc' }];
}
