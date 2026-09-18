import { HttpException, Logger } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Prisma } from '@prisma/client';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';

// Op81 shared setup for the public-envelope regression specs
// (scout-diagnostics-public.spec.ts and scout-diagnostics-public-cause.spec.ts).
// Setup, ORM fixture factories and the common envelope assertion live here so the
// two sequential slices stay individually within the size gate without dropping,
// weakening or duplicating any case. No production logic lives in this file: it
// only builds inputs for, and asserts the observable output of, the real filter.
//
// ASSERTION HELPER OBLIGATION: `envelopeOf` and `expectSanitizedEnvelope` below
// contain `expect(...)` calls on behalf of their callers. Every `it()` in the two
// specs asserts through them. Repository assertion-enforcement work (the "each
// it() has an expect()" check) must register both names, otherwise those cases
// will look assertion-free to a purely syntactic scan.

/** Every key the filter is permitted to emit (see src/filters/not-found-envelope.ts). */
export const PERMITTED_ENVELOPE_KEYS = [
  'statusCode',
  'code',
  'message',
  'error',
  'timestamp',
  'path',
  'request_id',
];

export const known = (payload: string, code = 'P2002') =>
  new Prisma.PrismaClientKnownRequestError(payload, {
    code,
    clientVersion: 'test',
    meta: { target: [payload] },
  });
export const unknownRequest = (payload: string) =>
  new Prisma.PrismaClientUnknownRequestError(payload, { clientVersion: 'test' });
export const validation = (payload: string) =>
  new Prisma.PrismaClientValidationError(payload, { clientVersion: 'test' });
export const initialization = (payload: string) =>
  new Prisma.PrismaClientInitializationError(payload, 'test', 'P1001');
export const rustPanic = (payload: string) =>
  new Prisma.PrismaClientRustPanicError(payload, 'test');
/** Already-sanitized ORM name that the matcher also recognizes. */
export const legacySanitized = (payload: string) =>
  Object.assign(new Error(payload), { name: 'DatabaseRequestError' });

/** Ordinary repository/transport wrapper around an ORM failure. */
export const wrap = (inner: Error, message = 'repository write failed') =>
  Object.assign(new Error(message), { cause: inner });

/** Wrapper chain whose tail points back at its head, with the ORM error inside. */
export function cyclicWithOrm(inner: Error): Error {
  const outer = wrap(inner, 'retry envelope');
  Object.assign(inner, { cause: outer });
  return outer;
}

export interface LeakCase {
  name: string;
  status: number;
  marker: string;
  exception: HttpException;
}

export function leak(
  name: string,
  status: number,
  build: (marker: string) => HttpException,
): LeakCase {
  const marker = `SYNTHETIC_ORM_PAYLOAD_${name.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
  return { name, status, marker, exception: build(marker) };
}

export interface FilterRun {
  logSpy: jest.SpyInstance;
  statusMock: jest.Mock;
  jsonMock: jest.Mock;
}

export function runFilter(exception: unknown, url = '/api/scout/ingest'): FilterRun {
  const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn();
  const response = { status: statusMock, json: jsonMock };
  const request = { method: 'POST', url, requestId: 'correlation-1' };
  new HttpExceptionFilter().catch(exception, new ExecutionContextHost([request, response]));
  return { logSpy, statusMock, jsonMock };
}

/** Asserts a single response was sent and returns its envelope. Contains assertions. */
export function envelopeOf(jsonMock: jest.Mock): Record<string, unknown> {
  expect(jsonMock).toHaveBeenCalledTimes(1);
  return jsonMock.mock.calls[0][0];
}

/**
 * The shared public-envelope contract for an ORM-derived failure. Contains the
 * assertions every leak case makes: no ORM payload in the client envelope or the
 * logs, and an envelope that is still a real, usable error — same status,
 * permitted keys only, a non-empty actionable message and preserved correlation.
 */
export function expectSanitizedEnvelope(
  run: FilterRun,
  expected: { status: number; marker: string; path?: string },
): void {
  const body = envelopeOf(run.jsonMock);

  // The unsafe payload must not reach the client in any envelope field.
  expect(JSON.stringify(body)).not.toContain(expected.marker);
  // ...nor the logs, which the recovered filter already sanitizes.
  expect(JSON.stringify(run.logSpy.mock.calls)).not.toContain(expected.marker);

  expect(run.statusMock).toHaveBeenCalledWith(expected.status);
  expect(body.statusCode).toBe(expected.status);
  expect(Object.keys(body).filter((key) => !PERMITTED_ENVELOPE_KEYS.includes(key))).toEqual([]);
  const message = Array.isArray(body.message) ? body.message.join(' ') : body.message;
  expect(typeof message).toBe('string');
  expect(String(message).trim().length).toBeGreaterThan(0);
  expect(typeof body.error).toBe('string');
  expect(String(body.error).trim().length).toBeGreaterThan(0);
  expect(body.request_id).toBe('correlation-1');
  expect(typeof body.timestamp).toBe('string');
  expect(body.path).toBe(expected.path ?? '/api/scout/ingest');
}
