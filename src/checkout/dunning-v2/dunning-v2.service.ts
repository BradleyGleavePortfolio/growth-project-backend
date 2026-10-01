import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ClientPurchase, DunningState, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { StripeConnectApiService } from '../../connect/stripe-connect-api.service';
import { NotificationKind } from '../../notifications/notification-kind';
import { isDunningV2Enabled } from './dunning-v2.feature';
import { DunningV2Telemetry } from './dunning-v2.telemetry';
import { DispatchContext, DunningV2Dispatcher } from './dunning-v2.dispatcher';
import {
  DUNNING_V2_DAY_MS,
  DUNNING_V2_LOCKOUT_DAY,
  DUNNING_V2_REVERSAL_COACH_GAP_DAYS,
  DUNNING_V2_REVERSAL_ENTRY_STEP,
  DUNNING_V2_REVERSAL_LOCKOUT_GAP_DAYS,
  DunningV2State,
  dunningV2LockoutAt,
  dunningV2StepForElapsed,
} from './dunning-v2.cadence';

/**
 * B3 Smart Dunning v2 — the state machine that drives the owner's 10-day
 * non-payment sequence (S-DUNNING rewrite of the B3 service).
 *
 * WHO CHARGES: Stripe, never this code. Stripe's retry schedule (dashboard:
 * Revenue recovery > Retries, custom schedule 1 / 2 / 4 days after the
 * previous attempt = Days 1 / 3 / 7) performs every charge. There is no
 * charge, invoice-pay or payment-intent call anywhere in v2, so v2 cannot
 * double charge. v2 only (a) tracks the cycle, (b) sends the Day 0/1/3/7
 * notices, (c) locks on Day 10, (d) unlocks on payment.
 *
 * CYCLE ANCHOR: `DunningState.entered_at` is the instant of the first failed
 * charge of the CURRENT cycle (Day 0). v1 `recordFailure` creates the row (or
 * reopens a resolved one) with `step_index = -1`; the first v2 call claims
 * the row by CAS (`step_index: -1 -> 0`) and stamps `entered_at`. Every later
 * step is derived from elapsed time since `entered_at`, never from Stripe's
 * `attempt_count`, so notices follow the owner's calendar even when Stripe's
 * schedule differs or a hard decline suppresses the retry webhooks.
 *
 * STEP CLAIMS: a step's notices are sent only by the caller whose
 * `updateMany({ where: { id, status: 'active', step_index: <prev> } })`
 * returns count 1. Duplicate webhooks, overlapping crons on several machines
 * and a webhook racing the cron all collapse to one send per step.
 *
 * ELIGIBILITY: only paid recurring Stripe subscriptions enter v2. A purchase
 * with `amount_cents <= 0`, no `stripe_subscription_id`, or a non-recurring
 * billing type (invite-code / free / comp grants, one-time packages) is never
 * claimed, never notified and never locked.
 *
 * Every public method is a hard no-op while FEATURE_DUNNING_V2 is OFF.
 *
 * State vocabulary (spec §1), mapped onto the v1 columns:
 *   INACTIVE  -> no row, or status 'resolved'/'abandoned' with no active cycle.
 *   ACTIVE    -> status 'active', locked_out_at IS NULL.
 *   LOCKED    -> status 'active', locked_out_at IS NOT NULL (Day-10 sweep).
 *   RECOVERED -> status 'resolved', recovered_at set.
 */

/** The prisma surface v2 writes through: the root client or an open tx. */
export type DunningV2Db = Prisma.TransactionClient | PrismaService;

/** A claimed step whose notices still need to be sent (outside any tx). */
export interface DunningV2StepClaim {
  dunningStateId: string;
  purchaseId: string;
  stepIndex: number;
  isLateReversalCycle: boolean;
}

/** What the client app reads to render the Day 0-9 banner or the lockout. */
export interface ClientDunningStatus {
  /** False while FEATURE_DUNNING_V2 is off: no banner, no lockout screen. */
  enabled: boolean;
  state: 'none' | 'past_due' | 'locked';
  purchase_id: string | null;
  amount_cents: number | null;
  currency: string | null;
  /** First failed charge of the cycle (Day 0), ISO. */
  failed_at: string | null;
  /** The Day-10 instant access pauses (past_due) or paused (locked), ISO. */
  lockout_at: string | null;
  locked_at: string | null;
  /** Whole days since the first failure, 0-based. */
  day: number | null;
  coach_name: string | null;
  card_last4: string | null;
  /** The client action that ends the cycle: POST this route for a portal URL. */
  update_payment_route: '/v1/checkout/billing-portal';
}

const PAID_STRIPE_STATUSES = new Set(['active', 'trialing']);

/** `last_failure_reason` marker of a compressed late-reversal (dispute) cycle. */
export const DUNNING_V2_REVERSAL_REASON = 'charge_disputed';

@Injectable()
export class DunningV2Service {
  private readonly logger = new Logger(DunningV2Service.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telemetry: DunningV2Telemetry,
    @Optional() private readonly dispatcher?: DunningV2Dispatcher,
    @Optional() private readonly stripe?: StripeConnectApiService,
  ) {}

  private enabled(): boolean {
    return isDunningV2Enabled();
  }

  /** Spec §1 state mapping. Pure. */
  static deriveState(
    row: {
      status: string;
      locked_out_at: Date | null;
      recovered_at: Date | null;
    } | null,
  ): DunningV2State {
    if (!row) return 'INACTIVE';
    if (row.status === 'active') {
      return row.locked_out_at ? 'LOCKED' : 'ACTIVE';
    }
    if (row.status === 'resolved') {
      return row.recovered_at ? 'RECOVERED' : 'INACTIVE';
    }
    return 'INACTIVE';
  }

  /**
   * True when a purchase may enter v2 dunning: a paid, recurring Stripe
   * subscription. Invite-code / free / comp grants ($0, no subscription) and
   * one-time packages never qualify. Pure.
   */
  static isEligiblePurchase(
    purchase: Pick<ClientPurchase, 'amount_cents' | 'billing_type' | 'stripe_subscription_id'>,
  ): boolean {
    if (!purchase.stripe_subscription_id) return false;
    if (purchase.billing_type !== 'recurring') return false;
    if (!(purchase.amount_cents > 0)) return false;
    // Forward-compatible comp-grant guard: once the entitlement source column
    // (C01) lands, any purchase that carries a non-null `source` is a grant.
    const source = (purchase as { source?: unknown }).source;
    if (source !== undefined && source !== null) return false;
    return true;
  }

  // ── Failure entry (invoice.payment_failed) ────────────────────────────────
  /**
   * Called after v1 `recordFailure` for every `invoice.payment_failed` on a
   * package subscription. Claims Day 0 for a fresh cycle (stamping
   * `entered_at`) or advances an existing cycle to the step its elapsed time
   * calls for. DB-only; returns the claimed step (if any) so the caller can
   * send the notices AFTER its own transaction work, outside any DB tx.
   */
  async recordPaymentFailed(
    purchaseId: string,
    now: Date = new Date(),
  ): Promise<DunningV2StepClaim | null> {
    if (!this.enabled()) return null;
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: purchaseId },
    });
    if (!purchase || !DunningV2Service.isEligiblePurchase(purchase)) {
      return null;
    }
    const state = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchaseId },
    });
    if (!state || state.status !== 'active') return null;

    if (state.step_index < 0 || state.entered_at == null) {
      // Fresh cycle (v1 just created / reopened the row): claim Day 0.
      const claimed = await this.prisma.dunningState.updateMany({
        where: { id: state.id, status: 'active', step_index: state.step_index },
        data: { step_index: 0, entered_at: now, locked_out_at: null },
      });
      if (claimed.count !== 1) return null;
      return {
        dunningStateId: state.id,
        purchaseId,
        stepIndex: 0,
        isLateReversalCycle: false,
      };
    }
    return this.advance(state, now);
  }

  /**
   * Advance one active, unlocked cycle to the step its elapsed time calls
   * for. Claims at most one step per call (a cycle that skipped ahead sends
   * only the latest step's notices, never a burst). Returns the claim or null.
   */
  async advance(
    state: Pick<
      DunningState,
      'id' | 'purchase_id' | 'step_index' | 'entered_at' | 'last_failure_reason'
    >,
    now: Date = new Date(),
  ): Promise<DunningV2StepClaim | null> {
    if (!this.enabled() || state.entered_at == null) return null;
    const target = dunningV2StepForElapsed(now.getTime() - state.entered_at.getTime());
    if (target <= state.step_index) return null;
    const claimed = await this.prisma.dunningState.updateMany({
      where: {
        id: state.id,
        status: 'active',
        locked_out_at: null,
        step_index: state.step_index,
      },
      data: {
        step_index: target,
        ...(target >= 2 ? { escalated_at: now } : {}),
      },
    });
    if (claimed.count !== 1) return null;
    return {
      dunningStateId: state.id,
      purchaseId: state.purchase_id,
      stepIndex: target,
      isLateReversalCycle: state.last_failure_reason === DUNNING_V2_REVERSAL_REASON,
    };
  }

  /**
   * Send the notices for a claimed step: client push / email / in-app blocker
   * and, at Day 7, the coach on all three channels (classifier ladder).
   * Never throws; a transport failure is logged by the dispatcher.
   */
  async dispatchClaim(claim: DunningV2StepClaim | null): Promise<void> {
    if (!claim || !this.dispatcher) return;
    try {
      const ctx = await this.buildDispatchContext(claim);
      if (!ctx) return;
      await this.dispatcher.dispatchStep(ctx);
    } catch (err) {
      this.logger.warn(
        `dunning v2 dispatch failed state=${claim.dunningStateId} step=${claim.stepIndex}: ${(err as Error).message}`,
      );
    }
  }

  // ── Hourly sweep: advance steps + Day-10 lockout ──────────────────────────
  /**
   * One sweep tick. For every active, unlocked, claimed cycle: lock it if it
   * reached Day 10 (with positive evidence it is still unpaid), otherwise
   * advance it to its due step and send that step's notices. Bounded to
   * `limit` rows per tick (oldest first); idempotent and overlap-safe.
   */
  async runSweep(
    now: Date = new Date(),
    limit = 500,
  ): Promise<{ locked: number; advanced: number; skipped: number }> {
    if (!this.enabled()) return { locked: 0, advanced: 0, skipped: 0 };
    // Only v2-CLAIMED cycles (step_index >= 0, entered_at stamped by the claim).
    // An unclaimed row (step_index -1) is a v1-era or just-reopened cycle whose
    // entered_at may belong to an EARLIER cycle; sweeping it could lock a
    // client on the spot. It is adopted by its next invoice.payment_failed.
    const rows = await this.prisma.dunningState.findMany({
      where: {
        status: 'active',
        locked_out_at: null,
        step_index: { gte: 0 },
        entered_at: { not: null },
      },
      orderBy: { entered_at: 'asc' },
      take: limit,
    });
    let locked = 0;
    let advanced = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        const lockAt = dunningV2LockoutAt(row.entered_at as Date);
        if (now.getTime() >= lockAt.getTime()) {
          const outcome = await this.tryLock(row, now);
          if (outcome === 'locked') locked += 1;
          else skipped += 1;
          continue;
        }
        const claim = await this.advance(row, now);
        if (claim) {
          advanced += 1;
          await this.dispatchClaim(claim);
        }
      } catch (err) {
        skipped += 1;
        this.logger.warn(`dunning v2 sweep row failed state=${row.id}: ${(err as Error).message}`);
      }
    }
    return { locked, advanced, skipped };
  }

  /** @deprecated name kept for callers/tests: the sweep (lock + advance). */
  async runLockoutSweep(now: Date = new Date()): Promise<{ locked: number }> {
    const { locked } = await this.runSweep(now);
    return { locked };
  }

  /**
   * Lock one Day-10 cycle. Requires positive evidence of non-payment (spec P8:
   * never lock on a TGP-side fault): the purchase is still eligible and
   * `past_due`/`unpaid`, and — when Stripe is reachable — the subscription is
   * not paid. A Stripe error skips this tick (retried next hour) instead of
   * locking on uncertainty. The lock itself is a CAS on `locked_out_at: null`.
   */
  private async tryLock(row: DunningState, now: Date): Promise<'locked' | 'skipped'> {
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: row.purchase_id },
    });
    if (!purchase || !DunningV2Service.isEligiblePurchase(purchase)) {
      return 'skipped';
    }
    if (purchase.status !== 'past_due' && purchase.status !== 'unpaid') {
      this.logger.warn(
        `dunning v2 lock skipped state=${row.id}: purchase status ${purchase.status} is not past_due`,
      );
      return 'skipped';
    }
    if (this.stripe && purchase.stripe_subscription_id) {
      try {
        const sub = await this.stripe.retrieveSubscription(purchase.stripe_subscription_id);
        if (PAID_STRIPE_STATUSES.has(String(sub.status))) {
          this.logger.warn(
            `dunning v2 lock skipped state=${row.id}: Stripe reports subscription ${String(sub.status)}; waiting for invoice.paid`,
          );
          return 'skipped';
        }
        if (String(sub.status) === 'canceled') return 'skipped';
      } catch (err) {
        this.logger.warn(
          `dunning v2 lock deferred state=${row.id}: Stripe check failed: ${(err as Error).message}`,
        );
        return 'skipped';
      }
    }
    let won = false;
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.dunningState.updateMany({
        where: { id: row.id, status: 'active', locked_out_at: null },
        data: { locked_out_at: now, step_index: Math.max(row.step_index, 3) },
      });
      if (res.count !== 1) return;
      won = true;
      await tx.clientPurchase.update({
        where: { id: row.purchase_id },
        data: { entitlement_active: false },
      });
    });
    if (!won) return 'skipped';
    this.telemetry.lockoutEntered(row.purchase_id, { dunning_state_id: row.id });
    this.logger.log(
      JSON.stringify({
        event: 'dunning_v2.locked',
        dunning_state_id: row.id,
        purchase_id: row.purchase_id,
        entered_at: (row.entered_at as Date).toISOString(),
      }),
    );
    return 'locked';
  }

  // ── §5 Recovery — immediate clear on payment ──────────────────────────────
  /**
   * Run right after v1 `recordResolution` on `invoice.paid`. Lifts a Day-10
   * lockout (and restores the entitlement the sweep turned off), dismisses
   * this client's open dunning blockers and revokes recovery tokens.
   *
   * `db` MUST be the caller's open transaction when one is held: BillingService
   * runs the webhook inside an interactive transaction that already holds the
   * ClientPurchase row lock (the renewal resync update). Writing that row on a
   * second connection would wait on our own lock until the transaction timed
   * out. With `db` the writes join the caller's transaction instead.
   *
   * Idempotent: a second call finds nothing locked and nothing to dismiss.
   */
  async applyImmediateClear(
    purchaseId: string,
    via: 'card_update' | 'retry' | 'manual' = 'retry',
    db?: DunningV2Db,
  ): Promise<{ liftedLockout: boolean }> {
    if (!this.enabled()) return { liftedLockout: false };
    const client: DunningV2Db = db ?? this.prisma;

    const state = await client.dunningState.findUnique({
      where: { purchase_id: purchaseId },
      select: {
        id: true,
        locked_out_at: true,
        purchase_id: true,
        purchase: { select: { client_user_id: true } },
      },
    });
    if (!state) return { liftedLockout: false };
    const wasLocked = state.locked_out_at != null;

    const run = async (w: DunningV2Db) => {
      if (wasLocked) {
        await w.dunningState.update({
          where: { id: state.id },
          data: { locked_out_at: null },
        });
        await w.clientPurchase.update({
          where: { id: purchaseId },
          data: { entitlement_active: true },
        });
      }
      // Dismiss THIS client's open blockers only (never another tenant's).
      await w.notification.updateMany({
        where: {
          user_id: state.purchase.client_user_id,
          kind: NotificationKind.DUNNING_BLOCKER,
          read_at: null,
        },
        data: { read_at: new Date() },
      });
      const attempts = await w.dunningAttempt.findMany({
        where: { dunning_state_id: state.id },
        select: { id: true },
      });
      if (attempts.length > 0) {
        await w.paymentRecoveryToken.updateMany({
          where: {
            dunning_attempt_id: { in: attempts.map((a) => a.id) },
            used_at: null,
          },
          data: { used_at: new Date() },
        });
      }
    };
    if (db) {
      await run(db);
    } else {
      await this.prisma.$transaction(async (tx) => run(tx));
    }

    this.telemetry.recovered(state.purchase_id, via);
    if (wasLocked) {
      this.telemetry.lockoutExited(state.purchase_id, {
        dunning_state_id: state.id,
      });
    }
    return { liftedLockout: wasLocked };
  }

  // ── §6 Late reversal (dispute on a cleared payment) ───────────────────────
  /**
   * Open a compressed cycle when a PREVIOUSLY CLEARED payment is disputed
   * (spec §6). Enters at Step 2 (Day-3 equivalent): `entered_at` is set three
   * days in the past so the Day-7 coach step and the Day-10 lockout fall 4 and
   * 7 days from now, driven by the same hourly sweep as a normal cycle.
   * Only `charge.dispute.created` reaches this (a refund the coach issued is
   * never treated as non-payment).
   */
  async handleLateReversal(input: {
    purchaseId: string;
    reversedChargeAt: Date;
    now?: Date;
  }): Promise<{ opened: boolean; reason: string; claim?: DunningV2StepClaim }> {
    if (!this.enabled()) return { opened: false, reason: 'flag_off' };
    const now = input.now ?? new Date();

    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: input.purchaseId },
    });
    if (!purchase || !DunningV2Service.isEligiblePurchase(purchase)) {
      return { opened: false, reason: 'not_eligible' };
    }
    const state = await this.prisma.dunningState.findUnique({
      where: { purchase_id: input.purchaseId },
      select: { id: true, status: true, resolved_at: true, purchase_id: true },
    });
    if (!state) return { opened: false, reason: 'no_state' };
    if (state.status === 'active') {
      return { opened: false, reason: 'cycle_already_active' };
    }
    const previouslyCleared =
      state.status === 'resolved' &&
      state.resolved_at != null &&
      input.reversedChargeAt.getTime() >= state.resolved_at.getTime();
    if (!previouslyCleared) {
      return { opened: false, reason: 'not_a_cleared_payment_reversal' };
    }

    const enteredAt = new Date(
      now.getTime() -
        (DUNNING_V2_LOCKOUT_DAY -
          DUNNING_V2_REVERSAL_COACH_GAP_DAYS -
          DUNNING_V2_REVERSAL_LOCKOUT_GAP_DAYS) *
          DUNNING_V2_DAY_MS,
    );
    const opened = await this.prisma.dunningState.updateMany({
      where: { id: state.id, status: state.status },
      data: {
        status: 'active',
        step_index: DUNNING_V2_REVERSAL_ENTRY_STEP,
        reversal_count: { increment: 1 },
        resolved_at: null,
        recovered_at: null,
        last_failure_at: now,
        last_failure_reason: DUNNING_V2_REVERSAL_REASON,
        entered_at: enteredAt,
        next_attempt_at: addDays(now, DUNNING_V2_REVERSAL_COACH_GAP_DAYS),
        locked_out_at: null,
      },
    });
    if (opened.count !== 1) {
      return { opened: false, reason: 'cycle_already_active' };
    }
    await this.prisma.clientPurchase.update({
      where: { id: input.purchaseId },
      data: { status: 'past_due' },
    });

    this.telemetry.reversalDetected(state.purchase_id, {
      dunning_state_id: state.id,
      entry_step: DUNNING_V2_REVERSAL_ENTRY_STEP,
      lockout_in_days: DUNNING_V2_REVERSAL_COACH_GAP_DAYS + DUNNING_V2_REVERSAL_LOCKOUT_GAP_DAYS,
    });
    const claim: DunningV2StepClaim = {
      dunningStateId: state.id,
      purchaseId: state.purchase_id,
      stepIndex: DUNNING_V2_REVERSAL_ENTRY_STEP,
      isLateReversalCycle: true,
    };
    await this.dispatchClaim(claim);
    return { opened: true, reason: 'compressed_cycle_opened', claim };
  }

  /**
   * Late-reversal entry from the webhook (dispute created). Resolves the
   * purchase from the disputed charge and delegates. No-op while flag off.
   */
  async detectAndHandleLateReversal(input: {
    chargeId: string | null;
    paymentIntentId?: string | null;
    reversedChargeAt: Date;
    now?: Date;
  }): Promise<{ opened: boolean; reason: string }> {
    if (!this.enabled()) return { opened: false, reason: 'flag_off' };
    const purchaseId = await this.resolvePurchaseFromCharge(
      input.chargeId,
      input.paymentIntentId ?? null,
    );
    if (!purchaseId) return { opened: false, reason: 'purchase_unresolved' };
    const res = await this.handleLateReversal({
      purchaseId,
      reversedChargeAt: input.reversedChargeAt,
      now: input.now,
    });
    return { opened: res.opened, reason: res.reason };
  }

  // ── Client read model (banner + lockout screen) ───────────────────────────
  /**
   * The signed-in client's dunning view. Scoped to `clientUserId` only.
   * Returns `state: 'locked'` when any eligible cycle is locked, else
   * `past_due` for an active cycle (Days 0-9), else `none`.
   */
  async getClientStatus(clientUserId: string): Promise<ClientDunningStatus> {
    const base: ClientDunningStatus = {
      enabled: this.enabled(),
      state: 'none',
      purchase_id: null,
      amount_cents: null,
      currency: null,
      failed_at: null,
      lockout_at: null,
      locked_at: null,
      day: null,
      coach_name: null,
      card_last4: null,
      update_payment_route: '/v1/checkout/billing-portal',
    };
    if (!base.enabled) return base;

    const rows = await this.prisma.dunningState.findMany({
      where: {
        status: 'active',
        step_index: { gte: 0 },
        entered_at: { not: null },
        purchase: { client_user_id: clientUserId },
      },
      include: { purchase: true },
      orderBy: [{ locked_out_at: 'desc' }, { entered_at: 'asc' }],
      take: 10,
    });
    const eligible = rows.filter((r) => DunningV2Service.isEligiblePurchase(r.purchase));
    const row = eligible.find((r) => r.locked_out_at != null) ?? eligible[0];
    if (!row) return base;

    const [coach, customer] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: row.purchase.coach_user_id },
        select: { name: true },
      }),
      this.prisma.connectCustomer.findUnique({
        where: { client_user_id: clientUserId },
        select: { default_card_last4: true },
      }),
    ]);
    const enteredAt = row.entered_at as Date;
    return {
      ...base,
      state: row.locked_out_at ? 'locked' : 'past_due',
      purchase_id: row.purchase_id,
      amount_cents: row.last_failed_amount_cents ?? row.purchase.amount_cents,
      currency: row.purchase.currency,
      failed_at: enteredAt.toISOString(),
      lockout_at: dunningV2LockoutAt(enteredAt).toISOString(),
      locked_at: row.locked_out_at ? row.locked_out_at.toISOString() : null,
      day: Math.max(0, Math.floor((Date.now() - enteredAt.getTime()) / DUNNING_V2_DAY_MS)),
      coach_name: coach?.name ?? null,
      card_last4: customer?.default_card_last4 ?? null,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async buildDispatchContext(claim: DunningV2StepClaim): Promise<DispatchContext | null> {
    const state = await this.prisma.dunningState.findUnique({
      where: { id: claim.dunningStateId },
      include: { purchase: true },
    });
    if (!state || state.status !== 'active' || !state.entered_at) return null;
    const purchase = state.purchase;
    const [client, coach, customer, prefs] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: purchase.client_user_id },
        select: { name: true, email: true },
      }),
      this.prisma.user.findUnique({
        where: { id: purchase.coach_user_id },
        select: { name: true, email: true },
      }),
      this.prisma.connectCustomer.findUnique({
        where: { client_user_id: purchase.client_user_id },
        select: { default_card_last4: true },
      }),
      this.prisma.notificationPreferences.findUnique({
        where: { user_id: purchase.client_user_id },
        select: { timezone: true },
      }),
    ]);
    const clientName = client?.name ?? '';
    const firstName = clientName.trim().split(/\s+/)[0] || 'there';
    const amountCents = state.last_failed_amount_cents ?? purchase.amount_cents;
    return {
      dunningStateId: state.id,
      stepIndex: claim.stepIndex,
      isLateReversalCycle: claim.isLateReversalCycle,
      clientUserId: purchase.client_user_id,
      coachUserId: purchase.coach_user_id,
      clientEmail: client?.email ?? null,
      coachEmail: coach?.email ?? null,
      tokens: {
        firstName,
        clientName: clientName || 'Your client',
        coachName: coach?.name ?? 'your coach',
        amount: formatMoney(amountCents, purchase.currency),
        cardLast4: customer?.default_card_last4 ?? undefined,
        lockoutDate: formatLockoutDate(
          dunningV2LockoutAt(state.entered_at),
          prefs?.timezone ?? null,
        ),
      },
      dunningDetailDeeplink: `tgp://coach/clients/${purchase.client_user_id}`,
    };
  }

  /**
   * Resolve a ClientPurchase id from a disputed Stripe charge / PI, mirroring
   * the v1 refund-dispute order: ConnectTransfer.source_stripe_charge_id, then
   * the purchase's payment intent. Read-only.
   */
  private async resolvePurchaseFromCharge(
    chargeId: string | null,
    paymentIntentId: string | null,
  ): Promise<string | null> {
    try {
      if (chargeId) {
        const transfer = await this.prisma.connectTransfer.findFirst({
          where: { source_stripe_charge_id: chargeId },
          select: { purchase_id: true },
        });
        if (transfer?.purchase_id) return transfer.purchase_id;
      }
      if (paymentIntentId) {
        const purchase = await this.prisma.clientPurchase.findFirst({
          where: { stripe_payment_intent_id: paymentIntentId },
          select: { id: true },
        });
        if (purchase) return purchase.id;
      }
    } catch (err) {
      this.logger.warn(`dunning v2 dispute purchase resolution failed: ${(err as Error).message}`);
    }
    return null;
  }
}

/** Add (or subtract, with a negative n) whole days to a Date. */
export function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** Integer cents -> display string. USD gets a $ prefix. */
export function formatMoney(cents: number, currency: string | null): string {
  const cur = (currency ?? 'usd').toUpperCase();
  const amount = (cents / 100).toFixed(2);
  return cur === 'USD' ? `$${amount}` : `${amount} ${cur}`;
}

/**
 * The lockout date as the client reads it, in their notification time zone
 * (falls back to America/Los_Angeles, the product default), e.g. "Saturday,
 * October 11". An invalid zone falls back rather than throwing.
 */
export function formatLockoutDate(at: Date, timeZone: string | null): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  };
  try {
    return new Intl.DateTimeFormat('en-US', {
      ...opts,
      timeZone: timeZone || 'America/Los_Angeles',
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      ...opts,
      timeZone: 'America/Los_Angeles',
    }).format(at);
  }
}
