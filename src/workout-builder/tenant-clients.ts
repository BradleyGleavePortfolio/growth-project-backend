/**
 * Owner 4: a client who moves to another coach leaves the former coach's
 * programs at once. A client stays in a head coach's tenant while their coach
 * now is that head coach or a sub-coach on the head coach's team; history
 * still follows the client (their copies are never deleted).
 */
import { Prisma } from '@prisma/client';

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
 * Plans a head coach still has: standalone plans, library days, and the days
 * of a client's copy while every client it belongs to is still in the tenant
 * (`client_id`, or for older copies the clients assigned to its days). One
 * rule for the plan list (before paging) and every by-id read or write.
 */
export function planStaysInTenantWhere(headCoachId: string): Prisma.WorkoutPlanWhereInput {
  return {
    OR: [{ program_id: null }, { program: { is: programStaysInTenantWhere(headCoachId) } }],
  };
}

/** The same rule for a program, also as the source of a fork, clone or assignment. */
export function programStaysInTenantWhere(headCoachId: string): Prisma.WorkoutProgramWhereInput {
  const inTenant = inTenantWhere(headCoachId);
  // A client with no coach has left too (in SQL, NOT of a null comparison is not true).
  const left: Prisma.UserWhereInput = { OR: [{ coach_id: null }, { NOT: inTenant }] };
  const anyMoved = { assignments: { some: { client: left } } };
  return {
    OR: [
      { is_template: true },
      { client: { is: inTenant } },
      { client_id: null, plans: { none: anyMoved } },
    ],
  };
}
