import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { CheckoutReceiptService } from './checkout-receipt.service';

// r48 #14 — branded PDF receipt scheduler.
//
// A276-P0-2 (r48-followup) — PDF receipts deprecated in favor of Stripe-
// hosted receipt_url (pay.stripe.com/receipts/…). The scheduler is
// gated OFF by default and only runs when LEGACY_PDF_RECEIPT_ENABLED=true.
// Code is kept in the tree so a future PR can revive branded PDFs once
// shared S3 infra (DATA_EXPORT_BUCKET pattern) lands. The legacy
// CHECKOUT_RECEIPT_DISABLED override is honoured for one more release
// as a soft-deprecation in case any environment relied on it.
//
// Historical context (still applicable should the path be revived):
//   * PDF rendering + S3 upload + email send is up to 1-2s per row;
//     running inside the webhook would stretch every Stripe round-
//     trip and risk the timeout retry chain.
//   * A failure (Resend outage, FS unwritable, OOM) here doesn't fail
//     the webhook — it just leaves receipt_url NULL and the next
//     tick retries idempotently.
//   * Batch size kept small (10) so a backlog from a Stripe outage
//     doesn't monopolise pdfkit's synchronous render loop.

const BATCH_SIZE = 10;

@Injectable()
export class CheckoutReceiptScheduler {
  private readonly logger = new Logger(CheckoutReceiptScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly receipt: CheckoutReceiptService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'checkout-receipt' })
  async run(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    // A276-P0-2 — default OFF. Stripe-hosted receipt_url is the
    // canonical buyer-facing receipt path now (welcome email emits
    // pay.stripe.com/receipts/…). Revive by setting
    // LEGACY_PDF_RECEIPT_ENABLED=true; do NOT do this in production
    // until shared S3 infra is wired — the current storeReceipt path
    // writes to ephemeral local FS which is lost on Fly redeploy and
    // produces unreachable local:// URLs.
    if (process.env.LEGACY_PDF_RECEIPT_ENABLED !== 'true') return;
    // Legacy override kept for one release as soft-deprecation. Always
    // a no-op now that the path is opted-in via LEGACY_PDF_RECEIPT_ENABLED.
    if (process.env.CHECKOUT_RECEIPT_DISABLED === 'true') return;
    try {
      const processed = await this.runOnce();
      if (processed > 0) {
        this.logger.log(`checkout-receipt: generated ${processed} receipts`);
      }
    } catch (err) {
      this.logger.error(
        `checkout-receipt tick failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  async runOnce(): Promise<number> {
    const rows = await this.prisma.guestCheckout.findMany({
      where: {
        // Only fire for rows that actually completed payment.
        status: { in: ['paid', 'converted'] },
        receipt_url: null,
      },
      orderBy: { created_at: 'asc' },
      take: BATCH_SIZE,
      select: { id: true },
    });
    let n = 0;
    for (const row of rows) {
      try {
        await this.receipt.generateAndSend(row.id);
        n += 1;
      } catch (err) {
        this.logger.error(
          `generateAndSend ${row.id} crashed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
    return n;
  }
}
