import { ForbiddenException } from '@nestjs/common';
import {
  DunningLockoutGuard,
  isAllowedWhileLocked,
  normalizePath,
} from '../src/checkout/dunning-v2/dunning-lockout.guard';
import { LOCKED_DUNNING_CODE } from '../src/checkout/dunning-v2/dunning-v2.cadence';

// R66 gate 4 (lockout middleware): non-billing routes 403 when LOCKED;
// billing/auth/health/Roman-chat allowed. Plus the pure path helpers.

describe('normalizePath', () => {
  it('strips query, leading slash, /api and /v1 prefixes, lowercases', () => {
    expect(normalizePath('/api/v1/community/feed?x=1')).toBe('community/feed');
    expect(normalizePath('/API/V1/Billing')).toBe('billing');
    expect(normalizePath('health')).toBe('health');
  });
});

describe('isAllowedWhileLocked (route allow-list)', () => {
  it.each([
    'billing',
    'billing/portal',
    'checkout/session',
    'payment-recovery/mint',
    'recover/abc',
    'auth/logout',
    'auth/refresh',
    'health',
    'healthz',
    'readyz',
    'coach/billing', // second-segment billing variant
    'ai', // Roman chat base
    'ai/gateway',
    'ai/gateway/stream',
    '', // root / redirect
  ])('ALLOWS %s while locked', (p) => {
    expect(isAllowedWhileLocked(p)).toBe(true);
  });

  it.each([
    'community/feed',
    'workouts',
    'programs/123',
    'fasting',
    'check-ins',
    'insights/holistic',
    'log/today',
  ])('BLOCKS %s while locked', (p) => {
    expect(isAllowedWhileLocked(p)).toBe(false);
  });
});

// ── Guard integration with a stub prisma + execution context ───────────────
function makeCtx(path: string, userId?: string) {
  const req: any = { path, user: userId ? { id: userId } : undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}

function makePrismaStub(lockedRow: any) {
  return {
    dunningState: {
      findFirst: jest.fn(async () => lockedRow),
    },
  } as any;
}

describe('DunningLockoutGuard', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  afterAll(() => {
    if (prevFlag === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prevFlag;
  });

  it('flag OFF → invisible no-op (returns true, reads no state)', async () => {
    delete process.env['FEATURE_DUNNING_V2'];
    const prisma = makePrismaStub({ id: 'd1' });
    const guard = new DunningLockoutGuard(prisma);
    await expect(
      guard.canActivate(makeCtx('/api/v1/community/feed', 'u1')),
    ).resolves.toBe(true);
    expect(prisma.dunningState.findFirst).not.toHaveBeenCalled();
  });

  describe('flag ON', () => {
    beforeEach(() => {
      process.env['FEATURE_DUNNING_V2'] = 'true';
    });

    it('403 LOCKED_DUNNING on a non-billing route when client is locked', async () => {
      const prisma = makePrismaStub({ id: 'd1' });
      const guard = new DunningLockoutGuard(prisma);
      await expect(
        guard.canActivate(makeCtx('/api/v1/community/feed', 'u1')),
      ).rejects.toMatchObject(
        expect.objectContaining({
          // ForbiddenException carries the { code } response object.
          response: expect.objectContaining({ code: LOCKED_DUNNING_CODE }),
        }),
      );
    });

    it('throws a ForbiddenException type', async () => {
      const prisma = makePrismaStub({ id: 'd1' });
      const guard = new DunningLockoutGuard(prisma);
      await expect(
        guard.canActivate(makeCtx('/api/v1/workouts', 'u1')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ALLOWS billing route even when locked (never reads state)', async () => {
      const prisma = makePrismaStub({ id: 'd1' });
      const guard = new DunningLockoutGuard(prisma);
      await expect(
        guard.canActivate(makeCtx('/api/v1/billing/portal', 'u1')),
      ).resolves.toBe(true);
      expect(prisma.dunningState.findFirst).not.toHaveBeenCalled();
    });

    it('ALLOWS Roman chat route when locked', async () => {
      const prisma = makePrismaStub({ id: 'd1' });
      const guard = new DunningLockoutGuard(prisma);
      await expect(
        guard.canActivate(makeCtx('/api/ai/gateway/stream', 'u1')),
      ).resolves.toBe(true);
    });

    it('ALLOWS a non-billing route when the client is NOT locked', async () => {
      const prisma = makePrismaStub(null);
      const guard = new DunningLockoutGuard(prisma);
      await expect(
        guard.canActivate(makeCtx('/api/v1/community/feed', 'u1')),
      ).resolves.toBe(true);
    });

    it('unauthenticated request → allowed (auth guards handle it)', async () => {
      const prisma = makePrismaStub({ id: 'd1' });
      const guard = new DunningLockoutGuard(prisma);
      await expect(
        guard.canActivate(makeCtx('/api/v1/community/feed', undefined)),
      ).resolves.toBe(true);
    });

    it('fails OPEN on a lookup error (never lock on infra hiccup)', async () => {
      const prisma = {
        dunningState: {
          findFirst: jest.fn(async () => {
            throw new Error('db down');
          }),
        },
      } as any;
      const guard = new DunningLockoutGuard(prisma);
      await expect(
        guard.canActivate(makeCtx('/api/v1/community/feed', 'u1')),
      ).resolves.toBe(true);
    });
  });
});
