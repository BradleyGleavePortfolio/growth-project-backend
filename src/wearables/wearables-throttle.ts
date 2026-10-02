import { THROTTLER_NAMES } from '../throttler/throttler.config';

/**
 * S14 (audit B-623-1) — throttler ISOLATION for the on-device wearables path.
 *
 * NestJS Throttler evaluates EVERY globally registered named throttler
 * (`THROTTLER_LIMITS`) against EVERY request. A route that only declares a
 * `default` override still falls through to each other throttler's GLOBAL
 * baseline, so `auth-password-reset` (3/hour), `auth-signup` (5/hour) and
 * `auth-recent-auth` (5/min) were also governing ingest and capped a history
 * import at 3 requests per hour.
 *
 * The wearables routes below are governed by EXACTLY one throttler: the
 * per-user `default` bucket with the route's own explicit limit (the
 * UserThrottlerGuard tracker keys authenticated requests by user id, and the
 * storage key includes controller + handler, so each route has its own
 * per-user counter). Every OTHER named throttler is skipped. The skip map is
 * derived from THROTTLER_NAMES so a throttler added later is skipped here by
 * default instead of silently lowering these ceilings. Mirrors the storefront
 * join precedent (`STOREFRONT_JOIN_SKIP_THROTTLERS`). Auth routes keep their
 * own buckets; nothing in the global config changes.
 */
export const WEARABLES_SKIP_THROTTLERS: Readonly<Record<string, boolean>> = Object.freeze(
  Object.values(THROTTLER_NAMES)
    .filter((name) => name !== THROTTLER_NAMES.DEFAULT)
    .reduce<Record<string, boolean>>((acc, name) => {
      acc[name] = true;
      return acc;
    }, {}),
);

/** Sample ingest: 60 requests / 60 s per user (a 30-day import is batched). */
export const WEARABLES_INGEST_PER_MIN = 60;
/** Sample reads for the Health and Sleep views: 60 / 60 s per user. */
export const WEARABLES_READ_PER_MIN = 60;
/** On-device source registration: 10 / 60 s per user. */
export const WEARABLES_ON_DEVICE_REGISTER_PER_MIN = 10;
/** Connection list read: 60 / 60 s per user. */
export const WEARABLES_CONNECTIONS_LIST_PER_MIN = 60;
