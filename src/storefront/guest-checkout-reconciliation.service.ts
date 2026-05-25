import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import {
  GuestCheckoutService,
  RECONCILIATION_MAX_ATTEMPTS,
} from './guest-checkout.service';

// Audit #3 P1-6 + P1-7 — durable reconciliation worker for paid guest
// checkouts whose conversion didn't complete inline.
//
// Two scan branches per tick:
//
//   1. `conversion_failed_retryable` with retry_count < cap and
//      last_retry_at older than the backoff window. These rows already
//      know they failed; we just need to re-run convertGuestToUser. After
//      RECONCILIATION_MAX_ATTEMPTS attempts the row moves to
//      `conversion_failed_terminal` and pages on-call.
//   2. `paid` rows with no created_user_id past a short grace window —
//      covers the P1-7 case where handlePaymentSucceeded crashed between
//      flipping the row to `paid` and calling markRetryable. Without
//      this scan, a Stripe replay would short-circuit on the inserted
//      StripeProcessedEvent and the customer would stay unprovisioned
//      forever.
//
// Bounded per-tick batch keeps the worker from monopolising the DB
// during a backlog; the cron simply runs again next minute.
const RECONCILIATION_BATCH_SIZE = 25;
// Wait at least this long between retries on the same row. Stops a
// transient outage from burning through the retry budget in seconds.
const RECONCILIATION_RETRY_BACKOFF_MS = 60_000;
// Treat `paid` rows older than this as orphaned (handler crashed between
// `paid` and reconciliation). 2 minutes is more than enough for the
// inline convert path; anything older needs operator-visible reconciliation.
const PAID_GRACE_WINDOW_MS = 2 * 60_000;

@Injectable()
export class GuestCheckoutReconciliationService {
  private readonly logger = new Logger(GuestCheckoutReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly guestCheckout: GuestCheckoutService,
  ) {}

  // EVERY_MINUTE rather than EVERY_30_SECONDS — Stripe webhook retries
  // are spaced hours apart on the upstream side, so a minute is plenty
  // and keeps the load profile predictable for ops.
  @Cron(CronExpression.EVERY_MINUTE, { name: 'guest-checkout-reconciliation' })
  async run(): Promise<void> {
    try {
      const retryableCount = await this.scanRetryable();
      const orphanCount = await this.scanOrphanedPaid();
      if (retryableCount > 0 || orphanCount > 0) {
        this.logger.log(
          `GuestCheckoutReconciliation: processed retryable=${retryableCount} orphaned_paid=${orphanCount}`,
        );
      }
    } catch (err) {
      // Never throw from a cron handler — the scheduler will keep
      // re-arming us next tick.
      this.logger.error(
        `GuestCheckoutReconciliation tick crashed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  // Branch 1: re-arm rows that already know they failed. last_retry_at
  // NULLS FIRST so freshly-flipped rows run on the very next tick.
  private async scanRetryable(): Promise<number> {
    const cutoff = new Date(Date.now() - RECONCILIATION_RETRY_BACKOFF_MS);
    const rows = await this.prisma.guestCheckout.findMany({
      where: {
        status: 'conversion_failed_retryable',
        retry_count: { lt: RECONCILIATION_MAX_ATTEMPTS },
        OR: [
          { last_retry_at: null },
          { last_retry_at: { lte: cutoff } },
        ],
      },
      orderBy: [{ last_retry_at: 'asc' }],
      take: RECONCILIATION_BATCH_SIZE,
      select: { id: true },
    });
    for (const row of rows) {
      try {
        await this.guestCheckout.reconcilePaidCheckout(row.id);
      } catch (err) {
        // reconcilePaidCheckout already does its own retry bookkeeping
        // via markRetryable; any error bubbling here is unexpected and
        // shouldn't stop the batch.
        this.logger.error(
          `reconcilePaidCheckout crashed for ${row.id}: ${(err as Error)?.message ?? String(err)}`,
        );
      }
    }
    return rows.length;
  }

  // Branch 2: rows stuck in `paid` past the grace window with no
  // created_user_id. handler crashed between `paid` flip and the
  // markRetryable call; Stripe replays short-circuit on the processed
  // event, so this scan is the only durable recovery path.
  private async scanOrphanedPaid(): Promise<number> {
    const cutoff = new Date(Date.now() - PAID_GRACE_WINDOW_MS);
    const rows = await this.prisma.guestCheckout.findMany({
      where: {
        status: 'paid',
        created_user_id: null,
        // created_at is a proxy for "first observed paid" — paid is set
        // inline by the webhook, so created_at + grace is the right
        // floor; we also do not have a separate `paid_at` column yet.
        // A future migration could add one for stricter accounting.
        created_at: { lte: cutoff },
      },
      orderBy: [{ created_at: 'asc' }],
      take: RECONCILIATION_BATCH_SIZE,
      select: { id: true },
    });
    for (const row of rows) {
      try {
        await this.guestCheckout.reconcilePaidCheckout(row.id);
      } catch (err) {
        this.logger.error(
          `reconcilePaidCheckout (orphan) crashed for ${row.id}: ${(err as Error)?.message ?? String(err)}`,
        );
      }
    }
    return rows.length;
  }
}
