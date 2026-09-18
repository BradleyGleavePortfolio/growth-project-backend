import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  LeakCase,
  envelopeOf,
  expectSanitizedEnvelope,
  known,
  leak,
  runFilter,
  validation,
} from './diagnostics-public-harness';

// Op81 D1 slice S1 — NEW regression coverage for the public error envelope.
//
// `HttpExceptionFilter` sanitizes the diagnostic it logs and captures
// (`safeDiagnostic`), but for an `HttpException` it used to read the ORIGINAL
// `exception.getResponse()` when building the client envelope. When a service
// catches a Prisma failure and rethrows it as an HttpException whose body was
// derived from that failure, ORM-derived text reached the public response.
// These cases pin that boundary: no ORM payload in the client envelope, while
// ordinary (non-ORM) client errors keep their exact message, array, code and
// status. They are authored now as Op81 re-establishment work; they are not a
// copy of any earlier suite.
//
// This file carries a bounded initial subset — five vectors where the ORM
// payload arrives through the message field itself (bare strings and
// ValidationPipe-shaped arrays) — plus the four ordinary-4xx controls. The
// subset size is set by the measured formatted size gate, not by coverage
// judgement: every remaining vector is in the next sequential slice,
// scout-diagnostics-public-cause.spec.ts, and none was dropped. Shared setup
// and the common envelope assertion live in diagnostics-public-harness.ts
// (assertion-helper registration is still a repository-control obligation).
jest.mock('@sentry/node', () => ({
  withScope: (cb: (scope: { setTag: jest.Mock; setExtra: jest.Mock }) => void) =>
    cb({ setTag: jest.fn(), setExtra: jest.fn() }),
  captureException: jest.fn(),
}));

const leakCases: LeakCase[] = [
  leak(
    'bare string response wrapping a validation error',
    500,
    (m) => new HttpException(`Database write rejected: ${m}`, 500, { cause: validation(m) }),
  ),
  leak(
    'internal server error built from a known request error message',
    500,
    (m) => new InternalServerErrorException(m, { cause: known(m) }),
  ),
  leak(
    'bad request string wrapping a validation error',
    400,
    (m) => new BadRequestException(m, { cause: validation(m) }),
  ),
  leak(
    'bad request array whose first element carries ORM text',
    400,
    (m) => new BadRequestException([m, 'athleteId must be a UUID'], { cause: validation(m) }),
  ),
  leak(
    'bad request array whose last element carries ORM text',
    400,
    (m) => new BadRequestException(['athleteId must be a UUID', m], { cause: validation(m) }),
  ),
];

afterEach(() => jest.restoreAllMocks());

describe('public error envelope never carries ORM-derived text', () => {
  it.each(leakCases)('$name', ({ exception, status, marker }) => {
    expectSanitizedEnvelope(runFilter(exception), { status, marker });
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
