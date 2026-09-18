import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { safeDiagnostic } from '../../src/observability/orm-diagnostics';
import { buildSentryOptions } from '../../src/observability/sentry-config';

// Op81 D2 — NEW boundary coverage for the ORM diagnostic sink itself:
// every supported ORM class, valid vs malformed Prisma code shapes,
// nested/cyclic causes, primitive and non-Error inputs, both Sentry detection
// routes (original exception and serialized exception type), the complete
// permitted Sentry envelope, and ordinary-event behaviour including sensitive
// headers. Authored for Op81; not a reconstruction of any lost suite.
jest.mock('@sentry/node', () => {
  const setTag = jest.fn();
  const setExtra = jest.fn();
  return {
    __scope: { setTag, setExtra },
    withScope: (cb: (scope: { setTag: jest.Mock; setExtra: jest.Mock }) => void) =>
      cb({ setTag, setExtra }),
    captureException: jest.fn(),
  };
});

const sentryMock: { __scope: { setTag: jest.Mock; setExtra: jest.Mock } } =
  jest.requireMock('@sentry/node');

const MARKER = 'SYNTHETIC_ORM_ARGUMENTS_PAYLOAD';
/** Client-supplied query token: echoing the caller's own URL is not ORM disclosure. */
const CLIENT_TOKEN = 'CLIENT_SUPPLIED_QUERY_TOKEN';

const ormErrors: Array<[string, () => Error, string]> = [
  [
    'validation error',
    () => new Prisma.PrismaClientValidationError(MARKER, { clientVersion: 'test' }),
    'Database request failed',
  ],
  [
    'known request error with a valid P-code',
    () =>
      new Prisma.PrismaClientKnownRequestError(MARKER, {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: [MARKER] },
      }),
    'Database request failed (P2002)',
  ],
  [
    'known request error with a four-digit code at range end',
    () =>
      new Prisma.PrismaClientKnownRequestError(MARKER, { code: 'P9999', clientVersion: 'test' }),
    'Database request failed (P9999)',
  ],
  [
    'known request error with a lowercase code',
    () =>
      new Prisma.PrismaClientKnownRequestError(MARKER, { code: 'p2002', clientVersion: 'test' }),
    'Database request failed',
  ],
  [
    'known request error with a three-digit code',
    () => new Prisma.PrismaClientKnownRequestError(MARKER, { code: 'P202', clientVersion: 'test' }),
    'Database request failed',
  ],
  [
    'known request error with a five-digit code',
    () =>
      new Prisma.PrismaClientKnownRequestError(MARKER, { code: 'P20025', clientVersion: 'test' }),
    'Database request failed',
  ],
  [
    'known request error with a non-Prisma code',
    () =>
      new Prisma.PrismaClientKnownRequestError(MARKER, {
        code: `ERR_${MARKER}`,
        clientVersion: 'test',
      }),
    'Database request failed',
  ],
  [
    'unknown request error',
    () => new Prisma.PrismaClientUnknownRequestError(MARKER, { clientVersion: 'test' }),
    'Database request failed',
  ],
  [
    'initialization error',
    () => new Prisma.PrismaClientInitializationError(MARKER, 'test', 'P1001'),
    'Database request failed',
  ],
  [
    'rust panic error',
    () => new Prisma.PrismaClientRustPanicError(MARKER, 'test'),
    'Database request failed',
  ],
  [
    'already sanitized DatabaseRequestError',
    () => Object.assign(new Error(MARKER), { name: 'DatabaseRequestError' }),
    'Database request failed',
  ],
  [
    'ORM error behind one ordinary wrapper',
    () =>
      Object.assign(new Error('repository write failed'), {
        cause: new Prisma.PrismaClientValidationError(MARKER, { clientVersion: 'test' }),
      }),
    'Database request failed',
  ],
  [
    'ORM error behind two ordinary wrappers',
    () =>
      Object.assign(new Error('unit of work failed'), {
        cause: Object.assign(new Error('transaction aborted'), {
          cause: new Prisma.PrismaClientKnownRequestError(MARKER, {
            code: 'P2003',
            clientVersion: 'test',
          }),
        }),
      }),
    'Database request failed (P2003)',
  ],
];

describe('safeDiagnostic covers every supported ORM shape', () => {
  it.each(ormErrors)('replaces the %s', (_name, build, expected) => {
    const original = build();
    const safe = safeDiagnostic(original);
    expect(safe).not.toBe(original);
    expect(safe).toBeInstanceOf(Error);
    if (!(safe instanceof Error)) throw new Error('expected a diagnostic Error');
    expect(safe.name).toBe('DatabaseRequestError');
    expect(safe.message).toBe(expected);
    expect(safe.message + safe.stack + JSON.stringify(safe)).not.toContain(MARKER);
  });

  it('sanitizes a cyclic cause chain that still reaches the ORM error', () => {
    const orm = new Prisma.PrismaClientValidationError(MARKER, { clientVersion: 'test' });
    const outer = Object.assign(new Error('retry envelope'), { cause: orm });
    Object.assign(orm, { cause: outer });
    const safe = safeDiagnostic(outer);
    expect(safe).not.toBe(outer);
    expect(JSON.stringify(safe instanceof Error ? safe.message : safe)).toContain(
      'Database request failed',
    );
  });

  it('terminates on a cyclic non-ORM chain and returns the original error', () => {
    const first = new Error('transport envelope');
    const second = Object.assign(new Error('retry envelope'), { cause: first });
    Object.assign(first, { cause: second });
    expect(safeDiagnostic(first)).toBe(first);
  });

  it('returns an ordinary error unchanged', () => {
    const ordinary = new Error('queue unavailable');
    expect(safeDiagnostic(ordinary)).toBe(ordinary);
  });

  it.each([
    ['a string', 'plain failure text'],
    ['zero', 0],
    ['false', false],
    ['null', null],
    ['undefined', undefined],
    ['an array', ['a', 'b']],
    [
      'a plain object wearing an ORM name',
      { name: 'PrismaClientValidationError', message: MARKER },
    ],
  ])('returns %s unchanged', (_name, input) => {
    expect(safeDiagnostic(input)).toBe(input);
  });
});

function runFilter(exception: unknown, url = '/api/scout/ingest') {
  const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const request = {
    method: 'POST',
    url,
    route: { path: '/api/scout/ingest' },
    requestId: 'correlation-1',
  };
  new HttpExceptionFilter().catch(exception, new ExecutionContextHost([request, response]));
  return { logSpy, response };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(Sentry.captureException).mockClear();
  sentryMock.__scope.setTag.mockClear();
  sentryMock.__scope.setExtra.mockClear();
});

describe('filter diagnostic sinks and request correlation', () => {
  it('logs and captures only the sanitized diagnostic, with correlation tags', () => {
    const orm = new Prisma.PrismaClientKnownRequestError(MARKER, {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: [MARKER] },
    });
    const { logSpy } = runFilter(orm, `/api/scout/ingest?note=${CLIENT_TOKEN}`);
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain(CLIENT_TOKEN);
    expect(logged).toContain('Database request failed (P2002)');
    const captured = jest.mocked(Sentry.captureException).mock.calls[0][0];
    expect(captured).not.toBe(orm);
    expect(sentryMock.__scope.setTag).toHaveBeenCalledWith('request_id', 'correlation-1');
    expect(sentryMock.__scope.setTag).toHaveBeenCalledWith('http.path', '/api/scout/ingest');
    expect(sentryMock.__scope.setTag).toHaveBeenCalledWith('http.method', 'POST');
    expect(sentryMock.__scope.setExtra).toHaveBeenCalledWith('responseStatus', 500);
  });

  it('captures the sanitized diagnostic for a 5xx HttpException wrapping an ORM cause', () => {
    const orm = new Prisma.PrismaClientValidationError(MARKER, { clientVersion: 'test' });
    const wrapper = new HttpException('persist failed', 500, { cause: orm });
    runFilter(wrapper);
    const captured = jest.mocked(Sentry.captureException).mock.calls[0][0];
    expect(captured).not.toBe(wrapper);
    expect(captured).not.toBe(orm);
    expect(JSON.stringify(captured instanceof Error ? captured.message : captured)).not.toContain(
      MARKER,
    );
  });

  it('keeps ordinary server diagnostics intact', () => {
    const ordinary = new Error('queue unavailable');
    const { logSpy } = runFilter(ordinary);
    expect(JSON.stringify(logSpy.mock.calls)).toContain('queue unavailable');
    expect(Sentry.captureException).toHaveBeenCalledWith(ordinary);
  });

  it('does not report ordinary 4xx client errors to Sentry', () => {
    runFilter(new BadRequestException('athleteId must be a UUID'));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

/** The only keys beforeSend may emit for an ORM event. */
const PERMITTED_SENTRY_KEYS = [
  'type',
  'event_id',
  'timestamp',
  'environment',
  'release',
  'level',
  'tags',
  'exception',
];

function ormEvent(exceptionType: string): Sentry.ErrorEvent {
  return {
    type: undefined,
    event_id: 'event-1',
    timestamp: 1758000000,
    environment: 'production',
    release: 'growth-project-backend@sha-production',
    level: 'error',
    exception: {
      values: [
        {
          type: exceptionType,
          value: MARKER,
          stacktrace: { frames: [{ filename: 'writer.ts', vars: { arguments: MARKER } }] },
        },
      ],
    },
    request: {
      url: `/api/scout/ingest?note=${MARKER}`,
      data: { athlete: MARKER },
      query_string: `note=${MARKER}`,
      headers: { Authorization: 'Bearer secret', cookie: `sid=${MARKER}` },
    },
    user: { id: MARKER, email: 'athlete@example.invalid' },
    // TraceContext requires both ids; synthetic W3C-shaped values keep the
    // fixture a real Sentry event while the description carries the payload.
    contexts: {
      trace: {
        trace_id: '0af7651916cd43dd8448eb211c80319c',
        span_id: 'b7ad6b7169203331',
        description: MARKER,
      },
    },
    extra: { arguments: MARKER },
    breadcrumbs: [{ message: MARKER }],
    tags: { request_id: 'correlation-1', 'http.path': '/api/scout/ingest' },
  };
}

function beforeSendHook() {
  const hook = buildSentryOptions('https://unused.invalid', {}).beforeSend;
  if (!hook) throw new Error('beforeSend required');
  return hook;
}

/** name, serialized exception type on the event, whether the ORM error arrives via the hint. */
const detectionCases: Array<[string, string, boolean]> = [
  ['the original exception hint', 'SomeWrapperError', true],
  ['the serialized exception type', 'PrismaClientKnownRequestError', false],
  ['a serialized DatabaseRequestError type', 'DatabaseRequestError', false],
];

describe('Sentry beforeSend allowlists the ORM envelope', () => {
  it.each(detectionCases)('detects an ORM failure via %s', async (_n, serializedType, viaHint) => {
    const hint = viaHint
      ? {
          originalException: new Prisma.PrismaClientValidationError(MARKER, {
            clientVersion: 'test',
          }),
        }
      : {};
    const result = await beforeSendHook()(ormEvent(serializedType), hint);
    expect(result).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(Object.keys(result ?? {}).filter((key) => !PERMITTED_SENTRY_KEYS.includes(key))).toEqual(
      [],
    );
    expect(result?.exception?.values).toEqual([
      { type: 'DatabaseRequestError', value: 'Database request failed' },
    ]);
    expect(result?.request).toBeUndefined();
    expect(result?.user).toBeUndefined();
    expect(result?.contexts).toBeUndefined();
    expect(result?.extra).toBeUndefined();
    expect(result?.breadcrumbs).toBeUndefined();
    expect(result?.tags).toEqual({ request_id: 'correlation-1' });
    expect(result?.event_id).toBe('event-1');
    expect(result?.environment).toBe('production');
  });

  it('keeps ordinary events useful while stripping sensitive headers', async () => {
    const event: Sentry.ErrorEvent = {
      type: undefined,
      event_id: 'event-2',
      exception: { values: [{ type: 'Error', value: 'queue unavailable' }] },
      request: {
        data: { queue: 'scout-ingest' },
        headers: {
          Authorization: 'Bearer secret',
          authorization: 'Bearer secret',
          Cookie: 'sid=1',
          cookie: 'sid=1',
          'content-type': 'application/json',
        },
      },
      extra: { attempt: 2 },
      breadcrumbs: [{ message: 'enqueue attempted' }],
      tags: { request_id: 'correlation-2' },
    };
    const result = await beforeSendHook()(event, {
      originalException: new Error('queue unavailable'),
    });
    expect(result?.request?.headers).toEqual({ 'content-type': 'application/json' });
    expect(result?.request?.data).toEqual({ queue: 'scout-ingest' });
    expect(result?.extra).toEqual({ attempt: 2 });
    expect(result?.breadcrumbs).toEqual([{ message: 'enqueue attempted' }]);
    expect(result?.exception?.values?.[0]?.value).toBe('queue unavailable');
    expect(result?.tags).toEqual({ request_id: 'correlation-2' });
  });

  it('passes through an ordinary event that carries no request data', async () => {
    const event: Sentry.ErrorEvent = {
      type: undefined,
      event_id: 'event-3',
      exception: { values: [{ type: 'Error', value: 'timer drift' }] },
    };
    const result = await beforeSendHook()(event, {});
    expect(result).toBe(event);
    expect(result?.exception?.values?.[0]?.value).toBe('timer drift');
  });
});
