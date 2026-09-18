import { Logger } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/node';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import { buildSentryOptions } from '../../src/observability/sentry-config';

jest.mock('@sentry/node', () => ({
  withScope: (cb: (scope: { setTag: jest.Mock; setExtra: jest.Mock }) => void) =>
    cb({ setTag: jest.fn(), setExtra: jest.fn() }),
  captureException: jest.fn(),
}));
const marker = 'SYNTHETIC_HEALTH_PAYLOAD';
const errors = [
  new Prisma.PrismaClientValidationError(marker, { clientVersion: 'test' }),
  new Prisma.PrismaClientKnownRequestError(marker, {
    code: 'P2002',
    clientVersion: 'test',
    meta: { payload: marker },
  }),
  new Prisma.PrismaClientUnknownRequestError(marker, { clientVersion: 'test' }),
  Object.assign(new Error('wrapper'), {
    cause: new Prisma.PrismaClientValidationError(marker, { clientVersion: 'test' }),
  }),
];
function runFilter(error: Error, url = '/api/scout/ingest') {
  const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const request = { method: 'POST', url, requestId: 'correlation-1' };
  new HttpExceptionFilter().catch(error, new ExecutionContextHost([request, response]));
  return { log, response };
}
afterEach(() => jest.restoreAllMocks());

describe('ORM diagnostics before every sink', () => {
  it.each(errors)('removes ORM arguments from logs and captured exception: %#', (error) => {
    const { log, response } = runFilter(error);
    const captured = jest.mocked(Sentry.captureException).mock.calls.slice(-1)[0]?.[0];
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
    expect(captured).not.toBe(error);
    expect(captured).toBeInstanceOf(Error);
    if (!(captured instanceof Error)) throw new Error('expected diagnostic error');
    expect(captured.message + captured.stack + JSON.stringify(captured)).not.toContain(marker);
    expect(captured.message).toContain('Database request failed');
    expect(response.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(marker);
  });
  it('does not discard ordinary non-ORM diagnostics', () => {
    const error = new Error('queue unavailable');
    const { log } = runFilter(error);
    expect(JSON.stringify(log.mock.calls)).toContain('queue unavailable');
    expect(Sentry.captureException).toHaveBeenLastCalledWith(error);
  });
  it('sanitizes ORM exception text, arguments and request data in beforeSend independently', async () => {
    const event: Sentry.ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          {
            type: 'PrismaClientValidationError',
            value: marker,
            stacktrace: { frames: [{ filename: 'writer.ts', vars: { payload: marker } }] },
          },
        ],
      },
      request: {
        data: { payload: marker },
        headers: { Authorization: 'secret', 'content-type': 'application/json' },
      },
      extra: { arguments: marker },
      breadcrumbs: [{ message: marker }],
      tags: { request_id: 'correlation-1' },
    };
    const hook = buildSentryOptions('https://unused.invalid', {}).beforeSend;
    if (!hook) throw new Error('beforeSend required');
    const result = await hook(event, {});
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(result?.tags?.request_id).toBe('correlation-1');
  });
  it('does not log URL query payloads alongside a sanitized ORM exception', () => {
    const { log } = runFilter(errors[0], `/api/scout/ingest?note=${marker}`);
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
    expect(JSON.stringify(log.mock.calls)).toContain('/api/scout/ingest');
  });
});
