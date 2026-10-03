import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CronLeaseService } from './cron-lease.service';
import { PurchaseSplitHandlerService } from './purchase-split-handler.service';

// S-FEE — scheduled payout / settlement sweep, every 15 minutes.
//
// What it runs: PurchaseSplitHandlerService.runTransferSweeper, which
//   1. retries settlements still waiting for Stripe's fee and settles recent
//      paid purchases no webhook settled (ChargeSettlementService), then
//   2. posts due coach / head-coach transfers, each with its own backoff.
// Same code path as POST /v1/admin/payments/transfers/run-sweeper.
//
// Safety:
//   - single runner across Fly machines: CronLease row "sfee-settlement-sweep"
//     (LEASE_TTL_MS); a machine that does not get the lease skips the tick;
//   - idempotent per charge and transfer: ChargeSettlement is unique per
//     charge, ConnectTransfer.idempotency_key is unique and is the Stripe
//     Idempotency-Key, so an overlapping run cannot pay twice;
//   - bounded: 25 settlements + BATCH transfers per run, and no new work
//     starts after RUN_BUDGET_MS (well inside the lease);
//   - kill switch: SFEE_SETTLEMENT_SWEEP_ENABLED=false stops scheduled runs
//     (the admin endpoint still works for a manual run).
// Every failure is logged with a specific SFEE_* code (see SWEEP_LOG_CODES and
// TRANSFER_FAILURE_CODES in transfer-orchestrator.service.ts).

export const SWEEP_JOB_NAME = 'sfee-settlement-sweep';
export const SWEEP_CRON = '*/15 * * * *';
export const LEASE_TTL_MS = 10 * 60_000;
export const RUN_BUDGET_MS = 8 * 60_000;
export const BATCH = 50;

export const SWEEP_LOG_CODES = {
  disabled: 'SFEE_SWEEP_DISABLED',
  lockHeld: 'SFEE_SWEEP_SKIPPED_LOCK_HELD',
  lockError: 'SFEE_SWEEP_LOCK_ERROR',
  failed: 'SFEE_SWEEP_FAILED',
  deadline: 'SFEE_SWEEP_DEADLINE_REACHED',
  transfersFailed: 'SFEE_SWEEP_TRANSFERS_FAILED',
  done: 'SFEE_SWEEP_DONE',
} as const;

export type SweepRunResult =
  | { ran: false; reason: 'disabled' | 'lock_held' | 'lock_error' }
  | {
      ran: true;
      ok: boolean;
      attempted?: number;
      succeeded?: number;
      failed?: number;
      deadline_reached?: boolean;
    };

export function sweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SFEE_SETTLEMENT_SWEEP_ENABLED !== 'false';
}

@Injectable()
export class SettlementSweepCron {
  private readonly logger = new Logger(SettlementSweepCron.name);
  private readonly holder = `${process.env.FLY_MACHINE_ID ?? hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly lease: CronLeaseService,
    private readonly splits: PurchaseSplitHandlerService,
  ) {}

  @Cron(SWEEP_CRON, { name: SWEEP_JOB_NAME })
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.runOnce();
  }

  /** One guarded run. Never throws; returns what happened for tests/ops. */
  async runOnce(now: Date = new Date(), holder: string = this.holder): Promise<SweepRunResult> {
    if (!sweepEnabled()) {
      this.logger.warn(
        `${SWEEP_LOG_CODES.disabled} SFEE_SETTLEMENT_SWEEP_ENABLED=false; scheduled payouts are paused. Run POST /v1/admin/payments/transfers/run-sweeper by hand or unset the switch.`,
      );
      return { ran: false, reason: 'disabled' };
    }
    let acquired = false;
    try {
      acquired = (await this.lease.tryAcquire(SWEEP_JOB_NAME, holder, LEASE_TTL_MS, now)).acquired;
    } catch (err) {
      this.logger.error(
        `${SWEEP_LOG_CODES.lockError} alert=true could not read the sweep lease; this tick is skipped and the next one retries: ${(err as Error).message}`,
      );
      return { ran: false, reason: 'lock_error' };
    }
    if (!acquired) {
      this.logger.debug(`${SWEEP_LOG_CODES.lockHeld} another machine is running the sweep`);
      return { ran: false, reason: 'lock_held' };
    }
    try {
      const result = await this.splits.runTransferSweeper(now, {
        batch: BATCH,
        deadlineAt: Date.now() + RUN_BUDGET_MS,
      });
      if (result.deadline_reached) {
        this.logger.warn(
          `${SWEEP_LOG_CODES.deadline} stopped after ${result.attempted} transfers; the rest are due on the next run`,
        );
      }
      if (result.failed > 0) {
        this.logger.error(
          `${SWEEP_LOG_CODES.transfersFailed} alert=true ${result.failed} transfer(s) failed for good this run; see SFEE_TRANSFER_*_FINAL lines for each one`,
        );
      }
      this.logger.log(
        `${SWEEP_LOG_CODES.done} attempted=${result.attempted} succeeded=${result.succeeded} failed=${result.failed} settlements_settled=${result.settlements?.settled ?? 0}`,
      );
      return {
        ran: true,
        ok: true,
        attempted: result.attempted,
        succeeded: result.succeeded,
        failed: result.failed,
        ...(result.deadline_reached ? { deadline_reached: true } : {}),
      };
    } catch (err) {
      this.logger.error(
        `${SWEEP_LOG_CODES.failed} alert=true sweep run failed; due work stays pending for the next run: ${(err as Error).message}`,
      );
      return { ran: true, ok: false };
    } finally {
      await this.lease.release(SWEEP_JOB_NAME, holder, now).catch((err: unknown) => {
        this.logger.warn(
          `${SWEEP_LOG_CODES.lockError} could not release the sweep lease; it expires on its own in ${LEASE_TTL_MS / 60_000} minutes: ${(err as Error).message}`,
        );
      });
    }
  }
}
