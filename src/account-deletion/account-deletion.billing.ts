import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StripeApiError, StripeApiService } from '../billing/stripe-api.service';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';

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

/** Sol B-679-7 — a native checkout attempt touched this recently may still be finishing on Stripe. */
export const UNBOUND_ATTEMPT_SETTLE_MS = 120_000;

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

  constructor(
    private readonly stripe: StripeApiService,
    // Sol B-679-7 — the client that creates native checkout subscriptions.
    @Optional() private readonly checkoutStripe?: StripeConnectApiService,
  ) {}

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
      where: {
        OR: [{ created_user_id: userId }, { package: { coach_id: userId } }],
        stripe_subscription_id: { not: null },
      },
      select: { stripe_subscription_id: true },
    });
    for (const row of [...coachSubs, ...purchases, ...guest]) {
      if (row.stripe_subscription_id) ids.add(row.stripe_subscription_id);
    }
    return [...ids];
  }

  /**
   * Sol B-679-7 — subscriptions of native checkout attempts that Stripe may
   * have created but that are not bound to their row (a create that timed
   * out, or a request that died before its bind). The send itself is fenced:
   * the checkout holds both parties FOR KEY SHARE from its claim through its
   * bind and finalization holds FOR UPDATE, so no send runs now. Covers
   * attempts where the user pays (client) and where the user is paid (coach). Stripe is
   * asked for each attempt's own subscription (metadata.tgp_purchase_id,
   * created after the attempt). Fails closed: an attempt touched in the last
   * two minutes (Stripe may still be finishing its create), an unreadable or
   * an incomplete list throws, and the deletion retries on the next run.
   */
  async collectUnboundAttemptSubscriptionIds(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<string[]> {
    // B-678-3 — the deleted user as payer (client) or payee (coach); the key
    // carries the row's own client id.
    const rows = await tx.clientPurchase.findMany({
      where: {
        OR: [{ client_user_id: userId }, { coach_user_id: userId }],
        billing_type: 'recurring',
        status: 'pending',
        stripe_subscription_id: null,
        stripe_customer_id: { not: null },
        idempotency_key: { startsWith: 'sub-' },
        stripe_checkout_session_id: { startsWith: 'sub-' },
      },
      select: {
        id: true,
        client_user_id: true,
        idempotency_key: true,
        stripe_customer_id: true,
        created_at: true,
        updated_at: true,
      },
    });
    const ids: string[] = [];
    for (const row of rows) {
      const key = row.idempotency_key;
      if (key && !key.startsWith(`sub-${row.client_user_id}-`)) continue;
      if (
        !this.checkoutStripe ||
        Date.now() - row.updated_at.getTime() < UNBOUND_ATTEMPT_SETTLE_MS
      ) {
        throw new Error(
          `account deletion: subscription checkout purchase=${row.id} is still finishing; retry after two minutes`,
        );
      }
      const list = await this.checkoutStripe.listSubscriptionsForCustomer(
        row.stripe_customer_id ?? '',
        {
          createdGte: Math.floor(row.created_at.getTime() / 1000) - 300,
        },
      );
      if (list.has_more) {
        throw new Error(`account deletion: subscription list incomplete purchase=${row.id}`);
      }
      for (const sub of list.data ?? []) {
        const ended = sub.status === 'canceled' || sub.status === 'incomplete_expired';
        if (sub.metadata?.tgp_purchase_id === row.id && !ended) ids.push(sub.id);
      }
    }
    return ids;
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
