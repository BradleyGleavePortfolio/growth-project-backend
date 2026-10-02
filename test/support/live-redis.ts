// Live-Redis harness for throttler storage tests (Sol SOL-C13-A2 / SOL-C14-B1).
//
// The throttler's production backend is @nest-lab/throttler-storage-redis
// running a Lua script on a real Redis, wrapped by withFailOpenStorage. A
// mock cannot reproduce that script's overflow / PX semantics, so these
// suites talk to a real server. CI's build-and-test job starts a `redis`
// service and sets THROTTLER_LIVE_REDIS_URL; a CI run without it FAILS
// rather than silently skipping. Locally the suites skip when no URL is set.
import Redis from 'ioredis';

export const LIVE_REDIS_URL = (process.env.THROTTLER_LIVE_REDIS_URL ?? '').trim();

export function describeLiveRedis(name: string, fn: () => void): void {
  if (LIVE_REDIS_URL) {
    describe(name, fn);
    return;
  }
  if ((process.env.CI ?? '').toLowerCase() === 'true') {
    describe(name, () => {
      it('requires THROTTLER_LIVE_REDIS_URL in CI (refusing to skip a live-storage proof)', () => {
        throw new Error('THROTTLER_LIVE_REDIS_URL is not set in CI; the live Redis service is missing');
      });
    });
    return;
  }
  describe.skip(`${name} (skipped locally: THROTTLER_LIVE_REDIS_URL unset)`, fn);
}

export function liveRedisClient(): Redis {
  return new Redis(LIVE_REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: true, lazyConnect: false });
}
