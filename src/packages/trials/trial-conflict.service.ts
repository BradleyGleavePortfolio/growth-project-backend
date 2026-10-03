import { randomUUID } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../../connect/stripe-connect-api.service';
import { PrismaService } from '../../prisma.service';

// B-TRIALS-3 (B-656-1) — the cancellation a second free trial with the same
// coach owes, as durable state.
//
// Before: the webhook handed the subscription id to an in-memory post-commit
// hook; one transient Stripe failure was logged and forgotten, and a Stripe
// redelivery of the same event was already processed, so a saved-card trial
// stayed scheduled to charge with no access.
//
// Now:
//   owe()      inside the webhook transaction: one PackageTrialConflict row per
//              purchase (INSERT ... ON CONFLICT DO NOTHING, safe in the tx). It
//              commits with the denied entitlement or not at all.
//   settle()   right after commit, and from sweep() every 5 minutes: an
//              exclusive lease (compare-and-set), one bounded Stripe cancel,
//              and a fenced outcome. Success, or Stripe saying the
//              subscription is already gone, settles it as cancelled; any
//              other failure keeps it owed with exponential backoff.
//   isBlocked() every later subscription / invoice event for the purchase: a
//              purchase with a conflict row never gets trial access.
//   supersede() the trial ended before any cancel succeeded and Stripe moved
//              the subscription to active/past_due (billing started). A
//              cancel can no longer prevent that charge, and cancelling now
//              would leave a paying client with nothing, so the obligation
//              closes, the plan is treated as a regular paid plan sold
//              without a trial (the TRIAL_ALREADY_USED rule), and the sweep
//              alerts support once (ids only) to offer a refund.
// After TRIAL_CONFLICT_ALERT_AFTER failed attempts Sentry gets one alert
// (ids and codes only) so a person can cancel by hand well before the trial
// ends; the sweep keeps retrying regardless.

export const TRIAL_CONFLICT_LEASE_MS = 60 * 1000;
export const TRIAL_CONFLICT_CANCEL_TIMEOUT_MS = 20 * 1000;
export const TRIAL_CONFLICT_ALERT_AFTER = 3;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const SWEEP_BATCH = 50;

type Db = Prisma.TransactionClient | PrismaService;

export type TrialConflictSettleOutcome = 'cancelled' | 'retry' | 'busy' | 'not_owed' | 'stale';

export function trialConflictBackoffMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
}

/** Stripe says the subscription no longer exists or is already cancelled. */
export function isAlreadyCancelledError(err: unknown): boolean {
  if (err instanceof StripeConnectApiError) {
    if (err.httpStatus === 404 || err.stripeCode === 'resource_missing') return true;
    return /No such subscription|already (been )?cancel+ed|status of canceled/i.test(err.message);
  }
  return false;
}

/** A short, closed error code for the row and logs (never a message body). */
function errorCode(err: unknown): string {
  if (err instanceof TrialConflictTimeoutError) return 'timeout';
  if (err instanceof StripeConnectApiError) {
    if (err.stripeCode && /^[a-z_]{1,40}$/.test(err.stripeCode)) return err.stripeCode;
    return `http_${err.httpStatus}`;
  }
  return 'error';
}

export class TrialConflictTimeoutError extends Error {
  readonly code = 'TRIAL_CONFLICT_CANCEL_TIMEOUT';
  constructor() {
    super('trial conflict cancel timed out');
    this.name = 'TrialConflictTimeoutError';
  }
}

@Injectable()
export class TrialConflictService {
  private readonly logger = new Logger(TrialConflictService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly stripe?: StripeConnectApiService,
  ) {}

  /** Record the owed cancellation on the caller's transaction (idempotent). */
  async owe(
    db: Db,
    args: { purchaseId: string; subscriptionId: string; now?: Date },
  ): Promise<void> {
    await db.packageTrialConflict.createMany({
      data: [
        {
          purchase_id: args.purchaseId,
          stripe_subscription_id: args.subscriptionId,
          status: 'owed',
          next_attempt_at: args.now ?? new Date(),
        },
      ],
      skipDuplicates: true,
    });
  }

  /** Any conflict row (owed, cancelled or superseded) for this purchase. */
  async find(
    db: Db,
    purchaseId: string,
  ): Promise<{ status: string; stripe_subscription_id: string } | null> {
    return db.packageTrialConflict.findUnique({
      where: { purchase_id: purchaseId },
      select: { status: true, stripe_subscription_id: true },
    });
  }

  /** Purchases (of a page) that lost the one-trial race. */
  async blockedPurchaseIds(db: Db, purchaseIds: string[]): Promise<Set<string>> {
    if (purchaseIds.length === 0) return new Set();
    const rows = await db.packageTrialConflict.findMany({
      where: { purchase_id: { in: purchaseIds }, status: { in: ['owed', 'cancelled'] } },
      select: { purchase_id: true },
    });
    return new Set(rows.map((r) => r.purchase_id));
  }

  /** Stripe confirmed the subscription ended (customer.subscription.deleted). */
  async markCancelled(db: Db, purchaseId: string, now: Date = new Date()): Promise<void> {
    await db.packageTrialConflict.updateMany({
      where: { purchase_id: purchaseId, status: 'owed' },
      data: { status: 'cancelled', settled_at: now, lease_token: null, lease_until: null },
    });
  }

  /**
   * Billing started before any cancel succeeded (see the header). Closes the
   * obligation on the caller's transaction and returns true when this call
   * closed it (the sweep alerts support once, after commit).
   */
  async supersede(db: Db, purchaseId: string, now: Date = new Date()): Promise<boolean> {
    const res = await db.packageTrialConflict.updateMany({
      where: { purchase_id: purchaseId, status: 'owed' },
      data: {
        status: 'superseded',
        settled_at: now,
        lease_token: null,
        lease_until: null,
        last_error: 'billing_started',
      },
    });
    return res.count === 1;
  }

  /**
   * Try to cancel one owed subscription now. Exclusive (lease), bounded
   * (timeout shorter than the lease) and fenced (only the lease holder writes
   * the outcome). Never throws.
   */
  async settle(purchaseId: string, now: Date = new Date()): Promise<TrialConflictSettleOutcome> {
    try {
      const row = await this.prisma.packageTrialConflict.findUnique({
        where: { purchase_id: purchaseId },
      });
      if (!row || row.status !== 'owed') return 'not_owed';
      if (!this.stripe) return 'retry';
      const token = randomUUID();
      const claimed = await this.prisma.packageTrialConflict.updateMany({
        where: {
          id: row.id,
          status: 'owed',
          OR: [{ lease_until: null }, { lease_until: { lt: now } }],
        },
        data: {
          attempts: { increment: 1 },
          lease_token: token,
          lease_until: new Date(now.getTime() + TRIAL_CONFLICT_LEASE_MS),
        },
      });
      if (claimed.count !== 1) return 'busy';
      const attempts = row.attempts + 1;

      let outcome: 'cancelled' | 'retry';
      let code: string | null = null;
      try {
        await withDeadline(
          this.stripe.cancelSubscription(row.stripe_subscription_id),
          TRIAL_CONFLICT_CANCEL_TIMEOUT_MS,
        );
        outcome = 'cancelled';
      } catch (err) {
        if (isAlreadyCancelledError(err)) {
          outcome = 'cancelled';
          code = 'already_cancelled';
        } else {
          outcome = 'retry';
          code = errorCode(err);
        }
      }

      const fenced = await this.prisma.packageTrialConflict.updateMany({
        where: { id: row.id, lease_token: token, status: 'owed' },
        data:
          outcome === 'cancelled'
            ? {
                status: 'cancelled',
                settled_at: new Date(),
                lease_token: null,
                lease_until: null,
                last_error: code,
              }
            : {
                lease_token: null,
                lease_until: null,
                last_error: code,
                next_attempt_at: new Date(now.getTime() + trialConflictBackoffMs(attempts)),
              },
      });
      if (fenced.count !== 1) return 'stale';

      if (outcome === 'cancelled') {
        this.logger.warn(
          `trial conflict: cancelled subscription for purchase ${purchaseId} (TRIAL_ALREADY_USED)`,
        );
        return 'cancelled';
      }
      this.logger.error(
        `trial conflict: cancel failed for purchase ${purchaseId} attempt=${attempts} code=${code} (TRIAL_ALREADY_USED, retried by the sweep)`,
      );
      if (attempts >= TRIAL_CONFLICT_ALERT_AFTER && !row.alerted_at) {
        const first = await this.prisma.packageTrialConflict.updateMany({
          where: { id: row.id, alerted_at: null },
          data: { alerted_at: new Date() },
        });
        if (first.count === 1) {
          try {
            Sentry.captureMessage('trial conflict cancel still failing', {
              level: 'error',
              tags: {
                code: 'TRIAL_CONFLICT_CANCEL_FAILING',
                purchase_id: purchaseId,
                last: code ?? 'error',
              },
            });
          } catch (err) {
            this.logger.warn(`trial conflict alert not sent: ${(err as Error)?.name ?? 'error'}`);
          }
        }
      }
      return 'retry';
    } catch (err) {
      this.logger.error(
        `trial conflict settle errored for purchase ${purchaseId}: ${(err as Error)?.name ?? 'error'}`,
      );
      return 'retry';
    }
  }

  /** Retry every owed cancellation whose backoff has passed. */
  @Cron('*/5 * * * *', { name: 'trial-conflict-sweep', timeZone: 'UTC' })
  async sweep(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.packageTrialConflict.findMany({
      where: { status: 'owed', next_attempt_at: { lte: now } },
      orderBy: { next_attempt_at: 'asc' },
      take: SWEEP_BATCH,
      select: { purchase_id: true },
    });
    for (const row of due) await this.settle(row.purchase_id, now);
    await this.alertSuperseded();
    return due.length;
  }

  /**
   * Superseded conflicts (billing started before any cancel succeeded) alert
   * support exactly once, after the webhook transaction that closed them
   * committed (ids and codes only). Never throws.
   */
  async alertSuperseded(): Promise<number> {
    try {
      const rows = await this.prisma.packageTrialConflict.findMany({
        where: { status: 'superseded', alerted_at: null },
        take: SWEEP_BATCH,
        select: { id: true, purchase_id: true },
      });
      let sent = 0;
      for (const row of rows) {
        const first = await this.prisma.packageTrialConflict.updateMany({
          where: { id: row.id, alerted_at: null },
          data: { alerted_at: new Date() },
        });
        if (first.count !== 1) continue;
        sent += 1;
        this.logger.error(
          `trial conflict superseded: purchase ${row.purchase_id} started billing before its cancel succeeded (TRIAL_ALREADY_USED, offer a refund)`,
        );
        try {
          Sentry.captureMessage('trial conflict billed before cancel', {
            level: 'error',
            tags: { code: 'TRIAL_CONFLICT_SUPERSEDED', purchase_id: row.purchase_id },
          });
        } catch (err) {
          this.logger.warn(`trial conflict alert not sent: ${(err as Error)?.name ?? 'error'}`);
        }
      }
      return sent;
    } catch (err) {
      this.logger.error(`trial conflict alert sweep failed: ${(err as Error)?.name ?? 'error'}`);
      return 0;
    }
  }
}

/** Resolve the promise or reject with TrialConflictTimeoutError after ms. */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TrialConflictTimeoutError()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
