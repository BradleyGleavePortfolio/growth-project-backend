// B-RECUR6A-118 (split R1 of #654; inert until R2 wires it) — the send
// fence, the unresolved-bind hold and the own trial sheet of the native
// subscription checkout (R2 subscription-checkout.service.ts), as plain
// functions (operator 116 size ruling). Nothing in R1 calls this file.
import type { Logger } from '@nestjs/common';
import type { ClientPurchase, Prisma } from '@prisma/client';
import type {
  StripeConnectApiService,
  StripeSubscriptionCheckoutObject,
} from '../connect/stripe-connect-api.service';
import type { PrismaService } from '../prisma.service';
import { errorLabel } from './error-label';
import { expandedId, ownTrialCardOn, reservedMarker } from './subscription-plan';
import { ownTrialSetupSecret, readTrialSetup, type TrialSetupState } from './trial-card';

/** Sol B-679-7 — the send transaction outlives one Stripe create (10 s timeout per request). */
export const SEND_FENCE_TX_TIMEOUT_MS = 30_000;

/** Sol B-679-7 — sent (bound unless the row closed), account gone, or attempt closed. */
export type Fenced =
  { sub: StripeSubscriptionCheckoutObject; bound: ClientPurchase | null } | 'gone' | 'closed';

/** A Stripe create error raised inside the send transaction (it rolls back the claim). */
export class CreateFailed extends Error {
  constructor(readonly cause: unknown) {
    super('subscription create failed');
  }
}

/**
 * Sol B-679-7 / B-678-4 — send authority. One transaction first holds the
 * User rows of BOTH parties (client and coach, in id order) FOR KEY SHARE;
 * account finalization of either takes its own row FOR UPDATE SKIP LOCKED
 * (lockUser), so finalization either ran first (that account reads deleted,
 * or the attempt closed: nothing is sent) or skips while this send runs and
 * retries after the bind, then cancels the bound subscription. The claim
 * re-proves an open, unbound attempt of this client and this coach after
 * every earlier await (pin write, Stripe lookup) and renews its in-flight
 * stamp; the rows stay locked through the create and the bind (lock order
 * users, then purchase, as in finalization).
 * A create Stripe finished without a bind (lost reply, crash) is found by
 * the pinned retry and by the deletion billing stop
 * (AccountDeletionBillingService.collectUnboundAttemptSubscriptionIds).
 * `existing`: the attempt's subscription found on Stripe (no create).
 */
export function sendFenced(
  prisma: PrismaService,
  row: ClientPurchase,
  existing: StripeSubscriptionCheckoutObject | null,
  create: () => Promise<StripeSubscriptionCheckoutObject>,
): Promise<Fenced> {
  const owner = row.client_user_id;
  const coach = row.coach_user_id;
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<Fenced> => {
      // B-678-4 — both parties, deterministic order (no lock cycle between sends).
      for (const id of [...new Set([owner, coach])].sort()) {
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${id} FOR KEY SHARE`;
      }
      const alive = async (id: string) => {
        const u = await tx.user.findUnique({ where: { id }, select: { deleted_at: true } });
        return !!u && !u.deleted_at;
      };
      if (!(await alive(owner))) return 'gone';
      if (!(await alive(coach))) return 'closed';
      const open = {
        id: row.id,
        client_user_id: owner,
        coach_user_id: coach,
        status: 'pending',
        entitlement_active: false,
      };
      const claim = await tx.clientPurchase.updateMany({
        where: { ...open, stripe_subscription_id: null },
        data: { stripe_checkout_session_id: reservedMarker(row.idempotency_key) },
      });
      // Read back under the row lock: the attempt as claimed, or nothing is sent.
      const mine =
        claim.count === 1 ? await tx.clientPurchase.findUnique({ where: { id: row.id } }) : null;
      if (
        mine?.client_user_id !== owner ||
        mine.coach_user_id !== coach ||
        mine.status !== 'pending' ||
        mine.stripe_subscription_id
      ) {
        return 'closed';
      }
      let sub = existing;
      if (!sub) {
        try {
          sub = await create();
        } catch (err) {
          throw new CreateFailed(err);
        }
      }
      // Bind before anything else can fail. Only a row still pending binds.
      const invoice =
        sub.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
      const res = await tx.clientPurchase.updateMany({
        where: open,
        data: {
          stripe_checkout_session_id: sub.id,
          stripe_subscription_id: sub.id,
          stripe_payment_intent_id: expandedId(invoice?.payment_intent ?? null),
          current_period_end:
            typeof sub.current_period_end === 'number'
              ? new Date(sub.current_period_end * 1000)
              : null,
        },
      });
      const bound =
        res.count === 1 ? await tx.clientPurchase.findUnique({ where: { id: row.id } }) : null;
      return { sub, bound };
    },
    { timeout: SEND_FENCE_TX_TIMEOUT_MS, maxWait: 10_000 },
  );
}

/**
 * Sol B-679-8 — a subscription that may still charge (paid, in flight, or
 * its cleanup unconfirmed) stays this attempt's: bound to the row, and a
 * row the checkout closed meanwhile is open again, so admission reuses,
 * reports or ends this subscription and never reserves a second one. A row
 * closed by account deletion (another owner, or canceled) is never reopened;
 * it only records the id for reconciliation.
 */
export async function holdUnresolved(
  prisma: PrismaService,
  logger: Logger,
  row: ClientPurchase,
  sub: StripeSubscriptionCheckoutObject,
): Promise<void> {
  const bind = { stripe_subscription_id: sub.id, stripe_checkout_session_id: sub.id };
  try {
    const reopened = await prisma.clientPurchase.updateMany({
      where: {
        id: row.id,
        client_user_id: row.client_user_id,
        status: { in: ['pending', 'expired'] },
        entitlement_active: false,
        stripe_subscription_id: null,
      },
      data: { ...bind, status: 'pending' },
    });
    if (reopened.count === 0) {
      await prisma.clientPurchase.updateMany({
        where: { id: row.id, stripe_subscription_id: null },
        data: { stripe_subscription_id: sub.id },
      });
    }
  } catch (err) {
    logger.error(`could not record subscription purchase=${row.id} error=${errorLabel(err)}`);
  }
}

/**
 * Sol/Opus B-679-10 — a trial Stripe made no pending SetupIntent for (it
 * set the trial up off-session, e.g. on the customer's default card) gets
 * the attempt's own SetupIntent as its setup sheet (one per attempt). None
 * once the own card is on, or while Stripe's SetupIntent exists (C-679-1:
 * a canceled one is never replaced). `stored`: the stored secret's
 * SetupIntent when the caller already read it. Throws on a Stripe error.
 */
export async function ownTrialSheet(
  stripe: Pick<StripeConnectApiService, 'createSetupIntent' | 'retrieveSetupIntent'>,
  row: ClientPurchase,
  sub: StripeSubscriptionCheckoutObject,
  stored: TrialSetupState | null,
): Promise<{ mode: 'setup'; client_secret: string } | null> {
  if (sub.status !== 'trialing' || sub.pending_setup_intent || ownTrialCardOn(sub)) return null;
  const storedSecret = row.stripe_client_secret;
  const secret = await ownTrialSetupSecret(stripe, {
    purchaseId: row.id,
    subscriptionId: sub.id,
    customerId: row.stripe_customer_id ?? '',
    onBehalfOf: row.stripe_destination_account ?? '',
    storedSecret,
    stored: stored ?? (storedSecret ? await readTrialSetup(stripe, storedSecret, sub) : null),
  });
  return secret ? { mode: 'setup', client_secret: secret } : null;
}

/**
 * B-654-5 — the subscription Stripe made for this attempt, found by
 * metadata.tgp_purchase_id among the customer's subscriptions (moved from R2,
 * size move). null = Stripe has none; 'unreadable' = Stripe could not be
 * read now.
 */
export async function findAttemptSubscription(
  stripe: Pick<
    StripeConnectApiService,
    'listSubscriptionsForCustomer' | 'retrieveSubscriptionForCheckout'
  >,
  logger: Logger,
  row: ClientPurchase,
): Promise<StripeSubscriptionCheckoutObject | null | 'unreadable'> {
  if (!row.stripe_customer_id) return null;
  try {
    let list = await stripe.listSubscriptionsForCustomer(row.stripe_customer_id);
    const own = (l: typeof list) =>
      (l.data ?? []).find((s) => s.metadata?.tgp_purchase_id === row.id);
    let hit = own(list);
    if (!hit && list.has_more) {
      // C-679-2 — a full page without it: read only what was created since
      // this attempt began (5 min clock margin); its own subscription is newer.
      const createdGte = Math.floor(row.created_at.getTime() / 1000) - 300;
      list = await stripe.listSubscriptionsForCustomer(row.stripe_customer_id, { createdGte });
      hit = own(list);
    }
    if (!hit) return list.has_more ? 'unreadable' : null;
    return await stripe.retrieveSubscriptionForCheckout(hit.id);
  } catch (err) {
    logger.warn(`attempt subscription lookup failed purchase=${row.id} error=${errorLabel(err)}`);
    return 'unreadable';
  }
}
