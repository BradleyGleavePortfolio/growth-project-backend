import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { HealthController, READINESS_TIMEOUT_MS } from '../src/health/health.controller';
import { PrismaService } from '../src/prisma.service';

// S3 (2026-09-20) new proof, not inherited: readiness must settle even when the
// database round-trip never does. fly.toml probes /readyz with a 5s consumer
// timeout; a handler that waits on an unresolved Prisma query would leave one
// pending request per probe interval and give the platform a timeout instead
// of an explicit 503.
describe('readiness stays bounded when the database round-trip never settles', () => {
  let app: INestApplication;
  let baseUrl: string;
  const pending: Array<{ resolve: (value: unknown[]) => void }> = [];
  const query = jest.fn<Promise<unknown[]>, [TemplateStringsArray]>(
    () => new Promise((resolve) => pending.push({ resolve })),
  );
  const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  // Only `status` is exercised by the handler (passthrough response).
  const responseDouble = (): { res: Response; status: jest.Mock } => {
    const status = jest.fn().mockReturnThis();
    const partial: Partial<Response> = { status };
    return { res: partial as Response, status };
  };

  beforeAll(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: { $queryRaw: query } }],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    // Settle the deliberately stranded query so no promise outlives the suite.
    for (const entry of pending.splice(0)) entry.resolve([{ value: 1 }]);
    await app.close();
    logged.mockRestore();
    jest.useRealTimers();
  });

  it('bounds the probe below the platform check timeout and reports database_unavailable', async () => {
    expect(READINESS_TIMEOUT_MS).toBeLessThan(5000);
    const controller = app.get(HealthController);
    const { res, status } = responseDouble();
    const outcome = controller.readiness(res);
    // Nothing settles before the bound elapses.
    let settled = false;
    void outcome.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const body = await outcome;
    expect(settled).toBe(true);
    expect(status).toHaveBeenCalledWith(503);
    expect(body).toEqual({
      ok: false,
      db: 'down',
      error: 'database_unavailable',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(logged).toHaveBeenCalledWith({
      event: 'readiness_database_timeout',
      operation: 'health.readiness',
      timeout_ms: READINESS_TIMEOUT_MS,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
  });

  it('clears the bound timer when the query settles first (no stranded handle)', async () => {
    const controller = app.get(HealthController);
    query.mockResolvedValueOnce([{ value: 1 }]);
    const { res, status } = responseDouble();
    const body = await controller.readiness(res);
    expect(body).toEqual({
      ok: true,
      db: 'up',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(status).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('serves the bounded 503 over HTTP with no-store', async () => {
    jest.useRealTimers();
    const started = Date.now();
    const response = await fetch(new URL('/readyz', baseUrl));
    const elapsed = Date.now() - started;
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(elapsed).toBeGreaterThanOrEqual(READINESS_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(5000);
    expect(await response.json()).toMatchObject({
      ok: false,
      db: 'down',
      error: 'database_unavailable',
    });
  });
});
