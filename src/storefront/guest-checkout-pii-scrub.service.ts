import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma.service';

// Audit #3 P2-3 — daily PII retention scrub job.
//
// GuestCheckout stores guest_email and guest_name raw on a public-
// checkout table. Without retention bounds this is exactly the kind of
// identity data a hostile-lawyer / GDPR review will hammer us on. The
// job walks rows whose data_retention_at has elapsed, that have not
// already been scrubbed, and that never converted to a User
// (created_user_id IS NULL) — converted rows have a User record that
// owns the same identity data with its own retention rules.
//
// For each row we:
//   * Replace guest_email with sha256(lower(email) || salt). Hashed
//     emails still support reconciliation queries (the salt is stable
//     per deploy and surfaced via env) without exposing the plaintext.
//   * Replace guest_name with 'REDACTED' — a fixed sentinel because
//     names have no useful searchable form once hashed.
//   * Stamp scrubbed_at so the next run skips this row.

const SCRUB_BATCH_SIZE = 200;
const REDACTED_NAME = 'REDACTED';

@Injectable()
export class GuestCheckoutPiiScrubService {
  private readonly logger = new Logger(GuestCheckoutPiiScrubService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // Daily at 03:17 UTC — well away from peak traffic windows and not on
  // an exact-quarter-hour boundary so we don't collide with other crons.
  @Cron('17 3 * * *', { name: 'guest-checkout-pii-scrub', timeZone: 'UTC' })
  async run(): Promise<void> {
    try {
      let total = 0;
      // Loop until the batch comes back short — bounded by batch size
      // each iteration to keep contention predictable.
      // Safety cap of 100 iterations × 200 = 20k rows per day; if we
      // ever exceed that the scrub will catch up over multiple nights.
      const salt = this.resolveSalt();
      for (let i = 0; i < 100; i += 1) {
        const scrubbed = await this.scrubBatch(salt);
        total += scrubbed;
        if (scrubbed < SCRUB_BATCH_SIZE) break;
      }
      if (total > 0) {
        this.logger.log(
          `GuestCheckoutPiiScrub: anonymised ${total} guest checkout row(s)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `GuestCheckoutPiiScrub tick crashed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  // Exposed for tests + ad-hoc operator invocation.
  async scrubBatch(salt: string): Promise<number> {
    const now = new Date();
    const rows = await this.prisma.guestCheckout.findMany({
      where: {
        data_retention_at: { not: null, lte: now },
        scrubbed_at: null,
        created_user_id: null,
      },
      orderBy: [{ data_retention_at: 'asc' }],
      take: SCRUB_BATCH_SIZE,
      select: { id: true, guest_email: true },
    });
    if (rows.length === 0) return 0;
    for (const row of rows) {
      // Tolerate per-row failures so one corrupt row can't freeze the
      // batch. updateMany with WHERE scrubbed_at IS NULL guards against
      // a concurrent re-run flipping the same row twice.
      const hashedEmail = this.hashEmail(row.guest_email, salt);
      try {
        await this.prisma.guestCheckout.updateMany({
          where: { id: row.id, scrubbed_at: null },
          data: {
            guest_email: hashedEmail,
            guest_name: REDACTED_NAME,
            scrubbed_at: now,
          },
        });
      } catch (err) {
        this.logger.error(
          `GuestCheckoutPiiScrub: row ${row.id} scrub failed: ${(err as Error)?.message ?? String(err)}`,
        );
      }
    }
    return rows.length;
  }

  // Salt source: GUEST_CHECKOUT_PII_SALT env var. Falls back to a
  // build-time constant in dev/test so scrubs are stable across boots.
  // Never log the salt value.
  private resolveSalt(): string {
    const fromEnv = this.config.get<string>('GUEST_CHECKOUT_PII_SALT');
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
    return 'tgp-storefront-dev-salt-v1';
  }

  private hashEmail(email: string, salt: string): string {
    const normalised = (email ?? '').trim().toLowerCase();
    return (
      'sha256:' +
      createHash('sha256').update(normalised).update(salt).digest('hex')
    );
  }
}
