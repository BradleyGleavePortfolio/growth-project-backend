/**
 * Sol C-635-1: RomanErasureSweep erases deleted Roman chats that still hold
 * content (pre-upgrade soft deletes, rolling-deploy stragglers). The erasure
 * itself is proven in roman.service.spec.ts (fake with the real unique key)
 * and roman-session-erase.live.spec.ts (Postgres); this spec pins the
 * scheduling and the never-throw + Sentry contract of the wrapper.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import * as Sentry from '@sentry/node';
import { RomanModule } from '../../src/roman/roman.module';
import { RomanErasureSweep } from '../../src/roman/roman-erasure.sweep';
import type { RomanService } from '../../src/roman/roman.service';
import { ROMAN_ERASE_SWEEP_BOOT_DELAY_MS } from '../../src/roman/roman.constants';

jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

function makeSweep(impl: () => Promise<number>) {
  const eraseUnerasedDeletedSessions = jest.fn(impl);
  const roman: Pick<RomanService, 'eraseUnerasedDeletedSessions'> = {
    eraseUnerasedDeletedSessions,
  };
  return { sweep: new RomanErasureSweep(roman as RomanService), eraseUnerasedDeletedSessions };
}

describe('RomanErasureSweep (C-635-1)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('a run returns the erased count', async () => {
    const { sweep } = makeSweep(async () => 3);
    await expect(sweep.run('nightly')).resolves.toBe(3);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('a failed run never throws, reports to Sentry once, and returns 0', async () => {
    const { sweep } = makeSweep(async () => {
      throw new Error('database unavailable');
    });
    await expect(sweep.run('boot')).resolves.toBe(0);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('the nightly cron runs the sweep', async () => {
    const { sweep, eraseUnerasedDeletedSessions } = makeSweep(async () => 0);
    await sweep.nightly();
    expect(eraseUnerasedDeletedSessions).toHaveBeenCalledTimes(1);
  });

  it('boot schedules one delayed run off the boot path', async () => {
    jest.useFakeTimers();
    const { sweep, eraseUnerasedDeletedSessions } = makeSweep(async () => 0);
    sweep.onApplicationBootstrap();
    expect(eraseUnerasedDeletedSessions).not.toHaveBeenCalled();
    jest.advanceTimersByTime(ROMAN_ERASE_SWEEP_BOOT_DELAY_MS);
    expect(eraseUnerasedDeletedSessions).toHaveBeenCalledTimes(1);
  });

  it('shutdown before the delay cancels the boot run', () => {
    jest.useFakeTimers();
    const { sweep, eraseUnerasedDeletedSessions } = makeSweep(async () => 0);
    sweep.onApplicationBootstrap();
    sweep.onModuleDestroy();
    jest.advanceTimersByTime(ROMAN_ERASE_SWEEP_BOOT_DELAY_MS * 2);
    expect(eraseUnerasedDeletedSessions).not.toHaveBeenCalled();
  });

  it('RomanModule provides the sweep (it runs whatever the chat flag says)', () => {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RomanModule) ?? [];
    expect(providers).toContain(RomanErasureSweep);
  });

  it('the mwb-3-live-tests CI job runs the Roman live erase spec on Postgres', () => {
    const ci = readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
    const start = ci.indexOf('\n  mwb-3-live-tests:');
    const rest = ci.slice(start + 1);
    const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
    const job = next >= 0 ? rest.slice(0, next) : rest;
    expect(job).toContain('MWB3_TEST_DATABASE_URL: postgresql://');
    expect(job).toContain('npx jest test/roman/roman-session-erase.live.spec.ts --runInBand');
  });
});
