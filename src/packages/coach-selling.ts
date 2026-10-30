import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { notInBlockWith } from '../messaging/block-pair';

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

/**
 * STORE-1TO1 (owner #183-S1): every package includes 1:1 coaching with the coach who sells it, and
 * nothing measures that coaching. A package carries it only while its coach is a named coach (or
 * owner) account that sells and is not locked for deletion. The package writers refuse any other
 * coach (assertCoachSelling), and every in-app buy-side read (list, detail, card checkout,
 * subscription intent, free claim) reads through coachingCoachFor(buyer), which also drops a coach
 * the buyer is in a block with (#168-4: a block closes their coaching chat). The web reads (pay page,
 * guest intent, checkout recovery) use COACHING_COACH, and the one entitlement writer
 * (InviteGrantService.grant: invite, free, prepaid, consent activation) uses coachingCoachFor(buyer).
 * The join writer (a coach code or link: InviteCodesService.planJoin) reads its coach through
 * joinCoachFor(buyer) BEFORE it picks or publishes the join's package, so a refused coach gets no
 * "Getting started" package, no attach and no grant (FR-1TO1R2).
 */
const NOT_LEAVING = { ...SELLING_COACH, deletion_scheduled_at: null } satisfies Prisma.UserWhereInput;
export const COACHING_COACH = {
  ...NOT_LEAVING,
  role: { in: ['coach', 'owner'] },
  name: { not: '' },
} satisfies Prisma.UserWhereInput;

export function coachingCoachFor(buyerId: string): Prisma.UserWhereInput {
  return { ...COACHING_COACH, ...notInBlockWith(buyerId) };
}

/** The join's coach (name for the package screen), or null when he cannot coach this buyer one to one. */
export function joinCoachFor(
  db: Pick<Prisma.TransactionClient, 'user'>,
  coachId: string,
  buyerId: string,
): Promise<{ name: string } | null> {
  return db.user.findUnique({ where: { id: coachId, AND: [coachingCoachFor(buyerId)] }, select: { name: true } });
}

/** Package create, publish and reactivate: refused for a coach who cannot coach one to one. */
export async function assertCoachSelling(
  db: Pick<Prisma.TransactionClient, 'user'>,
  coachId: string,
): Promise<void> {
  if ((await db.user.count({ where: { id: coachId, NOT: COACHING_COACH } })) === 0) return;
  const leaving = (await db.user.count({ where: { id: coachId, NOT: NOT_LEAVING } })) > 0;
  // The existing answers of JwtAuthGuard (an account leaving or gone) and CoachGuard (an account
  // that is not a coach); no new words.
  throw new ForbiddenException(
    leaving ? 'Account is scheduled for deletion; cancel the deletion to regain access' : 'Coach access required',
  );
}
