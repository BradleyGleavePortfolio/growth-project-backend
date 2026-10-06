import { HttpException, HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ClientEntitlementGuard } from '../../../common/guards/client-entitlement.guard';
import { VoicePolicyService } from '../voice-policy.service';
import { LEGACY, ROMAN_V2 } from '../voice-policy.constants';
import { FEATURE_ROMAN_COPY_V2_ENV } from '../voice-policy.feature';

/**
 * Roman Phase 2 — integration: the paywall surface (ClientEntitlementGuard's
 * 402 PAYMENT_REQUIRED body) routes through VoicePolicyService.
 *
 *   - FEATURE_ROMAN_COPY_V2 OFF → the 402 body is byte-for-byte the pre-Phase-2
 *     response: { error, message, action } with the original message and NO
 *     avatar_crop. [unchanged behaviour]
 *   - FEATURE_ROMAN_COPY_V2 ON  → the 402 body carries the ROMAN_V2 paywall copy
 *     as `message` plus avatar_crop="neutral" (money surface, never "smile").
 *
 * The guard is constructed directly with a fake Prisma (no entitlement found, so
 * the guard always reaches the 402 throw), a stub Reflector (route not skipped),
 * and a real VoicePolicyService so the assertion exercises the true policy.
 */

const LEGACY_PAYWALL_MESSAGE =
  'An active package is required to access this feature.';

// Prisma stub: clientPurchase.findFirst returns null → no active entitlement →
// the guard always throws the 402. select arg is irrelevant to the stub.
const fakePrisma = {
  clientPurchase: {
    findFirst: async () => null,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// Reflector stub: never marks the route as skip-entitlement.
const fakeReflector = {
  getAllAndOverride: () => false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function studentContext(): ExecutionContext {
  const request = { user: { id: 'student_1', role: 'student' } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function capturePaywall402(
  guard: ClientEntitlementGuard,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await guard.canActivate(studentContext());
    throw new Error('expected guard to throw 402, but it returned');
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    return {
      status: err.getStatus(),
      body: err.getResponse() as Record<string, unknown>,
    };
  }
}

describe('ClientEntitlementGuard → VoicePolicyService (Phase 2 paywall copy)', () => {
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    prev[FEATURE_ROMAN_COPY_V2_ENV] = process.env[FEATURE_ROMAN_COPY_V2_ENV];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('flag OFF → 402 body is the legacy paywall response, no avatar_crop', async () => {
    delete process.env[FEATURE_ROMAN_COPY_V2_ENV];
    const guard = new ClientEntitlementGuard(
      fakePrisma,
      fakeReflector,
      new VoicePolicyService(),
    );
    const { status, body } = await capturePaywall402(guard);
    expect(status).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(body).toEqual({
      error: 'CLIENT_ENTITLEMENT_REQUIRED',
      message: LEGACY_PAYWALL_MESSAGE,
      action: 'OPEN_PLANS',
    });
    expect(body.avatar_crop).toBeUndefined();
    // Defence in depth: the legacy message must not leak the Roman variant.
    expect(body.message).not.toBe(ROMAN_V2.paywall);
  });

  it('flag OFF + no VoicePolicyService wired → identical legacy 402 body', async () => {
    delete process.env[FEATURE_ROMAN_COPY_V2_ENV];
    const guard = new ClientEntitlementGuard(fakePrisma, fakeReflector);
    const { status, body } = await capturePaywall402(guard);
    expect(status).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(body).toEqual({
      error: 'CLIENT_ENTITLEMENT_REQUIRED',
      message: LEGACY_PAYWALL_MESSAGE,
      action: 'OPEN_PLANS',
    });
    expect(body.avatar_crop).toBeUndefined();
  });

  it('flag ON → 402 body carries the Roman paywall copy + neutral avatar', async () => {
    process.env[FEATURE_ROMAN_COPY_V2_ENV] = 'true';
    const guard = new ClientEntitlementGuard(
      fakePrisma,
      fakeReflector,
      new VoicePolicyService(),
    );
    const { status, body } = await capturePaywall402(guard);
    expect(status).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(body.error).toBe('CLIENT_ENTITLEMENT_REQUIRED');
    expect(body.action).toBe('OPEN_PLANS');
    expect(body.message).toBe(ROMAN_V2.paywall);
    // Money surface — never "smile".
    expect(body.avatar_crop).toBe('neutral');
    // And it must not be the legacy string when the flag is ON.
    expect(body.message).not.toBe(LEGACY.paywall);
    expect(body.message).not.toBe(LEGACY_PAYWALL_MESSAGE);
  });

  it('flag ON paywall copy obeys the Roman voice lint (no "!" in message)', async () => {
    process.env[FEATURE_ROMAN_COPY_V2_ENV] = 'true';
    const guard = new ClientEntitlementGuard(
      fakePrisma,
      fakeReflector,
      new VoicePolicyService(),
    );
    const { body } = await capturePaywall402(guard);
    expect(String(body.message)).not.toContain('!');
  });
});
