/**
 * scripts/backfill-coach-subscriptions.ts
 *
 * One-time backfill that creates a CoachSubscription row for every existing
 * coach who does not yet have one. Status is set to "grandfathered" — the
 * SubscriptionGuard treats that the same as "active" so flipping
 * BILLING_ENFORCEMENT=enforce does not lock alumni or pre-billing coaches
 * out of the coach console.
 *
 * Idempotent: rows that already exist are left untouched.
 *
 * When to run: BEFORE the operator flips BILLING_ENFORCEMENT=enforce in
 * production. Once enforce is on, a coach without a row is still allowed
 * (the guard's "missing row" branch), but the explicit row makes the
 * grandfathered population auditable in the database itself.
 *
 * Usage:
 *   npm run backfill:coach-subscriptions
 *
 * Or directly:
 *   npx ts-node scripts/backfill-coach-subscriptions.ts
 *
 * Logs counts of scanned, backfilled, and already-had-subscription. Exits
 * non-zero on any error so a CI-driven runbook step fails loud.
 */

import { PrismaClient } from '@prisma/client';

// Far-future sentinel. Real Stripe-backed rows overwrite this on the
// first webhook delivery (customer.subscription.created), so we pick a
// date that is unambiguously a sentinel rather than a plausible billing
// cycle end.
const GRANDFATHERED_PERIOD_END = new Date('2099-01-01T00:00:00.000Z');
const GRANDFATHERED_STATUS = 'grandfathered';

export interface BackfillResult {
  scanned: number;
  backfilled: number;
  alreadyHadSubscription: number;
}

export async function backfillCoachSubscriptions(
  prisma: PrismaClient,
): Promise<BackfillResult> {
  const coaches = await prisma.user.findMany({
    where: { role: 'coach' },
    select: { id: true, email: true, coach_subscription: { select: { id: true } } },
  });

  let backfilled = 0;
  let alreadyHadSubscription = 0;

  for (const coach of coaches) {
    if (coach.coach_subscription) {
      alreadyHadSubscription++;
      continue;
    }

    // create() inside a try/catch on the unique constraint keeps the script
    // idempotent under racing invocations (two operators run it at once).
    try {
      await prisma.coachSubscription.create({
        data: {
          coach_id: coach.id,
          status: GRANDFATHERED_STATUS,
          current_period_end: GRANDFATHERED_PERIOD_END,
          cancel_at_period_end: false,
          billing_email: coach.email,
        },
      });
      backfilled++;
      console.log(`[backfill-coach-subscriptions] grandfathered coach=${coach.id} email=${coach.email}`);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        // Another invocation created the row between our findMany and
        // create. Treat as already-had.
        alreadyHadSubscription++;
        continue;
      }
      throw err;
    }
  }

  return {
    scanned: coaches.length,
    backfilled,
    alreadyHadSubscription,
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await backfillCoachSubscriptions(prisma);
    console.log(
      `[backfill-coach-subscriptions] done. scanned=${result.scanned} ` +
        `backfilled=${result.backfilled} already_had=${result.alreadyHadSubscription}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[backfill-coach-subscriptions] failed', err);
    process.exit(1);
  });
}
