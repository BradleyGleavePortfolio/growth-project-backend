import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DunningV2Service } from './dunning-v2.service';
import { isDunningV2Enabled } from './dunning-v2.feature';
import { DUNNING_LOCKOUT_SWEEP_CRON_EXPRESSION } from './dunning-v2.cadence';

/**
 * B3 Smart Dunning v2 — Day-10 hard-lockout sweep cron (spec §7.1).
 *
 * A daily cron SEPARATE from the v1 cadence tick/retry loop. It performs ONLY
 * lockouts — it never sends reminders or attempts charges. Follows the
 * established fixed-UTC-time pattern (see GdprScrubScheduler). Runs at 02:00
 * UTC (`DUNNING_LOCKOUT_SWEEP_CRON_EXPRESSION`).
 *
 * Gated: when FEATURE_DUNNING_V2 is OFF the tick logs and returns immediately
 * without touching any row — v1 deployments see a harmless no-op cron. The
 * sweep itself (candidate selection, per-row lockout transaction) lives in
 * DunningV2Service.runLockoutSweep and is idempotent (`locked_out_at: null`
 * filter), so a missed-tick catch-up never double-locks.
 */
@Injectable()
export class DunningLockoutScheduler {
  private readonly logger = new Logger(DunningLockoutScheduler.name);

  constructor(private readonly dunningV2: DunningV2Service) {}

  @Cron(DUNNING_LOCKOUT_SWEEP_CRON_EXPRESSION, {
    name: 'dunning-v2-lockout-sweep',
    timeZone: 'UTC',
  })
  async handleCron(): Promise<void> {
    if (!isDunningV2Enabled()) {
      this.logger.debug(
        'dunning v2 lockout sweep: FEATURE_DUNNING_V2 off — skipping',
      );
      return;
    }
    this.logger.log('dunning v2 lockout sweep: starting daily run');
    try {
      const { locked } = await this.dunningV2.runLockoutSweep();
      this.logger.log(`dunning v2 lockout sweep: completed; locked=${locked}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`dunning v2 lockout sweep: fatal error: ${message}`);
    }
  }
}
