/**
 * prom-client metrics tests.
 *
 * Covers:
 *  1. registerDefaultMetrics installs Node.js runtime collectors
 *  2. registerDefaultMetrics is idempotent on the shared registry
 *  3. buildHttpHistogram registers the duration histogram with the right name
 *  4. buildHttpHistogram reuses an existing metric (no duplicate registration)
 *  5. normaliseRouteLabel prefers the matched route pattern
 *  6. normaliseRouteLabel collapses UUIDs and numeric ids in raw paths
 *  7. normaliseRouteLabel falls back to 'unknown' for empty input
 *  8. promHttpMiddleware observes duration on response finish with labels
 *  9. promHttpMiddleware calls next() synchronously
 * 10. renderPromMetrics serialises the registry in Prometheus text format
 * 11. histogram buckets match the operator-blessed seconds layout
 */

import { Registry } from 'prom-client';
import type { Request, Response } from 'express';
import { EventEmitter } from 'events';
import {
  buildHttpHistogram,
  HTTP_DURATION_BUCKETS_SECONDS,
  normaliseRouteLabel,
  promHttpMiddleware,
  registerDefaultMetrics,
  renderPromMetrics,
} from '../src/observability/prom-metrics';

describe('registerDefaultMetrics', () => {
  it('installs Node.js default runtime collectors on a fresh registry', async () => {
    const reg = new Registry();
    registerDefaultMetrics(reg);
    const text = await reg.metrics();
    expect(text).toContain('process_cpu_seconds_total');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
  });

  it('is idempotent on the shared registry (no duplicate-registration throw)', () => {
    expect(() => {
      registerDefaultMetrics();
      registerDefaultMetrics();
    }).not.toThrow();
  });
});

describe('buildHttpHistogram', () => {
  it('registers http_request_duration_seconds with the seconds bucket layout', async () => {
    const reg = new Registry();
    const histogram = buildHttpHistogram(reg);
    histogram.observe({ method: 'GET', route: '/x', status_code: '200' }, 0.2);
    const text = await reg.metrics();
    expect(text).toContain('http_request_duration_seconds');
    // 10s tail bucket present once a sample has been observed
    expect(text).toContain('le="10"');
  });

  it('reuses an existing metric instead of registering a duplicate', () => {
    const reg = new Registry();
    const first = buildHttpHistogram(reg);
    const second = buildHttpHistogram(reg);
    expect(second).toBe(first);
  });

  it('exposes the operator-blessed bucket layout', () => {
    expect(HTTP_DURATION_BUCKETS_SECONDS).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
    ]);
  });
});

describe('normaliseRouteLabel', () => {
  it('prefers the matched Express route pattern', () => {
    const req = { route: { path: '/api/users/:id' }, path: '/api/users/42' } as unknown as Request;
    expect(normaliseRouteLabel(req)).toBe('/api/users/:id');
  });

  it('collapses UUIDs in the raw path when no pattern is present', () => {
    const req = {
      path: '/api/users/a1b2c3d4-e5f6-7890-abcd-ef1234567890/weight',
    } as unknown as Request;
    expect(normaliseRouteLabel(req)).toBe('/api/users/:id/weight');
  });

  it('collapses numeric ids in the raw path', () => {
    const req = { path: '/api/posts/12345/comments' } as unknown as Request;
    expect(normaliseRouteLabel(req)).toBe('/api/posts/:id/comments');
  });

  it('falls back to "unknown" when no path information is available', () => {
    const req = { path: '' } as unknown as Request;
    expect(normaliseRouteLabel(req)).toBe('unknown');
  });
});

describe('promHttpMiddleware', () => {
  function makeReqRes(method: string, path: string) {
    const req = { method, path } as unknown as Request;
    const res = new EventEmitter() as unknown as Response & EventEmitter;
    (res as unknown as { statusCode: number }).statusCode = 200;
    return { req, res };
  }

  it('observes a duration sample with method/route/status_code labels on finish', async () => {
    const reg = new Registry();
    const histogram = buildHttpHistogram(reg);
    const middleware = promHttpMiddleware(histogram);
    const { req, res } = makeReqRes('get', '/api/health');

    middleware(req, res, () => undefined);
    (res as unknown as { statusCode: number }).statusCode = 204;
    (res as unknown as EventEmitter).emit('finish');

    const text = await reg.metrics();
    expect(text).toContain('method="GET"');
    expect(text).toContain('route="/api/health"');
    expect(text).toContain('status_code="204"');
    expect(text).toContain('http_request_duration_seconds_count');
  });

  it('calls next() synchronously', () => {
    const reg = new Registry();
    const middleware = promHttpMiddleware(buildHttpHistogram(reg));
    const { req, res } = makeReqRes('post', '/api/log');
    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('renderPromMetrics', () => {
  it('serialises a registry to Prometheus text exposition format', async () => {
    const reg = new Registry();
    buildHttpHistogram(reg);
    const text = await renderPromMetrics(reg);
    expect(text).toContain('# HELP http_request_duration_seconds');
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
  });
});
