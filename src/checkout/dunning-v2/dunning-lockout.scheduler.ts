import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DunningV2Service } from './dunning-v2.service';
import { dunningErrorCode } from './dunning-v2.safe-error';
import { isDunningV2Enabled } from './dunning-v2.feature';
import { DUNNING_V2_SWEEP_CRON_EXPRESSION } from './dunning-v2.cadence';

/**
 * B3 Smart Dunning v2 — the sweep cron (S-DUNNING: hourly at minute 7 UTC).
 *
 * Each tick advances active cycles to their due step (Day 1/3/7 notices,
 * Day-7 coach alert) and locks cycles that reached Day 10. It never charges:
 * Stripe's retry schedule owns every charge attempt.
 *
 * Overlap: every write is a CAS (`step_index` / `locked_out_at: null`), so two
 * machines running the same tick, or a tick racing a webhook, send each step
 * once and lock once. Within one process a tick that is still running when
 * the next fires is skipped (`running`), so a slow Stripe check cannot stack
 * sweeps. Gated: with FEATURE_DUNNING_V2 off the tick returns immediately.
 */
@Injectable()
export class DunningLockoutScheduler {
  private readonly logger = new Logger(DunningLockoutScheduler.name);
  private running = false;

  constructor(private readonly dunningV2: DunningV2Service) {}

  @Cron(DUNNING_V2_SWEEP_CRON_EXPRESSION, {
    name: 'dunning-v2-sweep',
    timeZone: 'UTC',
  })
  async handleCron(): Promise<void> {
    if (!isDunningV2Enabled()) {
      this.logger.debug('dunning v2 sweep: FEATURE_DUNNING_V2 off, skipping');
      return;
    }
    if (this.running) {
      this.logger.warn('dunning v2 sweep: previous tick still running, skipping');
      return;
    }
    this.running = true;
    try {
      const out = await this.dunningV2.runSweep();
      this.logger.log(JSON.stringify({ event: 'dunning_v2.sweep_completed', ...out }));
    } catch (err: unknown) {
      this.logger.error(`dunning v2 sweep: fatal error: ${dunningErrorCode(err)}`);
    } finally {
      this.running = false;
    }
  }
}
