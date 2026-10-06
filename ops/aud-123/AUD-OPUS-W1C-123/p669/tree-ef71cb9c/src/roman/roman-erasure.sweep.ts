/**
 * Erasure sweep for deleted Roman chats that still hold content (Sol C-635-1).
 *
 * Since #635 a client delete ERASES the conversation (RomanService
 * .deleteSession / .deleteAllSessions). Rows deleted before that, or
 * soft-deleted by a machine still running the previous version during a
 * rolling deploy, keep their messages and subject context under a tombstone.
 * This sweep gives them the same erasure: transcript and subject context
 * removed, only the content-free count of in-window user turns kept for the
 * daily cap.
 *
 * It never touches a live session, so it is NOT a retention purge (owner
 * 2026-10-01 20:32: past AI chats are kept until the client deletes them or
 * their account).
 *
 * When it runs: once 60 s after boot, nightly at 04:00 UTC (after the
 * 03:00-03:45 deletion / export / scrub slots), and in follow-up runs until
 * nothing is left. One run is bounded (ROMAN_ERASE_SWEEP_BATCH x
 * ROMAN_ERASE_SWEEP_MAX_BATCHES rows), so a run that made progress and left
 * rows behind continues after ROMAN_ERASE_SWEEP_CONTINUE_DELAY_MS; a run that
 * erased nothing but left rows (failures, or a straggler that arrived after
 * the run) retries after ROMAN_ERASE_SWEEP_RETRY_DELAY_MS, at most
 * ROMAN_ERASE_SWEEP_MAX_RETRIES times in a row, then waits for the nightly
 * run. Each row is erased under a compare-and-set, so several machines can
 * run it at once. `RomanService.openOrResumeSession` also erases the one
 * unerased row that blocks today's key on demand, so a user is never stuck
 * before a sweep.
 *
 * Observability (Sol B-635-3): every run logs one line with erased / failed /
 * remaining counts (`remaining=0` is the rollout-done signal the operator
 * checks); any failed row, a failed run, or a backlog that stops retrying is
 * reported to Sentry. Every diagnostic goes through `safeDiagnostic` first,
 * so no ORM message (which can carry query arguments) reaches a log or
 * Sentry.
 */
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/node';
import { safeDiagnostic } from '../observability/orm-diagnostics';
import { RomanService, type RomanErasureRunResult } from './roman.service';
import {
  ROMAN_ERASE_SWEEP_BOOT_DELAY_MS,
  ROMAN_ERASE_SWEEP_CONTINUE_DELAY_MS,
  ROMAN_ERASE_SWEEP_MAX_RETRIES,
  ROMAN_ERASE_SWEEP_RETRY_DELAY_MS,
} from './roman.constants';

export type RomanErasureSweepTrigger = 'boot' | 'nightly' | 'follow-up';

/** Sentry error for an erasure run that left content behind (counts only). */
function sweepAlert(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

@Injectable()
export class RomanErasureSweep implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RomanErasureSweep.name);
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private followUpTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  /** Follow-up runs in a row that erased nothing while rows were left. */
  private retriesWithoutProgress = 0;

  constructor(private readonly roman: RomanService) {}

  onApplicationBootstrap(): void {
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.run('boot');
    }, ROMAN_ERASE_SWEEP_BOOT_DELAY_MS);
    this.bootTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.bootTimer = null;
    this.followUpTimer = null;
  }

  @Cron('0 4 * * *', { name: 'roman-erase-deleted-sessions', timeZone: 'UTC' })
  async nightly(): Promise<void> {
    await this.run('nightly');
  }

  /**
   * One sweep run. Never throws: a failure is logged and sent to Sentry
   * (sanitized). Returns the number of sessions erased. A run that starts
   * while another is in flight on this machine is skipped (returns 0).
   */
  async run(trigger: RomanErasureSweepTrigger): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    if (trigger !== 'follow-up') this.retriesWithoutProgress = 0;
    try {
      return await this.runOnce(trigger);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(trigger: RomanErasureSweepTrigger): Promise<number> {
    let result: RomanErasureRunResult;
    try {
      result = await this.roman.runUnerasedErasure();
    } catch (err) {
      const diagnostic = safeDiagnostic(err);
      Sentry.captureException(diagnostic, {
        tags: { job: 'roman-erase-sweep', trigger },
      });
      this.logger.error(`roman.erase_sweep_failed trigger=${trigger}: ${String(diagnostic)}`);
      this.scheduleRetry(trigger, 'run_failed');
      return 0;
    }

    let remaining: number | null = null;
    try {
      remaining = await this.roman.countUnerasedDeletedSessions();
    } catch (err) {
      this.logger.error(
        `roman.erase_sweep_count_failed trigger=${trigger}: ${String(safeDiagnostic(err))}`,
      );
    }

    const { erased, failed, firstFailure, boundHit } = result;
    const remainingText = remaining === null ? 'unknown' : String(remaining);
    const line = `roman.erase_sweep trigger=${trigger} erased=${erased} failed=${failed} remaining=${remainingText}`;
    if (failed > 0) this.logger.warn(line);
    else this.logger.log(line);

    if (failed > 0) {
      Sentry.captureException(
        sweepAlert(
          'RomanErasureIncomplete',
          `roman.erase_sweep_incomplete trigger=${trigger} erased=${erased} failed=${failed} remaining=${remainingText}`,
        ),
        {
          tags: { job: 'roman-erase-sweep', trigger },
          extra: { erased, failed, remaining, first_failure: firstFailure },
        },
      );
    }

    const left = remaining === null ? boundHit || failed > 0 : remaining > 0;
    if (!left) {
      this.retriesWithoutProgress = 0;
    } else if (erased > 0) {
      this.retriesWithoutProgress = 0;
      this.scheduleFollowUp(ROMAN_ERASE_SWEEP_CONTINUE_DELAY_MS);
    } else {
      this.scheduleRetry(trigger, `remaining=${remainingText}`);
    }
    return erased;
  }

  /** Retry a run that made no progress, a bounded number of times in a row. */
  private scheduleRetry(trigger: RomanErasureSweepTrigger, why: string): void {
    if (this.retriesWithoutProgress >= ROMAN_ERASE_SWEEP_MAX_RETRIES) {
      Sentry.captureException(
        sweepAlert(
          'RomanErasureStalled',
          `roman.erase_sweep_stalled trigger=${trigger} retries=${this.retriesWithoutProgress} ${why}`,
        ),
        { tags: { job: 'roman-erase-sweep', trigger } },
      );
      this.logger.error(
        `roman.erase_sweep_stalled trigger=${trigger} retries=${this.retriesWithoutProgress} ${why}; next try is the nightly run`,
      );
      return;
    }
    this.retriesWithoutProgress++;
    this.scheduleFollowUp(ROMAN_ERASE_SWEEP_RETRY_DELAY_MS);
  }

  private scheduleFollowUp(delayMs: number): void {
    if (this.stopped || this.followUpTimer) return;
    this.followUpTimer = setTimeout(() => {
      this.followUpTimer = null;
      void this.run('follow-up');
    }, delayMs);
    this.followUpTimer.unref?.();
  }
}
