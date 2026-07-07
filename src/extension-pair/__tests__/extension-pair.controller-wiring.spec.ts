// Decorator-wiring guards. These invariants are security-critical and easy to
// break by an innocent-looking refactor, so we pin them with metadata reflection
// rather than trusting review:
//   - every route sits behind the feature-flag guard (off ⇒ 404, surface hidden);
//   - init + status stay coach-gated (mobile-authenticated coach only);
//   - redeem stays @Public (extension bootstrap has no JWT) AND rate-limited
//     (the only brute-force brake over the 6-digit space).
import 'reflect-metadata';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { CoachGuard } from '../../auth/coach.guard';
import { ExtensionPairController } from '../extension-pair.controller';
import { ExtensionPairingFeatureFlagGuard } from '../extension-pair-feature-flag.guard';

// Nest stores @UseGuards targets under the '__guards__' metadata key, at the
// class for class-level guards and at the handler for method-level guards.
function guardsOn(target: object): unknown[] {
  return (Reflect.getMetadata('__guards__', target) as unknown[]) ?? [];
}

// @nestjs/throttler stores per-bucket metadata under `THROTTLER:LIMIT<name>` /
// `THROTTLER:TTL<name>`; the DEFAULT bucket's suffix is "default" (see
// src/regimes/__tests__/regimes-throttle-metadata.spec.ts).
const THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_KEY = 'THROTTLER:TTLdefault';

describe('ExtensionPairController wiring', () => {
  it('gates the whole controller behind the feature-flag guard', () => {
    const classGuards = guardsOn(ExtensionPairController);
    expect(classGuards).toContain(ExtensionPairingFeatureFlagGuard);
  });

  it('keeps init coach-gated', () => {
    const handlerGuards = guardsOn(ExtensionPairController.prototype.init);
    expect(handlerGuards).toContain(CoachGuard);
  });

  it('keeps status coach-gated', () => {
    const handlerGuards = guardsOn(ExtensionPairController.prototype.status);
    expect(handlerGuards).toContain(CoachGuard);
  });

  it('does NOT put a coach guard on redeem (extension bootstrap is unauthenticated)', () => {
    const handlerGuards = guardsOn(ExtensionPairController.prototype.redeem);
    expect(handlerGuards).not.toContain(CoachGuard);
  });

  it('marks redeem @Public so the global JwtAuthGuard skips it', () => {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ExtensionPairController.prototype.redeem);
    expect(isPublic).toBe(true);
  });

  it('does NOT mark init or status public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, ExtensionPairController.prototype.init)).toBeFalsy();
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, ExtensionPairController.prototype.status),
    ).toBeFalsy();
  });

  it('rate-limits redeem at the default 10/min per IP', () => {
    const limit = Reflect.getMetadata(THROTTLE_LIMIT_KEY, ExtensionPairController.prototype.redeem);
    const ttl = Reflect.getMetadata(THROTTLE_TTL_KEY, ExtensionPairController.prototype.redeem);
    expect(limit).toBe(10);
    expect(ttl).toBe(60_000);
  });

  it('does NOT rate-limit init or status (only the public redeem needs it)', () => {
    for (const handler of [
      ExtensionPairController.prototype.init,
      ExtensionPairController.prototype.status,
    ]) {
      expect(Reflect.getMetadata(THROTTLE_LIMIT_KEY, handler)).toBeUndefined();
    }
  });
});
