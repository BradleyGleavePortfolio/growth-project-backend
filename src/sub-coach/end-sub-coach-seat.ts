import type { Prisma } from '@prisma/client';

/**
 * SUBREVOKE (owner decision SUB-REINVITE, option 1): removing or revoking a
 * sub-coach ends their seat AND every client assignment (SubCoachAssignment
 * delegation) the head coach gave them, inside the caller's transaction.
 * A re-invite reopens the seat only, so a re-invited sub-coach starts with no
 * clients and the head coach assigns them again.
 *
 * The seat row is updated first: that row lock orders this transaction
 * against SubCoachReassignService, which reads the seat FOR SHARE before it
 * creates a delegation. Either the creation waits for the removal and then
 * sees the archived seat, or the removal waits and its delegation close below
 * (a new statement, so a new snapshot) also closes the new row.
 *
 * Only this head coach's delegations to this sub-coach close; their seat and
 * delegations under any other head coach are untouched. Returns how many
 * delegations were closed.
 */
export async function endSubCoachSeat(
  tx: Prisma.TransactionClient,
  seatId: string,
  headCoachId: string,
  subCoachId: string,
): Promise<number> {
  const now = new Date();
  await tx.teamSubCoachAssignment.update({
    where: { id: seatId },
    data: { archived_at: now },
  });
  const closed = await tx.subCoachAssignment.updateMany({
    where: { head_coach_id: headCoachId, sub_coach_id: subCoachId, unassigned_at: null },
    data: { unassigned_at: now },
  });
  return closed.count;
}
