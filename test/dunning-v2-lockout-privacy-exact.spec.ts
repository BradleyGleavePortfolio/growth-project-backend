/**
 * Sol B-622-1 / Opus C-622-1 — the AI consent lockout carve-out is exactly
 * three METHOD + PATH operations. The real DunningLockoutGuard (DI-built, flag
 * ON, caller explicitly locked) must:
 *   - admit GET /api/me/ai-consent, POST /api/me/ai-consent/roman and
 *     DELETE /api/me/ai-consent/roman without reading DunningState;
 *   - check lockout (one DunningState read) and 403 LOCKED_DUNNING for every
 *     descendant path and every other method, including the five probes from
 *     Sol's round-1 audit.
 */
import { Test } from '@nestjs/testing';
import type { ExecutionContext } from '@nestjs/common';
import { PrismaService } from '../src/prisma.service';
import { DunningLockoutGuard } from '../src/checkout/dunning-v2/dunning-lockout.guard';
import { LOCKED_DUNNING_CODE } from '../src/checkout/dunning-v2/dunning-v2.cadence';

describe('DunningLockoutGuard — AI consent carve-out is exact METHOD + PATH (B-622-1)', () => {
  const oldFlag = process.env.FEATURE_DUNNING_V2;
  afterAll(() => {
    if (oldFlag === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = oldFlag;
  });

  async function lockedGuard(): Promise<{
    guard: DunningLockoutGuard;
    lookup: jest.Mock;
    close: () => Promise<void>;
  }> {
    process.env.FEATURE_DUNNING_V2 = 'true';
    const lookup = jest.fn(async () => ({ id: 'locked', purchase_id: 'cp_locked' }));
    // S-DUNNING F6: the guard also checks for another live grant before
    // locking; this caller holds none.
    const otherGrants = jest.fn(async () => []);
    const module = await Test.createTestingModule({
      providers: [
        DunningLockoutGuard,
        {
          provide: PrismaService,
          useValue: {
            dunningState: { findFirst: lookup },
            clientPurchase: { findMany: otherGrants },
          },
        },
      ],
    }).compile();
    return { guard: module.get(DunningLockoutGuard), lookup, close: () => module.close() };
  }

  function ctx(method: string, path: string): ExecutionContext {
    const req = { method, path, user: { id: 'u_locked' } };
    return { switchToHttp: () => ({ getRequest: () => req }) } as ExecutionContext;
  }

  it.each([
    ['GET', '/api/me/ai-consent'],
    ['POST', '/api/me/ai-consent/roman'],
    ['DELETE', '/api/me/ai-consent/roman'],
  ])('admits %s %s for a locked caller without a lockout read', async (method, path) => {
    const { guard, lookup, close } = await lockedGuard();
    await expect(guard.canActivate(ctx(method, path))).resolves.toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    await close();
  });

  it.each([
    // Sol round-1 probes.
    ['GET', '/api/me/ai-consent/export'],
    ['POST', '/api/me/ai-consent/roman/messages'],
    ['POST', '/api/me/ai-consent'],
    ['GET', '/api/me/ai-consent/roman'],
    ['PUT', '/api/me/ai-consent/roman'],
    // Further wrong-method / lookalike cases.
    ['PATCH', '/api/me/ai-consent/roman'],
    ['DELETE', '/api/me/ai-consent'],
    ['HEAD', '/api/me/ai-consent'],
    ['GET', '/api/me/ai-consent-export'],
    ['GET', '/api/me/profile'],
  ])('locks %s %s for a locked caller (403 LOCKED_DUNNING)', async (method, path) => {
    const { guard, lookup, close } = await lockedGuard();
    await expect(guard.canActivate(ctx(method, path))).rejects.toMatchObject({
      status: 403,
      response: { code: LOCKED_DUNNING_CODE },
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    await close();
  });
});
