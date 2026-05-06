import {
  PtmScheduler,
  PTM_SCORING_CRON_DEFAULT,
} from '../src/ptm/ptm.scheduler';
import type { PtmRecomputeService } from '../src/ptm/ptm-recompute.service';

// Pins the contract between the PTM scheduler and PtmRecomputeService:
//
//   - Default cron expression is "0 4 * * *" (04:00 UTC, one hour after
//     the GDPR scrub at 03:00 UTC).
//   - PTM_SCORING_ENABLED='false' short-circuits the cron handler — no
//     recompute call is made.
//   - Default invocation calls recomputeBatch() exactly once per tick.
//   - A thrown error from recomputeBatch is caught and logged so the
//     Nest process keeps running.

describe('PtmScheduler', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('default cron expression is daily at 04:00 UTC', () => {
    expect(PTM_SCORING_CRON_DEFAULT).toBe('0 4 * * *');
  });

  it('@Cron metadata pins the name and timezone', () => {
    const meta = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      PtmScheduler.prototype.handleCron,
    );
    expect(meta).toBeDefined();
    expect(meta.name).toBe('ptm-recompute-nightly');
    expect(meta.timeZone).toBe('UTC');
  });

  it('PTM_SCORING_ENABLED=false short-circuits — no recompute call', async () => {
    process.env.PTM_SCORING_ENABLED = 'false';
    const recomputeBatch = jest.fn().mockResolvedValue({
      considered: 0,
      recomputed: 0,
      errors: 0,
    });
    const scheduler = new PtmScheduler({
      recomputeBatch,
    } as unknown as PtmRecomputeService);

    await scheduler.handleCron();

    expect(recomputeBatch).not.toHaveBeenCalled();
  });

  it('default invocation calls recomputeBatch exactly once', async () => {
    delete process.env.PTM_SCORING_ENABLED;
    const recomputeBatch = jest.fn().mockResolvedValue({
      considered: 5,
      recomputed: 5,
      errors: 0,
    });
    const scheduler = new PtmScheduler({
      recomputeBatch,
    } as unknown as PtmRecomputeService);

    await scheduler.handleCron();

    expect(recomputeBatch).toHaveBeenCalledTimes(1);
  });

  it('handleCron swallows fatal errors from recomputeBatch', async () => {
    delete process.env.PTM_SCORING_ENABLED;
    const recomputeBatch = jest
      .fn()
      .mockRejectedValue(new Error('database is on fire'));
    const scheduler = new PtmScheduler({
      recomputeBatch,
    } as unknown as PtmRecomputeService);

    // Contract: the cron handler resolves rather than rejects — an
    // unhandled rejection here would propagate up to @nestjs/schedule
    // and, on some Node versions, terminate the process.
    await expect(scheduler.handleCron()).resolves.toBeUndefined();
    expect(recomputeBatch).toHaveBeenCalledTimes(1);
  });
});
