import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  ClientPurchase,
  DunningAttempt,
  DunningState,
  PaymentReminder,
} from '@prisma/client';
import { StripeConnectApiService } from '../connect/stripe-connect-api.service';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';
import { PrismaService } from '../prisma.service';

// ─────────────────────────────────────────────────────────────────────────────
// Dunning v1 — webhook-driven failed-payment recovery.
//
// Lifecycle:
//   invoice.payment_failed       → recordFailure() — opens or extends a
//                                  DunningState row and schedules a fixed
//                                  cadence of DunningAttempt rows (one per
//                                  day in DUNNING_CADENCE_DAYS).
//   tick()                       → drains attempts whose scheduled_for ≤ now,
//                                  sends the matching email via EmailService
//                                  (idempotency key = attempt id), advances
//                                  DunningState.step_index and next_attempt_at.
//   invoice.payment_succeeded /  → recordResolution() — marks DunningState
//   invoice.paid                   resolved, cancels remaining pending
//                                  attempts, fires a recovery email if
//                                  anything had already been sent.
//   customer.subscription.deleted → terminate() — marks DunningState
//                                  abandoned and cancels remaining attempts;
//                                  no recovery email.
//
// Idempotency:
//   - DunningAttempt has UNIQUE(dunning_state_id, step_index): repeated
//     recordFailure() for the same invoice won't duplicate attempts.
//   - EmailService is invoked with attempt_id-derived idempotencyKey, so
//     a tick replay never double-sends.
//   - The Stripe-event idempotency upstream is already handled at the
//     webhook ingress layer (BillingService stripeEventLog).
//
// Observability:
//   Every state transition emits a structured JSON log line (event:
//   "dunning.opened", "dunning.attempt_scheduled", "dunning.attempt_sent",
//   "dunning.recovered", "dunning.escalated", "dunning.cancelled"). The
//   in-process DunningMetrics counter mirrors what Prometheus / Datadog
//   pollers would otherwise scrape; tests assert on it.
//
// Configurability:
//   DUNNING_CADENCE — array of {dayOffset, kind, template} tuples. The
//   default cadence is Day 0 / 3 / 7 / 14; can be overridden via env
//   DUNNING_CADENCE_DAYS=0,3,7,14. Templates are fixed by kind so callers
//   can't accidentally send the wrong copy to a step.
// ─────────────────────────────────────────────────────────────────────────────

export const DUNNING_GRACE_DAYS_DEFAULT = 7;
export const DUNNING_MAX_FAILURES_DEFAULT = 4;
// Max email-send retries per DunningAttempt before the row is marked
// 'failed_permanent' and dropped from the tick scan. Picked empirically:
// 3 retries with exponential 1h → 4h → 16h backoff covers transient
// SES/Resend outages without holding a stuck row for more than a day.
export const DUNNING_MAX_SEND_RETRIES_DEFAULT = 3;
// Exponential backoff base, in milliseconds. Schedule for retry N is
// now + base * 4^N. (1h, 4h, 16h with the default base.)
export const DUNNING_RETRY_BACKOFF_MS_DEFAULT = 60 * 60 * 1000;

export type DunningStepKind =
  | 'soft'
  | 'urgent'
  | 'final'
  | 'recovered'
  | 'cancelled';

export interface DunningCadenceStep {
  // Days from first failure (Day 0 = immediately).
  dayOffset: number;
  // Step kind drives email template + status copy.
  kind: DunningStepKind;
  // Template key used by EmailService.
  template: EmailTemplateKey;
}

// Defaults — the spec's Day 0/3/7/14 cadence. Soft → urgent → final → auto-
// cancel + grace-period notification. The auto-cancel step doesn't send an
// email of its own (the "recovered" or "cancelled" terminal email is fired
// from recordResolution() / terminate()), it just schedules the cancel; the
// final-notice email is the day-7 step.
export const DEFAULT_DUNNING_CADENCE: DunningCadenceStep[] = [
  { dayOffset: 0, kind: 'soft', template: EmailTemplateKey.PAYMENT_REMINDER_SOFT },
  { dayOffset: 3, kind: 'urgent', template: EmailTemplateKey.PAYMENT_REMINDER_URGENT },
  { dayOffset: 7, kind: 'final', template: EmailTemplateKey.PAYMENT_FINAL_NOTICE },
  { dayOffset: 14, kind: 'cancelled', template: EmailTemplateKey.DUNNING_FINAL },
];

export interface DunningConfig {
  cadence: DunningCadenceStep[];
  graceDays: number;
  maxFailures: number;
  maxSendRetries: number;
  retryBackoffMs: number;
}

// Parse env override of cadence days, preserving template/kind ordering from
// the default. Invalid env strings silently fall back to defaults — we log
// once at construction so ops sees the misconfig but the service still boots.
export function resolveDunningConfig(env?: NodeJS.ProcessEnv): DunningConfig {
  const raw = env?.DUNNING_CADENCE_DAYS;
  let cadence = DEFAULT_DUNNING_CADENCE;
  if (raw) {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s));
    if (
      parts.length === DEFAULT_DUNNING_CADENCE.length &&
      parts.every((n) => Number.isFinite(n) && n >= 0)
    ) {
      cadence = DEFAULT_DUNNING_CADENCE.map((step, i) => ({
        ...step,
        dayOffset: parts[i],
      }));
    }
  }
  const graceDays = numEnv(env, 'DUNNING_GRACE_DAYS', DUNNING_GRACE_DAYS_DEFAULT);
  const maxFailures = numEnv(
    env,
    'DUNNING_MAX_FAILURES',
    DUNNING_MAX_FAILURES_DEFAULT,
  );
  const maxSendRetries = numEnv(
    env,
    'DUNNING_MAX_SEND_RETRIES',
    DUNNING_MAX_SEND_RETRIES_DEFAULT,
  );
  const retryBackoffMs = numEnv(
    env,
    'DUNNING_RETRY_BACKOFF_MS',
    DUNNING_RETRY_BACKOFF_MS_DEFAULT,
  );
  return { cadence, graceDays, maxFailures, maxSendRetries, retryBackoffMs };
}

function numEnv(env: NodeJS.ProcessEnv | undefined, k: string, d: number): number {
  const v = env?.[k];
  if (!v) return d;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// In-process metric counters. Mirrors the shape of e.g. Prometheus's
// counter — `.inc(label)` increments and tests / debug endpoints can read
// `.snapshot()` to inspect. Kept dependency-free to avoid pulling in
// prom-client for one subsystem.
export class DunningMetrics {
  private counts = new Map<string, number>();
  inc(label: string, by = 1) {
    this.counts.set(label, (this.counts.get(label) ?? 0) + by);
  }
  get(label: string): number {
    return this.counts.get(label) ?? 0;
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
  reset(): void {
    this.counts.clear();
  }
}

export interface RecordFailureInput {
  purchase: ClientPurchase;
  stripe_invoice_id: string | null;
  amount_due_cents: number | null;
  attempt_number: number | null;
  reason: string | null;
}

export interface DunningAdminView {
  state: DunningState | null;
  attempts: DunningAttempt[];
  purchase: ClientPurchase | null;
}

@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);
  private readonly cfg: DunningConfig;
  readonly metrics: DunningMetrics;

  constructor(
    private prisma: PrismaService,
    private stripe: StripeConnectApiService,
    // EmailService is @Optional() so unit tests that construct the legacy
    // (prisma, stripe) 2-arg form keep building. Production wiring in
    // CheckoutModule always supplies it.
    @Optional() private email?: EmailService,
  ) {
    this.cfg = resolveDunningConfig(process.env);
    this.metrics = new DunningMetrics();
  }

  // ── Webhook entry points ──────────────────────────────────────────────────

  async recordFailure(input: RecordFailureInput): Promise<DunningState> {
    const { purchase } = input;
    const now = new Date();
    const existing = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchase.id },
    });

    const grace = this.computeGracePeriodEnd(now);
    const cancelScheduledAt = this.computeCancelScheduledAt(
      existing,
      input.attempt_number ?? null,
      now,
    );

    const reopened =
      existing && existing.status === 'resolved'
        ? { status: 'active', recovered_at: null, resolved_at: null, step_index: -1 }
        : null;

    // PR #281 P2-2: an active state row with step_index === -1 AND no
    // attempts on disk is the shape adminReset() leaves behind — the row
    // is intentionally re-armable. Treat it as a fresh window so the new
    // recordFailure() schedules a Day 0 cadence rather than no-op'ing on
    // the legacy guard.
    const isResetReArm =
      existing &&
      existing.status === 'active' &&
      existing.step_index === -1 &&
      !reopened &&
      (await this.prisma.dunningAttempt.count({
        where: { dunning_state_id: existing.id },
      })) === 0;

    const row = existing
      ? await this.prisma.dunningState.update({
          where: { purchase_id: purchase.id },
          data: {
            // If the previous window had resolved, reopen with a fresh
            // cadence. Otherwise the existing window continues.
            ...(reopened ?? {}),
            failure_count: { increment: 1 },
            last_attempt_number:
              input.attempt_number ?? existing.last_attempt_number,
            last_failed_amount_cents:
              input.amount_due_cents ?? existing.last_failed_amount_cents,
            last_failure_at: now,
            last_failure_reason: input.reason ?? existing.last_failure_reason,
            grace_period_ends_at:
              existing.grace_period_ends_at &&
              existing.grace_period_ends_at > now &&
              !reopened
                ? existing.grace_period_ends_at
                : grace,
            cancel_scheduled_at:
              existing.cancel_scheduled_at && !reopened
                ? existing.cancel_scheduled_at
                : cancelScheduledAt,
          },
        })
      : await this.prisma.dunningState.create({
          data: {
            purchase_id: purchase.id,
            status: 'active',
            failure_count: 1,
            last_attempt_number: input.attempt_number ?? null,
            last_failed_amount_cents: input.amount_due_cents ?? null,
            last_failure_at: now,
            last_failure_reason: input.reason ?? null,
            grace_period_ends_at: grace,
            cancel_scheduled_at: cancelScheduledAt,
            entered_at: now,
            step_index: -1,
          },
        });

    const isFreshWindow = !existing || !!reopened || !!isResetReArm;
    if (isFreshWindow) {
      // When reopening after a recovered window, the previous cadence's
      // attempts were cancelled but still occupy (dunning_state_id,
      // step_index) slots. Purge them so the new cadence can take 0..N
      // again without unique-violation collisions. (adminReset() already
      // deletes attempts; this guard is a no-op in the re-arm path but
      // keeps the invariant local.)
      if (reopened || isResetReArm) {
        await this.prisma.dunningAttempt.deleteMany({
          where: { dunning_state_id: row.id },
        });
      }
      await this.scheduleCadence(row, now);
      this.metrics.inc('dunning_entered_total');
      this.logEvent('dunning.opened', {
        purchase_id: purchase.id,
        dunning_state_id: row.id,
        invoice_id: input.stripe_invoice_id,
        amount_cents: input.amount_due_cents,
        attempt_number: input.attempt_number,
      });
    } else {
      this.logEvent('dunning.failure_recorded', {
        purchase_id: purchase.id,
        dunning_state_id: row.id,
        failure_count: row.failure_count + 1,
      });
    }

    // Legacy reminder rows kept for backwards-compat — payment-ops UI and
    // the v0 PaymentReminder feed still read them. Dedup window key =
    // stripe invoice id (one per failed invoice), matching v0 semantics.
    const windowKey =
      input.stripe_invoice_id ??
      `inv-na-${Math.floor(now.getTime() / (60 * 60 * 1000))}`;
    await this.enqueueReminder({
      purchase_id: purchase.id,
      recipient_user_id: purchase.client_user_id,
      kind: 'payment_failed',
      channel: 'inapp',
      window_key: windowKey,
    });
    await this.enqueueReminder({
      purchase_id: purchase.id,
      recipient_user_id: purchase.client_user_id,
      kind: 'payment_failed',
      channel: 'email',
      window_key: windowKey,
    });

    return row;
  }

  async recordResolution(purchaseId: string): Promise<DunningState | null> {
    const existing = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchaseId },
    });
    if (!existing || existing.status !== 'active') return existing;

    // Cancel pending cadence attempts so the tick loop won't fire them.
    // PR #281 P1-1: the where clause is scoped to status='pending' only —
    // any row currently in 'sending' (a tick worker has CAS-claimed it and
    // is mid-flight to the email provider) is left alone. Once the worker
    // finishes, it transitions sending → sent, and we never flip a sent
    // row back to cancelled. We DO stamp superseded_at on any failed/
    // retry-pending rows so ops can audit "customer received a reminder
    // after they paid" cases without losing the row history.
    await this.prisma.dunningAttempt.updateMany({
      where: { dunning_state_id: existing.id, status: 'pending' },
      data: { status: 'cancelled' },
    });
    await this.prisma.dunningAttempt.updateMany({
      where: {
        dunning_state_id: existing.id,
        status: { in: ['sending', 'failed'] },
      },
      data: { superseded_at: new Date() },
    });

    const updated = await this.prisma.dunningState.update({
      where: { purchase_id: purchaseId },
      data: {
        status: 'resolved',
        resolved_at: new Date(),
        recovered_at: new Date(),
        cancel_scheduled_at: null,
        next_attempt_at: null,
      },
    });

    this.metrics.inc('dunning_recovered_total');
    this.logEvent('dunning.recovered', {
      purchase_id: purchaseId,
      dunning_state_id: existing.id,
      step_index_at_recovery: existing.step_index,
    });

    // If any cadence step had already fired (step_index ≥ 0), send a
    // confirmation email so the customer sees the good-news payload too.
    if (existing.step_index >= 0) {
      await this.sendRecoveryEmail(updated);
    }

    return updated;
  }

  // Called by customer.subscription.deleted — Stripe has already canceled,
  // so we just mark the row abandoned and cancel remaining attempts. No
  // outbound email here (Stripe's own "sub cancelled" copy covers it, and
  // we don't want to double-message if the customer themselves chose to
  // cancel the failing sub).
  async terminate(
    purchaseId: string,
    reason: 'subscription_deleted' | 'admin_cancel' | 'grace_expired' =
      'subscription_deleted',
  ): Promise<DunningState | null> {
    const existing = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchaseId },
    });
    if (!existing) return null;
    if (existing.status === 'abandoned') return existing;

    await this.prisma.dunningAttempt.updateMany({
      where: { dunning_state_id: existing.id, status: 'pending' },
      data: { status: 'cancelled' },
    });

    const row = await this.prisma.dunningState.update({
      where: { purchase_id: purchaseId },
      data: {
        status: 'abandoned',
        abandoned_at: new Date(),
        next_attempt_at: null,
      },
    });

    this.metrics.inc('dunning_cancelled_total');
    this.logEvent('dunning.cancelled', {
      purchase_id: purchaseId,
      dunning_state_id: existing.id,
      reason,
    });

    return row;
  }

  // ── Cadence runner — drain due attempts and send their emails ──────────────

  async tick(now: Date = new Date(), limit = 100): Promise<{
    sent: number;
    skipped: number;
    failed: number;
  }> {
    // Two query passes so we don't have to OR over status — keeps the index
    // scan on (status, scheduled_for) and (status, next_retry_at) clean.
    //   1. status='pending' and scheduled_for <= now  — first-time sends.
    //   2. status='failed'  and next_retry_at  <= now — retries (PR #281 P2-3).
    const pendingDue = await this.prisma.dunningAttempt.findMany({
      where: { status: 'pending', scheduled_for: { lte: now } },
      orderBy: { scheduled_for: 'asc' },
      take: limit,
    });
    const retryDue = await this.prisma.dunningAttempt.findMany({
      where: { status: 'failed', next_retry_at: { lte: now } },
      orderBy: { next_retry_at: 'asc' },
      take: Math.max(0, limit - pendingDue.length),
    });
    const due = [...pendingDue, ...retryDue];

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const attempt of due) {
      const state = await this.prisma.dunningState.findUnique({
        where: { id: attempt.dunning_state_id },
      });
      if (!state || state.status !== 'active') {
        // The window resolved or was abandoned between scheduling and tick.
        await this.prisma.dunningAttempt.update({
          where: { id: attempt.id },
          data: { status: 'cancelled' },
        });
        skipped += 1;
        continue;
      }
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: state.purchase_id },
      });
      if (!purchase) {
        await this.prisma.dunningAttempt.update({
          where: { id: attempt.id },
          data: { status: 'skipped', failure_reason: 'no_purchase' },
        });
        skipped += 1;
        continue;
      }

      const result = await this.fireAttempt(attempt, state, purchase, now);
      if (result === 'sent') sent += 1;
      else if (result === 'skipped' || result === 'raced') skipped += 1;
      else failed += 1;
    }

    return { sent, skipped, failed };
  }

  // Fire one attempt — atomically claims the row (CAS pending|failed →
  // sending), sends the email, then transitions sending → sent. The CAS
  // claim closes the PR #281 P1-1 race: a concurrent recordResolution()
  // can only flip 'pending' rows to 'cancelled', so once a row is
  // 'sending' it is owned by this tick worker and the late-arriving
  // resolution leaves it alone (cancellation just sets superseded_at on
  // the now-in-flight row for audit).
  private async fireAttempt(
    attempt: DunningAttempt,
    state: DunningState,
    purchase: ClientPurchase,
    now: Date = new Date(),
  ): Promise<'sent' | 'skipped' | 'failed' | 'raced'> {
    // We accept either an initial pending row or a retry-eligible failed
    // row. Anything else is terminal for tick purposes.
    const fromStatus = attempt.status;
    if (fromStatus !== 'pending' && fromStatus !== 'failed') return 'skipped';

    // CAS claim: pending|failed → sending under a single SQL statement.
    // updateMany returns {count}, so count===0 means someone else (a
    // concurrent recordResolution / terminate / tick replica) already moved
    // the row out from under us. Bail without sending.
    const claim = await this.prisma.dunningAttempt.updateMany({
      where: { id: attempt.id, status: fromStatus },
      data: { status: 'sending' },
    });
    if (claim.count === 0) {
      this.metrics.inc('dunning_send_race_total');
      this.logEvent('dunning.attempt_raced', {
        purchase_id: purchase.id,
        dunning_state_id: state.id,
        attempt_id: attempt.id,
        step_index: attempt.step_index,
        from_status: fromStatus,
      });
      return 'raced';
    }

    const step = this.cadenceStep(attempt.step_index);
    const idemKey = `dunning:${attempt.id}`;

    try {
      // Special handling for the Day 14 "cancelled" cadence step (PR #281
      // P2-1): refresh subscription state from Stripe / DB before sending.
      // If the subscription is no longer pending cancellation, suppress the
      // outbound email — the cadence's job is done, the grace-period sweeper
      // / payment-recovery webhook handles the actual terminal copy.
      if (step?.kind === 'cancelled') {
        const fresh = await this.refreshCancellationView(state, purchase);
        if (!fresh.shouldSend) {
          await this.prisma.dunningAttempt.update({
            where: { id: attempt.id },
            data: {
              status: 'skipped',
              failure_reason: fresh.reason,
              email_idempotency_key: idemKey,
            },
          });
          this.logEvent('dunning.attempt_skipped', {
            purchase_id: purchase.id,
            attempt_id: attempt.id,
            step_index: attempt.step_index,
            reason: fresh.reason,
          });
          // We still advance step_index so the cadence moves on; the row
          // is terminal and the next tick won't re-pick it.
          await this.advanceState(state, attempt);
          return 'skipped';
        }
        // Apply the fresh cancellation date to the email payload below by
        // mutating a local view of state. We don't write the timestamp back
        // to DunningState here — the subscription webhook owns that.
        state = {
          ...state,
          cancel_scheduled_at: fresh.cancellationDate ?? state.cancel_scheduled_at,
        } as DunningState;
      }

      if (this.email) {
        const recipient = await this.lookupRecipientEmail(purchase.client_user_id);
        if (!recipient) {
          await this.prisma.dunningAttempt.update({
            where: { id: attempt.id },
            data: {
              status: 'skipped',
              failure_reason: 'no_recipient_email',
              email_idempotency_key: idemKey,
            },
          });
          this.logEvent('dunning.attempt_skipped', {
            purchase_id: purchase.id,
            attempt_id: attempt.id,
            step_index: attempt.step_index,
            reason: 'no_recipient_email',
          });
          return 'skipped';
        }
        const send = await this.email.send({
          to: recipient.email,
          template: step?.template ?? EmailTemplateKey.PAYMENT_REMINDER,
          idempotencyKey: idemKey,
          data: this.buildEmailData(state, purchase, recipient.name),
        });
        if (send.status === 'failed') {
          // Treat provider "failed" the same as a thrown exception so the
          // retry path is unified.
          throw new Error(send.error ?? 'email_provider_failed');
        }
        await this.prisma.dunningAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'sent',
            sent_at: new Date(),
            email_idempotency_key: idemKey,
            provider_message_id: send.providerMessageId,
            failure_reason: null,
            next_retry_at: null,
          },
        });
      } else {
        // No EmailService wired (test / dev). Mark sent anyway — the
        // cadence advance is what matters and the attempt row records
        // the would-have-been state.
        await this.prisma.dunningAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'sent',
            sent_at: new Date(),
            email_idempotency_key: idemKey,
            next_retry_at: null,
          },
        });
      }

      await this.advanceState(state, attempt);

      this.metrics.inc('dunning_attempt_sent_total');
      if (fromStatus === 'failed') this.metrics.inc('dunning_attempt_retry_succeeded_total');
      if (attempt.step_index >= 2) this.metrics.inc('dunning_escalated_total');
      this.logEvent('dunning.attempt_sent', {
        purchase_id: purchase.id,
        dunning_state_id: state.id,
        attempt_id: attempt.id,
        step_index: attempt.step_index,
        kind: attempt.kind,
        retried: fromStatus === 'failed',
      });
      return 'sent';
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      // Retry bookkeeping: bump retry_count, schedule next_retry_at, or
      // mark failed_permanent if we've blown the budget.
      const fresh = await this.prisma.dunningAttempt.findUnique({
        where: { id: attempt.id },
      });
      const nextCount = (fresh?.retry_count ?? attempt.retry_count ?? 0) + 1;
      if (nextCount > this.cfg.maxSendRetries) {
        await this.prisma.dunningAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'failed_permanent',
            failure_reason: msg.slice(0, 500),
            retry_count: nextCount,
            next_retry_at: null,
          },
        });
        this.metrics.inc('dunning_attempt_failed_permanent_total');
        this.logger.warn(
          `dunning.attempt_failed_permanent attempt=${attempt.id} step=${attempt.step_index} retries=${nextCount}: ${msg}`,
        );
        // Move the cadence forward so a stuck send doesn't block later
        // steps from firing.
        await this.advanceState(state, attempt);
      } else {
        const nextRetryAt = new Date(
          now.getTime() + this.cfg.retryBackoffMs * Math.pow(4, nextCount - 1),
        );
        await this.prisma.dunningAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'failed',
            failure_reason: msg.slice(0, 500),
            retry_count: nextCount,
            next_retry_at: nextRetryAt,
          },
        });
        this.metrics.inc('dunning_attempt_failed_total');
        this.logger.warn(
          `dunning.attempt_failed attempt=${attempt.id} step=${attempt.step_index} retry=${nextCount}/${this.cfg.maxSendRetries} next_at=${nextRetryAt.toISOString()}: ${msg}`,
        );
      }
      return 'failed';
    }
  }

  // ── Admin override ────────────────────────────────────────────────────────

  // Read full state — what payment-ops drill-down renders.
  async getAdminView(purchaseId: string): Promise<DunningAdminView> {
    const state = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchaseId },
    });
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: purchaseId },
    });
    const attempts = state
      ? await this.prisma.dunningAttempt.findMany({
          where: { dunning_state_id: state.id },
          orderBy: { step_index: 'asc' },
        })
      : [];
    return { state, attempts, purchase };
  }

  // Advance — fire the next pending cadence step immediately.
  async adminAdvance(purchaseId: string): Promise<DunningAdminView> {
    const state = await this.requireActiveState(purchaseId);
    const next = await this.prisma.dunningAttempt.findFirst({
      where: { dunning_state_id: state.id, status: 'pending' },
      orderBy: { step_index: 'asc' },
    });
    if (next) {
      await this.prisma.dunningAttempt.update({
        where: { id: next.id },
        data: { scheduled_for: new Date() },
      });
      await this.tick(new Date());
      this.logEvent('dunning.admin_advanced', {
        purchase_id: purchaseId,
        attempt_id: next.id,
      });
    }
    return this.getAdminView(purchaseId);
  }

  // Reset — wipe the in-flight cadence completely and re-arm so the next
  // webhook-driven recordFailure() starts a fresh Day 0 window. PR #281
  // P2-2: the previous implementation flipped pending rows to cancelled
  // but left them in place, which meant a subsequent recordFailure() on
  // the same purchase_id (no reopen branch because state.status stays
  // 'active') would hit (dunning_state_id, step_index) unique-violations
  // and silently skip scheduling any new attempts. We now hard-delete all
  // attempts and bring the state row back to the cleanest baseline short
  // of dropping it entirely — last_failure_at = null, failure_count = 0,
  // grace_period_ends_at and cancel_scheduled_at cleared. The state row
  // stays so getAdminView() can still find it for audit, but the next
  // failure walks the "existing && reopened-style" code path and gets a
  // fresh cadence scheduled from scratch.
  async adminReset(purchaseId: string): Promise<DunningAdminView> {
    const state = await this.requireActiveState(purchaseId);
    // Hard-delete attempts — cancelled rows would still occupy step_index
    // slots and unique-violate the next scheduleCadence(). See audit.
    await this.prisma.dunningAttempt.deleteMany({
      where: { dunning_state_id: state.id },
    });
    // Clear cadence + grace baselines so the next recordFailure() schedules
    // Day 0 at "now" rather than reusing a week-old window.
    await this.prisma.dunningState.update({
      where: { id: state.id },
      data: {
        next_attempt_at: null,
        step_index: -1,
        failure_count: 0,
        last_attempt_number: null,
        last_failed_amount_cents: null,
        last_failure_at: null,
        last_failure_reason: null,
        grace_period_ends_at: null,
        cancel_scheduled_at: null,
        recovered_at: null,
        resolved_at: null,
        escalated_at: null,
      },
    });
    this.metrics.inc('dunning_admin_reset_total');
    this.logEvent('dunning.admin_reset', {
      purchase_id: purchaseId,
      dunning_state_id: state.id,
    });
    return this.getAdminView(purchaseId);
  }

  // Cancel — abandon now + cancel Stripe subscription.
  async adminCancel(purchaseId: string): Promise<DunningAdminView> {
    const state = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchaseId },
    });
    if (state) {
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: purchaseId },
      });
      if (purchase?.stripe_subscription_id) {
        try {
          await this.stripe.cancelSubscription(purchase.stripe_subscription_id);
        } catch (err) {
          this.logger.warn(
            `adminCancel: cancelSubscription failed sub=${purchase.stripe_subscription_id}: ${(err as Error).message}`,
          );
        }
      }
      if (purchase) {
        await this.prisma.clientPurchase.update({
          where: { id: purchase.id },
          data: {
            status: 'canceled',
            entitlement_active: false,
            canceled_at: new Date(),
          },
        });
      }
      await this.terminate(purchaseId, 'admin_cancel');
    }
    return this.getAdminView(purchaseId);
  }

  // Trigger — re-fire the current step right now (creates an ad-hoc -1
  // attempt with a new idempotency key, so the EmailService dedupe doesn't
  // suppress it).
  async adminTriggerImmediate(purchaseId: string): Promise<DunningAdminView> {
    const state = await this.requireActiveState(purchaseId);
    const currentStep = Math.max(state.step_index, 0);
    const step = this.cadenceStep(currentStep);
    if (!step) return this.getAdminView(purchaseId);
    // Find a free negative step_index slot so we don't collide with the
    // primary cadence row.
    const existingAdhoc = await this.prisma.dunningAttempt.findMany({
      where: { dunning_state_id: state.id, step_index: { lt: 0 } },
      orderBy: { step_index: 'asc' },
    });
    const newSlot = existingAdhoc.length
      ? existingAdhoc[0].step_index - 1
      : -1;
    await this.prisma.dunningAttempt.create({
      data: {
        dunning_state_id: state.id,
        step_index: newSlot,
        kind: step.kind,
        scheduled_for: new Date(),
        status: 'pending',
      },
    });
    await this.tick(new Date());
    this.logEvent('dunning.admin_triggered', {
      purchase_id: purchaseId,
      step_index: currentStep,
      kind: step.kind,
    });
    return this.getAdminView(purchaseId);
  }

  // ── Sweeper — kept for v0 compatibility, now also drives the cadence tick.

  async runSweeper(
    now: Date = new Date(),
  ): Promise<{
    scanned: number;
    canceled: number;
    final_warned: number;
    cadence_sent: number;
  }> {
    // First drain the cadence so any due attempts fire before we check
    // for expired-grace rows.
    const tickResult = await this.tick(now);

    const expired = await this.findExpiredGracePeriods(now);
    let canceled = 0;
    for (const row of expired) {
      const out = await this.abandonAndCancel(row);
      if (out.stripe_canceled) canceled += 1;
    }

    // Final-warning legacy sweep — kept for purchases whose
    // cancel_scheduled_at sits inside 24h but the cadence Day 7 attempt
    // somehow didn't run (e.g. created before v1 shipped). New v1 windows
    // get their final-notice from the cadence itself.
    const warningCutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const upcoming = await this.prisma.dunningState.findMany({
      where: {
        status: 'active',
        cancel_scheduled_at: { not: null, gt: now, lte: warningCutoff },
      },
      take: 50,
    });
    let finalWarned = 0;
    for (const row of upcoming) {
      const purchase = await this.prisma.clientPurchase.findUnique({
        where: { id: row.purchase_id },
      });
      if (!purchase) continue;
      const result = await this.enqueueReminder({
        purchase_id: row.purchase_id,
        recipient_user_id: purchase.client_user_id,
        kind: 'final_warning',
        channel: 'email',
        window_key: `final-warning-${row.id}`,
      });
      if (result) finalWarned += 1;
      await this.enqueueReminder({
        purchase_id: row.purchase_id,
        recipient_user_id: purchase.client_user_id,
        kind: 'final_warning',
        channel: 'inapp',
        window_key: `final-warning-${row.id}`,
      });
    }

    return {
      scanned: expired.length,
      canceled,
      final_warned: finalWarned,
      cadence_sent: tickResult.sent,
    };
  }

  async findExpiredGracePeriods(
    now: Date = new Date(),
    limit = 50,
  ): Promise<DunningState[]> {
    return this.prisma.dunningState.findMany({
      where: {
        status: 'active',
        OR: [
          { grace_period_ends_at: { lte: now } },
          { cancel_scheduled_at: { lte: now } },
        ],
      },
      orderBy: { grace_period_ends_at: 'asc' },
      take: limit,
    });
  }

  async abandonAndCancel(
    dunning: DunningState,
  ): Promise<{ purchase: ClientPurchase | null; stripe_canceled: boolean }> {
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: dunning.purchase_id },
    });
    let stripeCanceled = false;
    if (purchase?.stripe_subscription_id) {
      try {
        await this.stripe.cancelSubscription(purchase.stripe_subscription_id);
        stripeCanceled = true;
      } catch (err) {
        this.logger.warn(
          `cancelSubscription failed sub=${purchase.stripe_subscription_id}: ${(err as Error).message}`,
        );
      }
    }
    // Cancel pending attempts so the tick loop won't keep firing.
    await this.prisma.dunningAttempt.updateMany({
      where: { dunning_state_id: dunning.id, status: 'pending' },
      data: { status: 'cancelled' },
    });
    await this.prisma.dunningState.update({
      where: { id: dunning.id },
      data: {
        status: 'abandoned',
        abandoned_at: new Date(),
        next_attempt_at: null,
      },
    });
    if (purchase) {
      await this.prisma.clientPurchase.update({
        where: { id: purchase.id },
        data: {
          status: 'canceled',
          entitlement_active: false,
          canceled_at: new Date(),
        },
      });
      await this.enqueueReminder({
        purchase_id: purchase.id,
        recipient_user_id: purchase.client_user_id,
        kind: 'canceled_for_nonpayment',
        channel: 'email',
        window_key: `final-${dunning.id}`,
      });
      await this.enqueueReminder({
        purchase_id: purchase.id,
        recipient_user_id: purchase.client_user_id,
        kind: 'canceled_for_nonpayment',
        channel: 'inapp',
        window_key: `final-${dunning.id}`,
      });
    }
    this.metrics.inc('dunning_cancelled_total');
    this.logEvent('dunning.cancelled', {
      purchase_id: dunning.purchase_id,
      dunning_state_id: dunning.id,
      reason: 'grace_expired',
      stripe_canceled: stripeCanceled,
    });
    return { purchase, stripe_canceled: stripeCanceled };
  }

  // ── Reminder helpers (kept for v0 compatibility) ───────────────────────────

  async enqueueReminder(args: {
    purchase_id: string;
    recipient_user_id: string;
    kind: string;
    channel: string;
    window_key: string;
  }): Promise<PaymentReminder | null> {
    try {
      return await this.prisma.paymentReminder.create({
        data: {
          purchase_id: args.purchase_id,
          recipient_user_id: args.recipient_user_id,
          kind: args.kind,
          channel: args.channel,
          window_key: args.window_key,
          status: 'queued',
        },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async markReminderSent(reminderId: string) {
    return this.prisma.paymentReminder.update({
      where: { id: reminderId },
      data: { status: 'sent', sent_at: new Date() },
    });
  }

  async markReminderFailed(reminderId: string, reason: string) {
    return this.prisma.paymentReminder.update({
      where: { id: reminderId },
      data: { status: 'failed', failure_reason: reason },
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async scheduleCadence(state: DunningState, now: Date) {
    const earliestScheduled = new Date(
      now.getTime() + this.cfg.cadence[0].dayOffset * 24 * 3600 * 1000,
    );
    for (const step of this.cfg.cadence) {
      const idx = this.cfg.cadence.indexOf(step);
      const scheduledFor = new Date(
        now.getTime() + step.dayOffset * 24 * 3600 * 1000,
      );
      try {
        await this.prisma.dunningAttempt.create({
          data: {
            dunning_state_id: state.id,
            step_index: idx,
            kind: step.kind,
            scheduled_for: scheduledFor,
            status: 'pending',
          },
        });
        this.logEvent('dunning.attempt_scheduled', {
          purchase_id: state.purchase_id,
          dunning_state_id: state.id,
          step_index: idx,
          scheduled_for: scheduledFor.toISOString(),
          kind: step.kind,
        });
      } catch (err) {
        // Unique violation = the cadence was already scheduled for this
        // window (e.g. a duplicate webhook). Safe to ignore.
        if (!this.isUniqueViolation(err)) throw err;
      }
    }
    await this.prisma.dunningState.update({
      where: { id: state.id },
      data: { next_attempt_at: earliestScheduled },
    });
  }

  private async advanceState(state: DunningState, attempt: DunningAttempt) {
    // Don't regress step_index when an ad-hoc -1 attempt fires.
    const newStep = Math.max(state.step_index, attempt.step_index);
    const nextPending = await this.prisma.dunningAttempt.findFirst({
      where: {
        dunning_state_id: state.id,
        status: 'pending',
        step_index: { gte: 0 },
      },
      orderBy: { scheduled_for: 'asc' },
    });
    await this.prisma.dunningState.update({
      where: { id: state.id },
      data: {
        step_index: newStep,
        next_attempt_at: nextPending?.scheduled_for ?? null,
        ...(attempt.step_index >= 2 ? { escalated_at: new Date() } : {}),
      },
    });
  }

  // PR #281 P2-1: by the time the Day 14 cadence step fires, the
  // cancellation timestamps on DunningState (cancel_scheduled_at /
  // grace_period_ends_at) may be a week stale — they were stamped at Day 0
  // / Day 7 and the customer may have updated cards, paid out-of-band,
  // or cancelled themselves in between. Refresh from the freshest source
  // available (Stripe Subscription.cancel_at / canceled_at), with a
  // graceful fallback to a forward-looking +24h if Stripe doesn't surface
  // a future cancel_at. Returns shouldSend=false if the subscription is
  // no longer pending cancellation (already canceled OR not flagged for
  // cancel-at-period-end and not past_due) so we don't email a customer
  // about a cancellation that's no longer scheduled.
  private async refreshCancellationView(
    state: DunningState,
    purchase: ClientPurchase,
  ): Promise<{
    shouldSend: boolean;
    cancellationDate: Date | null;
    reason: string;
  }> {
    if (!purchase.stripe_subscription_id) {
      // No subscription to inspect — fall back to the recorded cancel
      // timestamp, but only if it's still forward-looking.
      const cd = state.cancel_scheduled_at ?? state.grace_period_ends_at;
      if (!cd || cd.getTime() <= Date.now()) {
        return {
          shouldSend: false,
          cancellationDate: null,
          reason: 'cancellation_date_in_past',
        };
      }
      return { shouldSend: true, cancellationDate: cd, reason: 'no_stripe_sub' };
    }
    try {
      const sub = await this.stripe.retrieveSubscription(
        purchase.stripe_subscription_id,
      );
      // Already canceled — the customer.subscription.deleted webhook will
      // (or already did) drive the terminal copy; don't double-message.
      if (sub.status === 'canceled' || sub.canceled_at) {
        return {
          shouldSend: false,
          cancellationDate: null,
          reason: 'subscription_already_canceled',
        };
      }
      // Subscription recovered (active / trialing) and no longer flagged
      // for cancel-at-period-end — customer paid and we don't need to send
      // a Day 14 "final" copy at all.
      const stillPendingCancel =
        sub.cancel_at_period_end === true ||
        typeof (sub as Record<string, unknown>).cancel_at === 'number' ||
        sub.status === 'past_due' ||
        sub.status === 'unpaid';
      if (!stillPendingCancel) {
        return {
          shouldSend: false,
          cancellationDate: null,
          reason: 'subscription_no_longer_pending_cancel',
        };
      }
      // Build a fresh cancellation date. Stripe's `cancel_at` (seconds-
      // since-epoch) is the source of truth when set; otherwise fall back
      // to current_period_end; final fallback is now + 24h so the email
      // never shows a past date.
      const cancelAtSec =
        (sub as Record<string, unknown>).cancel_at as number | undefined;
      const periodEndSec = sub.current_period_end;
      const fallbackMs = Date.now() + 24 * 60 * 60 * 1000;
      const cancellationMs =
        (typeof cancelAtSec === 'number' && cancelAtSec * 1000) ||
        (typeof periodEndSec === 'number' && periodEndSec * 1000) ||
        fallbackMs;
      const fresh = new Date(
        cancellationMs > Date.now() ? cancellationMs : fallbackMs,
      );
      return {
        shouldSend: true,
        cancellationDate: fresh,
        reason: 'refreshed_from_stripe',
      };
    } catch (err) {
      // Stripe failures shouldn't block the send entirely — fall back to
      // a forward-looking +24h so the email at least shows a sane date.
      this.logger.warn(
        `dunning.refreshCancellationView Stripe fetch failed sub=${purchase.stripe_subscription_id}: ${(err as Error).message}`,
      );
      return {
        shouldSend: true,
        cancellationDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        reason: 'stripe_fetch_failed_fallback',
      };
    }
  }

  private async sendRecoveryEmail(state: DunningState) {
    if (!this.email) return;
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: state.purchase_id },
    });
    if (!purchase) return;
    const recipient = await this.lookupRecipientEmail(purchase.client_user_id);
    if (!recipient) return;
    try {
      await this.email.send({
        to: recipient.email,
        template: EmailTemplateKey.PAYMENT_RECOVERED,
        idempotencyKey: `dunning-recovered:${state.id}`,
        data: this.buildEmailData(state, purchase, recipient.name),
      });
    } catch (err) {
      this.logger.warn(
        `dunning.sendRecoveryEmail failed state=${state.id}: ${(err as Error).message}`,
      );
    }
  }

  private async lookupRecipientEmail(
    userId: string,
  ): Promise<{ email: string; name: string | null } | null> {
    try {
      const u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true },
      });
      if (!u || !u.email) return null;
      return { email: u.email, name: u.name ?? null };
    } catch {
      return null;
    }
  }

  private buildEmailData(
    state: DunningState,
    purchase: ClientPurchase,
    recipientName: string | null,
  ): Record<string, unknown> {
    const amount = state.last_failed_amount_cents ?? purchase.amount_cents;
    const cancellation = state.cancel_scheduled_at ?? state.grace_period_ends_at;
    return {
      recipient_name: recipientName ?? null,
      amount_display: formatCurrency(amount, purchase.currency ?? 'usd'),
      cancellation_date: cancellation
        ? cancellation.toISOString().slice(0, 10)
        : null,
      billing_portal_url: process.env.BILLING_PORTAL_URL ?? 'https://thegrowthproject.app/billing',
      coach_name: null,
    };
  }

  private async requireActiveState(purchaseId: string): Promise<DunningState> {
    const state = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchaseId },
    });
    if (!state) {
      throw new Error(`dunning: no state for purchase ${purchaseId}`);
    }
    if (state.status !== 'active') {
      throw new Error(
        `dunning: state for purchase ${purchaseId} is ${state.status}, not active`,
      );
    }
    return state;
  }

  private cadenceStep(index: number): DunningCadenceStep | null {
    if (index < 0 || index >= this.cfg.cadence.length) return null;
    return this.cfg.cadence[index];
  }

  private computeGracePeriodEnd(now: Date): Date {
    return new Date(now.getTime() + this.cfg.graceDays * 24 * 60 * 60 * 1000);
  }

  private computeCancelScheduledAt(
    existing: DunningState | null,
    attemptNumber: number | null,
    now: Date,
  ): Date {
    if (
      typeof attemptNumber === 'number' &&
      attemptNumber >= this.cfg.maxFailures
    ) {
      return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
    return existing?.cancel_scheduled_at ?? this.computeGracePeriodEnd(now);
  }

  private isUniqueViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: string; message?: string };
    if (e.code === 'P2002') return true;
    return /unique constraint/i.test(e.message ?? '');
  }

  private logEvent(event: string, fields: Record<string, unknown>) {
    // Single-line JSON the Fly log shipper picks up; production Datadog
    // pipeline indexes on `event` and `dunning_state_id`.
    try {
      this.logger.log(JSON.stringify({ event, ...fields }));
    } catch {
      this.logger.log(`${event} ${JSON.stringify({ event })}`);
    }
  }
}

function formatCurrency(cents: number | null | undefined, currency: string): string {
  if (cents == null) return '';
  const amount = (cents / 100).toFixed(2);
  const cur = (currency ?? 'usd').toUpperCase();
  return cur === 'USD' ? `$${amount}` : `${amount} ${cur}`;
}
