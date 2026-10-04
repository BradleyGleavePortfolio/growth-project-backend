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
 * Sol B-679-7 — send authority. One transaction first holds the client's
 * User row FOR KEY SHARE; account finalization takes it FOR UPDATE
 * (lockUser), so finalization either ran first (the account reads deleted,
 * or the attempt closed: nothing is sent) or waits for this bind and then
 * cancels the bound subscription. The claim re-proves an open, unbound
 * attempt of this client after every earlier await (pin write, Stripe
 * lookup) and renews its in-flight stamp; the row stays locked through the
 * create and the bind (lock order user, then purchase, as in finalization).
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
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<Fenced> => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${owner} FOR KEY SHARE`;
      const user = await tx.user.findUnique({
        where: { id: owner },
        select: { deleted_at: true },
      });
      if (!user || user.deleted_at) return 'gone';
      const open = { id: row.id, status: 'pending', entitlement_active: false };
      const claim = await tx.clientPurchase.updateMany({
        where: { ...open, client_user_id: owner, stripe_subscription_id: null },
        data: { stripe_checkout_session_id: reservedMarker(row.idempotency_key) },
      });
      // Read back under the row lock: the attempt as claimed, or nothing is sent.
      const mine =
        claim.count === 1 ? await tx.clientPurchase.findUnique({ where: { id: row.id } }) : null;
      if (
        mine?.client_user_id !== owner ||
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
