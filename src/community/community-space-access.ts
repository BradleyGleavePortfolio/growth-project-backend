import type { PrismaService } from '../prisma.service';
import { FULL_NAME_VISIBILITY } from './member-display-name';

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

/** #C6-NAMES-EVERYWHERE, the roster's rule (#C6-MEMBER-NAMES) on every surface: the viewer sees a person's
 * full name only when both are in one space of the workspace open to all of the coach's clients, the
 * viewer by the rule and the person on its roster. A [space, person] of a space (its posts and comments)
 * asks that space; null asks the coach-wide surfaces (the Hall, wins, the leaderboard): any such space.
 * Everyone else keeps a first name. At most three round trips; one when the workspace has no such space. */
export async function fullNamesFor(
  prisma: PrismaService,
  viewerId: string,
  workspaceId: string | null,
  named: ReadonlyArray<readonly [string | null, string]>,
): Promise<(space: string | null, person: string) => boolean> {
  const spaces = workspaceId && named.length > 0
    ? await prisma.communityCohort.findMany({
        where: { workspace_id: workspaceId, visibility: FULL_NAME_VISIBILITY },
        select: { id: true },
      })
    : [];
  const mine = await spacesOpenTo(prisma, spaces.map((c) => [c.id, viewerId] as const));
  const shared = spaces.map((c) => c.id).filter((c) => mine.has(spaceAccessKey(c, viewerId)));
  const within = (space: string | null) => (space ? shared.filter((c) => c === space) : shared);
  const pairs = named.flatMap(([space, person]) => within(space).map((c) => [c, person] as const));
  const listed = await spacesOpenTo(prisma, pairs, true);
  return (space: string | null, person: string) =>
    within(space).some((c) => listed.has(spaceAccessKey(c, person)));
}

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
 * people with a row in the workspace can pass, so they are the only candidates. One round trip.
 * C6-BVIS: `listed` (a space's roster) also counts a pending invitation, as app.community_can_access. */
export async function readersNow(
  prisma: PrismaService,
  workspaceId: string,
  spaceId: string | null,
  listed = false,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH w AS (SELECT "id", "coach_id" FROM "community_workspaces" WHERE "id" = ${workspaceId}::uuid),
    p AS (SELECT w."coach_id" AS "id" FROM w
          UNION SELECT u."id" FROM "User" u JOIN w ON u."coach_id" = w."coach_id"
          UNION SELECT m."user_id" FROM "community_memberships" m JOIN w ON m."workspace_id" = w."id")
    SELECT p."id" FROM p, w
    WHERE CASE WHEN ${spaceId}::uuid IS NULL THEN p."id" = w."coach_id" OR app.community_workspace_open(w."id", p."id")
               ELSE app.community_can_access(${spaceId}::uuid, p."id", ${listed}::boolean) END`;
  return rows.map((r) => r.id);
}

/** C6-WINS-MOVE: where a row was written, for app.community_author_stays: its workspace and its space
 * (null: the Hall, a DM). */
export type RowPlace = readonly [workspaceId: string, spaceId: string | null];
/** The place of a post, message or voice note row. */
export const placeOf = (row: { workspace_id: string; cohort_id: string | null }): RowPlace => [row.workspace_id, row.cohort_id];

/** C6-WINS-MOVE (owner: history follows the client): a client who moves to another coach, or to none,
 * leaves the former coach's community, so what they wrote in its Hall and in its spaces that are not public
 * no longer reads there. The row policies ask the same function. The viewer keeps their own rows. One
 * round trip. */
export async function rowsByAuthorsWhoStay<T>(
  prisma: PrismaService,
  viewerId: string,
  rows: T[],
  author: (row: T) => string | null | undefined,
  place: (row: T) => RowPlace,
): Promise<T[]> {
  const ask = rows.map((r, i) => [i, place(r), author(r)] as const).filter(([, , a]) => a && a !== viewerId);
  if (ask.length === 0) return rows;
  const kept = await prisma.$queryRaw<{ n: number }[]>`
    SELECT (t."n" - 1)::int AS "n"
    FROM unnest(${ask.map(([, p]) => p[0])}::uuid[], ${ask.map(([, p]) => p[1] ?? '')}::text[],
                ${ask.map(([, , a]) => a as string)}::text[]) WITH ORDINALITY AS t("w", "s", "a", "n")
    WHERE app.community_author_stays(t."w", NULLIF(t."s", '')::uuid, t."a")`;
  const gone = new Set(ask.map(([i]) => i));
  for (const k of kept) gone.delete(ask[k.n][0]);
  return gone.size === 0 ? rows : rows.filter((_, i) => !gone.has(i));
}
