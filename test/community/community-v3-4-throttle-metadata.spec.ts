/**
 * F3 (R79) — community v3-4 (search + wearable-prompts) @Throttle metadata pin.
 *
 * PR #399's R81 cleanup (F3) added @Throttle decorators to the v3-4 community
 * read/write handlers that were missing one, but a decorator alone is invisible
 * to the type-checker — a future refactor that drops one would silently widen
 * the rate-limit surface (the exact lesson from PR #403). This focused spec
 * makes the per-handler throttle contract EXPLICIT and local, matching the
 * established repo pattern in test/billing-throttle-metadata.spec.ts and
 * src/regimes/__tests__/regimes-throttle-metadata.spec.ts.
 *
 * The @nestjs/throttler decorator stores per-bucket metadata under
 * `THROTTLER:LIMIT<name>` / `THROTTLER:TTL<name>`; for the unnamed `default`
 * bucket the suffix is "default".
 *
 * Pinned contracts (source: PR #399 audit F3 + throttler.config.ts):
 *   - CommunitySearchController.reindex            → COMMUNITY_POSTS_PER_MIN
 *   - CommunityWearablePromptsController.list      → COMMUNITY_READS_PER_MIN
 *   - CommunityWearablePromptsController.dismiss   → COMMUNITY_POSTS_PER_MIN
 *   - CommunityWearablePromptsController.actOn     → COMMUNITY_POSTS_PER_MIN
 *
 * The expected limits are read from THROTTLER_ROUTE_LIMITS (the single source of
 * truth, env-overridable) so this pins the WIRING, not a hard-coded number.
 */

import 'reflect-metadata';
import { CommunitySearchController } from '../../src/community/search/community-search.controller';
import { CommunityWearablePromptsController } from '../../src/community/wearable-prompts/wearable-prompts.controller';
import { THROTTLER_ROUTE_LIMITS } from '../../src/throttler/throttler.config';

const LIMIT_KEY = 'THROTTLER:LIMITdefault';
const TTL_KEY = 'THROTTLER:TTLdefault';

function throttle(handler: (...args: any[]) => any) {
  return {
    limit: Reflect.getMetadata(LIMIT_KEY, handler) as number,
    ttl: Reflect.getMetadata(TTL_KEY, handler) as number,
  };
}

describe('F3 community v3-4 — @Throttle metadata pin', () => {
  it('CommunitySearchController.reindex is throttled at the POSTS bucket', () => {
    expect(throttle(CommunitySearchController.prototype.reindex)).toEqual({
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN,
      ttl: 60_000,
    });
  });

  it('WearablePromptsController.list is throttled at the READS bucket', () => {
    expect(
      throttle(CommunityWearablePromptsController.prototype.list),
    ).toEqual({
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_READS_PER_MIN,
      ttl: 60_000,
    });
  });

  it('WearablePromptsController.dismiss is throttled at the POSTS bucket', () => {
    expect(
      throttle(CommunityWearablePromptsController.prototype.dismiss),
    ).toEqual({
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN,
      ttl: 60_000,
    });
  });

  it('WearablePromptsController.actOn is throttled at the POSTS bucket', () => {
    expect(
      throttle(CommunityWearablePromptsController.prototype.actOn),
    ).toEqual({
      limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN,
      ttl: 60_000,
    });
  });

  it('the READS bucket is a DISTINCT, observable limit from the POSTS bucket', () => {
    // F3 rationale: cost-amplifying reads get their own bucket so a read-flood
    // is throttled and observed separately from posts.
    expect(THROTTLER_ROUTE_LIMITS.COMMUNITY_READS_PER_MIN).not.toBe(
      THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN,
    );
  });
});
