/**
 * RomanErasureSweep (Sol C-635-1, B-635-3): erases deleted Roman chats that
 * still hold content (pre-upgrade soft deletes, rolling-deploy stragglers).
 * The erasure itself is proven in roman.service.spec.ts (fake with the real
 * unique key) and roman-session-erase.live.spec.ts (Postgres); this spec pins
 * the scheduling, the follow-up runs until nothing is left, and the
 * never-throw + sanitized Sentry contract, with the REAL RomanService
 * per-row catch where it matters (Sol B-635-3).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import type { PrismaService } from '../../src/prisma.service';
import { RomanModule } from '../../src/roman/roman.module';
import { RomanErasureSweep } from '../../src/roman/roman-erasure.sweep';
import { RomanService, type RomanErasureRunResult } from '../../src/roman/roman.service';
import {
  ROMAN_ERASE_SWEEP_BOOT_DELAY_MS,
  ROMAN_ERASE_SWEEP_CONTINUE_DELAY_MS,
  ROMAN_ERASE_SWEEP_MAX_RETRIES,
  ROMAN_ERASE_SWEEP_RETRY_DELAY_MS,
} from '../../src/roman/roman.constants';
import { grantAllEgress } from '../ai-egress/ai-egress.fakes';

jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

const CANARY = 'AUDIT_PRIVATE_ORM_QUERY_CANARY';

function run(over: Partial<RomanErasureRunResult> = {}): RomanErasureRunResult {
  return { erased: 0, failed: 0, firstFailure: null, boundHit: false, ...over };
}

/** A service double: each call to runUnerasedErasure / count pops the next scripted value. */
function makeSweep(runs: Array<RomanErasureRunResult | Error>, counts: Array<number | Error> = []) {
  const runUnerasedErasure = jest.fn(async () => {
    const next = runs.length > 1 ? runs.shift()! : runs[0];
    if (next instanceof Error) throw next;
    return next;
  });
  const countUnerasedDeletedSessions = jest.fn(async () => {
    const next = counts.length > 1 ? counts.shift()! : (counts[0] ?? 0);
    if (next instanceof Error) throw next;
    return next;
  });
  const roman: Pick<RomanService, 'runUnerasedErasure' | 'countUnerasedDeletedSessions'> = {
    runUnerasedErasure,
    countUnerasedDeletedSessions,
  };
  // The sweep only uses these two methods.
  const sweep = new RomanErasureSweep(roman as RomanService);
  return { sweep, runUnerasedErasure, countUnerasedDeletedSessions };
}

function ormError(): Error {
  return new Prisma.PrismaClientKnownRequestError(`Database query failed ${CANARY}`, {
    code: 'P2024',
    clientVersion: 'test',
  });
}

describe('RomanErasureSweep (C-635-1 / B-635-3)', () => {
  let logs: jest.SpyInstance[] = [];
  beforeEach(() => {
    logs = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
    ];
  });
  afterEach(() => {
    for (const l of logs) l.mockRestore();
    jest.useRealTimers();
    jest.clearAllMocks();
  });
  // Errors serialize with name, message and stack (JSON.stringify alone drops
  // them), so a canary anywhere in what was logged or sent is caught.
  const withErrors = (_k: string, v: unknown) =>
    v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
  const allLogText = () =>
    JSON.stringify(
      logs.map((l) => l.mock.calls),
      withErrors,
    );
  const sentryText = () =>
    JSON.stringify(jest.mocked(Sentry.captureException).mock.calls, withErrors);

  it('a run returns the erased count and always logs one line with the remaining count', async () => {
    const { sweep } = makeSweep([run({ erased: 3 })], [0]);
    await expect(sweep.run('nightly')).resolves.toBe(3);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(allLogText()).toContain(
      'roman.erase_sweep trigger=nightly erased=3 failed=0 remaining=0',
    );
  });

  it('a zero-result run still logs (remaining=0 is the rollout-done signal)', async () => {
    const { sweep } = makeSweep([run()], [0]);
    await expect(sweep.run('boot')).resolves.toBe(0);
    expect(allLogText()).toContain('roman.erase_sweep trigger=boot erased=0 failed=0 remaining=0');
  });

  it('a failed run never throws, reports a SANITIZED diagnostic to Sentry once, and returns 0', async () => {
    jest.useFakeTimers();
    const { sweep } = makeSweep([ormError()]);
    await expect(sweep.run('boot')).resolves.toBe(0);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentryText()).not.toContain(CANARY);
    expect(allLogText()).not.toContain(CANARY);
    expect(allLogText()).toContain('Database request failed (P2024)');
    sweep.onModuleDestroy();
  });

  it('per-row failures inside a run are reported to Sentry (counts + sanitized first failure)', async () => {
    jest.useFakeTimers();
    const { sweep } = makeSweep(
      [
        run({
          erased: 2,
          failed: 1,
          firstFailure: 'DatabaseRequestError: Database request failed (P2024)',
        }),
      ],
      [1],
    );
    await expect(sweep.run('nightly')).resolves.toBe(2);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = jest.mocked(Sentry.captureException).mock.calls[0];
    expect((err as Error).name).toBe('RomanErasureIncomplete');
    expect((err as Error).message).toBe(
      'roman.erase_sweep_incomplete trigger=nightly erased=2 failed=1 remaining=1',
    );
    expect(ctx).toMatchObject({
      tags: { job: 'roman-erase-sweep', trigger: 'nightly' },
      extra: {
        erased: 2,
        failed: 1,
        remaining: 1,
        first_failure: 'DatabaseRequestError: Database request failed (P2024)',
      },
    });
    sweep.onModuleDestroy();
  });

  it('with the REAL service, a per-row ORM failure reaches Sentry and no raw ORM text reaches a log or Sentry', async () => {
    jest.useFakeTimers();
    const db = {
      romanSession: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'legacy-session', user_id: 'test-user', day_key: '2026-10-01' },
          ]),
        count: jest.fn().mockResolvedValue(1),
      },
      $transaction: jest.fn().mockRejectedValue(ormError()),
    };
    // @ts-expect-error partial double: only the delegates the sweep run touches.
    const prisma: PrismaService = db;
    const sweep = new RomanErasureSweep(new RomanService(prisma, grantAllEgress()));
    await expect(sweep.run('boot')).resolves.toBe(0);
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(sentryText()).not.toContain(CANARY);
    expect(allLogText()).not.toContain(CANARY);
    expect(sentryText()).toContain('Database request failed (P2024)');
    sweep.onModuleDestroy();
  });

  it('a run that made progress but left rows continues after the short delay until nothing is left', async () => {
    jest.useFakeTimers();
    const { sweep, runUnerasedErasure } = makeSweep(
      [
        run({ erased: 5000, boundHit: true }),
        run({ erased: 5000, boundHit: true }),
        run({ erased: 12 }),
      ],
      [10012, 12, 0],
    );
    await sweep.run('boot');
    expect(runUnerasedErasure).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(ROMAN_ERASE_SWEEP_CONTINUE_DELAY_MS);
    expect(runUnerasedErasure).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(ROMAN_ERASE_SWEEP_CONTINUE_DELAY_MS);
    expect(runUnerasedErasure).toHaveBeenCalledTimes(3);
    // Drained: no further run is scheduled.
    await jest.advanceTimersByTimeAsync(ROMAN_ERASE_SWEEP_RETRY_DELAY_MS * 4);
    expect(runUnerasedErasure).toHaveBeenCalledTimes(3);
    expect(allLogText()).toContain('trigger=follow-up erased=12 failed=0 remaining=0');
  });

  it('a run with no progress retries a bounded number of times, then alerts and waits for the nightly run', async () => {
    jest.useFakeTimers();
    const { sweep, runUnerasedErasure } = makeSweep(
      [run({ failed: 2, firstFailure: 'DatabaseRequestError: Database request failed (P2024)' })],
      [2],
    );
    await sweep.run('nightly');
    for (let i = 0; i < ROMAN_ERASE_SWEEP_MAX_RETRIES; i++) {
      await jest.advanceTimersByTimeAsync(ROMAN_ERASE_SWEEP_RETRY_DELAY_MS);
    }
    expect(runUnerasedErasure).toHaveBeenCalledTimes(1 + ROMAN_ERASE_SWEEP_MAX_RETRIES);
    await jest.advanceTimersByTimeAsync(ROMAN_ERASE_SWEEP_RETRY_DELAY_MS * 10);
    expect(runUnerasedErasure).toHaveBeenCalledTimes(1 + ROMAN_ERASE_SWEEP_MAX_RETRIES);
    const names = jest.mocked(Sentry.captureException).mock.calls.map(([e]) => (e as Error).name);
    expect(names).toContain('RomanErasureStalled');
    // The next nightly run starts a fresh retry cycle.
    await sweep.nightly();
    await jest.advanceTimersByTimeAsync(ROMAN_ERASE_SWEEP_RETRY_DELAY_MS);
    expect(runUnerasedErasure).toHaveBeenCalledTimes(3 + ROMAN_ERASE_SWEEP_MAX_RETRIES);
    sweep.onModuleDestroy();
  });

  it('when the remaining count cannot be read, a bound-hit run still continues (never silently stops)', async () => {
    jest.useFakeTimers();
    const { sweep, runUnerasedErasure } = makeSweep(
      [run({ erased: 5000, boundHit: true }), run({ erased: 1 })],
      [ormError(), 0],
    );
    await sweep.run('boot');
    expect(allLogText()).toContain('remaining=unknown');
    expect(allLogText()).not.toContain(CANARY);
    await jest.advanceTimersByTimeAsync(ROMAN_ERASE_SWEEP_CONTINUE_DELAY_MS);
    expect(runUnerasedErasure).toHaveBeenCalledTimes(2);
    sweep.onModuleDestroy();
  });

  it('a run that starts while another is in flight on this machine is skipped', async () => {
    let release: (v: RomanErasureRunResult) => void = () => undefined;
    const runUnerasedErasure = jest.fn(
      () => new Promise<RomanErasureRunResult>((resolve) => (release = resolve)),
    );
    const roman: Pick<RomanService, 'runUnerasedErasure' | 'countUnerasedDeletedSessions'> = {
      runUnerasedErasure,
      countUnerasedDeletedSessions: jest.fn(async () => 0),
    };
    const sweep = new RomanErasureSweep(roman as RomanService);
    const first = sweep.run('boot');
    await expect(sweep.run('nightly')).resolves.toBe(0);
    release(run({ erased: 1 }));
    await expect(first).resolves.toBe(1);
    expect(runUnerasedErasure).toHaveBeenCalledTimes(1);
  });

  it('the nightly cron runs the sweep', async () => {
    const { sweep, runUnerasedErasure } = makeSweep([run()], [0]);
    await sweep.nightly();
    expect(runUnerasedErasure).toHaveBeenCalledTimes(1);
  });

  it('boot schedules one delayed run off the boot path', async () => {
    jest.useFakeTimers();
    const { sweep, runUnerasedErasure } = makeSweep([run()], [0]);
    sweep.onApplicationBootstrap();
    expect(runUnerasedErasure).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(ROMAN_ERASE_SWEEP_BOOT_DELAY_MS);
    expect(runUnerasedErasure).toHaveBeenCalledTimes(1);
  });

  it('shutdown cancels the boot run and any pending follow-up', async () => {
    jest.useFakeTimers();
    const { sweep, runUnerasedErasure } = makeSweep([run({ erased: 1, boundHit: true })], [5]);
    sweep.onApplicationBootstrap();
    sweep.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(ROMAN_ERASE_SWEEP_BOOT_DELAY_MS * 2);
    expect(runUnerasedErasure).not.toHaveBeenCalled();

    const other = makeSweep([run({ erased: 1, boundHit: true })], [5]);
    await other.sweep.run('nightly');
    other.sweep.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(ROMAN_ERASE_SWEEP_RETRY_DELAY_MS * 2);
    expect(other.runUnerasedErasure).toHaveBeenCalledTimes(1);
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
