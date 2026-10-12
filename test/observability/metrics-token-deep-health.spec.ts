import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HealthDeepController } from '../../src/observability/health-deep.controller';
import { MetricsAuthGuard } from '../../src/observability/metrics-auth.guard';
import { MetricsController } from '../../src/observability/metrics.controller';
import { MetricsService } from '../../src/observability/metrics.service';
import { PromMetricsController } from '../../src/observability/prom-metrics.controller';
import { PrismaService } from '../../src/prisma.service';

const SENTINEL =
  'postgresql://synthetic-user:synthetic-password@synthetic-db.internal.invalid/synthetic_schema';
const ENV_KEYS = ['NODE_ENV', 'METRICS_AUTH_TOKEN', 'REDIS_URL'] as const;

describe('observability endpoints over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  const savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  const query = jest.fn<Promise<unknown[]>, [TemplateStringsArray]>();
  const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  const get = async (path: string, token?: string) => {
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const response = await fetch(new URL(path, baseUrl), { headers });
    return { status: response.status, body: await response.text() };
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MetricsController, PromMetricsController, HealthDeepController],
      providers: [
        MetricsService,
        MetricsAuthGuard,
        { provide: PrismaService, useValue: { $queryRaw: query } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    delete process.env.METRICS_AUTH_TOKEN;
    delete process.env.REDIS_URL;
    logged.mockClear();
  });

  afterAll(async () => {
    await app.close();
    logged.mockRestore();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    ['unset', undefined, 503],
    ['set', 'scrape-token', 401],
  ])('rejects /metrics exactly like /metrics/prom (token %s)', async (_, token, status) => {
    if (token) process.env.METRICS_AUTH_TOKEN = token;
    for (const presented of [undefined, 'wrong-token']) {
      const prom = await get('/metrics/prom', presented);
      expect(prom.status).toBe(status);
      expect(await get('/metrics', presented)).toEqual(prom);
    }
  });

  it('serves /metrics with the right token', async () => {
    process.env.METRICS_AUTH_TOKEN = 'scrape-token';
    const response = await get('/metrics', 'scrape-token');
    expect(response.status).toBe(200);
    expect(response.body).toContain('# TYPE http_requests_total counter');
  });

  it('reports a failing database with the same shape and status but no error text', async () => {
    query.mockRejectedValueOnce(new Error(`Connection failed: ${SENTINEL}`));
    const response = await fetch(new URL('/health/deep', baseUrl));
    const body: unknown = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      ok: false,
      db: 'down',
      redis: 'unconfigured',
      uptime: expect.any(Number),
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      errors: ['db: unavailable'],
    });
    expect(logged).toHaveBeenCalledWith({
      event: 'deep_health_dependency_down',
      operation: 'health.deep',
      component: 'db',
      diagnostic: 'Error',
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SENTINEL);
  });
});
