import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Prisma } from '@prisma/client';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';

// Op81 D1 — NEW regression coverage for the public error envelope.
//
// `HttpExceptionFilter` sanitizes the diagnostic it logs and captures
// (`safeDiagnostic`), but for an `HttpException` it still reads the ORIGINAL
// `exception.getResponse()` when building the client envelope. When a service
// catches a Prisma failure and rethrows it as an HttpException whose body was
// derived from that failure, ORM-derived text reaches the public response.
// These cases pin that boundary: no ORM payload in the client envelope, while
// ordinary (non-ORM) client errors keep their exact message, array, code and
// status. They are authored now as Op81 re-establishment work; they are not a
// copy of any earlier suite.
jest.mock('@sentry/node', () => ({
  withScope: (cb: (scope: { setTag: jest.Mock; setExtra: jest.Mock }) => void) =>
    cb({ setTag: jest.fn(), setExtra: jest.fn() }),
  captureException: jest.fn(),
}));

/** Every key the filter is permitted to emit (see src/filters/not-found-envelope.ts). */
const PERMITTED_ENVELOPE_KEYS = [
  'statusCode',
  'code',
  'message',
  'error',
  'timestamp',
  'path',
  'request_id',
];

const known = (payload: string, code = 'P2002') =>
  new Prisma.PrismaClientKnownRequestError(payload, {
    code,
    clientVersion: 'test',
    meta: { target: [payload] },
  });
const unknownRequest = (payload: string) =>
  new Prisma.PrismaClientUnknownRequestError(payload, { clientVersion: 'test' });
const validation = (payload: string) =>
  new Prisma.PrismaClientValidationError(payload, { clientVersion: 'test' });
const initialization = (payload: string) =>
  new Prisma.PrismaClientInitializationError(payload, 'test', 'P1001');
const rustPanic = (payload: string) => new Prisma.PrismaClientRustPanicError(payload, 'test');
/** Already-sanitized ORM name that the matcher also recognizes. */
const legacySanitized = (payload: string) =>
  Object.assign(new Error(payload), { name: 'DatabaseRequestError' });

/** Ordinary repository/transport wrapper around an ORM failure. */
const wrap = (inner: Error, message = 'repository write failed') =>
  Object.assign(new Error(message), { cause: inner });

/** Wrapper chain whose tail points back at its head, with the ORM error inside. */
function cyclicWithOrm(inner: Error): Error {
  const outer = wrap(inner, 'retry envelope');
  Object.assign(inner, { cause: outer });
  return outer;
}

interface LeakCase {
  name: string;
  status: number;
  marker: string;
  exception: HttpException;
}

function leak(
  name: string,
  status: number,
  build: (marker: string) => HttpException,
): LeakCase {
  const marker = `SYNTHETIC_ORM_PAYLOAD_${name.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
  return { name, status, marker, exception: build(marker) };
}

const leakCases: LeakCase[] = [
  leak('bare string response wrapping a validation error', 500, (m) =>
    new HttpException(`Database write rejected: ${m}`, 500, { cause: validation(m) }),
  ),
  leak('internal server error built from a known request error message', 500, (m) =>
    new InternalServerErrorException(m, { cause: known(m) }),
  ),
  leak('service unavailable object body wrapping an initialization error', 503, (m) =>
    new ServiceUnavailableException(
      { message: `Database unreachable: ${m}`, error: 'Service Unavailable' },
      { cause: initialization(m) },
    ),
  ),
  leak('bad request string wrapping a validation error', 400, (m) =>
    new BadRequestException(m, { cause: validation(m) }),
  ),
  leak('bad request array whose first element carries ORM text', 400, (m) =>
    new BadRequestException([m, 'athleteId must be a UUID'], { cause: validation(m) }),
  ),
  leak('bad request array whose last element carries ORM text', 400, (m) =>
    new BadRequestException(['athleteId must be a UUID', m], { cause: validation(m) }),
  ),
  leak('conflict whose error field carries ORM text', 409, (m) =>
    new ConflictException(
      { message: 'Duplicate scout entry', error: m, code: 'scout_entry_conflict' },
      { cause: known(m) },
    ),
  ),
  leak('unprocessable entity whose machine code carries ORM text', 422, (m) =>
    new UnprocessableEntityException(
      { message: 'Invalid scout payload', error: 'Unprocessable Entity', code: m },
      { cause: known(m, 'NOT_A_PRISMA_CODE') },
    ),
  ),
  leak('not found built from a P2025 message', 404, (m) =>
    new NotFoundException(m, { cause: known(m, 'P2025') }),
  ),
  leak('forbidden wrapping an unknown request error', 403, (m) =>
    new ForbiddenException(m, { cause: unknownRequest(m) }),
  ),
  leak('explicit 409 object body with an array message and a rust panic cause', 409, (m) =>
    new HttpException({ message: [m], error: 'Conflict' }, 409, { cause: rustPanic(m) }),
  ),
  leak('500 object body with both array message and machine code', 500, (m) =>
    new HttpException(
      { message: ['persist failed', m], error: 'Internal Server Error', code: `db_${m}` },
      500,
      { cause: unknownRequest(m) },
    ),
  ),
  leak('nested repository wrapper around a validation error', 500, (m) =>
    new InternalServerErrorException(m, { cause: wrap(validation(m)) }),
  ),
  leak('three-level wrapper chain around a known request error', 500, (m) =>
    new InternalServerErrorException(m, {
      cause: wrap(wrap(known(m), 'transaction aborted'), 'unit of work failed'),
    }),
  ),
  leak('cyclic wrapper chain that still reaches the ORM error', 500, (m) =>
    new HttpException(`persist failed: ${m}`, 500, { cause: cyclicWithOrm(validation(m)) }),
  ),
  leak('already sanitized DatabaseRequestError name as cause', 500, (m) =>
    new InternalServerErrorException(`Database request failed: ${m}`, {
      cause: legacySanitized(m),
    }),
  ),
  leak('503 string response wrapping an initialization error', 503, (m) =>
    new ServiceUnavailableException(m, { cause: initialization(m) }),
  ),
  leak('422 array message wrapping a validation error', 422, (m) =>
    new UnprocessableEntityException([m], { cause: validation(m) }),
  ),
  leak('400 wrapping a known request error with a malformed code shape', 400, (m) =>
    new BadRequestException(m, { cause: known(m, 'P202') }),
  ),
  leak('409 wrapping a known request error whose meta target leaked into the body', 409, (m) =>
    new ConflictException({ message: `Unique constraint failed on ${m}` }, { cause: known(m) }),
  ),
  leak('500 wrapping a rust panic error message', 500, (m) =>
    new HttpException(m, 500, { cause: rustPanic(m) }),
  ),
];

function runFilter(exception: unknown, url = '/api/scout/ingest') {
  const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn();
  const response = { status: statusMock, json: jsonMock };
  const request = { method: 'POST', url, requestId: 'correlation-1' };
  new HttpExceptionFilter().catch(exception, new ExecutionContextHost([request, response]));
  return { logSpy, statusMock, jsonMock };
}

function envelopeOf(jsonMock: jest.Mock): Record<string, unknown> {
  expect(jsonMock).toHaveBeenCalledTimes(1);
  return jsonMock.mock.calls[0][0];
}

afterEach(() => jest.restoreAllMocks());

describe('public error envelope never carries ORM-derived text', () => {
  it.each(leakCases)('$name', ({ exception, status, marker }) => {
    const { logSpy, statusMock, jsonMock } = runFilter(exception);
    const body = envelopeOf(jsonMock);

    // The unsafe payload must not reach the client in any envelope field.
    expect(JSON.stringify(body)).not.toContain(marker);
    // ...nor the logs, which the recovered filter already sanitizes.
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(marker);

    // The envelope stays a real, usable error: same status, permitted keys
    // only, a non-empty actionable message, and preserved correlation.
    expect(statusMock).toHaveBeenCalledWith(status);
    expect(body.statusCode).toBe(status);
    expect(Object.keys(body).filter((key) => !PERMITTED_ENVELOPE_KEYS.includes(key))).toEqual([]);
    const message = Array.isArray(body.message) ? body.message.join(' ') : body.message;
    expect(typeof message).toBe('string');
    expect(String(message).trim().length).toBeGreaterThan(0);
    expect(typeof body.error).toBe('string');
    expect(String(body.error).trim().length).toBeGreaterThan(0);
    expect(body.request_id).toBe('correlation-1');
    expect(typeof body.timestamp).toBe('string');
    expect(body.path).toBe('/api/scout/ingest');
  });
});

describe('ordinary client errors keep their exact public contract', () => {
  it('preserves a plain 4xx string message and error name', () => {
    const { jsonMock, statusMock } = runFilter(
      new NotFoundException('Scout entry not found'),
      '/api/scout/entries/42',
    );
    const body = envelopeOf(jsonMock);
    expect(statusMock).toHaveBeenCalledWith(404);
    expect(body.message).toBe('Scout entry not found');
    expect(body.error).toBe('Not Found');
    expect(body.code).toBeUndefined();
    expect(body.request_id).toBe('correlation-1');
  });

  it('preserves a ValidationPipe message array element-for-element', () => {
    const messages = ['athleteId must be a UUID', 'height must not be greater than 260'];
    const { jsonMock, statusMock } = runFilter(new BadRequestException(messages));
    const body = envelopeOf(jsonMock);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(body.message).toEqual(messages);
    expect(body.error).toBe('Bad Request');
  });

  it('preserves a machine-readable code alongside its message', () => {
    const { jsonMock } = runFilter(
      new BadRequestException({
        message: 'Invite code format is invalid',
        error: 'Bad Request',
        code: 'invite_code_invalid_format',
      }),
    );
    const body = envelopeOf(jsonMock);
    expect(body.statusCode).toBe(400);
    expect(body.message).toBe('Invite code format is invalid');
    expect(body.code).toBe('invite_code_invalid_format');
    expect(body.error).toBe('Bad Request');
  });

  it('preserves a 4xx message whose cause is an ordinary non-ORM error', () => {
    const { jsonMock, statusMock } = runFilter(
      new ConflictException('Scout roster is locked for this week', {
        cause: new Error('advisory lock held by another request'),
      }),
    );
    const body = envelopeOf(jsonMock);
    expect(statusMock).toHaveBeenCalledWith(409);
    expect(body.message).toBe('Scout roster is locked for this week');
    expect(body.error).toBe('Conflict');
  });
});
