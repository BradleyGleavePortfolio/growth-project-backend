import type { ExecutionContext } from '@nestjs/common';
import { DunningLockoutGuard } from '../src/checkout/dunning-v2/dunning-lockout.guard';

// B-353-10 (Opus L3 on mobile m#353): a dispute or Day-10 lockout's way back
// on mobile is "Message coach". A locked client must reach exactly their own
// coach thread (ClientMessagingController, thread with the assigned coach) and
// nothing else. Synthetic ids only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;

describe('DunningLockoutGuard: a locked client reaches their own coach thread only (B-353-10)', () => {
  const prior = process.env.FEATURE_DUNNING_V2;
  beforeEach(() => {
    process.env.FEATURE_DUNNING_V2 = 'true';
  });
  afterAll(() => {
    if (prior === undefined) delete process.env.FEATURE_DUNNING_V2;
    else process.env.FEATURE_DUNNING_V2 = prior;
  });

  const lockedGuard = () =>
    new DunningLockoutGuard(
      stub({
        dunningState: { findFirst: jest.fn(async () => ({ id: 'ds_1', purchase_id: 'cp_1' })) },
        // The guard also checks for another live grant before locking; none here.
        clientPurchase: { findMany: jest.fn(async () => []) },
      }),
    );
  const ctx = (method: string, path: string): ExecutionContext =>
    stub({
      switchToHttp: () => ({ getRequest: () => ({ method, path, user: { id: 'client-1' } }) }),
    });

  it.each([
    ['GET', '/api/messages'],
    ['POST', '/api/messages'],
    ['POST', '/api/messages/read'],
    ['GET', '/api/messages/unread-count'],
    ['POST', '/api/messages/report'], // MessagesSafetyController — safety report
    ['get', '/api/messages?before=2026-10-01T00:00:00.000Z'],
  ])('admits %s %s for a locked client', async (method, path) => {
    await expect(lockedGuard().canActivate(ctx(method, path))).resolves.toBe(true);
  });

  it.each([
    ['POST', '/api/messages/voice-upload'], // paid surface
    ['GET', '/api/messages/coach-review'],
    ['DELETE', '/api/messages'],
    ['PUT', '/api/messages/read'],
    ['GET', '/api/messages/read'],
    ['GET', '/api/messages/report'],
    ['GET', '/api/messages/other-thread'],
    ['GET', '/api/coach/clients/client-2/messages'],
    ['GET', '/api/coach/messages/unread-count'],
    ['GET', '/api/community/messages'],
  ])('still refuses %s %s for a locked client', async (method, path) => {
    await expect(lockedGuard().canActivate(ctx(method, path))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('a missing method never matches', async () => {
    const req = stub({
      switchToHttp: () => ({
        getRequest: () => ({ path: '/api/messages', user: { id: 'client-1' } }),
      }),
    });
    await expect(lockedGuard().canActivate(req)).rejects.toMatchObject({ status: 403 });
  });
});
