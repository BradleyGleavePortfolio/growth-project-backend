/**
 * B-675-1 (B-675-116): PackageIdempotencyFilter puts `package_id` on the wire
 * for a 422 IDEMPOTENCY_KEY_REUSED and nothing else. Every answer is compared
 * key for key with what the global HttpExceptionFilter writes for the same
 * exception, so the envelope cannot drift from the one every other route uses.
 */
import { randomUUID } from 'node:crypto';
import { type ArgumentsHost, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import {
  IDEMPOTENCY_KEY_REUSED_CODE,
  PackageIdempotencyFilter,
  reusedKeyPackageId,
} from '../src/packages/package-idempotency.filter';

type Body = Record<string, unknown>;

/** Runs a filter against a recording Express double; returns status + body. */
function wire(
  filter: { catch(exception: UnprocessableEntityException, host: ArgumentsHost): void },
  exception: UnprocessableEntityException,
): { status: number; body: Body } {
  const out = { status: 0, body: {} as Body };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(b: Body) {
      out.body = b;
      return res;
    },
  };
  const req = {
    url: '/v1/coach/packages',
    method: 'POST',
    route: { path: '/v1/coach/packages' },
    requestId: 'req-test-1',
  };
  const http = { getResponse: () => res, getRequest: () => req, getNext: () => undefined };
  const host: Pick<ArgumentsHost, 'switchToHttp'> = {
    switchToHttp: () => http as ReturnType<ArgumentsHost['switchToHttp']>,
  };
  filter.catch(exception, host as ArgumentsHost);
  return out;
}

const withoutTimestamp = ({ timestamp: _t, ...rest }: Body): Body => rest;

const reused = (packageId: unknown, extra: Body = {}) =>
  new UnprocessableEntityException({
    code: IDEMPOTENCY_KEY_REUSED_CODE,
    message: 'This Idempotency-Key already created a package with different details.',
    package_id: packageId,
    ...extra,
  });

describe('B-675-1 PackageIdempotencyFilter', () => {
  const filter = new PackageIdempotencyFilter();
  const global = new HttpExceptionFilter();

  it('adds package_id to the exact global envelope for IDEMPOTENCY_KEY_REUSED', () => {
    const id = randomUUID();
    const ex = reused(id);
    const ours = wire(filter, ex);
    const base = wire(global, ex);
    expect(ours.status).toBe(422);
    expect(base.body).not.toHaveProperty('package_id');
    expect(withoutTimestamp(ours.body)).toEqual({ ...withoutTimestamp(base.body), package_id: id });
    expect(ours.body).toMatchObject({
      statusCode: 422,
      code: IDEMPOTENCY_KEY_REUSED_CODE,
      request_id: 'req-test-1',
      path: '/v1/coach/packages',
    });
    expect(typeof ours.body.timestamp).toBe('string');
  });

  it('passes no other field of the exception body through', () => {
    const id = randomUUID();
    const ours = wire(filter, reused(id, { coach_id: 'coach-1', request_hash: 'abc', stack: 'x' }));
    expect(Object.keys(ours.body).sort()).toEqual(
      [
        'code',
        'error',
        'message',
        'package_id',
        'path',
        'request_id',
        'statusCode',
        'timestamp',
      ].sort(),
    );
  });

  it.each([
    ['a non-UUID string', 'pkg-1'],
    ['free text', 'coach@example.com'],
    ['a number', 42],
    ['missing', undefined],
  ])('drops a package_id that is %s and answers the plain global envelope', (_label, value) => {
    const ex = reused(value);
    const ours = wire(filter, ex);
    expect(ours.status).toBe(422);
    expect(ours.body).not.toHaveProperty('package_id');
    expect(withoutTimestamp(ours.body)).toEqual(withoutTimestamp(wire(global, ex).body));
  });

  it('leaves every other 422 to the global filter, even one that carries a package_id', () => {
    const ex = new UnprocessableEntityException({
      code: 'SOMETHING_ELSE',
      message: 'Other.',
      package_id: randomUUID(),
    });
    const ours = wire(filter, ex);
    expect(ours.body).not.toHaveProperty('package_id');
    expect(withoutTimestamp(ours.body)).toEqual(withoutTimestamp(wire(global, ex).body));
    const plain = new UnprocessableEntityException('Plain message.');
    expect(withoutTimestamp(wire(filter, plain).body)).toEqual(
      withoutTimestamp(wire(global, plain).body),
    );
  });

  it('an exception caused by an ORM failure gets the generic global envelope, no package_id', () => {
    const cause = new Prisma.PrismaClientKnownRequestError('secret query text', {
      code: 'P2010',
      clientVersion: 'test',
    });
    const ex = new UnprocessableEntityException(
      { code: IDEMPOTENCY_KEY_REUSED_CODE, message: 'x', package_id: randomUUID() },
      { cause },
    );
    const ours = wire(filter, ex);
    expect(ours.body).not.toHaveProperty('package_id');
    expect(JSON.stringify(ours.body)).not.toContain('secret query text');
    expect(withoutTimestamp(ours.body)).toEqual(withoutTimestamp(wire(global, ex).body));
  });

  it('reusedKeyPackageId reads only this code and only a UUID', () => {
    const id = randomUUID();
    expect(reusedKeyPackageId({ code: IDEMPOTENCY_KEY_REUSED_CODE, package_id: id })).toBe(id);
    expect(reusedKeyPackageId({ code: 'OTHER', package_id: id })).toBeNull();
    expect(reusedKeyPackageId({ code: IDEMPOTENCY_KEY_REUSED_CODE, package_id: 'x' })).toBeNull();
    expect(reusedKeyPackageId('IDEMPOTENCY_KEY_REUSED')).toBeNull();
    expect(reusedKeyPackageId(null)).toBeNull();
  });
});
