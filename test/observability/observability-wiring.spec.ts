/**
 * Observability wiring tests — verifies the H3 controllers, the bearer-token
 * guard, and the db-stats service collaborate as wired into ObservabilityModule
 * without booting the full AppModule. Uses lightweight fakes for the request
 * context and Prisma so the suite stays fast and deterministic.
 */

import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { MetricsAuthGuard } from '../../src/observability/metrics-auth.guard';
import { PromMetricsController } from '../../src/observability/prom-metrics.controller';
import { DbStatsController } from '../../src/observability/db-stats.controller';
import { DbStatsService } from '../../src/observability/db-stats.service';
import { registerDefaultMetrics } from '../../src/observability/prom-metrics';
import { PrismaService } from '../../src/prisma.service';

/**
 * The service only ever touches `prisma.$queryRaw`. We build a real
 * PrismaService instance and override that single method with a jest spy so
 * the double is a genuine PrismaService (no structural cast needed).
 */
function prismaWith$queryRaw(impl: jest.Mock): PrismaService {
  const prisma = new PrismaService();
  jest.spyOn(prisma, '$queryRaw').mockImplementation(impl);
  return prisma;
}

function ctx(authHeader?: string): ExecutionContext {
  const headers = authHeader ? { authorization: authHeader } : {};
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  };
  // The guard only ever calls `context.switchToHttp().getRequest()`; the rest
  // of the ExecutionContext surface (getArgs/getClass/switchToRpc/...) is
  // infeasible to mock, so we expose just the exercised method and widen the
  // structurally-compatible stub to the public type.
  return host as ExecutionContext;
}

describe('PromMetricsController behind MetricsAuthGuard', () => {
  const ORIGINAL_TOKEN = process.env.METRICS_AUTH_TOKEN;
  const ORIGINAL_ENV = process.env.NODE_ENV;
  const guard = new MetricsAuthGuard();
  const controller = new PromMetricsController();

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.METRICS_AUTH_TOKEN;
    else process.env.METRICS_AUTH_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_ENV;
  });

  it('serves metrics text once the guard authorises a valid token', async () => {
    process.env.METRICS_AUTH_TOKEN = 'scrape-token';
    expect(guard.canActivate(ctx('Bearer scrape-token'))).toBe(true);
    registerDefaultMetrics();
    const body = await controller.prom();
    expect(body).toContain('process_cpu_seconds_total');
  });

  it('blocks the scrape with 401 when the token is wrong', () => {
    process.env.METRICS_AUTH_TOKEN = 'scrape-token';
    expect(() => guard.canActivate(ctx('Bearer nope'))).toThrow(UnauthorizedException);
  });

  it('fails closed with 503 in production when no token is configured', () => {
    delete process.env.METRICS_AUTH_TOKEN;
    process.env.NODE_ENV = 'production';
    expect(() => guard.canActivate(ctx())).toThrow(ServiceUnavailableException);
  });
});

describe('DbStatsController over DbStatsService', () => {
  function prismaReturning(rows: unknown[]): PrismaService {
    return prismaWith$queryRaw(jest.fn().mockResolvedValue(rows));
  }

  it('returns a redacted, timestamped payload when the extension is present', async () => {
    const service = new DbStatsService(
      prismaReturning([
        { query: 'SELECT 1', calls: 5n, total_exec_time: 50, mean_exec_time: 10, rows: 5n },
      ]),
    );
    const controller = new DbStatsController(service);
    const body = await controller.dbStatsTop();
    expect(body.available).toBe(true);
    expect(typeof body.generatedAt).toBe('string');
    if (!body.available) return;
    expect(body.statements).toHaveLength(1);
    expect(body.statements[0].queryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns an unavailable payload when the extension is missing', async () => {
    const failing = prismaWith$queryRaw(
      jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: '42P01' })),
    );
    const controller = new DbStatsController(new DbStatsService(failing));
    const body = await controller.dbStatsTop();
    expect(body.available).toBe(false);
    expect(typeof body.generatedAt).toBe('string');
  });
});
