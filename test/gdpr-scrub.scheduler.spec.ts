import {
  GdprScrubScheduler,
  GDPR_SCRUB_CRON_EXPRESSION,
} from '../src/users/gdpr-scrub.scheduler';
import type { GdprScrubService } from '../src/users/gdpr-scrub.service';

// Pins the contract between the scheduler and GdprScrubService:
//
//   - The cron expression is exactly "45 3 * * *" — the 03:45 UTC slot in
//     the nightly cron stagger (see src/account-deletion/... for the full
//     alphabetical-by-class-name 15-minute policy). Drift here would
//     silently miss a regulatory commitment, so the value is asserted both
//     as the exported constant AND as the decorator metadata
//     @nestjs/schedule reads off the method.
//   - handleCron() invokes GdprScrubService.run() exactly once per tick.
//   - A thrown error from run() is caught and logged — the scheduler
//     must never crash the Nest process or a single bad night would
//     take the API down until the next deploy.

describe('GdprScrubScheduler', () => {
  it('cron expression is daily at 03:00 UTC', () => {
    expect(GDPR_SCRUB_CRON_EXPRESSION).toBe('45 3 * * *');
  });

  it('@Cron metadata pins the same expression and UTC timezone', () => {
    // @nestjs/schedule attaches its config under SCHEDULE_CRON_OPTIONS.
    // Reading it back guarantees a future refactor that "fixes" the
    // constant but forgets to update the decorator can't sneak through.
    const meta = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      GdprScrubScheduler.prototype.handleCron,
    );
    expect(meta).toBeDefined();
    expect(meta.cronTime).toBe('45 3 * * *');
    expect(meta.timeZone).toBe('UTC');
    expect(meta.name).toBe('gdpr-scrub-daily');
  });

  it('handleCron invokes GdprScrubService.run() once', async () => {
    const run = jest.fn().mockResolvedValue({
      dry_run: false,
      grace_period_days: 30,
      cutoff: new Date().toISOString(),
      considered: 2,
      scrubbed: 2,
      errors: [],
      candidates: [],
    });
    const scheduler = new GdprScrubScheduler({
      run,
    } as unknown as GdprScrubService);

    await scheduler.handleCron();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({});
  });

  it('handleCron swallows fatal errors from run() so the process keeps running', async () => {
    const boom = new Error('database is on fire');
    const run = jest.fn().mockRejectedValue(boom);
    const scheduler = new GdprScrubScheduler({
      run,
    } as unknown as GdprScrubService);

    // The contract is that the cron handler resolves rather than rejects —
    // an unhandled rejection here would propagate up to @nestjs/schedule
    // and, on some Node versions, terminate the process.
    await expect(scheduler.handleCron()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
