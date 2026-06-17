/**
 * F6 (R79) — regime/refund write-route @Throttle metadata pin.
 *
 * PR #403 (F4) added @Throttle decorators to the financial/regime write
 * handlers, but nothing pinned them, so a future refactor that drops a
 * decorator would silently widen the rate-limit surface. This focused spec
 * makes the per-handler throttle contract EXPLICIT and local, matching the
 * established repo pattern in test/billing-throttle-metadata.spec.ts.
 *
 * The @nestjs/throttler decorator stores per-bucket metadata under
 * `THROTTLER:LIMIT<name>` / `THROTTLER:TTL<name>`; for the unnamed `default`
 * bucket the suffix is "default" (see billing-throttle-metadata.spec.ts).
 *
 * Pinned contracts (source: src/regimes/refund-decisions.controller.ts:50,
 * src/regimes/regimes.controller.ts:65/82/94):
 *   - RefundDecisionsController.decide  → 10/min  (stricter financial-write)
 *   - RegimesController.promote/update/archive → 30/min (general write-route)
 */

import 'reflect-metadata';
import { RefundDecisionsController } from '../refund-decisions.controller';
import { RegimesController } from '../regimes.controller';

const LIMIT_KEY = 'THROTTLER:LIMITdefault';
const TTL_KEY = 'THROTTLER:TTLdefault';

function throttle(handler: (...args: any[]) => any) {
  return {
    limit: Reflect.getMetadata(LIMIT_KEY, handler) as number,
    ttl: Reflect.getMetadata(TTL_KEY, handler) as number,
  };
}

describe('F6 regimes/refund — write-route @Throttle metadata pin', () => {
  it('RefundDecisionsController.decide is throttled 10/min', () => {
    expect(throttle(RefundDecisionsController.prototype.decide)).toEqual({
      limit: 10,
      ttl: 60000,
    });
  });

  it('RegimesController.promote is throttled 30/min', () => {
    expect(throttle(RegimesController.prototype.promote)).toEqual({
      limit: 30,
      ttl: 60000,
    });
  });

  it('RegimesController.update is throttled 30/min', () => {
    expect(throttle(RegimesController.prototype.update)).toEqual({
      limit: 30,
      ttl: 60000,
    });
  });

  it('RegimesController.archive is throttled 30/min', () => {
    expect(throttle(RegimesController.prototype.archive)).toEqual({
      limit: 30,
      ttl: 60000,
    });
  });
});
