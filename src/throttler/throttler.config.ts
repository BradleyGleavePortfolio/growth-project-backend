import { Logger } from '@nestjs/common';
import { ThrottlerModuleOptions } from '@nestjs/throttler';

/**
 * Named throttler limits applied across the API. Limits are intentionally
 * tighter than the global default for endpoints that are common targets
 * for credential stuffing, signup-spam, and password-reset abuse.
 *
 * Surface         | Limit               | Tracker
 * ----------------|---------------------|---------
 * auth-login      | 10 / minute         | user-id when authed, IP otherwise
 * auth-signup     | 5 / hour            | user-id when authed, IP otherwise
 * auth-password-  | 5 / 15 minutes      | user-id when authed, IP otherwise
 *   reset         |                     |
 * diagnostic-     | 5 / hour (override  | IP (unauthed by definition)
 *   submit        |   via env var)      |
 * default         | 60 / minute         | user-id when authed, IP otherwise
 *
 * The `default` throttler is consulted whenever a route does not name a
 * specific throttler — it doubles as the per-user fairness floor.
 */
export const THROTTLER_NAMES = {
  AUTH_LOGIN: 'auth-login',
  AUTH_SIGNUP: 'auth-signup',
  AUTH_PASSWORD_RESET: 'auth-password-reset',
  DIAGNOSTIC_SUBMIT: 'diagnostic-submit',
  DEFAULT: 'default',
} as const;

// `diagnostic-submit`: 5/hour/IP by default. The endpoint is unauthenticated
// (lead capture) and an attacker could bulk-stuff submissions to seed the
// AI cost line; the limit is the primary defense. Operators can raise the
// cap with DIAGNOSTIC_RATE_LIMIT_PER_HOUR for high-traffic launches.
const DIAGNOSTIC_RATE_LIMIT_PER_HOUR = (() => {
  const raw = process.env.DIAGNOSTIC_RATE_LIMIT_PER_HOUR;
  if (!raw) return 5;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(n, 1000);
})();

export const THROTTLER_LIMITS = [
  { name: THROTTLER_NAMES.AUTH_LOGIN, ttl: 60_000, limit: 10 },
  { name: THROTTLER_NAMES.AUTH_SIGNUP, ttl: 3_600_000, limit: 5 },
  { name: THROTTLER_NAMES.AUTH_PASSWORD_RESET, ttl: 900_000, limit: 5 },
  { name: THROTTLER_NAMES.DIAGNOSTIC_SUBMIT, ttl: 3_600_000, limit: DIAGNOSTIC_RATE_LIMIT_PER_HOUR },
  { name: THROTTLER_NAMES.DEFAULT, ttl: 60_000, limit: 60 },
] as const;

/**
 * Build ThrottlerModule options. When REDIS_URL is set we lazily import
 * ioredis + the redis storage adapter and wire them as the throttler's
 * shared backend; when unset we return only `throttlers`, and
 * ThrottlerModule defaults to its built-in in-memory tracker.
 *
 * The dynamic import keeps `ioredis` out of the boot path for dev/test
 * runs that never construct a Redis client — Jest workers don't pay the
 * tcp-handshake/teardown tax, and `npm run start` in dev stays
 * fully self-contained.
 */
export async function buildThrottlerOptions(
  redisUrl: string | undefined,
  logger: Logger = new Logger('ThrottlerConfig'),
): Promise<ThrottlerModuleOptions> {
  const throttlers = THROTTLER_LIMITS.map((t) => ({ ...t }));

  if (!redisUrl || redisUrl.trim().length === 0) {
    logger.log(
      'REDIS_URL not set — using in-memory throttler tracker. Limits do NOT cross Fly machines.',
    );
    return { throttlers };
  }

  // Lazy import so dev/test never load ioredis.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { default: Redis } = await import('ioredis');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ThrottlerStorageRedisService } = await import(
    '@nest-lab/throttler-storage-redis'
  );

  const client = new (Redis as any)(redisUrl, {
    // Background reconnects keep failures isolated to the throttler — we'd
    // rather degrade open than reject every request when Redis blips.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  });

  client.on('error', (err: Error) => {
    logger.warn(`Redis throttler client error: ${err.message}`);
  });

  logger.log(
    `Redis throttler backend initialized (named throttlers: ${throttlers
      .map((t) => t.name)
      .join(', ')}).`,
  );

  return {
    throttlers,
    storage: new (ThrottlerStorageRedisService as any)(client),
  };
}
