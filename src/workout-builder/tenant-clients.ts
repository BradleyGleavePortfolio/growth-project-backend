/**
 * Owner 4: a client who moves to another coach leaves the former coach's
 * programs at once. A client stays in a head coach's tenant while their coach
 * now is that head coach or a sub-coach on the head coach's team; history
 * still follows the client (their copies are never deleted).
 */
import { Prisma } from '@prisma/client';

type Db = Pick<Prisma.TransactionClient, 'user' | 'clientWorkoutAssignment'>;

/** Clients whose coach now is the head coach or a sub-coach on their team. */
export function inTenantWhere(headCoachId: string): Prisma.UserWhereInput {
  return {
    OR: [
      { coach_id: headCoachId },
      {
        coach: {
          sub_coach_assignments_as_sub: { some: { head_coach_id: headCoachId, archived_at: null } },
        },
      },
    ],
  };
}

/** The same rule over `"User" u` in raw SQL. */
export function inTenantSql(headCoachId: string): Prisma.Sql {
  return Prisma.sql`AND (u."coach_id" = ${headCoachId} OR EXISTS (
    SELECT 1 FROM "TeamSubCoachAssignment" t
    WHERE t."head_coach_id" = ${headCoachId} AND t."sub_coach_id" = u."coach_id"
      AND t."archived_at" IS NULL))`;
}

/**
 * True while every client a program copy belongs to is still in the tenant:
 * `client_id`, or for older copies the clients assigned to its days.
 */
export async function copyStaysInTenant(
  db: Db,
  copy: { id: string; client_id: string | null },
  headCoachId: string,
): Promise<boolean> {
  const clientIds = copy.client_id
    ? [copy.client_id]
    : (
        await db.clientWorkoutAssignment.findMany({
          where: { workout_plan: { program_id: copy.id } },
          select: { client_id: true },
          distinct: ['client_id'],
        })
      ).map((a) => a.client_id);
  if (clientIds.length === 0) return true;
  const staying = await db.user.count({
    where: { id: { in: clientIds }, ...inTenantWhere(headCoachId) },
  });
  return staying === clientIds.length;
}
