/**
 * W1.5-A3.1 — behavior-pinned tests for the LEGACY RlsContextInterceptor and the
 * dual-context expand it participates in. NO database, NO Nest container: a fake
 * PrismaService records every `$executeRawUnsafe(sql, ...params)` so we can read
 * back exactly which GUC was stamped with which value.
 *
 * These pin two invariants:
 *
 *   1. F-1 regression. The interceptor MUST stamp app.current_user_id from
 *      `req.user.id` (ENGINEERING_RULES §11). The pre-fix code read `req.user.sub`,
 *      which is undefined for the Prisma-User request shape — so a request that
 *      carries `id` but no `sub` stamps the REAL id after the fix and would have
 *      stamped nothing (no call) before it. This test FAILS on the `user.sub`
 *      code and PASSES on `user.id`.
 *
 *   2. Dual-context expand. The interceptor mirrors the same id onto the new
 *      `app.user_id` namespace so both namespaces carry identical truth on the
 *      legacy connection.
 */
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { RlsContextInterceptor } from '../src/common/interceptors/rls-context.interceptor';
import type { PrismaService } from '../src/prisma.service';

type RawCall = { sql: string; params: unknown[] };

function makeFakePrisma(): { prisma: PrismaService; calls: RawCall[] } {
  const calls: RawCall[] = [];
  const prisma = {
    $executeRawUnsafe: jest.fn((sql: string, ...params: unknown[]) => {
      calls.push({ sql, params });
      return Promise.resolve(1);
    }),
  } as unknown as PrismaService;
  return { prisma, calls };
}

function makeContext(user: unknown): ExecutionContext {
  const request = { user, method: 'GET', url: '/x' };
  return {
    switchToHttp: () => ({ getRequest: <T>(): T => request as T }),
  } as unknown as ExecutionContext;
}

function makeHandler(): CallHandler {
  return { handle: () => of('ok') };
}

/** Find the value stamped for a given GUC name, or undefined if it was never set. */
function stampedValue(calls: RawCall[], guc: string): unknown {
  const call = calls.find((c) => c.sql.includes(`'${guc}'`));
  return call?.params[0];
}

describe('RlsContextInterceptor (legacy, W1.5-A3.1)', () => {
  it('F-1: stamps app.current_user_id from req.user.id (fails on the old user.sub read)', async () => {
    const { prisma, calls } = makeFakePrisma();
    const interceptor = new RlsContextInterceptor(prisma);
    // Prisma User request shape: has `id`, has NO `sub`. The old `user.sub` code
    // would skip the whole block (no calls); the fixed `user.id` code stamps it.
    const ctx = makeContext({ id: 'user-real-id', role: 'coach' });

    await firstValueFrom(await interceptor.intercept(ctx, makeHandler()));

    expect(stampedValue(calls, 'app.current_user_id')).toBe('user-real-id');
  });

  it('does NOT trust a legacy user.sub claim when id is absent (no id => no stamp)', async () => {
    const { prisma, calls } = makeFakePrisma();
    const interceptor = new RlsContextInterceptor(prisma);
    // A token-only shape carrying just `sub`: post-fix this is NOT an identity
    // source, so nothing is stamped (fail-closed). Pre-fix it WOULD have stamped
    // `sub` — this asserts the wrong claim is no longer used.
    const ctx = makeContext({ sub: 'jwt-sub-not-an-id' });

    await firstValueFrom(await interceptor.intercept(ctx, makeHandler()));

    expect(stampedValue(calls, 'app.current_user_id')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('dual-context expand: mirrors the SAME id onto the new app.user_id namespace', async () => {
    const { prisma, calls } = makeFakePrisma();
    const interceptor = new RlsContextInterceptor(prisma);
    const ctx = makeContext({ id: 'user-7', role: 'student' });

    await firstValueFrom(await interceptor.intercept(ctx, makeHandler()));

    expect(stampedValue(calls, 'app.current_user_id')).toBe('user-7');
    expect(stampedValue(calls, 'app.user_id')).toBe('user-7');
    // Both namespaces resolved to the same acting user — the expand invariant.
    expect(stampedValue(calls, 'app.user_id')).toBe(
      stampedValue(calls, 'app.current_user_id'),
    );
    expect(stampedValue(calls, 'app.current_user_role')).toBe('student');
  });

  it('stamps every GUC as transaction-scoped (set_config(..., $1, true))', async () => {
    const { prisma, calls } = makeFakePrisma();
    const interceptor = new RlsContextInterceptor(prisma);
    const ctx = makeContext({ id: 'user-9', role: 'owner' });

    await firstValueFrom(await interceptor.intercept(ctx, makeHandler()));

    for (const c of calls) {
      expect(c.sql).toMatch(/set_config\('app\.[a-z_]+',\s*\$1,\s*true\)/);
    }
  });
});
