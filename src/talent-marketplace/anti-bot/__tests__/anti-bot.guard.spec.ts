import { ExecutionContext, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AntiBotGuard, ANTI_BOT_SURFACE_KEY } from '../anti-bot.guard';
import {
  AntiBotProvider,
  AntiBotVerdict,
  ANTI_BOT_REASONS,
  ANTI_BOT_SURFACES,
} from '../anti-bot.types';

/**
 * Unit tests for the gate guard: signal normalization + verdict→HTTP mapping.
 * The provider is a stub returning a scripted verdict; we assert the guard's
 * pass/throw behaviour and the structured response shape, not provider logic.
 */

function makeContext(
  surface: string | undefined,
  req: Record<string, unknown>,
): { ctx: ExecutionContext; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
  const http = {
    getRequest: () => req,
    getResponse: () => res,
  };
  const ctxMock = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => http,
  };
  void surface;
  // @ts-expect-error — minimal structural ExecutionContext mock for the unit test.
  const ctx: ExecutionContext = ctxMock;
  return { ctx, headers };
}

/** Minimal Reflector stub: only getAllAndOverride is exercised by the guard. */
function stubReflector(surface: string | undefined): Reflector {
  // @ts-expect-error — minimal structural Reflector mock for the unit test.
  return { getAllAndOverride: jest.fn(() => surface) };
}

function guardWith(verdict: AntiBotVerdict, surface: string | undefined): AntiBotGuard {
  const provider: AntiBotProvider = {
    id: 'stub',
    evaluate: jest.fn(async () => verdict),
  };
  return new AntiBotGuard(stubReflector(surface), provider);
}

const baseReq = () => ({
  headers: { 'fly-client-ip': '203.0.113.9', 'user-agent': 'jest' },
  body: { email: 'a@b.com' },
});

describe('AntiBotGuard', () => {
  it('passes through routes with no @AntiBotGate metadata', async () => {
    const guard = guardWith({ decision: 'deny', reason: ANTI_BOT_REASONS.RateExceeded }, undefined);
    const { ctx } = makeContext(undefined, baseReq());
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows when the provider returns allow', async () => {
    const guard = guardWith({ decision: 'allow' }, ANTI_BOT_SURFACES.Apply);
    const { ctx } = makeContext(ANTI_BOT_SURFACES.Apply, baseReq());
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws 428 with Retry-After + reason on challenge', async () => {
    const guard = guardWith(
      { decision: 'challenge', reason: ANTI_BOT_REASONS.VelocityAnomaly, retryAfterSeconds: 90 },
      ANTI_BOT_SURFACES.Apply,
    );
    const { ctx, headers } = makeContext(ANTI_BOT_SURFACES.Apply, baseReq());
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      status: HttpStatus.PRECONDITION_REQUIRED,
    });
    expect(headers['Retry-After']).toBe('90');
    try {
      await guard.canActivate(ctx);
    } catch (e) {
      const body = (e as HttpException).getResponse() as { reason: string; retryAfter: number };
      expect(body.reason).toBe(ANTI_BOT_REASONS.VelocityAnomaly);
      expect(body.retryAfter).toBe(90);
    }
  });

  it('throws 429 on a rate-exceeded deny', async () => {
    const guard = guardWith(
      { decision: 'deny', reason: ANTI_BOT_REASONS.RateExceeded, retryAfterSeconds: 600 },
      ANTI_BOT_SURFACES.Apply,
    );
    const { ctx, headers } = makeContext(ANTI_BOT_SURFACES.Apply, baseReq());
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(headers['Retry-After']).toBe('600');
  });

  it('throws 403 on an identity-heuristic deny', async () => {
    const guard = guardWith(
      { decision: 'deny', reason: ANTI_BOT_REASONS.DuplicateIdentity },
      ANTI_BOT_SURFACES.AccountCreate,
    );
    const { ctx } = makeContext(ANTI_BOT_SURFACES.AccountCreate, baseReq());
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('gates the listing-publish surface and forwards it to the provider', async () => {
    const provider: AntiBotProvider = {
      id: 'stub',
      evaluate: jest.fn(async () => ({ decision: 'allow' as const })),
    };
    const guard = new AntiBotGuard(stubReflector(ANTI_BOT_SURFACES.ListingPublish), provider);
    const { ctx } = makeContext(ANTI_BOT_SURFACES.ListingPublish, baseReq());
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(provider.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ surface: ANTI_BOT_SURFACES.ListingPublish }),
    );
  });

  it('reads the surface metadata key from handler + class', async () => {
    const provider: AntiBotProvider = { id: 'stub', evaluate: jest.fn(async () => ({ decision: 'allow' as const })) };
    const reflector = stubReflector(ANTI_BOT_SURFACES.Apply);
    const guard = new AntiBotGuard(reflector, provider);
    const { ctx } = makeContext(ANTI_BOT_SURFACES.Apply, baseReq());
    await guard.canActivate(ctx);
    expect((reflector.getAllAndOverride as jest.Mock).mock.calls[0][0]).toBe(ANTI_BOT_SURFACE_KEY);
    expect(provider.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ surface: ANTI_BOT_SURFACES.Apply, ip: '203.0.113.9' }),
    );
  });
});
