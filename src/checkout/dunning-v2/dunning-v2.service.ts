import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { isDunningV2Enabled } from './dunning-v2.feature';
import { DunningV2Telemetry } from './dunning-v2.telemetry';
import {
  DUNNING_V2_FINAL_STEP_INDEX,
  DUNNING_V2_LOCKOUT_GRACE_DAYS,
  DUNNING_V2_REVERSAL_ENTRY_STEP,
  DUNNING_V2_REVERSAL_COACH_GAP_DAYS,
  DUNNING_V2_REVERSAL_LOCKOUT_GAP_DAYS,
  DunningV2State,
} from './dunning-v2.cadence';

/**
 * B3 Smart Dunning v2 — state machine + recovery + late-reversal + sweep
 * (spec §1, §5, §6, §7).
 *
 * This service ADDS v2 behaviour ALONGSIDE the v1 DunningService — it does not
 * rebuild or mutate it. Every public method is a HARD no-op while
 * FEATURE_DUNNING_V2 is OFF (returns without reading/writing state), so v1
 * remains the active default. The v2 schema columns (`locked_out_at`,
 * `reversal_count`) are touched ONLY from here, behind the flag.
 *
 * State vocabulary (spec §1), mapped onto the shipped v1 enum + new columns
 * (no `locked`/`recovered` enum value exists — see spec §11 decision 3):
 *   INACTIVE  → no DunningState row, or status='resolved' with no active cycle.
 *   ACTIVE    → status='active', locked_out_at IS NULL.
 *   LOCKED    → status='active', locked_out_at IS NOT NULL (Day-10 sweep).
 *   RECOVERED → status='resolved', recovered_at set (transient, then INACTIVE).
 */
@Injectable()
export class DunningV2Service {
  private readonly logger = new Logger(DunningV2Service.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telemetry: DunningV2Telemetry,
  ) {}

  private enabled(): boolean {
    return isDunningV2Enabled();
  }

  /**
   * Derive the v2 logical state from a DunningState row (spec §1 mapping).
   * Pure — exported for the state-transition unit tests.
   */
  static deriveState(row: {
    status: string;
    locked_out_at: Date | null;
    recovered_at: Date | null;
  } | null): DunningV2State {
    if (!row) return 'INACTIVE';
    if (row.status === 'active') {
      return row.locked_out_at ? 'LOCKED' : 'ACTIVE';
    }
    if (row.status === 'resolved') {
      return row.recovered_at ? 'RECOVERED' : 'INACTIVE';
    }
    return 'INACTIVE';
  }

  // ── §5 Recovery — immediate clear on success (Option A) ───────────────────
  /**
   * v2 additions to apply INSIDE the existing v1 recordResolution transaction
   * (spec §5.3). Restores entitlement, lifts the lockout, dismisses blockers,
   * revokes recovery tokens — all same-request. Idempotent: a second call after
   * the state is already resolved is a no-op.
   *
   * Returns true if the row was in lockout and has now been lifted.
   */
  async applyImmediateClear(
    purchaseId: string,
    via: 'card_update' | 'retry' | 'manual' = 'retry',
  ): Promise<{ liftedLockout: boolean }> {
    if (!this.enabled()) return { liftedLockout: false };

    const state = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchaseId },
      select: { id: true, locked_out_at: true, purchase_id: true },
    });
    if (!state) return { liftedLockout: false };

    const wasLocked = state.locked_out_at != null;

    await this.prisma.$transaction(async (tx) => {
      // Restore entitlement + lift lockout same-request (§5.3).
      await tx.clientPurchase.update({
        where: { id: purchaseId },
        data: { entitlement_active: true },
      });
      await tx.dunningState.update({
        where: { id: state.id },
        data: { locked_out_at: null },
      });
      // Dismiss in-app blockers: clear the durable blocker feed rows.
      await tx.notification
        .updateMany?.({
          where: {
            user_id: { not: undefined },
            kind: 'DUNNING_BLOCKER' as never,
          },
          data: { read_at: new Date() } as never,
        })
        .catch(() => undefined);
      // Revoke recovery tokens for this state's attempts (§5.3 / §10.6).
      const attempts = await tx.dunningAttempt.findMany({
        where: { dunning_state_id: state.id },
        select: { id: true },
      });
      const attemptIds = attempts.map((a) => a.id);
      if (attemptIds.length > 0) {
        await tx.paymentRecoveryToken
          .updateMany?.({
            where: { dunning_attempt_id: { in: attemptIds }, used_at: null },
            data: { used_at: new Date() },
          })
          .catch(() => undefined);
      }
    });

    this.telemetry.recovered(state.purchase_id, via);
    if (wasLocked) {
      this.telemetry.lockoutExited(state.purchase_id, {
        dunning_state_id: state.id,
      });
    }
    return { liftedLockout: wasLocked };
  }

  // ── §6 Late-reversal handler — compressed re-cadence ──────────────────────
  /**
   * Open a compressed late-reversal cycle if the reversed charge was for a
   * PREVIOUSLY-CLEARED purchase (spec §6.1 "previously cleared" test) AND no
   * cycle is already in flight (spec §6.4 one-active-cycle-per-state).
   *
   * Enters at Step 2 (Day-3-equivalent), increments reversal_count exactly once
   * per cycle-open, and schedules the Day-7-equivalent. Returns the action so
   * callers/tests can assert.
   */
  async handleLateReversal(input: {
    purchaseId: string;
    reversedChargeAt: Date;
    now?: Date;
  }): Promise<{ opened: boolean; reason: string }> {
    if (!this.enabled()) return { opened: false, reason: 'flag_off' };
    const now = input.now ?? new Date();

    const state = await this.prisma.dunningState.findUnique({
      where: { purchase_id: input.purchaseId },
      select: {
        id: true,
        status: true,
        resolved_at: true,
        purchase_id: true,
      },
    });
    if (!state) return { opened: false, reason: 'no_state' };

    // §6.4 one active cycle per state: if a cycle is already in flight, no-op.
    if (state.status === 'active') {
      return { opened: false, reason: 'cycle_already_active' };
    }

    // §6.1 "previously cleared" test: resolved + resolved_at set, and the
    // reversed charge is at/after resolved_at.
    const previouslyCleared =
      state.status === 'resolved' &&
      state.resolved_at != null &&
      input.reversedChargeAt.getTime() >= state.resolved_at.getTime();
    if (!previouslyCleared) {
      return { opened: false, reason: 'not_a_cleared_payment_reversal' };
    }

    // Open the compressed cycle (§6.2): enter at Step 2, +1 reversal_count,
    // clear resolved/recovered, schedule Day-7-equivalent.
    const coachNotifyAt = addDays(now, DUNNING_V2_REVERSAL_COACH_GAP_DAYS);
    await this.prisma.dunningState.update({
      where: { id: state.id },
      data: {
        status: 'active',
        step_index: DUNNING_V2_REVERSAL_ENTRY_STEP,
        reversal_count: { increment: 1 },
        resolved_at: null,
        recovered_at: null,
        last_failure_at: now,
        next_attempt_at: coachNotifyAt,
        locked_out_at: null,
      },
    });

    this.telemetry.reversalDetected(state.purchase_id, {
      dunning_state_id: state.id,
      entry_step: DUNNING_V2_REVERSAL_ENTRY_STEP,
      lockout_in_days:
        DUNNING_V2_REVERSAL_COACH_GAP_DAYS +
        DUNNING_V2_REVERSAL_LOCKOUT_GAP_DAYS,
    });
    return { opened: true, reason: 'compressed_cycle_opened' };
  }

  // ── §7 Day-10 hard-lockout sweep ──────────────────────────────────────────
  /**
   * Lock out rows that reached the Day-7 final step and have been unresolved
   * for DUNNING_V2_LOCKOUT_GRACE_DAYS more days (spec §7.2). Idempotent: the
   * `locked_out_at: null` filter means a re-run never double-locks.
   *
   * Per candidate, in one transaction: set locked_out_at, turn entitlement off.
   * No client notify (client is being locked) and no coach notify (coach was
   * notified at Step 3) — spec §7.3.
   */
  async runLockoutSweep(now: Date = new Date()): Promise<{ locked: number }> {
    if (!this.enabled()) return { locked: 0 };

    const cutoff = addDays(now, -DUNNING_V2_LOCKOUT_GRACE_DAYS);
    const candidates = await this.prisma.dunningState.findMany({
      where: {
        status: 'active',
        step_index: DUNNING_V2_FINAL_STEP_INDEX,
        locked_out_at: null,
        last_failure_at: { lt: cutoff },
      },
      select: { id: true, purchase_id: true },
    });

    let locked = 0;
    for (const c of candidates) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.dunningState.update({
            where: { id: c.id },
            data: { locked_out_at: now },
          });
          await tx.clientPurchase.update({
            where: { id: c.purchase_id },
            data: { entitlement_active: false },
          });
        });
        this.telemetry.lockoutEntered(c.purchase_id, {
          dunning_state_id: c.id,
        });
        locked += 1;
      } catch (err) {
        this.logger.warn(
          `lockout sweep failed for state=${c.id}: ${(err as Error).message}`,
        );
      }
    }
    return { locked };
  }

  /**
   * Late-reversal entry from the webhook arm (spec §6.1). Resolves the
   * purchase from a reversed-charge event and, if it was a previously-cleared
   * payment with no active cycle, opens the compressed cycle. Reuses the
   * charge→purchase resolution shape from the v1 refund/dispute path
   * (ConnectTransfer.source_stripe_charge_id → SplitLedgerEntry → PI metadata)
   * but does NOT mutate that v1 service. No-op while the flag is off.
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
    if (!purchaseId) {
      return { opened: false, reason: 'purchase_unresolved' };
    }
    return this.handleLateReversal({
      purchaseId,
      reversedChargeAt: input.reversedChargeAt,
      now: input.now,
    });
  }

  /**
   * Resolve a ClientPurchase id from a Stripe charge / PI, mirroring the v1
   * refund-dispute resolution order: ConnectTransfer.source_stripe_charge_id,
   * then SplitLedgerEntry, then PI-metadata fallback. Read-only.
   */
  private async resolvePurchaseFromCharge(
    chargeId: string | null,
    paymentIntentId: string | null,
  ): Promise<string | null> {
    try {
      if (chargeId) {
        const transfer = await this.prisma.connectTransfer?.findFirst?.({
          where: { source_stripe_charge_id: chargeId },
          select: { purchase_id: true },
        });
        const tid = (transfer as { purchase_id?: string } | null)?.purchase_id;
        if (tid) return tid;
      }
      if (paymentIntentId) {
        const purchase = await this.prisma.clientPurchase.findFirst({
          where: { stripe_payment_intent_id: paymentIntentId },
          select: { id: true },
        });
        if (purchase) return purchase.id;
      }
    } catch {
      // Read-only resolution; never throw into the webhook tx.
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
