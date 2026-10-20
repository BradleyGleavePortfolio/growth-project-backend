import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * COACH-GONE-DELIVERY: the one rule for "this coach sells". From his confirmed deletion request
 * until he cancels it (or for good, once deleted) nothing new of his is sold: the request takes his
 * packages off sale (AccountDeletionService.setSelling), the package writers refuse to put one back
 * (assertCoachSelling), and every new purchase reads its package through SELLING_COACH.
 * What his clients already bought is untouched.
 */
export const SELLING_COACH = {
  deletion_confirmed_at: null,
  deleted_at: null,
} satisfies Prisma.UserWhereInput;

/** Package create, publish and reactivate: refused for a coach who is leaving or gone. */
export async function assertCoachSelling(
  db: Pick<Prisma.TransactionClient, 'user'>,
  coachId: string,
): Promise<void> {
  if ((await db.user.count({ where: { id: coachId, NOT: SELLING_COACH } })) > 0) {
    // JwtAuthGuard's existing answer to an account scheduled for deletion (no new words).
    throw new ForbiddenException('Account is scheduled for deletion; cancel the deletion to regain access');
  }
}
