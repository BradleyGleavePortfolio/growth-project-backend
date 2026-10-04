import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { ClientPurchase, DunningState, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { StripeConnectApiService } from '../../connect/stripe-connect-api.service';
import { NotificationKind } from '../../notifications/notification-kind';
import { isDunningV2Enabled } from './dunning-v2.feature';
import { DunningV2Telemetry } from './dunning-v2.telemetry';
import {
  ChannelResult,
  DispatchContext,
  DunningChannel,
  DunningV2Dispatcher,
  dunningChannelsFor,
} from './dunning-v2.dispatcher';
import { DunningEscalationClassifier } from './dunning-escalation.classifier';
import { effectiveLock } from './dunning-effective-access';
import { dunningErrorCode } from './dunning-v2.safe-error';
import { formatMinor } from '../client-billing.money';
import {
  DUNNING_V2_CADENCE_DAYS,
  DUNNING_V2_DAY_MS,
  DUNNING_V2_LOCKOUT_DAY,
  DunningV2State,
  dunningV2LockoutAt,
  dunningV2StepForElapsed,
  DUNNING_UPDATE_CARD_URL,
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
 * DURABLE DELIVERY (B-628-6): the claim CAS and one DunningNoticeDelivery
 * row per transport commit in ONE transaction; each transport's real result
 * is recorded, and a failed or never-attempted one is retried by the sweep
 * (15 min / 1 h / 4 h / 12 h, dead after 6). Keys carry the cycle key.
 *
 * DELIVERY GUARANTEE (C-628-12): the per-row claim makes the DATABASE the
 * authority (no two live workers send a row; a stale one never overwrites a
 * newer receipt). After a claim expires the row is sent again. Email is
 * deduplicated by the reused idempotency key; the
 * client push (Expo) and the in-app blocker row: AT-LEAST-ONCE (Expo takes no
 * key; a duplicate reminder is the accepted failure, a missed one is not). A
 * queued push outbox (#648) is audited there.
 *
 * LOCK TIMING: the Day-10 lock is applied by the hourly sweep, so it lands
 * up to 1 hour after the Day-10 instant (never before it).
 *
 * DISPUTE PAUSE (R-DISPUTE-PAUSE): a dispute on any charge of the plan
 * locks the cycle at once with the dispute marker and pauses billing at
 * Stripe. No payment, card update, Stripe status or dispute closure ends
 * it; only the owning coach's restart does (`restartAfterDisputePause`).
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
  /** The claimed cycle (entered_at ms). Absent only on legacy claims. */
  cycleKey?: string;
}

/** Outbox retry backoff after the Nth failed attempt (1-based). */
export const DUNNING_NOTICE_BACKOFF_MS = [
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
  12 * 60 * 60_000,
];
export const DUNNING_NOTICE_MAX_ATTEMPTS = 6;
/** Grace before the sweep picks up a pending row the claimer never sent. */
export const DUNNING_NOTICE_PENDING_GRACE_MS = 10 * 60_000;
/**
 * S-DUNNING-R4 (B-628-6): how long one worker owns a claimed delivery
 * ('sending'). After it, a crashed worker's claim may be taken over.
 */
export const DUNNING_NOTICE_CLAIM_MS = 10 * 60_000;

export function dunningCycleKey(enteredAt: Date): string {
  return String(enteredAt.getTime());
}

export function noticeDeliveryId(
  stateId: string,
  cycleKey: string,
  step: number,
  channel: DunningChannel,
): string {
  return `${stateId}:${cycleKey}:${step}:${channel}`;
}

const CLASSIFIER = new DunningEscalationClassifier();

/** Dispute statuses that end a dispute cycle in the client's favour. */
const DISPUTE_WON_STATUSES = new Set(['won', 'warning_closed']);
/** Dispute statuses that are final (a later read never moves them back). */
const DISPUTE_TERMINAL_STATUSES = new Set(['won', 'warning_closed', 'lost', 'charge_refunded']);
/** Status a dispute obligation is recorded with when its dispute opens. */
const DISPUTE_OPEN_STATUS = 'open';
/** The step a dispute pause records: its notices go to the client and coach. */
const DUNNING_V2_PAUSE_STEP = 3;

/** A delivery row this worker holds (B-628-6). */
interface ClaimedDelivery {
  id: string;
  channel: DunningChannel;
  token: string;
  /** Attempts including this claim. */
  attempts: number;
  /** Transport idempotency attempt (email key suffix). */
  keyAttempt: number;
}

/** The dispute a `charge.dispute.closed` event closes (B-628-8). */
interface ClosingDispute {
  disputeId: string | null;
  chargeId: string | null;
  status: string | null;
}

/**
 * Dispute obligations that still block a purchase-wide reversal lock: every
 * dispute not closed in the client's favour (open, under review or lost).
 * The closing dispute counts with its event status; it is matched by its
 * Stripe dispute id, or by charge when the event carries no id.
 */
export function outstandingDisputes<
  T extends { stripe_dispute_id: string; stripe_charge_id: string; status: string },
>(disputes: T[], closing: ClosingDispute | null): T[] {
  const isClosing = (d: T): boolean =>
    closing != null &&
    (closing.disputeId
      ? d.stripe_dispute_id === closing.disputeId
      : closing.chargeId != null && d.stripe_charge_id === closing.chargeId);
  return disputes.filter((d) => {
    // The event decides the closing dispute unless a record already holds
    // its final status (a final status is never outvoted by an event).
    const status =
      isClosing(d) && !DISPUTE_TERMINAL_STATUSES.has(d.status)
        ? (closing?.status ?? d.status)
        : d.status;
    return !DISPUTE_WON_STATUSES.has(status);
  });
}

/** One dispute obligation on a purchase, from either record. */
export interface DisputeObligation {
  stripe_dispute_id: string;
  stripe_charge_id: string;
  status: string;
}

/**
 * B-628-8: one obligation per Stripe dispute from the ledger (ChargeDispute)
 * and the dunning record. Either may lag, so a final status wins; two
 * conflicting finals resolve against the client (never lift on a conflict).
 */
export function mergeDisputeObligations(
  ledger: Array<{ stripe_dispute_id: string; stripe_charge_id: string; status: string }>,
  recorded: Array<{ stripe_dispute_id: string; stripe_charge_id: string | null; status: string }>,
): DisputeObligation[] {
  const byId = new Map<string, DisputeObligation>();
  for (const d of ledger) byId.set(d.stripe_dispute_id, { ...d });
  for (const r of recorded) {
    const prior = byId.get(r.stripe_dispute_id);
    if (!prior) {
      byId.set(r.stripe_dispute_id, {
        stripe_dispute_id: r.stripe_dispute_id,
        stripe_charge_id: r.stripe_charge_id ?? '',
        status: r.status,
      });
      continue;
    }
    const a = DISPUTE_TERMINAL_STATUSES.has(prior.status);
    const b = DISPUTE_TERMINAL_STATUSES.has(r.status);
    if (
      b &&
      (!a || (DISPUTE_WON_STATUSES.has(prior.status) && !DISPUTE_WON_STATUSES.has(r.status)))
    ) {
      prior.status = r.status;
    }
    if (!prior.stripe_charge_id && r.stripe_charge_id) prior.stripe_charge_id = r.stripe_charge_id;
  }
  return [...byId.values()];
}

/** What the client app reads to render the Day 0-9 banner or the lockout. */
export interface ClientDunningStatus {
  /** False while FEATURE_DUNNING_V2 is off: no banner, no lockout screen. */
  enabled: boolean;
  state: 'none' | 'past_due' | 'locked';
  /**
   * S-DUNNING-R3: what the cycle is about. 'dispute' = the bank reversed a
   * payment already made (no invoice is open, a card update does not end
   * it); 'payment' = a renewal charge failed. Null with state 'none'.
   */
  kind: 'payment' | 'dispute' | null;
  /**
   * B-628-7: true when the cycle is locked but the client keeps access
   * through another live entitlement (the request guard lets them in), so
   * the app shows the banner instead of the lockout screen.
   */
  lock_waived: boolean;
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
  card_brand: string | null;
  /**
   * The client action that ends the cycle (OR-110-2, native): POST this route
   * for a SetupIntent, present the in-app PaymentSheet, then POST
   * `/v1/checkout/payment-method/confirm`, which (1A) pays the open invoice.
   */
  update_payment_route: '/v1/checkout/payment-method/setup-intent' | null;
  /** Universal link (emails, notifications) that opens the in-app card update. */
  update_card_url: string | null;
  /**
   * POST to end the plan now (owner 2A: the unpaid invoice is voided, access
   * ends at once, nothing more is collected). Null when there is no cycle.
   */
  cancel_route: string | null;
  /**
   * R-DISPUTE-PAUSE mobile contract. 'dispute_paused': a dispute paused the
   * plan (state 'locked', kind 'dispute', access_ended and billing_paused
   * true, restart_by 'coach', lockout_at / update_payment_route /
   * update_card_url / cancel_route / amount_cents all null: no lock date,
   * no retry or card path). 'payment_failed': a renewal charge failed.
   */
  reason: 'dispute_paused' | 'payment_failed' | null;
  access_ended: boolean;
  billing_paused: boolean;
  restart_by: 'coach' | null;
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
   * After v1 `recordFailure`: claim Day 0 (stamping `entered_at`) or advance
   * to the step elapsed time calls for. DB-only; the caller sends the
   * returned claim's notices after its own transaction.
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
      const claim: DunningV2StepClaim = {
        dunningStateId: state.id,
        purchaseId,
        stepIndex: 0,
        isLateReversalCycle: false,
        cycleKey: dunningCycleKey(now),
      };
      const won = await this.claimWithOutbox(
        { id: state.id, status: 'active', step_index: state.step_index },
        { step_index: 0, entered_at: now, locked_out_at: null },
        claim,
        now,
      );
      return won ? claim : null;
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
    const claim: DunningV2StepClaim = {
      dunningStateId: state.id,
      purchaseId: state.purchase_id,
      stepIndex: target,
      isLateReversalCycle: state.last_failure_reason === DUNNING_V2_REVERSAL_REASON,
      cycleKey: dunningCycleKey(state.entered_at),
    };
    const won = await this.claimWithOutbox(
      {
        id: state.id,
        status: 'active',
        locked_out_at: null,
        // S-DUNNING-R2 2A: a client who ended their plan gets no more notices.
        client_canceled_at: null,
        step_index: state.step_index,
        // The same cycle the caller read (a reopened cycle re-anchors).
        entered_at: state.entered_at,
      },
      {
        step_index: target,
        ...(target >= 2 ? { escalated_at: now } : {}),
      },
      claim,
      now,
    );
    return won ? claim : null;
  }

  /**
   * B-628-6: the step claim (CAS) and its outbox rows commit together, so a
   * crash between claim and send leaves pending rows the sweep delivers.
   */
  private async claimWithOutbox(
    where: Prisma.DunningStateWhereInput,
    data: Prisma.DunningStateUpdateManyMutationInput,
    claim: DunningV2StepClaim,
    now: Date,
  ): Promise<boolean> {
    const channels = dunningChannelsFor(
      CLASSIFIER.resolve({
        stepIndex: claim.stepIndex,
        isLateReversalCycle: claim.isLateReversalCycle,
      }),
    );
    const cycleKey = claim.cycleKey as string;
    let won = false;
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.dunningState.updateMany({ where, data });
      if (res.count !== 1) return;
      won = true;
      for (const channel of channels) {
        const id = noticeDeliveryId(claim.dunningStateId, cycleKey, claim.stepIndex, channel);
        await tx.dunningNoticeDelivery.upsert({
          where: { id },
          create: {
            id,
            dunning_state_id: claim.dunningStateId,
            cycle_key: cycleKey,
            step_index: claim.stepIndex,
            channel,
            status: 'pending',
            attempts: 0,
            next_attempt_at: new Date(now.getTime() + DUNNING_NOTICE_PENDING_GRACE_MS),
          },
          update: {},
        });
      }
    });
    return won;
  }

  /**
   * Send a claimed step's notices (client push / email / blocker; the coach
   * on all three at Day 7). Never throws. B-628-6: each row is CLAIMED
   * (CAS to 'sending', token + expiry) before its transport, the cycle is
   * re-checked, and only the holder writes the receipt. `rowIds` limits a
   * retry to the due rows.
   */
  async dispatchClaim(
    claim: DunningV2StepClaim | null,
    now: Date = new Date(),
    opts: { rowIds?: string[] } = {},
  ): Promise<void> {
    if (!claim || !this.dispatcher) return;
    try {
      const ctx = await this.buildDispatchContext(claim);
      if (!ctx) return;
      if (!claim.cycleKey) {
        await this.dispatcher.dispatchStep(ctx);
        return;
      }
      ctx.cycleKey = claim.cycleKey;
      const rows = await this.prisma.dunningNoticeDelivery.findMany({
        where: {
          dunning_state_id: claim.dunningStateId,
          cycle_key: claim.cycleKey,
          step_index: claim.stepIndex,
          ...(opts.rowIds ? { id: { in: opts.rowIds } } : {}),
          status: { in: ['pending', 'failed', 'sending'] },
        },
      });
      const claimed = await this.claimDeliveries(rows, now, opts.rowIds != null);
      if (claimed.length === 0) return;
      // The cycle may have ended (paid, canceled, locked) between the read
      // and the claim: close the claimed rows instead of sending.
      if (!(await this.cycleStillLive(claim.dunningStateId, claim.cycleKey))) {
        for (const c of claimed) {
          await this.prisma.dunningNoticeDelivery.updateMany({
            where: { id: c.id, claim_token: c.token, status: 'sending' },
            data: { status: 'canceled', claim_token: null, next_attempt_at: null },
          });
        }
        return;
      }
      // One transport call per idempotency attempt (normally one group).
      const byAttempt = new Map<number, ClaimedDelivery[]>();
      for (const c of claimed) {
        byAttempt.set(c.keyAttempt, [...(byAttempt.get(c.keyAttempt) ?? []), c]);
      }
      for (const [attempt, group] of byAttempt) {
        const { results } = await this.dispatcher.dispatchStepDetailed(ctx, undefined, {
          channels: group.map((c) => c.channel),
          attempt,
        });
        for (const c of group) {
          const result: ChannelResult = results[c.channel] ?? {
            status: 'skipped',
            error: 'not_in_step',
          };
          await this.recordDelivery(c, result, now);
        }
      }
    } catch (err) {
      this.logger.warn(
        `dunning v2 dispatch failed state=${claim.dunningStateId} step=${claim.stepIndex}: ${dunningErrorCode(err)}`,
      );
    }
  }

  /**
   * CAS-claim each eligible delivery (pending, due failed, or 'sending' with
   * an expired claim) on status + attempt + token as read: one worker wins.
   * A takeover reuses the attempt, so a sent email dedups by its key.
   */
  private async claimDeliveries(
    rows: Array<{
      id: string;
      channel: string;
      status: string;
      attempts: number;
      next_attempt_at: Date | null;
      claim_token: string | null;
      key_attempt: number | null;
    }>,
    now: Date,
    retryPath: boolean,
  ): Promise<ClaimedDelivery[]> {
    const out: ClaimedDelivery[] = [];
    for (const row of rows) {
      const due = row.next_attempt_at != null && row.next_attempt_at.getTime() <= now.getTime();
      const takeover = row.status === 'sending';
      const eligible = takeover
        ? due
        : row.status === 'pending'
          ? !retryPath || due
          : retryPath && due;
      if (!eligible) continue;
      const where = {
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        claim_token: row.claim_token ?? null,
      };
      if (row.attempts >= DUNNING_NOTICE_MAX_ATTEMPTS) {
        const res = await this.prisma.dunningNoticeDelivery.updateMany({
          where,
          data: { status: 'dead', claim_token: null, next_attempt_at: null },
        });
        if (res.count === 1) {
          this.logger.error(
            JSON.stringify({
              event: 'dunning_v2.notice_dead',
              delivery_id: row.id,
              attempts: row.attempts,
            }),
          );
        }
        continue;
      }
      const token = randomUUID();
      const keyAttempt = takeover && row.key_attempt != null ? row.key_attempt : row.attempts;
      const res = await this.prisma.dunningNoticeDelivery.updateMany({
        where,
        data: {
          status: 'sending',
          claim_token: token,
          key_attempt: keyAttempt,
          attempts: row.attempts + 1,
          next_attempt_at: new Date(now.getTime() + DUNNING_NOTICE_CLAIM_MS),
        },
      });
      if (res.count !== 1) continue;
      out.push({
        id: row.id,
        channel: row.channel as DunningChannel,
        token,
        attempts: row.attempts + 1,
        keyAttempt,
      });
    }
    return out;
  }

  /** The cycle a delivery belongs to is still the live, unlocked one. */
  private async cycleStillLive(stateId: string, cycleKey: string): Promise<boolean> {
    const state = await this.prisma.dunningState.findUnique({ where: { id: stateId } });
    return (
      state != null &&
      state.status === 'active' &&
      // R-DISPUTE-PAUSE: a paused (locked) dispute cycle still sends its notices.
      (state.locked_out_at == null || state.last_failure_reason === DUNNING_V2_REVERSAL_REASON) &&
      state.client_canceled_at == null &&
      state.entered_at != null &&
      dunningCycleKey(state.entered_at) === cycleKey
    );
  }

  /** Write a receipt only while this worker still holds the claim. */
  private async recordDelivery(
    c: ClaimedDelivery,
    result: ChannelResult,
    now: Date,
  ): Promise<void> {
    const fence = { id: c.id, claim_token: c.token, status: 'sending' };
    let res: { count: number };
    let dead = false;
    if (result.status === 'sent' || result.status === 'skipped') {
      res = await this.prisma.dunningNoticeDelivery.updateMany({
        where: fence,
        data: {
          status: result.status,
          claim_token: null,
          sent_at: result.status === 'sent' ? now : null,
          last_error: result.error ?? null,
          next_attempt_at: null,
        },
      });
    } else {
      dead = c.attempts >= DUNNING_NOTICE_MAX_ATTEMPTS;
      const backoff =
        DUNNING_NOTICE_BACKOFF_MS[Math.min(c.attempts - 1, DUNNING_NOTICE_BACKOFF_MS.length - 1)];
      res = await this.prisma.dunningNoticeDelivery.updateMany({
        where: fence,
        data: {
          status: dead ? 'dead' : 'failed',
          claim_token: null,
          last_error: result.error ?? 'delivery_failed',
          next_attempt_at: dead ? null : new Date(now.getTime() + backoff),
        },
      });
    }
    if (res.count !== 1) {
      // A newer claim owns the row (this worker's claim expired): its
      // receipt wins; this one is dropped, never overwriting it.
      this.logger.warn(
        JSON.stringify({
          event: 'dunning_v2.notice_stale_receipt',
          delivery_id: c.id,
          result: result.status,
        }),
      );
      return;
    }
    if (dead) {
      this.logger.error(
        JSON.stringify({
          event: 'dunning_v2.notice_dead',
          delivery_id: c.id,
          attempts: c.attempts,
        }),
      );
    }
  }

  /**
   * Retry due outbox rows (failed past backoff, pending past grace, expired
   * 'sending'); a row whose cycle ended, changed or locked is 'canceled'.
   */
  async retryDueNotices(now: Date = new Date(), limit = 200): Promise<{ retried: number }> {
    if (!this.enabled() || !this.dispatcher) return { retried: 0 };
    const due = await this.prisma.dunningNoticeDelivery.findMany({
      where: {
        status: { in: ['pending', 'failed', 'sending'] },
        next_attempt_at: { lte: now },
      },
      orderBy: { next_attempt_at: 'asc' },
      take: limit,
    });
    const groups = new Map<string, typeof due>();
    for (const row of due) {
      const k = `${row.dunning_state_id}|${row.cycle_key}|${row.step_index}`;
      groups.set(k, [...(groups.get(k) ?? []), row]);
    }
    let retried = 0;
    for (const rows of groups.values()) {
      const first = rows[0];
      const state = await this.prisma.dunningState.findUnique({
        where: { id: first.dunning_state_id },
      });
      const live =
        state != null &&
        state.status === 'active' &&
        (state.locked_out_at == null || state.last_failure_reason === DUNNING_V2_REVERSAL_REASON) &&
        state.client_canceled_at == null &&
        state.entered_at != null &&
        dunningCycleKey(state.entered_at) === first.cycle_key;
      if (!live) {
        await this.prisma.dunningNoticeDelivery.updateMany({
          where: {
            id: { in: rows.map((r) => r.id) },
            OR: [
              { status: { in: ['pending', 'failed'] } },
              { status: 'sending', next_attempt_at: { lte: now } },
            ],
          },
          data: { status: 'canceled', claim_token: null, next_attempt_at: null },
        });
        continue;
      }
      await this.dispatchClaim(
        {
          dunningStateId: state.id,
          purchaseId: state.purchase_id,
          stepIndex: first.step_index,
          isLateReversalCycle: state.last_failure_reason === DUNNING_V2_REVERSAL_REASON,
          cycleKey: first.cycle_key,
        },
        now,
        { rowIds: rows.map((r) => r.id) },
      );
      retried += 1;
    }
    return { retried };
  }

  // ── Hourly sweep: advance steps + Day-10 lockout ──────────────────────────
  /**
   * One sweep tick. For every active, unlocked, claimed cycle: lock it if it
   * reached Day 10 (with positive evidence it is still unpaid), otherwise
   * advance it to its due step and send that step's notices. Bounded to
   * `limit` DUE rows per tick, least recently skipped first (B-688-2);
   * idempotent and overlap-safe.
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
        // S-DUNNING-R2 2A: never notify or Day-10-lock a client who ended
        // their plan in dunning; the reconciler finishes that cancel.
        client_canceled_at: null,
        step_index: { gte: 0 },
        entered_at: { not: null },
        // B-688-2 (Sol): only cycles due for the lock or for a step they
        // have not claimed, so rows with nothing to do never fill the page.
        OR: [
          { entered_at: { lte: daysBefore(now, DUNNING_V2_LOCKOUT_DAY) } },
          ...DUNNING_V2_CADENCE_DAYS.slice(1).map((day, i) => ({
            step_index: { lt: i + 1 },
            entered_at: { lte: daysBefore(now, day) },
          })),
        ],
      },
      // A row the sweep looked at and could not act on goes behind the rest.
      orderBy: [{ sweep_checked_at: { sort: 'asc', nulls: 'first' } }, { entered_at: 'asc' }],
      take: limit,
    });
    let locked = 0;
    let advanced = 0;
    let skipped = 0;
    for (const row of rows) {
      let acted = false;
      try {
        const lockAt = dunningV2LockoutAt(row.entered_at as Date);
        if (now.getTime() >= lockAt.getTime()) {
          acted = (await this.tryLock(row, now)) === 'locked';
          if (acted) locked += 1;
          else skipped += 1;
        } else {
          const claim = await this.advance(row, now);
          if (claim) {
            acted = true;
            advanced += 1;
            await this.dispatchClaim(claim);
          }
        }
      } catch (err) {
        skipped += 1;
        this.logger.warn(`dunning v2 sweep row failed state=${row.id}: ${dunningErrorCode(err)}`);
      }
      if (!acted) await this.markSweepChecked(row, now);
    }
    try {
      await this.retryDueNotices(now);
    } catch (err) {
      this.logger.warn(`dunning v2 notice retry failed: ${dunningErrorCode(err)}`);
    }
    return { locked, advanced, skipped };
  }

  /** B-688-2: stamp a due row the sweep could not act on (same cycle only). */
  private async markSweepChecked(row: DunningState, now: Date): Promise<void> {
    try {
      await this.prisma.dunningState.updateMany({
        where: { id: row.id, entered_at: row.entered_at },
        data: { sweep_checked_at: now },
      });
    } catch (err) {
      this.logger.warn(`dunning v2 sweep stamp failed state=${row.id}: ${dunningErrorCode(err)}`);
    }
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
    const dispute = row.last_failure_reason === DUNNING_V2_REVERSAL_REASON;
    if (dispute) {
      // B-628-8: a dispute cycle's evidence is the dispute itself, not the
      // subscription (which stays active and keeps renewing). A won dispute
      // resolves the cycle instead of locking.
      // R-DISPUTE-PAUSE: no dispute outcome resolves a cycle on its own.
      if (purchase.status === 'canceled') return 'skipped';
    } else if (purchase.status !== 'past_due' && purchase.status !== 'unpaid') {
      this.logger.warn(
        `dunning v2 lock skipped state=${row.id}: purchase status ${purchase.status} is not past_due`,
      );
      return 'skipped';
    }
    if (!dispute && this.stripe && purchase.stripe_subscription_id) {
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
          `dunning v2 lock deferred state=${row.id}: Stripe check failed: ${dunningErrorCode(err)}`,
        );
        return 'skipped';
      }
    }
    let won = false;
    await this.prisma.$transaction(async (tx) => {
      // B-688-1 (Sol): under the row lock, lock only the cycle whose Day 10
      // was read (same entered_at: a cycle reopened during the Stripe await
      // has its own window) and only while the purchase still shows it.
      await this.lockDunningState(tx, row.purchase_id);
      const fresh = await tx.clientPurchase.findUnique({ where: { id: row.purchase_id } });
      if (!fresh || !DunningV2Service.isEligiblePurchase(fresh)) return;
      if (dispute ? fresh.status === 'canceled' : !['past_due', 'unpaid'].includes(fresh.status)) {
        return;
      }
      const res = await tx.dunningState.updateMany({
        where: {
          id: row.id,
          status: 'active',
          locked_out_at: null,
          client_canceled_at: null,
          entered_at: row.entered_at,
          step_index: row.step_index, // Opus B-688-6: a v1 reopen resets the step
        },
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
   * After v1 `recordResolution` on `invoice.paid`: lift a Day-10 lock (and
   * the entitlement), dismiss open blockers, revoke recovery tokens. `db`
   * MUST be the caller's open transaction when one is held (it already holds
   * the ClientPurchase row lock; a second connection would self-deadlock).
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
        status: true,
        locked_out_at: true,
        last_failure_reason: true,
        entered_at: true,
        purchase_id: true,
        purchase: { select: { client_user_id: true } },
      },
    });
    if (!state) return { liftedLockout: false };
    // R-DISPUTE-PAUSE: no payment, card update or manual clear ends a
    // dispute pause; only the coach restart does.
    if (state.status === 'active' && state.last_failure_reason === DUNNING_V2_REVERSAL_REASON) {
      return { liftedLockout: false };
    }
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

  // ── §6 Disputes on a recurring plan (R-DISPUTE-PAUSE) ─────────────────────
  /**
   * R-DISPUTE-PAUSE (owner 12:01 PDT 10-04): a dispute on ANY charge of a
   * paid recurring plan, whether or not a renewal ever failed, pauses all
   * billing for that plan and ends the client's access at once. Nothing
   * restores it when the dispute closes (won, lost or otherwise); only the
   * owning coach's restart does (`restartAfterDisputePause`). This replaces
   * the compressed dispute cycle (lock date). One-time purchases, free and
   * code grants are not eligible and are unchanged. A refund is never
   * non-payment (S-DUNNING F11): without a Stripe dispute id nothing pauses.
   */
  async handleLateReversal(input: {
    purchaseId: string;
    reversedChargeAt: Date;
    /** The opening Stripe dispute (`dp_...`) and its charge (B-628-8). */
    disputeId?: string | null;
    chargeId?: string | null;
    now?: Date;
  }): Promise<{ opened: boolean; reason: string; claim?: DunningV2StepClaim }> {
    if (!this.enabled()) return { opened: false, reason: 'flag_off' };
    if (!input.disputeId) return { opened: false, reason: 'no_dispute_id' };
    return this.applyDisputePause({
      purchaseId: input.purchaseId,
      disputeId: input.disputeId,
      chargeId: input.chargeId ?? null,
      status: DISPUTE_OPEN_STATUS,
      now: input.now ?? new Date(),
    });
  }

  /**
   * Dispute entry from the webhook (dispute created). Resolves the purchase
   * from the disputed charge and delegates. No-op while flag off.
   */
  async detectAndHandleLateReversal(input: {
    chargeId: string | null;
    paymentIntentId?: string | null;
    /** The opening Stripe dispute (`dp_...`), recorded as an obligation. */
    disputeId?: string | null;
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
      disputeId: input.disputeId ?? null,
      chargeId: input.chargeId,
      now: input.now,
    });
    return { opened: res.opened, reason: res.reason };
  }

  /**
   * True while the plan is paused by a dispute (the dispute marker on an
   * active cycle), so no renewal payment, card update or Stripe status
   * update hands access back. Only the coach restart ends it.
   */
  async isDisputeCycleOpen(purchaseId: string, db?: DunningV2Db): Promise<boolean> {
    if (!this.enabled()) return false;
    const client: DunningV2Db = db ?? this.prisma;
    const state = await client.dunningState.findUnique({
      where: { purchase_id: purchaseId },
      select: { status: true, last_failure_reason: true },
    });
    return state?.status === 'active' && state.last_failure_reason === DUNNING_V2_REVERSAL_REASON;
  }

  /** Alias read by the webhook entitlement writers (R-DISPUTE-PAUSE). */
  async isDisputePaused(purchaseId: string, db?: DunningV2Db): Promise<boolean> {
    return this.isDisputeCycleOpen(purchaseId, db);
  }

  /**
   * B-628-13: an active cycle with a dispute keeps the dispute marker. CAS
   * on the active row, so a cycle resolved meanwhile is never reopened here.
   */
  async keepAsDisputeCycle(purchaseId: string, db?: DunningV2Db): Promise<void> {
    if (!this.enabled()) return;
    const client: DunningV2Db = db ?? this.prisma;
    await client.dunningState.updateMany({
      where: {
        purchase_id: purchaseId,
        status: 'active',
        OR: [
          { last_failure_reason: null },
          { last_failure_reason: { not: DUNNING_V2_REVERSAL_REASON } },
        ],
      },
      data: { last_failure_reason: DUNNING_V2_REVERSAL_REASON },
    });
  }

  /**
   * `charge.dispute.closed`: records the closing status and restores
   * NOTHING, won or lost (R-DISPUTE-PAUSE). A closure processed before its
   * `charge.dispute.created` pauses the plan itself (the dispute existed),
   * so the outcome never depends on webhook order.
   */
  async onDisputeClosed(input: {
    chargeId: string | null;
    paymentIntentId?: string | null;
    status: string | null;
    /** The closing Stripe dispute (`dp_...`); matched before the charge. */
    disputeId?: string | null;
    /** The closure's own time (event.created); processing time when absent. */
    closedAt?: Date;
    now?: Date;
  }): Promise<{ resolved: boolean; reason: string }> {
    if (!this.enabled()) return { resolved: false, reason: 'flag_off' };
    const purchaseId = await this.resolvePurchaseFromCharge(
      input.chargeId,
      input.paymentIntentId ?? null,
    );
    if (!purchaseId) return { resolved: false, reason: 'purchase_unresolved' };
    if (!input.disputeId) return { resolved: false, reason: 'no_dispute_id' };
    const out = await this.applyDisputePause({
      purchaseId,
      disputeId: input.disputeId,
      chargeId: input.chargeId ?? null,
      status: input.status ?? DISPUTE_OPEN_STATUS,
      now: input.closedAt ?? input.now ?? new Date(),
    });
    return { resolved: false, reason: out.opened ? 'paused_on_closure' : 'pause_kept' };
  }

  /**
   * The pause itself. Under the DunningState row lock, then the purchase row
   * lock (the dunning lock order: DunningState before ClientPurchase), in ONE
   * transaction: record the dispute obligation, lock the cycle now with the
   * dispute marker (creating the row when the plan never failed a renewal),
   * end the entitlement and cancel the cycle's pending notices. A dispute id
   * seen before was applied by that earlier transaction, so a redelivery
   * after a coach restart changes nothing. Then, outside the transaction (no
   * Stripe call holds a row lock), billing is paused at Stripe; a failure
   * throws so the webhook is redelivered. The notices go out only after the
   * pause is confirmed (no copy claims a pause before it is true).
   */
  private async applyDisputePause(input: {
    purchaseId: string;
    disputeId: string;
    chargeId: string | null;
    status: string;
    now: Date;
  }): Promise<{ opened: boolean; reason: string; claim?: DunningV2StepClaim }> {
    const { purchaseId, now } = input;
    let reason = 'not_eligible';
    let opened = false;
    let paused: { stateId: string; enteredAt: Date; subscriptionId: string } | null = null;
    await this.prisma.$transaction(async (tx) => {
      await this.lockDunningState(tx, purchaseId);
      await tx.$queryRaw`SELECT "id" FROM "ClientPurchase" WHERE "id" = ${purchaseId} FOR UPDATE`;
      const purchase = await tx.clientPurchase.findUnique({ where: { id: purchaseId } });
      if (!purchase || !DunningV2Service.isEligiblePurchase(purchase)) return;
      const { priorStatus } = await this.upsertDisputeObligation(tx, input);
      const state = await tx.dunningState.findUnique({ where: { purchase_id: purchaseId } });
      const subscriptionId = purchase.stripe_subscription_id as string;
      if (
        state?.status === 'active' &&
        state.last_failure_reason === DUNNING_V2_REVERSAL_REASON &&
        state.locked_out_at != null &&
        state.entered_at != null
      ) {
        reason = 'already_paused';
        paused = { stateId: state.id, enteredAt: state.entered_at, subscriptionId };
        return;
      }
      if (priorStatus !== null) {
        reason = 'dispute_already_applied';
        return;
      }
      if (purchase.status === 'canceled') {
        reason = 'plan_ended';
        return;
      }
      const data = {
        status: 'active',
        step_index: DUNNING_V2_PAUSE_STEP,
        last_failure_reason: DUNNING_V2_REVERSAL_REASON,
        last_failure_at: now,
        entered_at: now,
        locked_out_at: now,
        next_attempt_at: null,
        resolved_at: null,
        recovered_at: null,
        client_canceled_at: null,
      };
      const row = state
        ? await tx.dunningState.update({
            where: { id: state.id },
            data: { ...data, reversal_count: { increment: 1 } },
          })
        : await tx.dunningState.create({
            data: { purchase_id: purchaseId, failure_count: 0, reversal_count: 1, ...data },
          });
      await tx.dunningNoticeDelivery.updateMany({
        where: { dunning_state_id: row.id, status: { in: ['pending', 'failed'] } },
        data: { status: 'canceled', next_attempt_at: null },
      });
      await tx.clientPurchase.update({
        where: { id: purchaseId },
        data: { entitlement_active: false },
      });
      reason = 'paused';
      opened = true;
      paused = { stateId: row.id, enteredAt: now, subscriptionId };
    });
    const p = paused as { stateId: string; enteredAt: Date; subscriptionId: string } | null;
    if (!p) return { opened: false, reason };
    const cycleKey = dunningCycleKey(p.enteredAt);
    await this.pauseBillingAtStripe(p.subscriptionId, purchaseId, cycleKey);
    if (opened) {
      this.telemetry.lockoutEntered(purchaseId, { dunning_state_id: p.stateId });
      this.telemetry.reversalDetected(purchaseId, { dunning_state_id: p.stateId, paused: true });
      this.logger.log(
        JSON.stringify({ event: 'dunning_v2.dispute_paused', purchase_id: purchaseId }),
      );
    }
    // Client (push, email, blocker) and coach (all three) notices, once per
    // pause: deterministic outbox ids, so a redelivery re-sends nothing.
    const claim: DunningV2StepClaim = {
      dunningStateId: p.stateId,
      purchaseId,
      stepIndex: DUNNING_V2_PAUSE_STEP,
      isLateReversalCycle: true,
      cycleKey,
    };
    const live = await this.claimWithOutbox(
      {
        id: p.stateId,
        status: 'active',
        last_failure_reason: DUNNING_V2_REVERSAL_REASON,
        entered_at: p.enteredAt,
      },
      { step_index: DUNNING_V2_PAUSE_STEP },
      claim,
      now,
    );
    if (live) await this.dispatchClaim(claim, now);
    return { opened, reason, claim };
  }

  /**
   * Pause collection at Stripe and stop every open invoice's retries (marked
   * uncollectible, not forgiven). The open-invoice list fails closed: an
   * incomplete list throws, so the event is redelivered rather than leaving
   * an invoice being retried. Idempotent per pause.
   */
  private async pauseBillingAtStripe(
    subscriptionId: string,
    purchaseId: string,
    cycleKey: string,
  ): Promise<void> {
    if (!this.stripe) throw new Error('DUNNING_PAUSE_STRIPE_UNAVAILABLE');
    await this.stripe.pauseSubscriptionCollection({
      subscriptionId,
      idempotencyKey: `dunning_v2:dispute_pause:${purchaseId}:${cycleKey}`,
    });
    const open = await this.stripe.listOpenInvoices(subscriptionId);
    for (const inv of open) {
      await this.stripe.markInvoiceUncollectible({
        invoiceId: inv.id,
        idempotencyKey: `dunning_v2:dispute_pause:${inv.id}`,
      });
    }
  }

  /**
   * R-DISPUTE-PAUSE coach restart. Only the plan's own coach (tenant check:
   * any other caller gets `not_found`, never another coach's data) may
   * restart a plan a dispute paused. Billing resumes at Stripe first; then,
   * under the row locks, the cycle ends and access returns, but only if the
   * same pause is still in place and no new dispute was recorded meanwhile
   * (that dispute keeps the plan paused, and the pause is re-applied at
   * Stripe). A canceled plan cannot be restarted.
   */
  async restartAfterDisputePause(input: {
    coachUserId: string;
    purchaseId: string;
    now?: Date;
  }): Promise<{ restarted: boolean; reason: string }> {
    if (!this.enabled()) return { restarted: false, reason: 'flag_off' };
    const now = input.now ?? new Date();
    const purchase = await this.prisma.clientPurchase.findUnique({
      where: { id: input.purchaseId },
    });
    if (!purchase || purchase.coach_user_id !== input.coachUserId) {
      return { restarted: false, reason: 'not_found' };
    }
    const state = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchase.id },
    });
    if (
      !state?.entered_at ||
      state.status !== 'active' ||
      state.last_failure_reason !== DUNNING_V2_REVERSAL_REASON
    ) {
      return { restarted: false, reason: 'not_paused' };
    }
    if (purchase.status === 'canceled' || !DunningV2Service.isEligiblePurchase(purchase)) {
      return { restarted: false, reason: 'plan_ended' };
    }
    if (!this.stripe) return { restarted: false, reason: 'billing_unavailable' };
    const subscriptionId = purchase.stripe_subscription_id as string;
    const cycleKey = dunningCycleKey(state.entered_at);
    const disputesBefore = await this.prisma.dunningDisputeObligation.count({
      where: { purchase_id: purchase.id },
    });
    let sub: { status: string };
    try {
      sub = await this.stripe.resumeSubscriptionCollection({
        subscriptionId,
        idempotencyKey: `dunning_v2:dispute_restart:${purchase.id}:${cycleKey}`,
      });
    } catch (err) {
      this.logger.warn(
        `dunning v2 restart failed purchase=${purchase.id}: ${dunningErrorCode(err)}`,
      );
      return { restarted: false, reason: 'billing_resume_failed' };
    }
    const live = ['active', 'trialing', 'past_due'].includes(String(sub.status));
    let reason = 'plan_ended';
    await this.prisma.$transaction(async (tx) => {
      await this.lockDunningState(tx, purchase.id);
      await tx.$queryRaw`SELECT "id" FROM "ClientPurchase" WHERE "id" = ${purchase.id} FOR UPDATE`;
      const disputesNow = await tx.dunningDisputeObligation.count({
        where: { purchase_id: purchase.id },
      });
      if (disputesNow !== disputesBefore) {
        reason = 'new_dispute';
        return;
      }
      const fresh = await tx.clientPurchase.findUnique({ where: { id: purchase.id } });
      if (!live || !fresh || fresh.status === 'canceled') return;
      const res = await tx.dunningState.updateMany({
        where: {
          id: state.id,
          status: 'active',
          last_failure_reason: DUNNING_V2_REVERSAL_REASON,
          entered_at: state.entered_at,
        },
        data: { status: 'resolved', resolved_at: now, locked_out_at: null, next_attempt_at: null },
      });
      if (res.count !== 1) {
        reason = 'not_paused';
        return;
      }
      await tx.clientPurchase.update({
        where: { id: purchase.id },
        data: { entitlement_active: true },
      });
      await tx.notification.updateMany({
        where: {
          user_id: purchase.client_user_id,
          kind: NotificationKind.DUNNING_BLOCKER,
          read_at: null,
        },
        data: { read_at: now },
      });
      await tx.dunningNoticeDelivery.updateMany({
        where: { dunning_state_id: state.id, status: { in: ['pending', 'failed'] } },
        data: { status: 'canceled', next_attempt_at: null },
      });
      reason = 'restarted';
    });
    if (reason !== 'restarted') {
      // Billing was resumed but the plan stays paused: pause it again.
      if (live) await this.pauseBillingAtStripe(subscriptionId, purchase.id, cycleKey);
      return { restarted: false, reason };
    }
    this.telemetry.lockoutExited(purchase.id, { dunning_state_id: state.id });
    this.logger.log(
      JSON.stringify({ event: 'dunning_v2.dispute_restarted', purchase_id: purchase.id }),
    );
    return { restarted: true, reason };
  }

  /** Row lock on the purchase's DunningState (no-op when none exists). */
  private async lockDunningState(tx: Prisma.TransactionClient, purchaseId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "DunningState" WHERE "purchase_id" = ${purchaseId} FOR UPDATE`;
  }

  /**
   * Insert or advance one obligation: 'open' never moves a final back; a
   * final beats a non-final; a not-in-favour final beats won (never reverse).
   */
  private async upsertDisputeObligation(
    tx: Prisma.TransactionClient,
    input: {
      purchaseId: string;
      disputeId: string;
      chargeId: string | null;
      status: string;
      now: Date;
    },
  ): Promise<{ priorStatus: string | null }> {
    const prior = await tx.dunningDisputeObligation.findUnique({
      where: { stripe_dispute_id: input.disputeId },
      select: { status: true, stripe_charge_id: true },
    });
    const terminal = DISPUTE_TERMINAL_STATUSES.has(input.status);
    if (!prior) {
      await tx.dunningDisputeObligation.create({
        data: {
          stripe_dispute_id: input.disputeId,
          purchase_id: input.purchaseId,
          stripe_charge_id: input.chargeId,
          status: input.status,
          closed_at: terminal ? input.now : null,
        },
      });
      return { priorStatus: null };
    }
    const priorTerminal = DISPUTE_TERMINAL_STATUSES.has(prior.status);
    const advance =
      terminal &&
      (!priorTerminal ||
        (DISPUTE_WON_STATUSES.has(prior.status) && !DISPUTE_WON_STATUSES.has(input.status)));
    if (advance || (!prior.stripe_charge_id && input.chargeId)) {
      await tx.dunningDisputeObligation.update({
        where: { stripe_dispute_id: input.disputeId },
        data: {
          ...(advance ? { status: input.status, closed_at: input.now } : {}),
          ...(!prior.stripe_charge_id && input.chargeId
            ? { stripe_charge_id: input.chargeId }
            : {}),
        },
      });
    }
    return { priorStatus: prior.status };
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
      kind: null,
      lock_waived: false,
      purchase_id: null,
      amount_cents: null,
      currency: null,
      failed_at: null,
      lockout_at: null,
      locked_at: null,
      day: null,
      coach_name: null,
      card_last4: null,
      card_brand: null,
      update_payment_route: '/v1/checkout/payment-method/setup-intent',
      update_card_url: DUNNING_UPDATE_CARD_URL,
      cancel_route: null,
      reason: null,
      access_ended: false,
      billing_paused: false,
      restart_by: null,
    };
    if (!base.enabled) return base;

    const rows = await this.prisma.dunningState.findMany({
      where: {
        status: 'active',
        client_canceled_at: null,
        step_index: { gte: 0 },
        entered_at: { not: null },
        // Sol B-688-7: eligible rows only, locks first (NULLS LAST on DESC).
        purchase: {
          client_user_id: clientUserId,
          billing_type: 'recurring',
          amount_cents: { gt: 0 },
          stripe_subscription_id: { not: null },
        },
      },
      include: { purchase: true },
      orderBy: [{ locked_out_at: { sort: 'desc', nulls: 'last' } }, { entered_at: 'asc' }],
      take: 10,
    });
    const eligible = rows.filter((r) => DunningV2Service.isEligiblePurchase(r.purchase));
    const row = eligible.find((r) => r.locked_out_at != null) ?? eligible[0];
    if (!row) return base;
    // B-628-7: the guard's rule, so the screen matches what requests do.
    const lock = row.locked_out_at ? await effectiveLock(this.prisma, clientUserId) : null;
    const lockWaived = lock != null && !lock.locked;

    const [coach, customer] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: row.purchase.coach_user_id },
        select: { name: true },
      }),
      this.prisma.connectCustomer.findUnique({
        where: { client_user_id: clientUserId },
        select: { default_card_last4: true, default_card_brand: true },
      }),
    ]);
    const enteredAt = row.entered_at as Date;
    const kind = row.last_failure_reason === DUNNING_V2_REVERSAL_REASON ? 'dispute' : 'payment';
    const state = row.locked_out_at && !lockWaived ? 'locked' : 'past_due';
    if (kind === 'dispute') {
      // R-DISPUTE-PAUSE: access ended at once, billing is paused, the coach
      // restarts it. No lock date, no retry, no card update, no cancel path.
      return {
        ...base,
        state,
        kind,
        lock_waived: lockWaived,
        purchase_id: row.purchase_id,
        currency: row.purchase.currency,
        failed_at: enteredAt.toISOString(),
        locked_at: row.locked_out_at ? row.locked_out_at.toISOString() : null,
        coach_name: coach?.name ?? null,
        update_payment_route: null,
        update_card_url: null,
        reason: 'dispute_paused',
        access_ended: true,
        billing_paused: true,
        restart_by: 'coach',
      };
    }
    return {
      ...base,
      state,
      kind,
      lock_waived: lockWaived,
      purchase_id: row.purchase_id,
      amount_cents: row.last_failed_amount_cents ?? row.purchase.amount_cents,
      currency: row.purchase.currency,
      failed_at: enteredAt.toISOString(),
      lockout_at: dunningV2LockoutAt(enteredAt).toISOString(),
      locked_at: row.locked_out_at ? row.locked_out_at.toISOString() : null,
      day: Math.max(0, Math.floor((Date.now() - enteredAt.getTime()) / DUNNING_V2_DAY_MS)),
      coach_name: coach?.name ?? null,
      card_last4: customer?.default_card_last4 ?? null,
      card_brand: customer?.default_card_brand ?? null,
      cancel_route: `/v1/checkout/subscriptions/${row.purchase_id}/cancel`,
      reason: 'payment_failed',
      access_ended: state === 'locked',
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
        amount: claim.isLateReversalCycle ? undefined : formatMoney(amountCents, purchase.currency),
        cardLast4: customer?.default_card_last4 ?? undefined,
        attempts: state.last_attempt_number ? String(state.last_attempt_number) : undefined,
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
      if (chargeId) {
        // The refund / dispute ledger already resolved this charge.
        const ledger = await this.prisma.chargeDispute.findFirst({
          where: { stripe_charge_id: chargeId },
          select: { purchase_id: true },
        });
        if (ledger?.purchase_id) return ledger.purchase_id;
      }
      if (paymentIntentId) {
        const purchase = await this.prisma.clientPurchase.findFirst({
          where: { stripe_payment_intent_id: paymentIntentId },
          select: { id: true },
        });
        if (purchase) return purchase.id;
      }
      // S-DUNNING-R5: a renewal charge of a subscription (however it was
      // created: hosted Checkout or the native subscription route) whose
      // settlement transfer is not written yet resolves through Stripe:
      // charge -> invoice -> subscription -> purchase.
      if (chargeId && this.stripe) {
        const charge = await this.stripe.retrieveCharge(chargeId);
        // `unknown` on purpose: the charge type differs between main and
        // #627 (string id vs. expanded object); both shapes are read safely.
        const invoiceRef: unknown = charge['invoice'];
        const invoiceId =
          typeof invoiceRef === 'string'
            ? invoiceRef
            : typeof invoiceRef === 'object' && invoiceRef !== null && 'id' in invoiceRef
              ? String(invoiceRef.id)
              : null;
        if (invoiceId) {
          const invoice = await this.stripe.retrieveInvoice(invoiceId);
          if (invoice.subscription) {
            const bySub = await this.prisma.clientPurchase.findFirst({
              where: { stripe_subscription_id: invoice.subscription },
              select: { id: true },
            });
            if (bySub) return bySub.id;
          }
        }
        const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
        if (pi && pi !== paymentIntentId) {
          const byPi = await this.prisma.clientPurchase.findFirst({
            where: { stripe_payment_intent_id: pi },
            select: { id: true },
          });
          if (byPi) return byPi.id;
        }
      }
    } catch (err) {
      const code = dunningErrorCode(err);
      this.logger.warn(`dunning v2 dispute purchase resolution failed: ${code}`);
      // W3 (Opus D34): only a clean miss (Stripe 404) is null; a failed read
      // throws, so the webhook is redelivered, never acknowledged.
      if (!code.startsWith('stripe_404')) throw err;
    }
    return null;
  }
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DUNNING_V2_DAY_MS);
}

/** Add (or subtract, with a negative n) whole days to a Date. */
export function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** Integer minor units -> display string ("$150.00", "1,200 JPY"; C-688-5). */
export function formatMoney(cents: number, currency: string | null): string {
  return formatMinor(cents, currency);
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
