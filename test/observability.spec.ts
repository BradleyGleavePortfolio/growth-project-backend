/**
 * Observability module tests.
 *
 * Covers:
 *  1. Log redaction — passwords and tokens never leak through redactObject
 *  2. Log redaction — bloodwork values are stripped
 *  3. Log line string redaction via redactLogLine
 *  4. Request-id middleware — honours incoming header
 *  5. Request-id middleware — generates id when header absent
 *  6. Request-id middleware — strips dangerous characters
 *  7. MetricsService — render() produces valid Prometheus text format
 *  8. MetricsService — recordRequest increments counters
 *  9. MetricsService — histogram buckets are cumulative
 * 10. HealthDeepController — DB up path returns 200
 * 11. HealthDeepController — DB down path returns 503
 * 12. AppLoggerService — emits JSON with redacted fields
 */

import { redactObject, redactLogLine } from '../src/observability/log-redaction';
import { MetricsService } from '../src/observability/metrics.service';
import { AppLoggerService } from '../src/observability/app-logger.service';
import { RequestIdMiddleware } from '../src/observability/request-id.middleware';
import { HealthDeepController } from '../src/observability/health-deep.controller';

// ── 1. redactObject ─────────────────────────────────────────────────────────

describe('redactObject', () => {
  it('replaces password field with [REDACTED]', () => {
    const input = { username: 'alice', password: 'hunter2', email: 'a@b.com' };
    const output = redactObject(input) as Record<string, unknown>;
    expect(output.password).toBe('[REDACTED]');
    expect(output.username).toBe('alice');
    expect(output.email).toBe('a@b.com');
  });

  it('replaces token field with [REDACTED]', () => {
    const input = { token: 'eyJhbGciOiJSUzI1NiJ9.payload.sig' };
    const output = redactObject(input) as Record<string, unknown>;
    expect(output.token).toBe('[REDACTED]');
  });

  it('replaces access_token field', () => {
    const input = { access_token: 'sk-live-abc123' };
    const output = redactObject(input) as Record<string, unknown>;
    expect(output.access_token).toBe('[REDACTED]');
  });

  it('strips bloodwork data', () => {
    const input = { user_id: 'u-1', blood_glucose: 98, hba1c: 5.6 };
    const output = redactObject(input) as Record<string, unknown>;
    expect(output.blood_glucose).toBe('[REDACTED]');
    expect(output.hba1c).toBe('[REDACTED]');
    expect(output.user_id).toBe('u-1');
  });

  it('strips body_fat', () => {
    const input = { body_fat: 18.5, weight: 75 };
    const output = redactObject(input) as Record<string, unknown>;
    expect(output.body_fat).toBe('[REDACTED]');
    expect(output.weight).toBe(75);
  });

  it('preserves allowed fields even if they share a prefix with sensitive names', () => {
    const input = { request_id: 'abc123', user_id: 'u-1', method: 'GET' };
    const output = redactObject(input) as Record<string, unknown>;
    expect(output.request_id).toBe('abc123');
    expect(output.user_id).toBe('u-1');
  });

  it('walks nested objects recursively', () => {
    const input = { user: { name: 'bob', password: 'secret123' } };
    const output = redactObject(input) as { user: Record<string, unknown> };
    expect(output.user.password).toBe('[REDACTED]');
    expect(output.user.name).toBe('bob');
  });

  it('handles arrays of objects', () => {
    const input = [{ password: 'p1' }, { token: 't1' }, { name: 'ok' }];
    const output = redactObject(input) as Array<Record<string, unknown>>;
    expect(output[0].password).toBe('[REDACTED]');
    expect(output[1].token).toBe('[REDACTED]');
    expect(output[2].name).toBe('ok');
  });

  it('handles circular references without throwing', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => redactObject(obj)).not.toThrow();
    const output = redactObject(obj) as Record<string, unknown>;
    expect(output.self).toBe('[Circular]');
  });

  it('does not mutate the original object', () => {
    const input = { password: 'secret', name: 'alice' };
    redactObject(input);
    expect(input.password).toBe('secret');
  });
});

// ── 2. redactLogLine ────────────────────────────────────────────────────────

describe('redactLogLine', () => {
  it('redacts password in JSON string', () => {
    const line = '{"level":"log","password":"hunter2","user":"alice"}';
    const out = redactLogLine(line);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts authorization token in JSON string', () => {
    const line = '{"authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.x.y"}';
    const out = redactLogLine(line);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).toContain('[REDACTED]');
  });

  it('leaves unrelated fields intact', () => {
    const line = '{"level":"log","message":"hello","user_id":"u-1"}';
    const out = redactLogLine(line);
    expect(out).toContain('"message":"hello"');
    expect(out).toContain('"user_id":"u-1"');
  });
});

// ── 3. MetricsService ───────────────────────────────────────────────────────

describe('MetricsService', () => {
  let svc: MetricsService;

  beforeEach(() => {
    process.env.METRICS_ENABLED = 'on';
    svc = new MetricsService();
    svc.onModuleInit();
  });

  afterEach(() => {
    delete process.env.METRICS_ENABLED;
  });

  it('render() returns a non-empty string with HELP lines', () => {
    const output = svc.render();
    expect(output).toContain('# HELP http_requests_total');
    expect(output).toContain('# TYPE http_requests_total counter');
  });

  it('recordRequest increments http_requests_total', () => {
    svc.recordRequest('GET', '/api/users', 200, 42);
    const output = svc.render();
    expect(output).toMatch(/http_requests_total\{[^}]+\} 1/);
  });

  it('histogram buckets are cumulative (observation <= bucket counts it)', () => {
    svc.recordRequest('GET', '/api/test', 200, 50);
    const output = svc.render();
    expect(output).toMatch(/le="50"[^}]*\} 1/);
    expect(output).toMatch(/le="100"[^}]*\} 1/);
    expect(output).toMatch(/le="25"[^}]*\} 0/);
  });

  it('recordRequest with 500 status still increments counter', () => {
    svc.recordRequest('POST', '/api/auth', 500, 100);
    const output = svc.render();
    expect(output).toMatch(/status="500"/);
  });

  it('render() returns disabled message when METRICS_ENABLED=off', () => {
    process.env.METRICS_ENABLED = 'off';
    const disabledSvc = new MetricsService();
    disabledSvc.onModuleInit();
    const output = disabledSvc.render();
    expect(output).toContain('disabled');
  });

  it('output ends with a newline (Prometheus scraper requirement)', () => {
    const output = svc.render();
    expect(output.endsWith('\n')).toBe(true);
  });

  it('multiple requests accumulate correctly', () => {
    svc.recordRequest('GET', '/api/weight', 200, 30);
    svc.recordRequest('GET', '/api/weight', 200, 30);
    svc.recordRequest('GET', '/api/weight', 200, 30);
    const output = svc.render();
    expect(output).toMatch(/http_requests_total\{[^}]*\} 3/);
  });
});

// ── 4. AppLoggerService ─────────────────────────────────────────────────────

describe('AppLoggerService', () => {
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.LOG_FORMAT = 'json';
    process.env.LOG_LEVEL = 'verbose';
    AppLoggerService.requestId = undefined;
    AppLoggerService.userId = undefined;
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    delete process.env.LOG_FORMAT;
    delete process.env.LOG_LEVEL;
  });

  it('emits JSON line containing timestamp, level, message', () => {
    const logger = new AppLoggerService();
    logger.log('hello world', 'TestCtx');
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const line = (writeSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(line);
    expect(parsed.timestamp).toBeDefined();
    expect(parsed.level).toBe('log');
    expect(parsed.message).toBe('hello world');
    expect(parsed.context).toBe('TestCtx');
  });

  it('includes request_id when set on thread-local', () => {
    AppLoggerService.requestId = 'test-req-id';
    const logger = new AppLoggerService();
    logger.log('with request id');
    const line = (writeSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(line);
    expect(parsed.request_id).toBe('test-req-id');
  });

  it('redacts password from logStructured meta', () => {
    const logger = new AppLoggerService();
    logger.logStructured('log', 'login attempt', { password: 'hunter2', user: 'alice' });
    const line = (writeSpy.mock.calls[0][0] as string).trim();
    expect(line).not.toContain('hunter2');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('alice');
  });
});

// ── 5. RequestIdMiddleware ──────────────────────────────────────────────────

describe('RequestIdMiddleware', () => {
  function buildReqRes(headers: Record<string, string> = {}) {
    const finishListeners: Array<() => void> = [];
    const res = {
      getHeader: jest.fn(),
      setHeader: jest.fn(),
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'finish') finishListeners.push(cb);
      }),
      finishListeners,
    };
    const req = { headers, requestId: undefined as string | undefined, route: undefined };
    return { req, res };
  }

  it('attaches a generated hex id when no X-Request-ID header present', () => {
    const mid = new RequestIdMiddleware();
    const { req, res } = buildReqRes();
    const next = jest.fn();
    mid.use(req as any, res as any, next);
    expect(req.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', req.requestId);
    expect(next).toHaveBeenCalled();
  });

  it('honours incoming X-Request-ID header', () => {
    const mid = new RequestIdMiddleware();
    const { req, res } = buildReqRes({ 'x-request-id': 'upstream-id-123' });
    const next = jest.fn();
    mid.use(req as any, res as any, next);
    expect(req.requestId).toBe('upstream-id-123');
  });

  it('strips non-alphanumeric chars from incoming header', () => {
    const mid = new RequestIdMiddleware();
    const { req, res } = buildReqRes({ 'x-request-id': 'safe-id<script>evil</script>' });
    const next = jest.fn();
    mid.use(req as any, res as any, next);
    expect(req.requestId).not.toContain('<');
    expect(req.requestId).not.toContain('>');
    expect(req.requestId).not.toContain('/');
  });

  it('truncates very long incoming X-Request-ID to 128 chars', () => {
    const mid = new RequestIdMiddleware();
    const long = 'a'.repeat(200);
    const { req, res } = buildReqRes({ 'x-request-id': long });
    const next = jest.fn();
    mid.use(req as any, res as any, next);
    expect((req.requestId as string).length).toBe(128);
  });

  it('resets thread-local userId on new request', () => {
    AppLoggerService.userId = 'stale-user';
    const mid = new RequestIdMiddleware();
    const { req, res } = buildReqRes();
    const next = jest.fn();
    mid.use(req as any, res as any, next);
    expect(AppLoggerService.userId).toBeUndefined();
  });
});

// ── 6. HealthDeepController ─────────────────────────────────────────────────

describe('HealthDeepController', () => {
  it('returns ok:true when DB query succeeds', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } as any;
    const ctrl = new HealthDeepController(prisma);

    const statusCodes: number[] = [];
    const res = {
      status: jest.fn((code: number) => { statusCodes.push(code); return res; }),
    } as any;

    const result = await ctrl.deep(res);
    expect(result.ok).toBe(true);
    expect(result.db).toBe('up');
    expect(statusCodes).toHaveLength(0);
  });

  it('returns ok:false and sets 503 when DB is down', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')),
    } as any;
    const ctrl = new HealthDeepController(prisma);

    const statusCodes: number[] = [];
    const res = {
      status: jest.fn((code: number) => { statusCodes.push(code); return res; }),
    } as any;

    const result = await ctrl.deep(res);
    expect(result.ok).toBe(false);
    expect(result.db).toBe('down');
    expect(statusCodes).toContain(503);
    expect(result.errors).toBeDefined();
  });
});
