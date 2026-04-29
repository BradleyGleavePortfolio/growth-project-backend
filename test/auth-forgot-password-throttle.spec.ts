import { APP_GUARD } from '@nestjs/core';
import { AuthController } from '../src/auth/auth.controller';
import { AppModule } from '../src/app.module';
import { UserThrottlerGuard } from '../src/throttler/user-throttler.guard';
import {
  THROTTLER_LIMITS,
  THROTTLER_NAMES,
} from '../src/throttler/throttler.config';

// Audit S-1: POST /auth/forgot-password must be throttled at 5 requests per
// 15 minutes. Phase 2 routes this through the named throttler
// `auth-password-reset` (see src/throttler/throttler.config.ts) so operators
// can adjust the limit in one place. There are two pieces to verify:
//
//   1. The handler carries @Throttle metadata under the named bucket
//      `auth-password-reset` with the documented numbers. The global
//      UserThrottlerGuard (registered as APP_GUARD in app.module.ts) reads
//      exactly this metadata at request time.
//   2. UserThrottlerGuard is bound globally so the @Throttle metadata above
//      is actually consulted on every request.

const NAME = THROTTLER_NAMES.AUTH_PASSWORD_RESET;

describe('POST /auth/forgot-password throttle (audit S-1)', () => {
  it(`declares @Throttle({ '${NAME}': { limit: 5, ttl: 900000 } }) on the handler`, () => {
    const handler = AuthController.prototype.forgotPassword;
    const limit = Reflect.getMetadata(`THROTTLER:LIMIT${NAME}`, handler);
    const ttl = Reflect.getMetadata(`THROTTLER:TTL${NAME}`, handler);
    expect(limit).toBe(5);
    expect(ttl).toBe(900_000);
  });

  it('5 requests / 15 min is strictly tighter than the named default bucket', () => {
    // The named default bucket is 60 requests / 60s (see throttler.config.ts),
    // i.e. 1/s. The route-level decorator must be tighter so the handler
    // cannot be hammered up to the default bucket's headroom.
    const handler = AuthController.prototype.forgotPassword;
    const limit = Reflect.getMetadata(`THROTTLER:LIMIT${NAME}`, handler) as number;
    const ttl = Reflect.getMetadata(`THROTTLER:TTL${NAME}`, handler) as number;
    const ratePerSec = limit / (ttl / 1000);
    const defaultBucket = THROTTLER_LIMITS.find((t) => t.name === THROTTLER_NAMES.DEFAULT);
    expect(defaultBucket).toBeDefined();
    const defaultRatePerSec = (defaultBucket as { limit: number; ttl: number }).limit /
      ((defaultBucket as { limit: number; ttl: number }).ttl / 1000);
    expect(ratePerSec).toBeLessThan(defaultRatePerSec);
  });

  it('relies on a globally-registered UserThrottlerGuard (APP_GUARD)', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    const guardProvider = providers.find(
      (p) =>
        p && typeof p === 'object' && p.provide === APP_GUARD && p.useClass === UserThrottlerGuard,
    );
    expect(guardProvider).toBeDefined();
  });
});
