import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  LeakCase,
  cyclicWithOrm,
  expectSanitizedEnvelope,
  initialization,
  known,
  leak,
  legacySanitized,
  runFilter,
  rustPanic,
  unknownRequest,
  validation,
  wrap,
} from './diagnostics-public-harness';

// Op81 D1 slice S2 — the remaining NEW public-envelope regressions, continuing
// scout-diagnostics-public.spec.ts as the next sequential slice (the combined
// formatted delta does not fit one compliant PR). Same contract, same shared
// assertion helper (diagnostics-public-harness.ts, registration pending): no ORM payload
// in the client envelope or logs, status/keys/message/correlation preserved.
//
// This file carries the vectors that do NOT arrive through a bare message
// string: ORM text in a structured object body, in the `error` field, in a
// machine-readable `code`, in meta-derived text, and ORM failures reached
// indirectly through nested, three-level and cyclic wrapper chains or through an
// already-sanitized ORM error name. Authored as Op81 re-establishment work; not
// a copy of any earlier suite.
jest.mock('@sentry/node', () => ({
  withScope: (cb: (scope: { setTag: jest.Mock; setExtra: jest.Mock }) => void) =>
    cb({ setTag: jest.fn(), setExtra: jest.fn() }),
  captureException: jest.fn(),
}));

const leakCases: LeakCase[] = [
  leak(
    'service unavailable object body wrapping an initialization error',
    503,
    (m) =>
      new ServiceUnavailableException(
        { message: `Database unreachable: ${m}`, error: 'Service Unavailable' },
        { cause: initialization(m) },
      ),
  ),
  leak(
    'conflict whose error field carries ORM text',
    409,
    (m) =>
      new ConflictException(
        { message: 'Duplicate scout entry', error: m, code: 'scout_entry_conflict' },
        { cause: known(m) },
      ),
  ),
  leak(
    'unprocessable entity whose machine code carries ORM text',
    422,
    (m) =>
      new UnprocessableEntityException(
        { message: 'Invalid scout payload', error: 'Unprocessable Entity', code: m },
        { cause: known(m, 'NOT_A_PRISMA_CODE') },
      ),
  ),
  leak(
    'not found built from a P2025 message',
    404,
    (m) => new NotFoundException(m, { cause: known(m, 'P2025') }),
  ),
  leak(
    'forbidden wrapping an unknown request error',
    403,
    (m) => new ForbiddenException(m, { cause: unknownRequest(m) }),
  ),
  leak(
    'explicit 409 object body with an array message and a rust panic cause',
    409,
    (m) => new HttpException({ message: [m], error: 'Conflict' }, 409, { cause: rustPanic(m) }),
  ),
  leak(
    '500 object body with both array message and machine code',
    500,
    (m) =>
      new HttpException(
        { message: ['persist failed', m], error: 'Internal Server Error', code: `db_${m}` },
        500,
        { cause: unknownRequest(m) },
      ),
  ),
  leak(
    'nested repository wrapper around a validation error',
    500,
    (m) => new InternalServerErrorException(m, { cause: wrap(validation(m)) }),
  ),
  leak(
    'three-level wrapper chain around a known request error',
    500,
    (m) =>
      new InternalServerErrorException(m, {
        cause: wrap(wrap(known(m), 'transaction aborted'), 'unit of work failed'),
      }),
  ),
  leak(
    'cyclic wrapper chain that still reaches the ORM error',
    500,
    (m) => new HttpException(`persist failed: ${m}`, 500, { cause: cyclicWithOrm(validation(m)) }),
  ),
  leak(
    'already sanitized DatabaseRequestError name as cause',
    500,
    (m) =>
      new InternalServerErrorException(`Database request failed: ${m}`, {
        cause: legacySanitized(m),
      }),
  ),
  leak(
    '400 wrapping a known request error with a malformed code shape',
    400,
    (m) => new BadRequestException(m, { cause: known(m, 'P202') }),
  ),
  leak(
    '409 wrapping a known request error whose meta target leaked into the body',
    409,
    (m) =>
      new ConflictException({ message: `Unique constraint failed on ${m}` }, { cause: known(m) }),
  ),
  // Message-field vectors carried here because S1's measured formatted budget
  // was full; identical in intent to S1's rows, not weaker variants.
  leak(
    '503 string response wrapping an initialization error',
    503,
    (m) => new ServiceUnavailableException(m, { cause: initialization(m) }),
  ),
  leak(
    '422 array message wrapping a validation error',
    422,
    (m) => new UnprocessableEntityException([m], { cause: validation(m) }),
  ),
  leak(
    '500 wrapping a rust panic error message',
    500,
    (m) => new HttpException(m, 500, { cause: rustPanic(m) }),
  ),
];

afterEach(() => jest.restoreAllMocks());

describe('public error envelope never carries ORM-derived text', () => {
  it.each(leakCases)('$name', ({ exception, status, marker }) => {
    expectSanitizedEnvelope(runFilter(exception), { status, marker });
  });
});
