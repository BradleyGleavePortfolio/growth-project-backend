import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import {
  WearableProcessedEventPruneScheduler,
  WEARABLE_PROCESSED_EVENT_PRUNE_CRON_EXPRESSION,
} from '../../../src/wearables/maintenance/wearable-processed-event-prune.scheduler';
import { WearableProcessedEventPruneService } from '../../../src/wearables/maintenance/wearable-processed-event-prune.service';

// Pins the contract between the scheduler and WearableProcessedEventPruneService:
//
//   - The cron expression is exactly "0 4 * * *" — the 04:00 UTC slot, the next
//     free 15-minute window after the 03:00–03:45 nightly stagger
//     (AccountDeletionService 03:00 → … → GdprScrubScheduler 03:45). Drift here
//     would silently move the prune off its window, so the value is asserted
//     both as the exported constant AND as the @nestjs/schedule decorator
//     metadata read off the method.
//   - handleCron() invokes prune() exactly once per tick and logs the
//     structured success event { event, deleted_count, cutoff_iso }.
//   - A thrown error from prune() is caught, logged as
//     'wearable_processed_event_prune_failed', and swallowed — the scheduler
//     must never crash the Nest process (a single bad night would otherwise
//     take the API down until the next deploy).
//
// The prune service is supplied through Nest's DI container via
// Test.createTestingModule().overrideProvider(...).useValue(...). The override
// value is typed as `unknown` at the DI boundary, so a structural mock that
// implements only the surface the scheduler touches (`prune`) satisfies the
// provider without any cast — the same idiom the rest of this repo's service
// specs use (see test/timeline.service.spec.ts, test/sub-coach-*.service.spec.ts).

describe('WearableProcessedEventPruneScheduler', () => {
  // Builds a TestingModule whose WearableProcessedEventPruneService provider is
  // overridden with a structural mock exposing the given prune() implementation.
  async function buildScheduler(
    prune: jest.Mock,
  ): Promise<WearableProcessedEventPruneScheduler> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WearableProcessedEventPruneScheduler,
        WearableProcessedEventPruneService,
      ],
    })
      .overrideProvider(WearableProcessedEventPruneService)
      .useValue({ prune })
      .compile();

    return module.get<WearableProcessedEventPruneScheduler>(
      WearableProcessedEventPruneScheduler,
    );
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('cron expression is daily at 04:00 UTC', () => {
    expect(WEARABLE_PROCESSED_EVENT_PRUNE_CRON_EXPRESSION).toBe('0 4 * * *');
  });

  it('@Cron metadata pins the same expression, UTC timezone, and name', () => {
    const meta = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      WearableProcessedEventPruneScheduler.prototype.handleCron,
    );
    expect(meta).toBeDefined();
    expect(meta.cronTime).toBe('0 4 * * *');
    expect(meta.timeZone).toBe('UTC');
    expect(meta.name).toBe('wearable-processed-event-prune-daily');
  });

  it('handleCron invokes prune() once and logs the structured success event', async () => {
    const cutoff = new Date('2026-01-01T04:00:00.000Z');
    const prune = jest.fn().mockResolvedValue({ deleted: 12, cutoff });
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    const scheduler = await buildScheduler(prune);

    await expect(scheduler.handleCron()).resolves.toBeUndefined();

    expect(prune).toHaveBeenCalledTimes(1);
    // prune() is called with a Date "now".
    expect(prune.mock.calls[0][0]).toBeInstanceOf(Date);
    expect(logSpy).toHaveBeenCalledWith({
      event: 'wearable_processed_event_prune',
      deleted_count: 12,
      cutoff_iso: cutoff.toISOString(),
    });
  });

  it('handleCron logs and swallows a fatal error from prune() (no rethrow)', async () => {
    const boom = new Error('database is on fire');
    const prune = jest.fn().mockRejectedValue(boom);
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const scheduler = await buildScheduler(prune);

    // The contract is that the handler resolves rather than rejects — an
    // unhandled rejection here would propagate to @nestjs/schedule and, on
    // some Node versions, terminate the process.
    await expect(scheduler.handleCron()).resolves.toBeUndefined();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({
      event: 'wearable_processed_event_prune_failed',
      error: 'database is on fire',
    });
  });

  it('stringifies non-Error throwables in the failure log', async () => {
    const prune = jest.fn().mockRejectedValue('plain string blip');
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const scheduler = await buildScheduler(prune);

    await expect(scheduler.handleCron()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith({
      event: 'wearable_processed_event_prune_failed',
      error: 'plain string blip',
    });
  });
});
