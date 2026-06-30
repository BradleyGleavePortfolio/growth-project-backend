/**
 * Extended prom-client metrics tests — exercises histogram bucket boundaries,
 * multi-label cardinality, the process-wide default instances, and the
 * controller wiring. Complements prom-metrics.spec.ts.
 */

import { Registry } from 'prom-client';
import type { Request, Response } from 'express';
import { EventEmitter } from 'events';
import {
  buildHttpHistogram,
  httpRequestDurationSeconds,
  HTTP_HISTOGRAM_LABELS,
  normaliseRouteLabel,
  promHttpMiddleware,
  promRegistry,
  registerDefaultMetrics,
  renderPromMetrics,
} from '../../src/observability/prom-metrics';
import { PromMetricsController } from '../../src/observability/prom-metrics.controller';

/**
 * The metrics helpers read only a tiny slice of the Express `Request`
 * (`method`, `path`, optional `route.path`). The full Express Request surface
 * is hundreds of members and infeasible to mock, so we build the exercised
 * fields and suppress the single structural mismatch.
 */
function makeReq(fields: { path?: string; method?: string; routePath?: string }): Request {
  const { path = '', method = 'GET', routePath } = fields;
  const req: { path: string; method: string; route?: { path: string } } = {
    path,
    method,
  };
  if (routePath !== undefined) {
    req.route = { path: routePath };
  }
  // @ts-expect-error partial Express Request: only method/path/route are read
  return req;
}

/**
 * A `Response` double backed by a real EventEmitter so `res.on('finish', ...)`
 * fires through `emitter.emit('finish')`. The Express Response surface is huge
 * and infeasible to mock, so we expose the exercised members and suppress the
 * single structural mismatch.
 */
function makeRes(statusCode = 200): { res: Response; emitter: EventEmitter } {
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, { statusCode });
  // @ts-expect-error partial Express Response: only on()/statusCode are used
  const typed: Response = res;
  return { res: typed, emitter };
}

describe('HTTP_HISTOGRAM_LABELS', () => {
  it('contains exactly method, route, status_code (no PII labels)', () => {
    expect([...HTTP_HISTOGRAM_LABELS]).toEqual(['method', 'route', 'status_code']);
  });

  it('does not include any user-identifying label', () => {
    for (const banned of ['userId', 'user_id', 'email', 'ip', 'sub']) {
      expect([...HTTP_HISTOGRAM_LABELS]).not.toContain(banned);
    }
  });
});

describe('histogram bucket boundaries', () => {
  function bucketCount(text: string, le: string): number {
    const re = new RegExp(
      `http_request_duration_seconds_bucket\\{[^}]*le="${le.replace('.', '\\.')}"[^}]*\\}\\s+(\\d+)`,
    );
    const m = re.exec(text);
    return m ? Number(m[1]) : 0;
  }

  it('places a 3ms sample in the 0.005 bucket and all above', async () => {
    const reg = new Registry();
    const h = buildHttpHistogram(reg);
    h.observe({ method: 'GET', route: '/x', status_code: '200' }, 0.003);
    const text = await reg.metrics();
    expect(bucketCount(text, '0.005')).toBe(1);
    expect(bucketCount(text, '10')).toBe(1);
  });

  it('places a 3s sample only in buckets >= 5 (not in 1)', async () => {
    const reg = new Registry();
    const h = buildHttpHistogram(reg);
    h.observe({ method: 'GET', route: '/slow', status_code: '200' }, 3);
    const text = await reg.metrics();
    expect(bucketCount(text, '1')).toBe(0);
    expect(bucketCount(text, '5')).toBe(1);
    expect(bucketCount(text, '10')).toBe(1);
  });

  it('places a 12s sample (beyond the tail) in no finite bucket', async () => {
    const reg = new Registry();
    const h = buildHttpHistogram(reg);
    h.observe({ method: 'GET', route: '/veryslow', status_code: '504' }, 12);
    const text = await reg.metrics();
    expect(bucketCount(text, '10')).toBe(0);
    expect(text).toContain('http_request_duration_seconds_count');
  });
});

describe('multi-label cardinality', () => {
  it('keeps separate series per method/route/status_code combination', async () => {
    const reg = new Registry();
    const h = buildHttpHistogram(reg);
    h.observe({ method: 'GET', route: '/a', status_code: '200' }, 0.01);
    h.observe({ method: 'POST', route: '/a', status_code: '201' }, 0.02);
    h.observe({ method: 'GET', route: '/b', status_code: '500' }, 0.03);
    const text = await reg.metrics();
    expect(text).toContain('method="POST"');
    expect(text).toContain('status_code="201"');
    expect(text).toContain('route="/b"');
    expect(text).toContain('status_code="500"');
  });
});

describe('process-wide default instances', () => {
  it('exposes a shared httpRequestDurationSeconds histogram', () => {
    expect(httpRequestDurationSeconds).toBeDefined();
  });

  it('registers defaults on the shared promRegistry', async () => {
    registerDefaultMetrics();
    const text = await renderPromMetrics(promRegistry);
    expect(text).toContain('process_cpu_seconds_total');
  });
});

describe('promHttpMiddleware on the default histogram', () => {
  it('records against the shared instance without an explicit histogram arg', () => {
    const middleware = promHttpMiddleware();
    const req = makeReq({ method: 'get', path: '/api/health' });
    const { res, emitter } = makeRes(200);
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(() => emitter.emit('finish')).not.toThrow();
  });
});

describe('normaliseRouteLabel additional cases', () => {
  it('handles trailing numeric id with no suffix', () => {
    const req = makeReq({ path: '/api/orders/99' });
    expect(normaliseRouteLabel(req)).toBe('/api/orders/:id');
  });

  it('does not collapse numbers embedded in a word', () => {
    const req = makeReq({ path: '/api/v1/users' });
    expect(normaliseRouteLabel(req)).toBe('/api/v1/users');
  });

  it('prefers an empty-string route pattern fallback to raw path', () => {
    const req = makeReq({ routePath: '', path: '/api/raw' });
    expect(normaliseRouteLabel(req)).toBe('/api/raw');
  });
});

describe('PromMetricsController', () => {
  it('returns Prometheus text from the shared registry', async () => {
    registerDefaultMetrics();
    const controller = new PromMetricsController();
    const text = await controller.prom();
    expect(typeof text).toBe('string');
    expect(text).toContain('process_cpu_seconds_total');
  });
});
