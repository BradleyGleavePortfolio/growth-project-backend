import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BloodworkService } from './bloodwork.service';

// Daily sweep that marks bloodwork panels as stale once they cross the
// configured age. Wired into @nestjs/schedule the same way
// GdprScrubScheduler is. Cron seam only — operations can also run the
// service method directly via a script if we ever need to backfill.
//
// Off by default in test (NODE_ENV === 'test') so unit tests that boot
// the AppModule don't fan out a Prisma write at module init.
@Injectable()
export class BloodworkStaleScheduler {
  private readonly logger = new Logger(BloodworkStaleScheduler.name);

  constructor(private readonly bloodwork: BloodworkService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async run() {
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.BLOODWORK_STALE_DISABLED === 'true') return;
    try {
      const out = await this.bloodwork.markStalePanels();
      if (out.marked > 0) {
        this.logger.log(`Marked ${out.marked} bloodwork panels stale`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Bloodwork stale sweep failed: ${msg}`);
    }
  }
}
