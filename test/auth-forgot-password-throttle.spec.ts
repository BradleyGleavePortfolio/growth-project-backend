import { APP_GUARD } from '@nestjs/core';
import { AuthController } from '../src/auth/auth.controller';
import { AppModule } from '../src/app.module';
import { UserThrottlerGuard } from '../src/throttler/user-throttler.guard';
import {
  THROTTLER_LIMITS,
  THROTTLER_NAMES,
} from '../src/throttler/throttler.config';

// Audit S-1: POST /auth/forgot-password must be throttled at 3 requests per
// hour per IP. Phase 10 routes this through the named throttler
// `auth-password-reset` (see src/throttler/throttler.config.ts) so operators
// can adjust the limit via AUTH_PWD_RESET_PER_HOUR env var.

const NAME = THROTTLER_NAMES.AUTH_PASSWORD_RESET;

describe('POST /auth/forgot-password throttle (audit S-1)', () => {
  it(`declares @Throttle({ '${NAME}': { limit: 3, ttl: 3600000 } }) on the handler`, () => {
    const handler = AuthController.prototype.forgotPassword;
    const limit = Reflect.getMetadata(`THROTTLER:LIMIT${NAME}`, handler) as number;
    const ttl = Reflect.getMetadata(`THROTTLER:TTL${NAME}`, handler) as number;
    expect(limit).toBe(3);
    expect(ttl).toBe(3_600_000);
  });

  it('3 requests / 1 hour is strictly tighter than the named default bucket (rate-per-sec)', () => {
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
