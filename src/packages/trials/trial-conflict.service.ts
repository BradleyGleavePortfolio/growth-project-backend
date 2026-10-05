import { randomUUID } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { trialErrorClass, trialHttpCode } from './trial-diagnostics';
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
//              the subscription to active, or a paid invoice proves it billed. A
//              cancel can no longer prevent that charge, and cancelling now
//              would leave a paying client with nothing, so the obligation
//              closes, the plan is treated as a regular paid plan sold
//              without a trial (the TRIAL_ALREADY_USED rule), and the sweep
//              alerts support once (ids only) to offer a refund.
// After TRIAL_CONFLICT_ALERT_AFTER failed attempts Sentry gets one alert
// (ids and codes only) so a person can cancel by hand well before the trial
// ends; the sweep keeps retrying regardless.
//
// B-TR3-118 (agent 118) — Sol B-673-1: an owed row is not proof that the
// subscription is still a free trial (its active webhook can be late or
// missing). settle() reads Stripe's current subscription first and cancels
// only one that has not billed (trialConflictAction); billing started
// supersedes it as the active webhook does (paid plan kept, billed alert),
// and a failed or unknown read cancels nothing. Sol C-673-2: every lease,
// admission and backoff reads a fresh clock, never the sweep's start time.
// B-TR4-119 (agent 119) — Sol B-673-1: past_due/unpaid say one invoice is
// unpaid, not that none was ever paid; only a complete paid-invoice page
// decides (charged: supersede; none: cancel; else retry). Sol B-673-2: a
// supersession, cancellation or new lease committed during the reads vetoes
// the DELETE (re-checked after the reads, before the decision).
// B-TR5-119 (agent 119) — Sol B-673-1 / Opus C-673-6: that cancel first voids every
// open invoice, each confirmed void (a payment that won fails its void, no DELETE).
// B-TR6-119 (agent 119) — Sol B-673-1: open is not the whole payable domain; an
// uncollectible invoice can still be paid. Both complete lists are read before
// the paid list and every member is voided (confirmed) before the DELETE. The
// lease is renewed by compare-and-set before each void and before the DELETE,
// so a lost lease stops the sequence (stale) and any number of invoices up to
// TRIAL_CONFLICT_MAX_VOIDS fits.
// B-TR7-120 (agent 120) — B-707-1: a renewal draft is in neither list and can
// finalize and be paid inside that window. Stripe never deletes a
// subscription's draft (it must be finalized, then voided), so a complete
// draft page is read first and each draft is finalized without collection
// (auto_advance=false, confirmed open) and voided (confirmed void) before the
// other voids, each call on a renewed lease. Before the DELETE the whole domain
// is read again: a draft, open or uncollectible invoice not fenced here, or any
// unknown page, retries; a charge on the paid page supersedes (paid plan kept,
// billed alert). Drafts count toward TRIAL_CONFLICT_MAX_VOIDS.

export const TRIAL_CONFLICT_LEASE_MS = 60 * 1000;
export const TRIAL_CONFLICT_CANCEL_TIMEOUT_MS = 20 * 1000;
export const TRIAL_CONFLICT_ALERT_AFTER = 3;
/** B-TR6-119 — more payable invoices than this (drafts count) is not a never-billed trial. */
export const TRIAL_CONFLICT_MAX_VOIDS = 10;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const SWEEP_BATCH = 50;

type Db = Prisma.TransactionClient | PrismaService;

export type TrialConflictSettleOutcome =
  'cancelled' | 'superseded' | 'retry' | 'busy' | 'not_owed' | 'stale';

/** Stripe states that never billed a regular invoice: a cancel takes no money back. */
const UNBILLED_STATUSES = new Set(['trialing', 'incomplete', 'paused']);
/** States that may follow a paid period: the invoice history decides. */
const HISTORY_STATUSES = new Set(['past_due', 'unpaid']);

export type TrialConflictAction =
  | 'cancel'
  | 'gone'
  | 'billed'
  | 'trial_ending'
  | 'lease_exhausted'
  | 'state_unknown'
  | 'history_unknown';
export type TrialPaidHistory = 'charged' | 'none' | 'unknown';

/** B-673-1 — none only from a complete, well-formed page with no charge on it. */
export function trialPaidHistory(list: unknown): TrialPaidHistory {
  const page = list as { data?: unknown; has_more?: unknown } | null | undefined;
  if (!page || !Array.isArray(page.data)) return 'unknown';
  let wellFormed = true;
  for (const inv of page.data as Array<{ amount_paid?: unknown; total?: unknown } | null>) {
    const paid = inv?.amount_paid;
    if (typeof paid !== 'number') wellFormed = false;
    else if (paid > 0 || (typeof inv?.total === 'number' && inv.total > 0)) return 'charged';
    // C-673-7 — none needs both amounts exactly 0 (a credit-funded charge shows in total).
    else if (paid !== 0 || inv?.total !== 0) wellFormed = false;
  }
  return wellFormed && page.has_more === false ? 'none' : 'unknown';
}

/**
 * B-673-1 — what an owed conflict may do, from Stripe's subscription as read
 * now: cancel (nothing billed, and the cancel lands before the trial ends and
 * inside the lease), gone (already ended), billed (billing started: supersede,
 * never cancel), or a retry code (an unknown state, the trial ends before the
 * cancel can land, or the lease has no room left).
 */
export function trialConflictAction(
  sub: { status?: unknown; trial_end?: unknown } | null | undefined,
  at: Date,
  leaseUntil: Date,
  history: TrialPaidHistory = 'unknown',
): TrialConflictAction {
  const status = typeof sub?.status === 'string' ? sub.status : '';
  if (status === 'canceled' || status === 'incomplete_expired') return 'gone';
  if (status === 'active') return 'billed';
  if (HISTORY_STATUSES.has(status)) {
    if (history === 'charged') return 'billed';
    if (history !== 'none') return 'history_unknown';
  } else if (!UNBILLED_STATUSES.has(status)) return 'state_unknown';
  if (at.getTime() + TRIAL_CONFLICT_CANCEL_TIMEOUT_MS >= leaseUntil.getTime()) {
    return 'lease_exhausted';
  }
  if (status !== 'trialing') return 'cancel';
  const end = typeof sub?.trial_end === 'number' ? sub.trial_end * 1000 : Number.NaN;
  // A cancel racing Stripe's trial-end charge could cancel a just-paid plan.
  return end > at.getTime() + TRIAL_CONFLICT_LEASE_MS ? 'cancel' : 'trial_ending';
}

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
  // B-656-7 — the HTTP status only; a Stripe code is free text to this log.
  if (err instanceof StripeConnectApiError) return trialHttpCode(err.httpStatus);
  return trialErrorClass(err);
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
   * the outcome). B-673-1: Stripe's current state decides first (see the
   * header). Never throws.
   */
  async settle(purchaseId: string, now: Date = new Date()): Promise<TrialConflictSettleOutcome> {
    const clock = elapsedClock(now);
    try {
      const row = await this.prisma.packageTrialConflict.findUnique({
        where: { purchase_id: purchaseId },
      });
      if (!row || row.status !== 'owed') return 'not_owed';
      if (!this.stripe) return 'retry';
      const token = randomUUID();
      const at = clock();
      const until = new Date(at.getTime() + TRIAL_CONFLICT_LEASE_MS);
      const claimed = await this.prisma.packageTrialConflict.updateMany({
        where: {
          id: row.id,
          status: 'owed',
          OR: [{ lease_until: null }, { lease_until: { lt: at } }],
        },
        data: { attempts: { increment: 1 }, lease_token: token, lease_until: until },
      });
      if (claimed.count !== 1) return 'busy';
      const attempts = row.attempts + 1;

      let outcome: 'cancelled' | 'superseded' | 'retry';
      let code: string | null = null;
      try {
        const sub = await withDeadline(
          this.stripe.retrieveSubscription(row.stripe_subscription_id),
          TRIAL_CONFLICT_CANCEL_TIMEOUT_MS,
        );
        const historic = HISTORY_STATUSES.has(String(sub?.status));
        // B-TR5-119 / B-TR6-119 / B-TR7-120 — the payable invoices (draft, open
        // and uncollectible) are read before the paid list: a payment between
        // the reads shows as paid, one after them fails its fence or the recheck.
        const subId = row.stripe_subscription_id;
        const payable = historic ? await readPayable(this.stripe, subId) : null;
        const history = historic
          ? trialPaidHistory(await readOrNull(this.stripe.listSubscriptionPaidInvoices(subId)))
          : undefined;
        // B-673-2 — the row must still be owed under this lease after the
        // reads, and (B-TR6-119) before each void and before the DELETE.
        const owned = async () =>
          !!(await this.prisma.packageTrialConflict.findFirst({
            where: { id: row.id, lease_token: token, status: 'owed' },
            select: { id: true },
          }));
        if (!(await owned())) return 'stale';
        const action = trialConflictAction(sub, clock(), until, history);
        const voided =
          action === 'cancel' && historic
            ? await this.voidPayable(this.stripe, row.id, token, subId, payable, clock)
            : null;
        if (voided === 'stale') return 'stale';
        if (voided === 'billed') {
          outcome = 'superseded';
          code = 'billing_started';
        } else if (voided && voided !== 'ok') {
          outcome = 'retry';
          code = voided;
        } else if (action === 'cancel') {
          await withDeadline(
            this.stripe.cancelSubscription(row.stripe_subscription_id),
            TRIAL_CONFLICT_CANCEL_TIMEOUT_MS,
          );
          outcome = 'cancelled';
        } else if (action === 'gone') {
          outcome = 'cancelled';
          code = 'already_cancelled';
        } else {
          outcome = action === 'billed' ? 'superseded' : 'retry';
          code = action === 'billed' ? 'billing_started' : action;
        }
      } catch (err) {
        if (isAlreadyCancelledError(err)) {
          outcome = 'cancelled';
          code = 'already_cancelled';
        } else {
          outcome = 'retry';
          code = errorCode(err);
        }
      }

      // Fenced: a webhook that superseded or cancelled the row meanwhile wins.
      const fenced = await this.prisma.packageTrialConflict.updateMany({
        where: { id: row.id, lease_token: token, status: 'owed' },
        data:
          outcome === 'retry'
            ? {
                lease_token: null,
                lease_until: null,
                last_error: code,
                next_attempt_at: new Date(clock().getTime() + trialConflictBackoffMs(attempts)),
              }
            : {
                status: outcome,
                settled_at: clock(),
                lease_token: null,
                lease_until: null,
                last_error: code,
              },
      });
      if (fenced.count !== 1) return 'stale';

      if (outcome === 'superseded') {
        // The billed alert goes out from alertSuperseded() (its own receipt).
        this.logger.warn(
          `trial conflict: purchase ${purchaseId} billed before its cancel; kept as a paid plan (TRIAL_ALREADY_USED)`,
        );
        return 'superseded';
      }
      if (outcome === 'cancelled') {
        this.logger.warn(
          `trial conflict: cancelled subscription for purchase ${purchaseId} (TRIAL_ALREADY_USED)`,
        );
        return 'cancelled';
      }
      this.logger.error(
        `trial conflict: cancel not done for purchase ${purchaseId} attempt=${attempts} code=${code} (TRIAL_ALREADY_USED, retried by the sweep)`,
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
            this.logger.warn(`trial conflict alert not sent: ${trialErrorClass(err)}`);
          }
        }
      }
      return 'retry';
    } catch (err) {
      this.logger.error(
        `trial conflict settle errored for purchase ${purchaseId}: ${trialErrorClass(err)}`,
      );
      return 'retry';
    }
  }

  /**
   * B-TR6-119 — void every payable invoice, each confirmed void. Before each
   * void and before the DELETE the lease is renewed by compare-and-set on this
   * token while the row is owed: a supersession, cancellation or takeover in
   * between stops here (stale), and each step gets a full lease for its
   * bounded call. B-TR7-120 — drafts are finalized (confirmed open) and voided
   * first; then every list is read again (see the header) before the DELETE.
   */
  private async voidPayable(
    stripe: StripeConnectApiService,
    id: string,
    token: string,
    subId: string,
    domain: PayableDomain | null,
    clock: () => Date,
  ): Promise<VoidResult> {
    if (!domain || !domain.payable.length) return 'invoices_unknown';
    const fenced = [...domain.drafts, ...domain.payable];
    if (fenced.length > TRIAL_CONFLICT_MAX_VOIDS) return 'invoices_too_many';
    // The next bounded call must still end inside the renewed lease.
    const renew = async (): Promise<VoidResult> => {
      const until = new Date(clock().getTime() + TRIAL_CONFLICT_LEASE_MS);
      const res = await this.prisma.packageTrialConflict.updateMany({
        where: { id, lease_token: token, status: 'owed' },
        data: { lease_until: until },
      });
      if (res.count !== 1) return 'stale';
      const fits = clock().getTime() + TRIAL_CONFLICT_CANCEL_TIMEOUT_MS < until.getTime();
      return fits ? 'ok' : 'lease_exhausted';
    };
    // One bounded Stripe call on a freshly renewed lease; a failure reads null.
    const call = async <T>(fn: () => Promise<T>) => {
      const lease = await renew();
      return { lease, res: lease === 'ok' ? await readOrNull(fn()) : null };
    };
    for (const inv of fenced) {
      if (domain.drafts.includes(inv)) {
        const fin = await call(() => stripe.finalizeInvoice(inv));
        if (fin.lease !== 'ok') return fin.lease;
        if (fin.res?.id !== inv || fin.res.status !== 'open') return 'draft_not_fenced';
      }
      // Main's voidInvoice is keyed: one void per invoice however often this retries.
      const res = await call(() => stripe.voidInvoice(inv, `tgp-trial-void-${inv}`));
      if (res.lease !== 'ok') return res.lease;
      if (res.res?.status !== 'void') return 'invoice_not_voided';
    }
    // B-707-1 — every invoice starts as a draft: one not fenced above, or a
    // payment that landed after the first reads, sends no DELETE. An id fenced
    // above is void (final), never new.
    const lists = [
      () => stripe.listDraftInvoices(subId),
      () => stripe.listOpenInvoices(subId),
      () => stripe.listUncollectibleInvoices(subId),
    ];
    for (const list of lists) {
      const page = await call(list);
      if (page.lease !== 'ok') return page.lease;
      const now = payableInvoiceIds([page.res]);
      if (!now) return 'invoices_unknown';
      if (now.some((inv) => !fenced.includes(inv))) return 'invoices_changed';
    }
    const paid = await call(() => stripe.listSubscriptionPaidInvoices(subId));
    if (paid.lease !== 'ok') return paid.lease;
    const history = trialPaidHistory(paid.res);
    if (history === 'charged') return 'billed';
    if (history !== 'none') return 'history_unknown';
    return renew();
  }

  /** Retry every owed cancellation whose backoff has passed. */
  @Cron('*/5 * * * *', { name: 'trial-conflict-sweep', timeZone: 'UTC' })
  async sweep(now: Date = new Date()): Promise<number> {
    const clock = elapsedClock(now);
    const due = await this.prisma.packageTrialConflict.findMany({
      where: { status: 'owed', next_attempt_at: { lte: now } },
      orderBy: { next_attempt_at: 'asc' },
      take: SWEEP_BATCH,
      select: { purchase_id: true },
    });
    // C-673-2 — each row starts from the time it is reached, not the sweep's start.
    for (const row of due) await this.settle(row.purchase_id, clock());
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
        // B-656-6 — its own receipt: an earlier cancel-failing alert
        // (alerted_at) never suppresses the billed alert.
        where: { status: 'superseded', billed_alerted_at: null },
        take: SWEEP_BATCH,
        select: { id: true, purchase_id: true },
      });
      let sent = 0;
      for (const row of rows) {
        const first = await this.prisma.packageTrialConflict.updateMany({
          where: { id: row.id, status: 'superseded', billed_alerted_at: null },
          data: { billed_alerted_at: new Date() },
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
          this.logger.warn(`trial conflict alert not sent: ${trialErrorClass(err)}`);
        }
      }
      return sent;
    } catch (err) {
      this.logger.error(`trial conflict alert sweep failed: ${trialErrorClass(err)}`);
      return 0;
    }
  }
}

/** B-TR5-119 — a bounded Stripe call; a failure proves nothing (null). */
async function readOrNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await withDeadline(promise, TRIAL_CONFLICT_CANCEL_TIMEOUT_MS);
  } catch {
    return null;
  }
}

type VoidResult =
  | 'ok'
  | 'stale'
  | 'billed'
  | 'lease_exhausted'
  | 'invoices_unknown'
  | 'invoices_too_many'
  | 'invoices_changed'
  | 'history_unknown'
  | 'draft_not_fenced'
  | 'invoice_not_voided';

/** B-TR7-120 — draft ids (not also open or uncollectible) and open/uncollectible ids. */
type PayableDomain = { drafts: string[]; payable: string[] };

type InvoicePage = { data?: Array<{ id?: unknown } | null>; has_more?: unknown } | null;

/**
 * B-TR6-119 — the payable invoice ids: complete open AND uncollectible pages of
 * string ids (deduplicated, open first), or null when either is unknown.
 */
export function payableInvoiceIds(pages: InvoicePage[]): string[] | null {
  const ids: string[] = [];
  for (const page of pages) {
    if (page?.has_more !== false || !Array.isArray(page.data)) return null;
    for (const inv of page.data) {
      if (typeof inv?.id !== 'string' || !inv.id) return null;
      if (!ids.includes(inv.id)) ids.push(inv.id);
    }
  }
  return ids;
}

async function readPayable(
  stripe: StripeConnectApiService,
  subId: string,
): Promise<PayableDomain | null> {
  // B-TR7-120 — drafts first: a draft finalized after this read is on the open page.
  const drafts = payableInvoiceIds([await readOrNull(stripe.listDraftInvoices(subId))]);
  if (!drafts) return null;
  const open = await readOrNull(stripe.listOpenInvoices(subId));
  if (!open) return null;
  const payable = payableInvoiceIds([
    open,
    await readOrNull(stripe.listUncollectibleInvoices(subId)),
  ]);
  return payable && { drafts: drafts.filter((inv) => !payable.includes(inv)), payable };
}

/** A clock that starts at `start` and advances with real elapsed time (C-673-2). */
function elapsedClock(start: Date): () => Date {
  const wallAtStart = Date.now();
  return () => new Date(start.getTime() + (Date.now() - wallAtStart));
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
