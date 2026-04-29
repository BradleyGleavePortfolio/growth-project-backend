import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthController } from '../src/auth/auth.controller';
import { AppModule } from '../src/app.module';

// Audit S-1: POST /auth/forgot-password must be throttled at 5 requests per
// 15 minutes per IP. There are two pieces to verify:
//
//   1. The handler carries the expected @Throttle metadata.
//      The global ThrottlerGuard (registered as APP_GUARD in app.module.ts,
//      see throttler.module.spec.ts) reads exactly this metadata at request
//      time, so getting the numbers right here is the load-bearing piece —
//      anything else would be testing @nestjs/throttler's internals.
//   2. ThrottlerGuard is bound globally so the @Throttle metadata above is
//      actually consulted on every request. We re-assert it here so a
//      regression to either side breaks this spec, not just the wiring spec.

describe('POST /auth/forgot-password throttle (audit S-1)', () => {
  it('declares @Throttle({ default: { limit: 5, ttl: 900000 } }) on the handler', () => {
    const handler = AuthController.prototype.forgotPassword as any;
    // @nestjs/throttler stores per-name metadata under "THROTTLER:LIMIT<name>"
    // and "THROTTLER:TTL<name>". The default tracker name is "default".
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', handler);
    const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', handler);
    expect(limit).toBe(5);
    expect(ttl).toBe(900_000);
  });

  it('5 requests / 15 min is strictly tighter than the global default', () => {
    // The global default is 100 requests / 60s (see app.module.ts), i.e.
    // ~1.67/s. The route-level decorator must be tighter on both axes
    // otherwise it is a no-op and audit S-1 would not actually be fixed.
    const handler = AuthController.prototype.forgotPassword as any;
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', handler);
    const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', handler);
    const ratePerSec = limit / (ttl / 1000);
    expect(ratePerSec).toBeLessThan(100 / 60);
  });

  it('relies on a globally-registered ThrottlerGuard (APP_GUARD)', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as any[];
    const guardProvider = providers.find(
      (p: any) =>
        p && typeof p === 'object' && p.provide === APP_GUARD && p.useClass === ThrottlerGuard,
    );
    expect(guardProvider).toBeDefined();
  });
});
