import type { PrismaService } from '../prisma.service';

/** C6-BVIS: keys (spaceAccessKey) of the [space, person] pairs app.community_can_access passes, one
 * round trip. `listed` also counts a row that is not removed (rosters: a pending invitation). */
export async function spacesOpenTo(
  prisma: PrismaService,
  pairs: ReadonlyArray<readonly [string, string]>,
  listed = false,
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const rows = await prisma.$queryRaw<{ k: string }[]>`
    SELECT t."c"::text || ':' || t."u" AS "k"
    FROM unnest(${pairs.map((p) => p[0])}::uuid[], ${pairs.map((p) => p[1])}::text[]) AS t("c", "u")
    WHERE app.community_can_access(t."c", t."u", ${listed}::boolean)`;
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
  listed = false,
): Promise<T[]> {
  const open = await spacesOpenTo(prisma, rows.map(pair), listed);
  return rows.filter((r) => open.has(spaceAccessKey(...pair(r))));
}

/** C10RT: everyone the rule lets read a row of the workspace now: of the space, or with no space of
 * the Hall (the coach, or a space that is not public opens). Only the coach, the coach's clients and
 * people with a row in the workspace can pass, so they are the only candidates. One round trip. */
export async function readersNow(prisma: PrismaService, workspaceId: string, spaceId: string | null): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH w AS (SELECT "id", "coach_id" FROM "community_workspaces" WHERE "id" = ${workspaceId}::uuid),
    p AS (SELECT w."coach_id" AS "id" FROM w
          UNION SELECT u."id" FROM "User" u JOIN w ON u."coach_id" = w."coach_id"
          UNION SELECT m."user_id" FROM "community_memberships" m JOIN w ON m."workspace_id" = w."id")
    SELECT p."id" FROM p, w
    WHERE CASE WHEN ${spaceId}::uuid IS NULL THEN p."id" = w."coach_id" OR app.community_workspace_open(w."id", p."id")
               ELSE app.community_can_access(${spaceId}::uuid, p."id") END`;
  return rows.map((r) => r.id);
}
