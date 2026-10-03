import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StripeApiError, StripeApiService } from '../billing/stripe-api.service';

/**
 * Account-deletion billing stop (B-608-5, operator policy 3).
 *
 * Collects every recurring Stripe subscription the deleted user pays for or
 * is paid through (coach platform subscription, client package
 * subscriptions in either direction, guest-checkout subscriptions) and
 * cancels it immediately at Stripe. Runs inside the finalization transaction
 * before the local mirrors are changed, so the Stripe ids are still readable;
 * a failure throws, rolls the transaction back and the cron retries. Each
 * cancel is idempotent (Idempotency-Key per subscription, and "already gone"
 * or "already canceled" counts as done).
 *
 * The local rows are then handled by the erasure manifest: entitlements are
 * deactivated, pending drips canceled, and the de-identified payment ledger
 * kept as a mirror of the Stripe record.
 */

export interface BillingStopResult {
  canceled: number;
  alreadyInactive: number;
}

function isAlreadyGone(err: unknown): boolean {
  if (!(err instanceof StripeApiError)) return false;
  if (err.httpStatus === 404 || err.stripeCode === 'resource_missing') return true;
  return err.httpStatus === 400 && /cancel/i.test(err.message);
}

@Injectable()
export class AccountDeletionBillingService {
  private readonly logger = new Logger(AccountDeletionBillingService.name);

  constructor(private readonly stripe: StripeApiService) {}

  async collectSubscriptionIds(tx: Prisma.TransactionClient, userId: string): Promise<string[]> {
    const ids = new Set<string>();
    const coachSubs = await tx.coachSubscription.findMany({
      where: {
        coach_id: userId,
        stripe_subscription_id: { not: null },
        status: { not: 'canceled' },
      },
      select: { stripe_subscription_id: true },
    });
    const purchases = await tx.clientPurchase.findMany({
      where: {
        OR: [{ client_user_id: userId }, { coach_user_id: userId }],
        stripe_subscription_id: { not: null },
        status: { not: 'canceled' },
      },
      select: { stripe_subscription_id: true },
    });
    const guest = await tx.guestCheckout.findMany({
      where: { created_user_id: userId, stripe_subscription_id: { not: null } },
      select: { stripe_subscription_id: true },
    });
    for (const row of [...coachSubs, ...purchases, ...guest]) {
      if (row.stripe_subscription_id) ids.add(row.stripe_subscription_id);
    }
    return [...ids];
  }

  async cancelAll(subscriptionIds: string[]): Promise<BillingStopResult> {
    let canceled = 0;
    let alreadyInactive = 0;
    for (const subscriptionId of subscriptionIds) {
      try {
        await this.stripe.cancelSubscription({
          subscriptionId,
          immediately: true,
          idempotencyKey: `account-deletion-cancel-${subscriptionId}`,
        });
        canceled += 1;
      } catch (err) {
        if (isAlreadyGone(err)) {
          alreadyInactive += 1;
          continue;
        }
        throw new Error(
          `account deletion: canceling a Stripe subscription failed: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `account deletion billing stop: canceled=${canceled} already_inactive=${alreadyInactive}`,
    );
    return { canceled, alreadyInactive };
  }
}
