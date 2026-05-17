import { Logger } from '@nestjs/common';
import { ThrottlerModuleOptions } from '@nestjs/throttler';

// Named throttler limits applied across the API.
//
// Design principles:
// - Per-user buckets (not per-IP) for authenticated routes. Avoids shared-NAT
//   lockout (offices, campus Wi-Fi, carrier CGNAT) while keeping per-user
//   fairness. UserThrottlerGuard switches the tracker key automatically.
// - Per-IP buckets for unauthenticated surfaces (auth endpoints) because there
//   is no user identity to key on yet.
// - Health check endpoints (/health, /healthz, /readyz) are whitelisted in
//   UserThrottlerGuard and NEVER count toward any bucket.
// - Successful login RESETS the auth-login counter so a real user on bad
//   WiFi (retry storms) is not locked out after the session is issued.
//
// Route surface                              | Throttler name          | Limit
// ------------------------------------------|-------------------------|------------------------
// Global authenticated default              | default                 | RATELIMIT_AUTHED_PER_MIN / min
// Global unauthenticated default            | default                 | RATELIMIT_ANON_PER_MIN / min
// POST /auth/login                          | auth-login-per-min      | AUTH_LOGIN_PER_MIN / min (IP)
//                                           | auth-login-per-hour     | AUTH_LOGIN_PER_HOUR / hour (IP)
// POST /auth/apple                          | auth-login-per-min      | shared (IP)
//                                           | auth-login-per-hour     | shared (IP)
// POST /auth/google                         | auth-login-per-min      | shared (IP)
//                                           | auth-login-per-hour     | shared (IP)
// POST /auth/forgot-password                | auth-password-reset     | AUTH_PWD_RESET_PER_HOUR / hour (IP)
// POST /auth/register                       | auth-signup             | 5 / hour (IP)
// POST /auth/signup-with-code               | auth-signup             | shared (IP)
// POST /coach/clients/:id/messages          | coach-messages          | COACH_MESSAGES_PER_MIN / min (user)
// PUT  /notifications/preferences           | notifications-prefs     | NOTIF_PREFS_PER_MIN / min (user)
// POST /bloodwork/:id                       | bloodwork-write         | BLOODWORK_WRITE_PER_MIN / min (user)
// GET  /coach/command-center/:path          | coach-command-center    | COACH_CMD_CENTER_PER_MIN / min (user)
// POST /diagnostic/submit                   | diagnostic-submit       | DIAGNOSTIC_RATE_LIMIT_PER_HOUR / hour (IP)
// POST /v1/checkout/sessions               | checkout-mint           | CHECKOUT_MINT_PER_HOUR / hour (user)
// POST /v1/checkout/payment-intent         | checkout-mint           | shared

export const THROTTLER_NAMES = {
  /** Per-minute hard cap on login attempts per IP (credential stuffing brake). */
  AUTH_LOGIN_PER_MIN: 'auth-login-per-min',
  /** Per-hour rolling cap on login attempts per IP (sustained attack brake). */
  AUTH_LOGIN_PER_HOUR: 'auth-login-per-hour',
  /** Per-hour cap on password-reset requests — keyed by IP, future: by email. */
  AUTH_PASSWORD_RESET: 'auth-password-reset',
  /** Per-hour cap on signup attempts per IP. */
  AUTH_SIGNUP: 'auth-signup',
  /** Per-minute cap on coach->client messages per user. */
  COACH_MESSAGES: 'coach-messages',
  /** Per-minute cap on notification-preference writes per user. */
  NOTIFICATIONS_PREFS: 'notifications-prefs',
  /** Per-minute cap on bloodwork writes per user. */
  BLOODWORK_WRITE: 'bloodwork-write',
  /** Per-minute cap on coach command-center reads per user. */
  COACH_COMMAND_CENTER: 'coach-command-center',
  /** Per-hour diagnostic submit cap per IP. */
  DIAGNOSTIC_SUBMIT: 'diagnostic-submit',
  /** Per-hour cap on checkout session / payment-intent minting per user.
   *  Prevents a compromised client account from spam-minting Stripe sessions. */
  CHECKOUT_MINT: 'checkout-mint',
  /** Catch-all: every route that carries no explicit @Throttle decorator. */
  DEFAULT: 'default',
} as const;

// ---------------------------------------------------------------------------
// Env-var parsing helpers. All values are clamped to sane ranges so a
// misconfigured env cannot accidentally open a DoS window or lock all users
// out. Each helper reads once at module-load time (safe: process.env is
// populated before the module is evaluated).
// ---------------------------------------------------------------------------

function readIntEnv(name: string, defaultVal: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.min(Math.max(n, min), max);
}

// Global defaults
const RATELIMIT_AUTHED_PER_MIN  = readIntEnv('RATELIMIT_AUTHED_PER_MIN', 300, 1, 10_000);
const RATELIMIT_ANON_PER_MIN    = readIntEnv('RATELIMIT_ANON_PER_MIN',   100, 1, 10_000);

// Auth route overrides
const AUTH_LOGIN_PER_MIN        = readIntEnv('AUTH_LOGIN_PER_MIN',    5,   1, 1_000);
const AUTH_LOGIN_PER_HOUR       = readIntEnv('AUTH_LOGIN_PER_HOUR',  30,   1, 5_000);
const AUTH_PWD_RESET_PER_HOUR   = readIntEnv('AUTH_PWD_RESET_PER_HOUR', 3, 1, 1_000);

// Route-level overrides for write-heavy endpoints
const COACH_MESSAGES_PER_MIN    = readIntEnv('COACH_MESSAGES_PER_MIN',  30,  1, 1_000);
const NOTIF_PREFS_PER_MIN       = readIntEnv('NOTIF_PREFS_PER_MIN',     30,  1, 1_000);
const BLOODWORK_WRITE_PER_MIN   = readIntEnv('BLOODWORK_WRITE_PER_MIN', 30,  1, 1_000);
const COACH_CMD_CENTER_PER_MIN  = readIntEnv('COACH_CMD_CENTER_PER_MIN', 60, 1, 1_000);

// Diagnostic submit (unauthenticated lead-capture endpoint)
const DIAGNOSTIC_RATE_LIMIT_PER_HOUR = readIntEnv('DIAGNOSTIC_RATE_LIMIT_PER_HOUR', 5, 1, 1_000);

// Checkout minting: per-user, per-hour. 20/hr is generous for normal clients
// (nobody buys 20 packages in an hour) but stops automated abuse from a
// compromised account spinning up Stripe sessions in a loop.
const CHECKOUT_MINT_PER_HOUR = readIntEnv('CHECKOUT_MINT_PER_HOUR', 20, 1, 500);

// Export per-route constants so controllers can reference them for @Throttle
// decorators without repeating magic numbers inline.
export const THROTTLER_ROUTE_LIMITS = {
  AUTH_LOGIN_PER_MIN,
  AUTH_LOGIN_PER_HOUR,
  AUTH_PWD_RESET_PER_HOUR,
  COACH_MESSAGES_PER_MIN,
  NOTIF_PREFS_PER_MIN,
  BLOODWORK_WRITE_PER_MIN,
  COACH_CMD_CENTER_PER_MIN,
  RATELIMIT_AUTHED_PER_MIN,
  RATELIMIT_ANON_PER_MIN,
  CHECKOUT_MINT_PER_HOUR,
} as const;

export const THROTTLER_LIMITS = [
  // Per-minute login limit (IP-keyed -- shared by login/apple/google)
  { name: THROTTLER_NAMES.AUTH_LOGIN_PER_MIN,  ttl: 60_000,       limit: AUTH_LOGIN_PER_MIN  },
  // Per-hour login limit (IP-keyed -- sustained-attack brake)
  { name: THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR, ttl: 3_600_000,    limit: AUTH_LOGIN_PER_HOUR },
  // Password-reset: 3/hour by default, keyed by IP
  { name: THROTTLER_NAMES.AUTH_PASSWORD_RESET, ttl: 3_600_000,    limit: AUTH_PWD_RESET_PER_HOUR },
  // Signup: 5/hour/IP (unchanged from original)
  { name: THROTTLER_NAMES.AUTH_SIGNUP,         ttl: 3_600_000,    limit: 5 },
  // Coach messages: 30/min/user
  { name: THROTTLER_NAMES.COACH_MESSAGES,      ttl: 60_000,       limit: COACH_MESSAGES_PER_MIN },
  // Notification preferences: 30/min/user
  { name: THROTTLER_NAMES.NOTIFICATIONS_PREFS, ttl: 60_000,       limit: NOTIF_PREFS_PER_MIN },
  // Bloodwork writes: 30/min/user
  { name: THROTTLER_NAMES.BLOODWORK_WRITE,     ttl: 60_000,       limit: BLOODWORK_WRITE_PER_MIN },
  // Coach command-center reads: 60/min/user
  { name: THROTTLER_NAMES.COACH_COMMAND_CENTER, ttl: 60_000,      limit: COACH_CMD_CENTER_PER_MIN },
  // Diagnostic submit: 5/hour/IP
  { name: THROTTLER_NAMES.DIAGNOSTIC_SUBMIT,   ttl: 3_600_000,    limit: DIAGNOSTIC_RATE_LIMIT_PER_HOUR },
  // Checkout minting: 20/hour/user
  { name: THROTTLER_NAMES.CHECKOUT_MINT,       ttl: 3_600_000,    limit: CHECKOUT_MINT_PER_HOUR },
  // Default catch-all: applies to every route that carries no explicit @Throttle decorator.
  // The guard in getTracker() buckets authed requests by user-id (300/min) and
  // unauthenticated requests by IP (100/min). Both share this one named throttler;
  // the differentiation is in the tracker key, not the limit.
  //
  // IMPORTANT: Public (@Public()) endpoints that have no dedicated throttler name
  // MUST carry an explicit @Throttle({ default: { ttl: 60_000, limit: 100 } })
  // decorator so they are bounded by the anonymous per-IP limit (100/min) rather
  // than the more permissive authenticated limit (300/min). Without an explicit
  // decorator the default catch-all uses Math.max(authed, anon) which may be
  // higher than desired for unauthenticated surfaces.
  { name: THROTTLER_NAMES.DEFAULT,             ttl: 60_000,       limit: Math.max(RATELIMIT_AUTHED_PER_MIN, RATELIMIT_ANON_PER_MIN) },
] as const;

/**
 * Build ThrottlerModule options. When REDIS_URL is set we lazily import
 * ioredis and the redis storage adapter and wire them as the throttler's
 * shared backend; when unset we return only `throttlers`, and
 * ThrottlerModule defaults to its built-in in-memory tracker.
 *
 * The dynamic import keeps `ioredis` out of the boot path for dev/test
 * runs that never construct a Redis client.
 *
 * RATELIMIT_ENABLED=off completely disables all throttling (useful for
 * load-test runs against staging). Defaults to on.
 */
export async function buildThrottlerOptions(
  redisUrl: string | undefined,
  logger: Logger = new Logger('ThrottlerConfig'),
): Promise<ThrottlerModuleOptions> {
  const throttlers = THROTTLER_LIMITS.map((t) => ({ ...t }));

  if (!redisUrl || redisUrl.trim().length === 0) {
    // Production refuses to boot without a shared throttler backend: an
    // in-memory tracker on a multi-machine Fly deploy makes rate limits
    // useless (every machine has its own counter), and credential-stuffing
    // attacks routinely fan out across machines. Dev/test keep the
    // in-memory fallback so contributors don't need a local Redis.
    // See README's "Placeholders / TODO env vars" section for REDIS_URL.
    if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production') {
      throw new Error(
        'REDIS_URL is required in production. Set REDIS_URL=redis(s)://host:port[/db] before deploy. ' +
          'See README.md "Placeholders / TODO env vars" section for the canonical reference.',
      );
    }
    logger.log(
      'REDIS_URL not set -- using in-memory throttler tracker. Limits do NOT cross Fly machines.',
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
    // Background reconnects keep failures isolated to the throttler.
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

  // Surface the host so operators can confirm the correct Redis instance is
  // wired up after `fly secrets set REDIS_URL=... && fly deploy`.
  const redisHost = (() => {
    try {
      return new URL(redisUrl).hostname;
    } catch {
      return redisUrl;
    }
  })();
  logger.log(`Throttler using Redis store at ${redisHost}`);

  return {
    throttlers,
    storage: new (ThrottlerStorageRedisService as any)(client),
  };
}