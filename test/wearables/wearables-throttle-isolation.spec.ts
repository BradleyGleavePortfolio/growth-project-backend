import { ExecutionContext, HttpException, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { AuthController } from '../../src/auth/auth.controller';
import { UserThrottlerGuard } from '../../src/throttler/user-throttler.guard';
import { THROTTLER_LIMITS, THROTTLER_NAMES } from '../../src/throttler/throttler.config';
import { ConnectionsController } from '../../src/wearables/connections/connections.controller';
import { WearableSamplesController } from '../../src/wearables/samples/wearable-samples.controller';
import { WEARABLES_SKIP_THROTTLERS } from '../../src/wearables/wearables-throttle';

/**
 * S14 audit B-623-1 — the REAL global guard (UserThrottlerGuard + the full
 * THROTTLER_LIMITS list + a real Reflector + the in-memory storage) against
 * the real controller metadata. Before the fix the ingest route accepted 3
 * requests and the 4th was rejected by `auth-password-reset`.
 */

type Handler = (...args: never[]) => unknown;

async function makeGuard(): Promise<{ guard: UserThrottlerGuard; storage: ThrottlerStorageService }> {
  const storage = new ThrottlerStorageService();
  const guard = new UserThrottlerGuard(
    { throttlers: THROTTLER_LIMITS.map((t) => ({ ...t })) },
    storage,
    new Reflector(),
  );
  await guard.onModuleInit();
  return { guard, storage };
}

function ctxFor(
  cls: Type<unknown>,
  handler: Handler,
  request: Record<string, unknown>,
): ExecutionContext {
  const res = { header: (): void => undefined, setHeader: (): void => undefined };
  // Real Nest context host (context type defaults to 'http').
  return new ExecutionContextHost([request, res, undefined], cls, handler);
}

async function countUntilBlocked(
  guard: UserThrottlerGuard,
  ctx: ExecutionContext,
  max: number,
): Promise<{ accepted: number; status: number | null }> {
  let accepted = 0;
  for (let i = 0; i < max; i += 1) {
    try {
      await guard.canActivate(ctx);
      accepted += 1;
    } catch (err) {
      return { accepted, status: err instanceof HttpException ? err.getStatus() : -1 };
    }
  }
  return { accepted, status: null };
}

const userReq = (path: string, id = 'user-1'): Record<string, unknown> => ({
  route: { path },
  url: path,
  user: { id },
  headers: {},
});

describe('S14 B-623-1 — wearables throttler isolation (real UserThrottlerGuard)', () => {
  let storage: ThrottlerStorageService | undefined;
  afterEach(() => {
    storage?.onApplicationShutdown();
    storage = undefined;
  });

  it('POST /v1/wearables/samples/ingest: 60 accepted, the 61st is a 429', async () => {
    const made = await makeGuard();
    storage = made.storage;
    const ctx = ctxFor(
      WearableSamplesController,
      WearableSamplesController.prototype.ingestSamples as Handler,
      userReq('/v1/wearables/samples/ingest'),
    );
    expect(await countUntilBlocked(made.guard, ctx, 70)).toEqual({ accepted: 60, status: 429 });
  });

  it('the ingest bucket is per user: a second user is unaffected by the first', async () => {
    const made = await makeGuard();
    storage = made.storage;
    const handler = WearableSamplesController.prototype.ingestSamples as Handler;
    const a = ctxFor(WearableSamplesController, handler, userReq('/v1/wearables/samples/ingest', 'a'));
    const b = ctxFor(WearableSamplesController, handler, userReq('/v1/wearables/samples/ingest', 'b'));
    expect(await countUntilBlocked(made.guard, a, 70)).toEqual({ accepted: 60, status: 429 });
    expect(await countUntilBlocked(made.guard, b, 5)).toEqual({ accepted: 5, status: null });
  });

  it('GET /v1/wearables/samples: 60 accepted, the 61st is a 429', async () => {
    const made = await makeGuard();
    storage = made.storage;
    const ctx = ctxFor(
      WearableSamplesController,
      WearableSamplesController.prototype.getSamples as Handler,
      userReq('/v1/wearables/samples'),
    );
    expect(await countUntilBlocked(made.guard, ctx, 70)).toEqual({ accepted: 60, status: 429 });
  });

  it('POST /v1/wearables/connections/on-device: 10 accepted, the 11th is a 429', async () => {
    const made = await makeGuard();
    storage = made.storage;
    const ctx = ctxFor(
      ConnectionsController,
      ConnectionsController.prototype.registerOnDevice as Handler,
      userReq('/v1/wearables/connections/on-device'),
    );
    expect(await countUntilBlocked(made.guard, ctx, 20)).toEqual({ accepted: 10, status: 429 });
  });

  it('GET /v1/wearables/connections: 60 accepted, the 61st is a 429', async () => {
    const made = await makeGuard();
    storage = made.storage;
    const ctx = ctxFor(
      ConnectionsController,
      ConnectionsController.prototype.list as Handler,
      userReq('/v1/wearables/connections'),
    );
    expect(await countUntilBlocked(made.guard, ctx, 70)).toEqual({ accepted: 60, status: 429 });
  });

  it('password reset keeps its own 3/hour limit (3 accepted, 4th 429), unaffected by wearables traffic', async () => {
    const made = await makeGuard();
    storage = made.storage;
    // Burn wearables traffic first from the same IP-less user context.
    const ingest = ctxFor(
      WearableSamplesController,
      WearableSamplesController.prototype.ingestSamples as Handler,
      userReq('/v1/wearables/samples/ingest'),
    );
    await countUntilBlocked(made.guard, ingest, 30);
    const reset = ctxFor(AuthController, AuthController.prototype.forgotPassword as Handler, {
      route: { path: '/auth/forgot-password' },
      url: '/auth/forgot-password',
      headers: { 'fly-client-ip': '203.0.113.9' },
    });
    expect(await countUntilBlocked(made.guard, reset, 10)).toEqual({ accepted: 3, status: 429 });
  });

  it('the skip map covers every named throttler except default (future names skipped too)', () => {
    const names = Object.values(THROTTLER_NAMES).filter((n) => n !== THROTTLER_NAMES.DEFAULT);
    expect(Object.keys(WEARABLES_SKIP_THROTTLERS).sort()).toEqual([...names].sort());
    expect(WEARABLES_SKIP_THROTTLERS[THROTTLER_NAMES.DEFAULT]).toBeUndefined();
    expect(WEARABLES_SKIP_THROTTLERS[THROTTLER_NAMES.AUTH_PASSWORD_RESET]).toBe(true);
  });
});
