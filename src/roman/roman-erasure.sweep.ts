/**
 * Erasure sweep for deleted Roman chats that still hold content (Sol C-635-1).
 *
 * Since #635 a client delete ERASES the conversation (RomanService
 * .deleteSession). Rows deleted before that, or soft-deleted by a machine
 * still running the previous version during a rolling deploy, keep their
 * messages and subject context under a tombstone. This sweep gives them the
 * same erasure: transcript and subject context removed, only the
 * content-free count of in-window user turns kept for the daily cap.
 *
 * It never touches a live session, so it is NOT a retention purge (owner
 * 2026-10-01 20:32: past AI chats are kept until the client deletes them or
 * their account). Runs once shortly after boot (the first start of this
 * version clears every pre-upgrade row) and nightly at 04:00 UTC (after the
 * 03:00-03:45 deletion / export / scrub slots) to catch rollout stragglers.
 * Each row is erased under a compare-and-set, so several machines can run it
 * at once. `RomanService.openOrResumeSession` also erases the one unerased row
 * that blocks today's key on demand, so a user is never stuck before a sweep.
 */
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as Sentry from '@sentry/node';
import { safeDiagnostic } from '../observability/orm-diagnostics';
import { RomanService } from './roman.service';
import { ROMAN_ERASE_SWEEP_BOOT_DELAY_MS } from './roman.constants';

@Injectable()
export class RomanErasureSweep implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RomanErasureSweep.name);
  private bootTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly roman: RomanService) {}

  onApplicationBootstrap(): void {
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.run('boot');
    }, ROMAN_ERASE_SWEEP_BOOT_DELAY_MS);
    this.bootTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = null;
  }

  @Cron('0 4 * * *', { name: 'roman-erase-deleted-sessions', timeZone: 'UTC' })
  async nightly(): Promise<void> {
    await this.run('nightly');
  }

  /** One sweep run. Never throws: a failure is logged and sent to Sentry. */
  async run(trigger: 'boot' | 'nightly'): Promise<number> {
    try {
      const erased = await this.roman.eraseUnerasedDeletedSessions();
      if (erased > 0) {
        this.logger.log(`roman.erase_sweep trigger=${trigger} erased=${erased}`);
      }
      return erased;
    } catch (err) {
      const diagnostic = safeDiagnostic(err);
      Sentry.captureException(diagnostic);
      this.logger.error(`roman.erase_sweep_failed trigger=${trigger}: ${String(diagnostic)}`);
      return 0;
    }
  }
}
