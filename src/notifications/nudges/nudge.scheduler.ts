/**
 * NudgeScheduler — drives Nudge v1 detection on a tight cadence so a
 * user whose local 8am window opens at minute 4 receives their nudge
 * by minute 19 of the same hour (spec §4 — schedule for next morning
 * if triggered overnight).
 *
 * Schedule: every 15 minutes by default. Override via NUDGE_DETECTION_CRON.
 * UTC throughout; per-user timezone is applied by QuietHoursPolicy inside
 * the engine, not by the cron string.
 *
 * Each tick does two things:
 *   1. Pick up deferred rows whose deferred_until has elapsed and
 *      re-run them through the engine gates.
 *   2. Run all four detectors and feed every fresh candidate through
 *      the engine.
 *
 * Both legs are idempotent: deferred rows update an existing log row,
 * and fresh candidates either land on a unique (user, trigger, signal)
 * slot (sent / suppressed / deferred) or collide and get logged as
 * suppressed_dedupe.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { NudgeDetectorService } from './nudge-detector.service';
import { NudgeEngineService } from './nudge-engine.service';

@Injectable()
export class NudgeScheduler {
  private readonly logger = new Logger(NudgeScheduler.name);

  constructor(
    private readonly detector: NudgeDetectorService,
    private readonly engine: NudgeEngineService,
    private readonly config: ConfigService,
  ) {}

  // Default: every 15 minutes. Override via NUDGE_DETECTION_CRON env var.
  // The @Cron decorator evaluates its argument at class-decoration time,
  // so we read env directly here (mirrors the pattern used in
  // DigestScheduler for CLIENT_DAILY_CRON / COACH_DAILY_CRON).
  @Cron(process.env.NUDGE_DETECTION_CRON ?? '*/15 * * * *', {
    name: 'nudge-detection',
    timeZone: 'UTC',
  })
  async tick(): Promise<void> {
    const enabled = this.config.get<string>('NUDGE_ENABLED') !== 'off';
    if (!enabled) {
      this.logger.debug('nudge detection skipped — NUDGE_ENABLED=off');
      return;
    }
    const now = new Date();
    try {
      const reprocessed = await this.engine.reprocessDeferred(now);
      if (reprocessed > 0) {
        this.logger.log(`nudge: reprocessed ${reprocessed} deferred rows`);
      }
    } catch (err) {
      this.logger.warn(
        `nudge reprocessDeferred failed: ${(err as Error).message}`,
      );
    }

    try {
      const candidates = await this.detector.scanAll(now);
      this.logger.log(`nudge: ${candidates.length} candidates from detectors`);
      for (const candidate of candidates) {
        await this.engine.process(candidate, now);
      }
    } catch (err) {
      this.logger.error('nudge detection tick failed', err);
    }
  }
}
