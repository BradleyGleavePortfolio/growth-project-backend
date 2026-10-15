import type { PrismaService } from '../prisma.service';

/**
 * C6-BVIS: a person reads or writes a community space only while
 * app.community_can_access(space, person) is true (migration 20270502002400).
 * Row security calls the same SQL function; the server asks it here, never a
 * copy of the rule. Takes [spaceId, personId] pairs and returns the keys
 * (spaceAccessKey) of the pairs that pass. One round trip; none for no pairs.
 */
export async function spacesOpenTo(
  prisma: PrismaService,
  pairs: ReadonlyArray<readonly [string, string]>,
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const rows = await prisma.$queryRaw<{ k: string }[]>`
    SELECT t."c"::text || ':' || t."u" AS "k"
    FROM unnest(${pairs.map((p) => p[0])}::uuid[], ${pairs.map((p) => p[1])}::text[]) AS t("c", "u")
    WHERE app.community_can_access(t."c", t."u")`;
  return new Set(rows.map((r) => r.k));
}

/** True when the person may read and write in the space. */
export async function canEnterSpace(prisma: PrismaService, spaceId: string, personId: string): Promise<boolean> {
  return (await spacesOpenTo(prisma, [[spaceId, personId]])).size > 0;
}

export const spaceAccessKey = (spaceId: string, personId: string): string => `${spaceId}:${personId}`;

/** The rows whose [space, person] passes the rule, in their order. */
export async function rowsWithSpaceAccess<T>(
  prisma: PrismaService,
  rows: T[],
  pair: (row: T) => readonly [string, string],
): Promise<T[]> {
  const open = await spacesOpenTo(prisma, rows.map(pair));
  return rows.filter((r) => open.has(spaceAccessKey(...pair(r))));
}
