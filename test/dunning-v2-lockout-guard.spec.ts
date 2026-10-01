import { ForbiddenException } from '@nestjs/common';
import {
  DunningLockoutGuard,
  isAllowedWhileLocked,
  isPrivacyOperationWhileLocked,
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
    'coach/billing', // mobile coach billing surface
    'coach/billing/status',
    'coach/billing/portal-session',
    'coach/me/billing', // v1 coach billing surface — same Stripe portal
    'coach/me/billing/portal-session',
    'roman', // dedicated Roman chat base (explains the lockout)
    'roman/sessions',
    'roman/sessions/abc/messages',
    // S-DUNNING F8: account rights and the coach thread stay reachable.
    'me/data-export/request',
    'me/data-export/status',
    'me/data-export/download',
    'me/delete-account',
    'me/delete-account/confirm',
    'me/delete-account/cancel',
    'me/delete-account/status',
    'messages',
    'messages/read',
    'messages/unread-count',
    'messages/report',
    'checkout/dunning', // the lockout screen's own status read
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
    // The entitlement-gated student AI assistant is a paid value surface and
    // must stay LOCKED — it is NOT the Roman lockout-explanation carve-out.
    'ai',
    'ai/chat',
    'ai/context',
    'ai/gateway', // internal provider routing, never a client explanation route
    'ai/gateway/stream',
    // An allow-list token off the head grants nothing: these are paid or
    // privileged surfaces, not payment recovery.
    'scheduling/auth/google/initiate',
    'scheduling/auth/google/callback',
    'admin/auth/impersonate',
    'coach/me', // only the coach BILLING subtree is carved out
    'coach/me/clients',
    // The AI consent carve-out is method-aware (isPrivacyOperationWhileLocked);
    // the method-blind path rules never admit it, or anything under /me.
    'me/ai-consent',
    'me/ai-consent/roman',
    'me',
    'me/profile',
    'me/ai-consent-export',
    'me/ai-consentroman',
    'coach/me/ai-consent',
    // Only the exact coach-thread routes are carved out (S-DUNNING F8).
    'messages/voice-upload',
    'messages/coach-review',
    'messages/anything-new',
    'me/data-exporter', // prefix match is segment-bounded
  ])('BLOCKS %s while locked', (p) => {
    expect(isAllowedWhileLocked(p)).toBe(false);
  });
});

describe('isPrivacyOperationWhileLocked (exact METHOD + PATH, Sol B-622-1)', () => {
  it.each([
    ['GET', 'me/ai-consent'],
    ['get', 'me/ai-consent'],
    ['POST', 'me/ai-consent/roman'],
    ['DELETE', 'me/ai-consent/roman'],
  ])('ALLOWS %s %s', (m, p) => {
    expect(isPrivacyOperationWhileLocked(m, p)).toBe(true);
  });

  it.each([
    ['GET', 'me/ai-consent/export'],
    ['POST', 'me/ai-consent/roman/messages'],
    ['POST', 'me/ai-consent'],
    ['GET', 'me/ai-consent/roman'],
    ['PUT', 'me/ai-consent/roman'],
    ['PATCH', 'me/ai-consent/roman'],
    ['DELETE', 'me/ai-consent'],
    ['HEAD', 'me/ai-consent'],
    ['OPTIONS', 'me/ai-consent/roman'],
    ['GET', 'me/ai-consent/'],
    ['GET', 'me/ai-consent-export'],
    ['GET', 'coach/me/ai-consent'],
    ['GET', 'me'],
    [undefined, 'me/ai-consent'],
    ['', 'me/ai-consent/roman'],
  ])('BLOCKS %s %s', (m, p) => {
    expect(isPrivacyOperationWhileLocked(m, p)).toBe(false);
  });
});

// ── Guard integration with a stub prisma + execution context ───────────────
function makeCtx(path: string, userId?: string) {
  const req: any = { path, user: userId ? { id: userId } : undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}

function makePrismaStub(lockedRow: any, otherPurchases: any[] = []) {
  return {
    dunningState: {
      findFirst: jest.fn(async () => lockedRow),
    },
    clientPurchase: {
      findMany: jest.fn(async () => otherPurchases),
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
    await expect(guard.canActivate(makeCtx('/api/v1/community/feed', 'u1'))).resolves.toBe(true);
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
      await expect(guard.canActivate(makeCtx('/api/v1/workouts', 'u1'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('ALLOWS billing route even when locked (never reads state)', async () => {
      const prisma = makePrismaStub({ id: 'd1' });
      const guard = new DunningLockoutGuard(prisma);
      await expect(guard.canActivate(makeCtx('/api/v1/billing/portal', 'u1'))).resolves.toBe(true);
      expect(prisma.dunningState.findFirst).not.toHaveBeenCalled();
    });

    it('ALLOWS the dedicated Roman chat route (/roman) when locked', async () => {
      const prisma = makePrismaStub({ id: 'd1' });
      const guard = new DunningLockoutGuard(prisma);
      await expect(guard.canActivate(makeCtx('/api/roman/sessions', 'u1'))).resolves.toBe(true);
      // Allow-list short-circuits before any DB read.
      expect(prisma.dunningState.findFirst).not.toHaveBeenCalled();
    });

    it('BLOCKS the student AI assistant (/ai/chat) when locked', async () => {
      const prisma = makePrismaStub({ id: 'd1' });
      const guard = new DunningLockoutGuard(prisma);
      await expect(guard.canActivate(makeCtx('/api/ai/chat', 'u1'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('ALLOWS a non-billing route when the client is NOT locked', async () => {
      const prisma = makePrismaStub(null);
      const guard = new DunningLockoutGuard(prisma);
      await expect(guard.canActivate(makeCtx('/api/v1/community/feed', 'u1'))).resolves.toBe(true);
    });

    it('unauthenticated request → allowed (auth guards handle it)', async () => {
      const prisma = makePrismaStub({ id: 'd1' });
      const guard = new DunningLockoutGuard(prisma);
      await expect(guard.canActivate(makeCtx('/api/v1/community/feed', undefined))).resolves.toBe(
        true,
      );
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
      await expect(guard.canActivate(makeCtx('/api/v1/community/feed', 'u1'))).resolves.toBe(true);
    });
  });
});

describe('DunningLockoutGuard lock authority (S-DUNNING F6)', () => {
  const prevFlag = process.env['FEATURE_DUNNING_V2'];
  beforeEach(() => {
    process.env['FEATURE_DUNNING_V2'] = 'true';
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env['FEATURE_DUNNING_V2'];
    else process.env['FEATURE_DUNNING_V2'] = prevFlag;
  });

  it('locks on locked_out_at alone: the query does not depend on entitlement_active', async () => {
    const prisma = makePrismaStub({ id: 'd1', purchase_id: 'p1' });
    const guard = new DunningLockoutGuard(prisma);
    await expect(guard.canActivate(makeCtx('/api/v1/workouts', 'u1'))).rejects.toMatchObject({
      response: expect.objectContaining({ code: LOCKED_DUNNING_CODE }),
    });
    const where = prisma.dunningState.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({
      locked_out_at: { not: null },
      status: 'active',
      purchase: { client_user_id: 'u1' },
    });
  });

  it('does NOT lock a client who holds another live grant (comp / invite-code / kept access)', async () => {
    const prisma = makePrismaStub({ id: 'd1', purchase_id: 'p1' }, [
      { id: 'p-comp', dunning: null },
    ]);
    const guard = new DunningLockoutGuard(prisma);
    await expect(guard.canActivate(makeCtx('/api/v1/workouts', 'u1'))).resolves.toBe(true);
    const where = prisma.clientPurchase.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ not: 'p1' });
    expect(where.entitlement_active).toBe(true);
  });

  it('still locks when the only other purchase is itself locked', async () => {
    const prisma = makePrismaStub({ id: 'd1', purchase_id: 'p1' }, [
      { id: 'p2', dunning: { status: 'active', locked_out_at: new Date() } },
    ]);
    const guard = new DunningLockoutGuard(prisma);
    await expect(guard.canActivate(makeCtx('/api/v1/workouts', 'u1'))).rejects.toMatchObject({
      response: expect.objectContaining({ code: LOCKED_DUNNING_CODE }),
    });
  });

  it('every LOCKED_DUNNING body carries a stable code and a human message with a next action', async () => {
    const prisma = makePrismaStub({ id: 'd1', purchase_id: 'p1' });
    const guard = new DunningLockoutGuard(prisma);
    const err = await guard.canActivate(makeCtx('/api/v1/workouts', 'u1')).then(
      () => null,
      (e: unknown) => e,
    );
    const body = (err as { response: { code: string; message: string } }).response;
    expect(body.code).toBe('LOCKED_DUNNING');
    expect(body.message).toMatch(/Update your payment/);
    expect(body.message).not.toMatch(/!/);
  });
});
