import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PushAbortedError } from '../src/notifications/push-delivery.types';
import {
  LOG_ERROR_CLASSES,
  LOG_ERROR_CODES,
  logErrorClass,
  logErrorCode,
  safeLogDiagnostic,
} from '../src/observability/orm-diagnostics';

// B-634-10 (Sol @ 9e6c62c9): the shared log sanitizer must emit only members
// of a reviewed closed enum. An identifier-shaped string is still arbitrary
// data, so a name or code outside the catalog never reaches a log line.
const CANARY = 'SYNTHETIC_PRIVATE_CANARY_123';

function named(name: string, message = `message ${CANARY}`): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function coded(code: string, base: Error = new Error(`message ${CANARY}`)): Error {
  return Object.assign(base, { code });
}

describe('B-634-10: safeLogDiagnostic is a closed enum', () => {
  it('an identifier-shaped unknown name logs as OtherError', () => {
    expect(safeLogDiagnostic(named(CANARY))).toBe('OtherError');
    expect(safeLogDiagnostic(named('Jamie_knee_pain'))).toBe('OtherError');
  });

  it('an identifier-shaped unknown code is dropped', () => {
    expect(safeLogDiagnostic(coded(CANARY))).toBe('Error');
    expect(safeLogDiagnostic(coded(CANARY, new TypeError('x')))).toBe('TypeError');
  });

  it('an unknown name and an unknown code together log as OtherError only', () => {
    expect(safeLogDiagnostic(coded(CANARY, named(CANARY)))).toBe('OtherError');
  });

  it('wrapped causes: a canary cause never surfaces; a catalogued cause code does', () => {
    const canaryCause = coded(CANARY, named(CANARY));
    const outer = Object.assign(new Error(`outer ${CANARY}`), { cause: canaryCause });
    expect(safeLogDiagnostic(outer)).toBe('Error');
    const fetchFailed = Object.assign(new TypeError('fetch failed'), {
      cause: coded('UND_ERR_CONNECT_TIMEOUT', named('ConnectTimeoutError')),
    });
    expect(safeLogDiagnostic(fetchFailed)).toBe('TypeError (UND_ERR_CONNECT_TIMEOUT)');
  });

  it('a cyclic cause chain terminates', () => {
    const a = named(CANARY);
    const b = Object.assign(new Error('b'), { cause: a });
    Object.assign(a, { cause: b });
    expect(safeLogDiagnostic(b)).toBe('Error');
  });

  it('non-Error throws log OtherError, never their content', () => {
    for (const value of [
      CANARY,
      { name: CANARY, code: CANARY, message: CANARY },
      42,
      null,
      undefined,
      Symbol(CANARY),
    ]) {
      expect(safeLogDiagnostic(value)).toBe('OtherError');
    }
  });

  it('a hostile getter on name or code cannot throw or leak', () => {
    const err = new Error(CANARY);
    Object.defineProperty(err, 'name', {
      get() {
        throw new Error(CANARY);
      },
    });
    expect(() => safeLogDiagnostic(err)).not.toThrow();
    expect(safeLogDiagnostic(err)).toBe('OtherError');
    const err2 = new RangeError(CANARY);
    Object.defineProperty(err2, 'code', {
      get() {
        throw new Error(CANARY);
      },
    });
    expect(safeLogDiagnostic(err2)).toBe('RangeError');
  });

  it('Prisma P-codes still pass through the validated ORM branch, also wrapped', () => {
    const orm = new Prisma.PrismaClientKnownRequestError(`Query: ${CANARY}`, {
      code: 'P2024',
      clientVersion: 'test',
      meta: { target: CANARY },
    });
    expect(safeLogDiagnostic(orm)).toBe('DatabaseRequestError: Database request failed (P2024)');
    const wrapped = Object.assign(named(CANARY), { cause: orm, code: CANARY });
    expect(safeLogDiagnostic(wrapped)).toBe(
      'DatabaseRequestError: Database request failed (P2024)',
    );
    // A non-ORM error that merely claims a P-code shape is not trusted.
    expect(safeLogDiagnostic(coded('P2024'))).toBe('Error');
  });

  it('known classes keep their name, catalogued code and HTTP status', () => {
    expect(safeLogDiagnostic(new RangeError(CANARY))).toBe('RangeError');
    expect(safeLogDiagnostic(new PushAbortedError(CANARY))).toBe('PushAbortedError (PUSH_ABORTED)');
    expect(safeLogDiagnostic(coded('ECONNRESET', new TypeError(CANARY)))).toBe(
      'TypeError (ECONNRESET)',
    );
    expect(
      safeLogDiagnostic(
        new ServiceUnavailableException({
          error: 'CALENDAR_PROVIDER_NOT_IMPLEMENTED',
          message: CANARY,
        }),
      ),
    ).toBe('ServiceUnavailableException (503)');
    expect(safeLogDiagnostic(new NotFoundException(CANARY))).toBe('NotFoundException (404)');
  });

  it('an HttpException-shaped impostor cannot inject a non-numeric status', () => {
    const fake = Object.assign(named('NotFoundException'), { getStatus: () => CANARY });
    expect(safeLogDiagnostic(fake)).toBe('NotFoundException');
    const outOfRange = Object.assign(named('NotFoundException'), { getStatus: () => 1234567 });
    expect(safeLogDiagnostic(outOfRange)).toBe('NotFoundException');
  });

  it('every output is built only from catalog members (property sweep)', () => {
    const allowed = new Set<string>([...LOG_ERROR_CLASSES, 'OtherError', ...LOG_ERROR_CODES]);
    const names = [...LOG_ERROR_CLASSES, CANARY, 'X', 'Error2', 'Prisma_Note', ''];
    const codes = [...LOG_ERROR_CODES, CANARY, 'ERR_X', 'abc.def-1', ''];
    for (const n of names) {
      for (const c of codes) {
        const out = safeLogDiagnostic(coded(c, named(n)));
        const tokens = out.replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
        for (const t of tokens) expect(allowed.has(t)).toBe(true);
        expect(out).not.toContain(CANARY);
      }
    }
  });

  it('the class and code helpers are exact-membership, not shape filters', () => {
    expect(logErrorClass(named('TypeError'))).toBe('TypeError');
    expect(logErrorClass(named('TypeErrorX'))).toBe('OtherError');
    expect(logErrorClass('TypeError')).toBe('OtherError');
    expect(logErrorCode(coded('ETIMEDOUT'))).toBe('ETIMEDOUT');
    expect(logErrorCode(coded('ETIMEDOUT2'))).toBeNull();
    expect(logErrorCode({ code: 'ETIMEDOUT' })).toBeNull();
  });
});
