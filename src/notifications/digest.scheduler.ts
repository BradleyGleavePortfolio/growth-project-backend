import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DigestService } from './digest.service';

/**
 * DigestScheduler — cron-driven triggers for all email digest sends.
 *
 * Schedule defaults (all UTC):
 *   CLIENT_DAILY_CRON   = "0 7 * * *"   — 07:00 UTC daily
 *   COACH_DAILY_CRON    = "0 6 * * *"   — 06:00 UTC daily
 *   WEEKLY_DIGEST_CRON  = "0 8 * * 0"   — 08:00 UTC every Sunday
 *
 * All three defaults are configurable via env vars (see .env.example).
 * The @Cron decorator accepts a cron string at decoration time; to allow
 * dynamic env-based schedules we fall back to the hardcoded defaults when
 * the env var is absent. If you need fully dynamic schedules, migrate these
 * to CronJob from @nestjs/schedule (dynamic registration via SchedulerRegistry).
 *
 * Idempotency: DigestService.claimDigestWindow ensures that if this cron
 * fires twice for the same day (e.g. on a redeploy) only one email goes out.
 */
@Injectable()
export class DigestScheduler {
  private readonly logger = new Logger(DigestScheduler.name);

  constructor(
    private readonly digestService: DigestService,
    private readonly config: ConfigService,
  ) {}

  // ── Client daily ─────────────────────────────────────────────────────────

  // Default: 07:00 UTC. Override via CLIENT_DAILY_CRON env var.
  @Cron(process.env.CLIENT_DAILY_CRON ?? '0 7 * * *', {
    name: 'client-daily-digest',
    timeZone: 'UTC',
  })
  async clientDailyDigest(): Promise<void> {
    const enabled =
      this.config.get<string>('EMAIL_DIGEST_CLIENT_ENABLED') !== 'off';
    if (!enabled) {
      this.logger.debug('client daily digest skipped — EMAIL_DIGEST_CLIENT_ENABLED=off');
      return;
    }
    this.logger.log('client daily digest cron triggered');
    await this.digestService.sendClientDailyDigests();
  }

  // ── Coach daily ───────────────────────────────────────────────────────────

  // Default: 06:00 UTC. Override via COACH_DAILY_CRON env var.
  @Cron(process.env.COACH_DAILY_CRON ?? '0 6 * * *', {
    name: 'coach-daily-digest',
    timeZone: 'UTC',
  })
  async coachDailyDigest(): Promise<void> {
    const enabled =
      this.config.get<string>('EMAIL_DIGEST_COACH_ENABLED') !== 'off';
    if (!enabled) {
      this.logger.debug('coach daily digest skipped — EMAIL_DIGEST_COACH_ENABLED=off');
      return;
    }
    this.logger.log('coach daily digest cron triggered');
    await this.digestService.sendCoachDailyDigests();
  }

  // ── Weekly (both roles) ───────────────────────────────────────────────────

  // Default: 08:00 UTC Sunday. Override via WEEKLY_DIGEST_CRON env var.
  @Cron(process.env.WEEKLY_DIGEST_CRON ?? '0 8 * * 0', {
    name: 'weekly-digest',
    timeZone: 'UTC',
  })
  async weeklyDigest(): Promise<void> {
    this.logger.log('weekly digest cron triggered');
    await this.digestService.sendWeeklyDigests();
  }
}
