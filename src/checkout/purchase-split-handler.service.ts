import { Injectable, Logger } from '@nestjs/common';
import type { ClientPurchase } from '@prisma/client';
import { FeePolicyService } from '../connect/fees/fee-policy.service';
import { SplitLedgerService } from '../connect/fees/split-ledger.service';
import { TransferOrchestratorService } from '../connect/fees/transfer-orchestrator.service';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';
import { PrismaService } from '../prisma.service';

// PurchaseSplitHandlerService — bridges the lifecycle webhook handler
// and the Phase 4 split machinery. Responsibilities:
//
//   1. After a charge succeeds (checkout.session.completed or invoice.paid),
//      compute the split plan for the matching ClientPurchase, materialize
//      SplitLedgerEntry rows, and enqueue the head-coach follow-on transfer.
//   2. Drive the TransferOrchestratorService to actually post the
//      head-coach Transfer to Stripe (with source_transaction set to the
//      Charge id).
//   3. Mark the application_fee + destination ledger slices as `posted`
//      against the charge so the audit ledger reflects real money state.
//
// The handler is idempotent — every step uses composite-unique upserts
// or stable Stripe idempotency keys.

@Injectable()
export class PurchaseSplitHandlerService {
  private readonly logger = new Logger(PurchaseSplitHandlerService.name);

  constructor(
    private prisma: PrismaService,
    private stripe: StripeConnectApiService,
    private feePolicy: FeePolicyService,
    private ledger: SplitLedgerService,
    private transfers: TransferOrchestratorService,
  ) {}

  // Resolve the charge id from a PaymentIntent (one-time) or Invoice
  // (recurring). Returns null when not yet known (rare race; the webhook
  // pipeline will re-invoke us on the next event).
  async resolveChargeIdForPurchase(
    purchase: ClientPurchase,
  ): Promise<string | null> {
    if (!purchase.stripe_payment_intent_id) return null;
    try {
      const pi = await this.stripe.retrievePaymentIntent(
        purchase.stripe_payment_intent_id,
      );
      const charge =
        (typeof pi.latest_charge === 'string' ? pi.latest_charge : null) ??
        pi.charges?.data?.[0]?.id ??
        null;
      return charge ?? null;
    } catch (err) {
      this.logger.warn(
        `resolveChargeIdForPurchase failed pi=${purchase.stripe_payment_intent_id}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // Called from the webhook handler after a successful payment. Builds
  // the ledger and queues the head-coach transfer (if applicable).
  // Returns the resolved Stripe charge id for telemetry.
  async onChargeSucceeded(args: {
    purchase: ClientPurchase;
    invoice_amount_cents?: number; // for recurring renewals, may differ from snapshot
    invoice_charge_id?: string | null; // for recurring renewals, when known
  }): Promise<{ charge_id: string | null; ledger_entries: number; transfer_enqueued: boolean }> {
    const purchase = args.purchase;
    const seller = await this.prisma.connectAccount.findUnique({
      where: { coach_user_id: purchase.coach_user_id },
    });
    if (!seller) {
      this.logger.warn(
        `Cannot post split for purchase=${purchase.id}: seller has no ConnectAccount`,
      );
      return { charge_id: null, ledger_entries: 0, transfer_enqueued: false };
    }

    const amountCents = args.invoice_amount_cents ?? purchase.amount_cents;
    const plan = await this.feePolicy.planFor(purchase.coach_user_id, amountCents);

    // Resolve head-coach connect account (only if we'll actually transfer).
    let headCoachAccount: { stripe_account_id: string } | null = null;
    if (plan.head_coach_id && plan.head_coach_split_cents > 0) {
      headCoachAccount = await this.prisma.connectAccount.findUnique({
        where: { coach_user_id: plan.head_coach_id },
        select: { stripe_account_id: true },
      });
      if (!headCoachAccount) {
        this.logger.warn(
          `Cannot transfer head-coach split for purchase=${purchase.id}: head coach ${plan.head_coach_id} has no ConnectAccount`,
        );
      }
    }

    const entries = await this.ledger.ensurePendingEntries({
      purchase,
      plan,
      platform_account_id: null,
      seller_stripe_account_id: seller.stripe_account_id,
      head_coach_stripe_account_id:
        headCoachAccount?.stripe_account_id ?? null,
    });

    // Resolve the parent charge id so we can mark the application_fee +
    // destination slices as posted and (for sub-coach) enqueue a transfer
    // with source_transaction set.
    const chargeId =
      args.invoice_charge_id ?? (await this.resolveChargeIdForPurchase(purchase));

    // Mark application_fee + destination as posted now that we know the
    // charge id. These slices moved synchronously at Stripe-charge time
    // (application_fee via application_fee_amount, destination via
    // transfer_data) so they're real money on Stripe's books already.
    for (const entry of entries) {
      if (entry.kind === 'application_fee' || entry.kind === 'destination') {
        if (entry.status !== 'posted') {
          await this.ledger.markPosted({
            entry_id: entry.id,
            stripe_charge_id: chargeId,
          });
        }
      }
    }

    let transferEnqueued = false;
    if (
      plan.head_coach_id &&
      plan.head_coach_split_cents > 0 &&
      headCoachAccount
    ) {
      const headCoachEntry = entries.find((e) => e.kind === 'head_coach_split');
      if (headCoachEntry) {
        const transfer = await this.transfers.enqueueHeadCoachTransfer({
          purchase_id: purchase.id,
          ledger_entry_id: headCoachEntry.id,
          destination_stripe_account_id: headCoachAccount.stripe_account_id,
          destination_user_id: plan.head_coach_id,
          amount_cents: plan.head_coach_split_cents,
          currency: purchase.currency,
          source_stripe_charge_id: chargeId,
        });
        transferEnqueued = true;
        // Best-effort: attempt the transfer immediately. If we don't have
        // a charge id yet (sub may be still settling), this is a no-op
        // and the sweeper picks it up.
        if (transfer.source_stripe_charge_id) {
          try {
            await this.transfers.attempt(transfer.id);
          } catch (err) {
            this.logger.warn(
              `transfer.attempt failed inline purchase=${purchase.id}: ${(err as Error).message}`,
            );
          }
        }
      }
    }

    return {
      charge_id: chargeId,
      ledger_entries: entries.length,
      transfer_enqueued: transferEnqueued,
    };
  }

  // Run all due-but-pending transfers (sweeper entry point).
  async runTransferSweeper(now: Date = new Date()): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
  }> {
    const due = await this.transfers.findDueTransfers(now);
    let succeeded = 0;
    let failed = 0;
    for (const row of due) {
      const updated = await this.transfers.attempt(row.id);
      if (updated.status === 'succeeded') succeeded += 1;
      else if (updated.status === 'failed') failed += 1;
    }
    return { attempted: due.length, succeeded, failed };
  }
}
