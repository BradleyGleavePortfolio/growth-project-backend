import 'reflect-metadata';
import { CoachBillingController } from '../src/billing/coach-billing.controller';
import { MobileCoachBillingController } from '../src/billing/mobile-coach-billing.controller';
import { OwnerBillingController } from '../src/billing/owner-billing.controller';
import { ConnectController } from '../src/connect/connect.controller';

// B2 / B3 / B8 — assert each Stripe-write route carries an explicit
// @Throttle({ default: { ttl: 60_000, limit: 10 } }). The @nestjs/throttler
// decorator stores per-bucket metadata under `THROTTLER:LIMIT<name>` /
// `THROTTLER:TTL<name>`; for the unnamed `default` bucket the suffix is
// "default".
const LIMIT_KEY = 'THROTTLER:LIMITdefault';
const TTL_KEY = 'THROTTLER:TTLdefault';

function throttle(handler: (...args: any[]) => any) {
  return {
    limit: Reflect.getMetadata(LIMIT_KEY, handler) as number,
    ttl: Reflect.getMetadata(TTL_KEY, handler) as number,
  };
}

describe('Stripe-write @Throttle metadata', () => {
  it('B2 — CoachBillingController.portalSession is throttled 10/min', () => {
    expect(throttle(CoachBillingController.prototype.portalSession)).toEqual({
      limit: 10,
      ttl: 60_000,
    });
  });

  it('B2 — MobileCoachBillingController.portalSession is throttled 10/min', () => {
    expect(
      throttle(MobileCoachBillingController.prototype.portalSession),
    ).toEqual({ limit: 10, ttl: 60_000 });
  });

  it('B3 — OwnerBillingController.startSubscription is throttled 10/min', () => {
    expect(
      throttle(OwnerBillingController.prototype.startSubscription),
    ).toEqual({ limit: 10, ttl: 60_000 });
  });

  it('B8 — ConnectController.onboardingLink is throttled 10/min', () => {
    expect(throttle(ConnectController.prototype.onboardingLink)).toEqual({
      limit: 10,
      ttl: 60_000,
    });
  });

  it('B8 — ConnectController.dashboardLink is throttled 10/min', () => {
    expect(throttle(ConnectController.prototype.dashboardLink)).toEqual({
      limit: 10,
      ttl: 60_000,
    });
  });
});
