import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { CheckoutReceiptService } from './checkout-receipt.service';

// r48 #14 — branded PDF receipt scheduler.
//
// Runs every minute; finds paid/converted GuestCheckout rows whose
// receipt_url is still NULL and generates + emails the receipt.
// 60-second target is satisfied by the EVERY_MINUTE cron (max
// in-flight = 60s after payment_intent.succeeded lands).
//
// Decoupled from the inline webhook on purpose:
//   * PDF rendering + S3 upload + email send is up to 1-2s per row;
//     running inside the webhook would stretch every Stripe round-
//     trip and risk the timeout retry chain.
//   * A failure (Resend outage, FS unwritable, OOM) here doesn't fail
//     the webhook — it just leaves receipt_url NULL and the next
//     tick retries idempotently.
//
// Batch size kept small (10) so a backlog from a Stripe outage
// doesn't monopolise pdfkit's synchronous render loop.

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
