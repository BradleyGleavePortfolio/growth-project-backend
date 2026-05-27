import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';

// r48 #14 — branded PDF receipts.
//
// A276-P0-2 (r48-followup) — DEPRECATED. The buyer-facing receipt path
// is now Stripe's hosted, signed, branded receipt URL
// (pay.stripe.com/receipts/…) emitted by GuestCheckoutService on
// payment_intent.succeeded. The Cron-driven sweeper that called into
// this service is gated OFF by default (CheckoutReceiptScheduler
// requires LEGACY_PDF_RECEIPT_ENABLED=true). Kept in the tree so a
// future PR can revive branded PDFs once shared S3 infra lands. Do
// NOT re-enable in production without wiring storeReceipt() to S3
// first — the local FS path produces unreachable local:// URLs.
//
// Original design notes (preserved for the revive-this-later PR):
//
// On payment_intent.succeeded we kick a deferred receipt generation
// (queued by the existing Cron-driven sweeper, not BullMQ — same
// rationale as #2).  The receipt:
//   * Reads the GuestCheckout row + its package_snapshot (captured at
//     PI create — see #6) so a coach editing the package post-payment
//     does not change what the receipt shows.
//   * Renders a branded one-page PDF via pdfkit (already installed,
//     same require()-style import the admin reports use).
//   * Stores the PDF on the local filesystem in dev (RECEIPT_FS_DIR
//     env, defaults to /tmp/checkout-receipts).  S3 wiring follows
//     the data-export pattern (DATA_EXPORT_BUCKET); for now the URL
//     is local:// in dev and will be s3:// when an operator sets a
//     bucket. The schema column receipt_url accepts either.
//   * Emails the PDF link to the buyer via the existing EmailService
//     (PAYMENT_RECEIPT template) within 60s of payment.
//
// PII handling: the PDF contains buyer name + email + amount paid +
// coach name + package name.  Local FS dev storage is fine; prod
// will use signed-URL S3 with a 7-day expiry (same pattern as
// data-export).

import { existsSync } from 'fs';

const RECEIPT_FS_DIR =
  process.env.RECEIPT_FS_DIR ?? '/tmp/checkout-receipts';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit') as new (opts: {
  size: string;
  margin: number;
  info?: Record<string, string>;
}) => PDFKitDoc;

// Minimal type surface for the PDFKit instance we actually call.
interface PDFKitDoc {
  pipe(dest: NodeJS.WritableStream): this;
  end(): void;
  on(event: string, cb: (...args: unknown[]) => void): this;
  fillColor(color: string): this;
  fontSize(size: number): this;
  font(name: string): this;
  text(text: string, options?: Record<string, unknown>): this;
  moveDown(lines?: number): this;
  moveTo(x: number, y: number): this;
  lineTo(x: number, y: number): this;
  stroke(): this;
}

@Injectable()
export class CheckoutReceiptService {
  private readonly logger = new Logger(CheckoutReceiptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /**
   * Generate + email the receipt for a GuestCheckout that just
   * transitioned to paid/converted.  Idempotent on receipt_url:
   * an already-stamped row is a no-op so a retry/replay never
   * generates twice.
   */
  async generateAndSend(checkoutId: string): Promise<void> {
    const row = await this.prisma.guestCheckout.findUnique({
      where: { id: checkoutId },
      include: {
        package: { include: { coach: true } },
      },
    });
    if (!row) return;
    if (row.receipt_url) {
      this.logger.debug(
        `receipt: skip ${checkoutId} — already has receipt_url`,
      );
      return;
    }
    if (row.status !== 'paid' && row.status !== 'converted') {
      this.logger.debug(
        `receipt: skip ${checkoutId} — status=${row.status} not eligible`,
      );
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await this.renderPdf(row);
    } catch (err) {
      this.logger.error(
        `receipt render failed for ${checkoutId}: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      return;
    }

    let storedUrl: string;
    try {
      storedUrl = await this.storeReceipt(row.id, buffer);
    } catch (err) {
      this.logger.error(
        `receipt store failed for ${checkoutId}: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      return;
    }

    // Stamp the row.  Idempotent via WHERE receipt_url IS NULL.
    try {
      await this.prisma.guestCheckout.updateMany({
        where: { id: row.id, receipt_url: null },
        data: { receipt_url: storedUrl },
      });
    } catch (err) {
      this.logger.error(
        `receipt url write failed for ${checkoutId}: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }

    // Email best-effort.  EmailService idempotency key prevents
    // duplicate sends on a redelivered event.
    if (this.email) {
      try {
        const snap = (row.package_snapshot as Record<string, unknown> | null) ?? {};
        await this.email.send({
          to: row.guest_email,
          template: EmailTemplateKey.PAYMENT_RECEIPT,
          idempotencyKey: `checkout-receipt:${row.id}`,
          data: {
            recipient_name: row.guest_name,
            package_name:
              (snap.name as string | undefined) ??
              row.package.name ??
              'Coaching package',
            amount_display: this.formatAmount(snap, row),
            paid_at: new Date().toISOString().slice(0, 10),
            coach_name: row.package.coach.name?.trim() || 'Your coach',
            receipt_url: storedUrl,
          },
        });
      } catch (err) {
        this.logger.error(
          `receipt email failed for ${checkoutId}: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
      }
    }
  }

  private renderPdf(
    row: {
      id: string;
      guest_email: string;
      guest_name: string;
      created_at: Date;
      package_snapshot: unknown;
      package: { name: string; amount_cents: number; currency: string; coach: { name: string | null } };
    },
  ): Promise<Buffer> {
    const snap = (row.package_snapshot as Record<string, unknown> | null) ?? {};
    const packageName =
      (snap.name as string | undefined) ?? row.package.name ?? 'Coaching package';
    const priceCents =
      typeof snap.price_cents === 'number'
        ? snap.price_cents
        : row.package.amount_cents;
    const currency =
      ((snap.currency as string | undefined) ?? row.package.currency ?? 'USD').toUpperCase();
    const coachName = row.package.coach.name?.trim() || 'Your coach';
    const receiptNumber = `R-${row.id.slice(0, 8).toUpperCase()}`;

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({
        size: 'LETTER',
        margin: 56,
        info: {
          Title: `Receipt ${receiptNumber}`,
          Author: 'Growth Project',
          Subject: `Payment for ${packageName}`,
        },
      });
      doc.on('data', (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      });
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err: unknown) => reject(err));

      // Branding header.
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#1A1A1A');
      doc.text('Growth Project');
      doc.moveDown(0.25);
      doc.font('Helvetica').fontSize(10).fillColor('#666666');
      doc.text('Receipt for your coaching purchase');
      doc.moveDown(2);

      // Receipt metadata table.
      doc.font('Helvetica').fontSize(11).fillColor('#1A1A1A');
      doc.text(`Receipt #: ${receiptNumber}`);
      doc.text(`Date: ${row.created_at.toISOString().slice(0, 10)}`);
      doc.text(`Customer: ${row.guest_name}`);
      doc.text(`Email: ${row.guest_email}`);
      doc.moveDown(1);

      // Item table.
      doc.font('Helvetica-Bold').fontSize(12);
      doc.text('Item');
      doc.moveDown(0.25);
      doc.font('Helvetica').fontSize(11);
      doc.text(`${packageName} — ${coachName}`);
      doc.moveDown(0.5);

      // Total.
      doc.font('Helvetica-Bold').fontSize(13);
      doc.text(`Total: ${(priceCents / 100).toFixed(2)} ${currency}`);
      doc.moveDown(2);

      // Footer.
      doc.font('Helvetica').fontSize(9).fillColor('#999999');
      doc.text(
        'Questions about this receipt? Reply to your welcome email or visit https://app.trygrowthproject.com/support.',
      );
      doc.text(`Issued ${new Date().toISOString()}`);

      doc.end();
    });
  }

  private async storeReceipt(
    checkoutId: string,
    buffer: Buffer,
  ): Promise<string> {
    // Local filesystem in dev — S3 follows the data-export pattern
    // and lands in a follow-up PR.  receipt_url stores 'local://...'
    // so a future migration to S3 can be detected + back-filled.
    const { mkdir, writeFile } = await import('fs/promises');
    if (!existsSync(RECEIPT_FS_DIR)) {
      await mkdir(RECEIPT_FS_DIR, { recursive: true });
    }
    const filename = `${checkoutId}.pdf`;
    const { join } = await import('path');
    const filePath = join(RECEIPT_FS_DIR, filename);
    await writeFile(filePath, buffer);
    this.logger.log(
      `receipt stored at ${filePath} (${buffer.length} bytes) — configure S3 for production`,
    );
    return `local://${filePath}`;
  }

  private formatAmount(snap: Record<string, unknown>, row: { package: { amount_cents: number; currency: string } }): string {
    const cents = typeof snap.price_cents === 'number' ? snap.price_cents : row.package.amount_cents;
    const currency = ((snap.currency as string | undefined) ?? row.package.currency ?? 'USD').toUpperCase();
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
