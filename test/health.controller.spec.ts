import { HttpStatus } from '@nestjs/common';
import { HealthController } from '../src/health/health.controller';

// Audit M-3: liveness (/healthz) must always return 200; readiness (/readyz)
// must round-trip a real query against Prisma and return 503 if it throws.
// We test the controller directly with a mocked PrismaService — booting the
// full Nest app for two endpoints would be overkill given the rest of the
// suite is controller-level too.

describe('HealthController', () => {
  function buildController(opts: { dbOk: boolean; error?: Error }) {
    const prisma = {
      $queryRaw: jest.fn(() => {
        if (opts.dbOk) return Promise.resolve([{ '?column?': 1 }]);
        return Promise.reject(opts.error ?? new Error('connection refused'));
      }),
    } as any;
    return { controller: new HealthController(prisma), prisma };
  }

  function makeRes() {
    let statusCode = HttpStatus.OK;
    return {
      status(code: number) {
        statusCode = code;
        return this;
      },
      get statusCode() {
        return statusCode;
      },
    } as any;
  }

  it('GET /healthz returns 200 with ok:true regardless of DB state', () => {
    const { controller } = buildController({ dbOk: false });
    const result = controller.liveness();
    expect(result.ok).toBe(true);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof result.uptime).toBe('number');
  });

  it('GET /health (legacy alias) is equivalent to /healthz', () => {
    const { controller } = buildController({ dbOk: true });
    const a = controller.check();
    const b = controller.liveness();
    // Both must return ok:true — timestamps will differ by µs but the
    // structural shape is what matters.
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(typeof a.uptime).toBe('number');
  });

  it('GET /readyz returns 200 + ok:true when DB ping succeeds', async () => {
    const { controller, prisma } = buildController({ dbOk: true });
    const res = makeRes();
    const body = await controller.readiness(res);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(HttpStatus.OK);
    expect(body.ok).toBe(true);
    expect(body.db).toBe('up');
  });

  it('GET /readyz returns 503 + ok:false when DB ping fails', async () => {
    const { controller } = buildController({
      dbOk: false,
      error: new Error('connection refused'),
    });
    const res = makeRes();
    const body = await controller.readiness(res);
    expect(res.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.ok).toBe(false);
    expect(body.db).toBe('down');
    expect(body.error).toContain('connection refused');
  });
});
