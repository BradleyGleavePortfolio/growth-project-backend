/**
 * #651 fix round 2, stacked piece A (client context): one regression per
 * finding that belongs to src/roman/context/* (B-651-10 coded context-view
 * failures, C-651-4 bounded memo). Red on the carried #651 @ a8fa651c code
 * (tests-only commit on ci/B-SCHED-ROMAN-A-before), green with the fix.
 * Only APIs that already existed at a8fa651c are imported.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RomanContextController } from '../../src/roman/context/roman-context.controller';
import { RomanClientContextService } from '../../src/roman/context/roman-client-context.service';
import type { RomanClientContextBundle } from '../../src/roman/context/roman-client-context.types';
import { HttpExceptionFilter } from '../../src/filters/http-exception.filter';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { PrismaService } from '../../src/prisma.service';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const CLIENT = { id: 'client-1', role: 'student' };

async function settle<T>(p: Promise<T>): Promise<{ ok: T } | { err: unknown }> {
  try {
    return { ok: await p };
  } catch (err) {
    return { err };
  }
}

/** The smallest bundle the memo reads (identity clock fields only). */
function bundleFor(_: unknown): RomanClientContextBundle {
  return fakeOf<RomanClientContextBundle>({
    context: {
      version: 'ctx-v3',
      identity: { first_name: 'Maya', timezone: 'UTC', local_date: '2026-10-03' },
    },
    rendered: '<client_data as_of="x" version="ctx-v3">{}</client_data>',
    hash: 'h'.repeat(64),
    generated_at: new Date(),
    estimated_tokens: 10,
    query_count: 1,
  });
}
const LEAN = null;

// ─── B-651-10: coded context-view failures ──────────────────────────────────

describe('B-651-10 GET /roman/context/me failures are coded with specific copy', () => {
  function runFilter(err: unknown) {
    const res = { statusCode: 0, body: null as unknown };
    const response = {
      status: (s: number) => {
        res.statusCode = s;
        return { json: (b: unknown) => (res.body = b) };
      },
    };
    const request = {
      method: 'GET',
      url: '/roman/context/me',
      route: { path: '/roman/context/me' },
      requestId: 'req-1',
    };
    const host = fakeOf<ArgumentsHost>({
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    });
    new HttpExceptionFilter().catch(err, host);
    return res;
  }

  async function call(err: unknown) {
    const ctx = fakeOf<RomanClientContextService>({
      buildFresh: jest.fn(async () => {
        throw err;
      }),
    });
    const ctl = new RomanContextController(ctx);
    const r = await settle(
      ctl.me(fakeOf<AuthedRequest>({ user: { id: CLIENT.id, role: 'student' } })),
    );
    expect('err' in r).toBe(true);
    return runFilter('err' in r ? r.err : null);
  }

  it('Sol probe: Prisma P2024 (pool timeout) is a coded 503 with a retry path, never a generic 500', async () => {
    const p2024 = new Prisma.PrismaClientKnownRequestError(
      'Timed out fetching a new connection from the pool. canary-query-text',
      { code: 'P2024', clientVersion: '6.19.3' },
    );
    const res = await call(p2024);
    expect(res.statusCode).toBe(503);
    const body = res.body as { code?: string; message?: string };
    expect(body.code).toBe('ROMAN_CONTEXT_UNAVAILABLE');
    expect(body.message).toMatch(/could not load/);
    expect(body.message).toMatch(/Try again in a moment/);
    expect(body.message).not.toMatch(
      /!|\bwe\b|\bus\b|\bour\b|something went wrong|internal server error/i,
    );
    expect(JSON.stringify(res.body)).not.toContain('canary');
  });

  it('an unexpected failure is a coded 500 with the support path and the reference id', async () => {
    const res = await call(new RangeError('canary detail'));
    expect(res.statusCode).toBe(500);
    const body = res.body as { code?: string; message?: string; request_id?: string };
    expect(body.code).toBe('ROMAN_CONTEXT_FAILED');
    expect(body.message).toMatch(/contact support/);
    expect(body.message).not.toMatch(/!|\bwe\b|\bus\b|\bour\b|something went wrong/i);
    expect(body.request_id).toBe('req-1');
    expect(JSON.stringify(res.body)).not.toContain('canary');
  });
});

// ─── C-651-4: bounded memo ──────────────────────────────────────────────────

describe('C-651-4 the context memo does not keep expired bundles or per-user fences forever', () => {
  function svcFor() {
    const svc = new RomanClientContextService(
      fakeOf<PrismaService>({}),
      fakeOf({ summarize: jest.fn(async () => null) }),
    );
    jest.spyOn(svc, 'buildFresh').mockImplementation(async () => bundleFor(LEAN));
    return svc;
  }
  const sizeOf = (svc: RomanClientContextService, field: string) =>
    (Reflect.get(svc, field) as Map<string, unknown>).size;

  it('an expired entry is evicted on the next build, for any user', async () => {
    const svc = svcFor();
    const t0 = new Date('2026-10-03T10:00:00Z');
    for (let i = 0; i < 20; i += 1) await svc.getBundle({ id: `u${i}`, role: 'student' }, t0);
    expect(sizeOf(svc, 'memo')).toBe(20);
    await svc.getBundle({ id: 'later', role: 'student' }, new Date(t0.getTime() + 60_000));
    expect(sizeOf(svc, 'memo')).toBe(1);
  });

  it('invalidating users with no build in flight leaves no generation entry behind', async () => {
    const svc = svcFor();
    for (let i = 0; i < 50; i += 1) svc.invalidateForUser(`u${i}`);
    expect(sizeOf(svc, 'generation')).toBe(0);
  });

  it('control: a write during an in-flight build still keeps the stale bundle out of the memo', async () => {
    const svc = new RomanClientContextService(
      fakeOf<PrismaService>({}),
      fakeOf({ summarize: jest.fn(async () => null) }),
    );
    let release: () => void = () => undefined;
    jest.spyOn(svc, 'buildFresh').mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r(bundleFor(LEAN));
        }),
    );
    const t0 = new Date('2026-10-03T10:00:00Z');
    const p = svc.getBundle({ id: 'u1', role: 'student' }, t0);
    await new Promise((r) => setImmediate(r));
    svc.invalidateForUser('u1');
    release();
    await p;
    expect(sizeOf(svc, 'memo')).toBe(0);
    expect(sizeOf(svc, 'generation')).toBe(0);
  });
});
