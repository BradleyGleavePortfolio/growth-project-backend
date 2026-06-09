import { Logger } from '@nestjs/common';
import { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

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
// POST /coach/ai/workout-program           | coach-ai-generation     | 5 / hour (user)
// POST /coach/ai/meal-plan                 | coach-ai-generation     | 5 / hour (user)
// POST /coach/ai/client-insight            | coach-ai-generation     | 10 / hour (user)

export const THROTTLER_NAMES = {
  /** Per-minute hard cap on login attempts per IP (credential stuffing brake). */
  AUTH_LOGIN_PER_MIN: 'auth-login-per-min',
  /** Per-hour rolling cap on login attempts per IP (sustained attack brake). */
  AUTH_LOGIN_PER_HOUR: 'auth-login-per-hour',
  /** Per-hour cap on password-reset requests — keyed by IP, future: by email. */
  AUTH_PASSWORD_RESET: 'auth-password-reset',
  /** Per-hour cap on signup attempts per IP. */
  AUTH_SIGNUP: 'auth-signup',
  /** Per-minute cap on POST /auth/recent-auth-token (sensitive re-auth) per user/IP. */
  AUTH_RECENT_AUTH: 'auth-recent-auth',
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
  /** Stream 1 — per-minute cap on POST /coach/ai/credit-packs/checkout
   *  per user. Every call hits Stripe + creates a row in
   *  CoachCreditPackPurchase; tight bucket stops automated abuse without
   *  interfering with a real coach retrying on flaky network. */
  COACH_AI_CREDIT_PACK_CHECKOUT: 'coach-ai-credit-pack-checkout',
  /** Per-hour cap on coach AI generation endpoints (workout-program,
   *  meal-plan, client-insight). Each call hits Anthropic and costs real
   *  money, so we want this bucket to be independently observable and
   *  tunable from the global `default` bucket. Per-route limits are set
   *  inline on each handler's @Throttle decorator (workout/meal: 5/hr,
   *  client-insight: 10/hr). The named bucket itself just declares the
   *  baseline ttl/limit so the throttler module knows about it. */
  COACH_AI_GENERATION: 'coach-ai-generation',
  /** H4 #7 (token enumeration) — IP-WIDE second layer for the public
   *  storefront GET join/:token route. The `default` throttler on that
   *  route is keyed by the COMPOSITE (token, IP) tracker
   *  (`storefront-join:<token>:<ip>`), which gives every probed token its
   *  OWN 20/min bucket — so a single IP can still enumerate many distinct
   *  tokens cheaply (20 attempts EACH). This named throttler is applied on
   *  the GET join route with a custom IP-ONLY getTracker
   *  (`storefront-join-ip:<ip>`) so ALL distinct-token probes from one IP
   *  share a single budget, bounding enumeration across the whole token
   *  space while the composite layer keeps per-(token,IP) fairness.
   *
   *  IMPORTANT: the GLOBAL baseline limit below is intentionally very high
   *  (effectively non-biting). NestJS throttler evaluates every named
   *  throttler in this array against EVERY route, so a low baseline here
   *  would throttle unrelated routes. Only the GET join route opts into a
   *  tight ceiling via its route-level @Throttle override; all other
   *  routes fall through to this non-biting baseline AND use the guard's
   *  default tracker, so they are unaffected. */
  STOREFRONT_JOIN_IP: 'storefront-join-ip',
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

// Stream 1 — credit-pack checkout. Per-minute cap because the mobile UX
// retries on Stripe failures and we don't want to lock a real coach out
// for an hour. 5/min/user is plenty even for back-to-back custom amount
// tweaks; the bucket exists to stop automation, not friction the user.
const COACH_AI_CREDIT_PACK_CHECKOUT_PER_MIN = readIntEnv(
  'COACH_AI_CREDIT_PACK_CHECKOUT_PER_MIN',
  5,
  1,
  120,
);

// Community v1-3 write surfaces. Per-user, per-window caps on the abusable
// write paths (messages, posts, comments, DMs, reactions, moderation reports).
// Each is env-tunable and clamped so a misconfigured env cannot open a flood
// window. Rationale + windows are the audit table in the v1-3 builder brief.
const COMMUNITY_MESSAGES_PER_MIN  = readIntEnv('COMMUNITY_MESSAGES_PER_MIN',  30, 1, 1_000);
const COMMUNITY_MSG_EDIT_PER_MIN  = readIntEnv('COMMUNITY_MSG_EDIT_PER_MIN',  10, 1, 1_000);
const COMMUNITY_POSTS_PER_MIN     = readIntEnv('COMMUNITY_POSTS_PER_MIN',      5, 1, 1_000);
const COMMUNITY_COMMENTS_PER_MIN  = readIntEnv('COMMUNITY_COMMENTS_PER_MIN',  30, 1, 1_000);
const COMMUNITY_DM_PER_MIN        = readIntEnv('COMMUNITY_DM_PER_MIN',        30, 1, 1_000);
const COMMUNITY_REACTIONS_PER_MIN = readIntEnv('COMMUNITY_REACTIONS_PER_MIN', 60, 1, 1_000);
// Report-spam is itself abuse: 10 per 5-minute window.
const COMMUNITY_REPORTS_PER_5MIN  = readIntEnv('COMMUNITY_REPORTS_PER_5MIN',  10, 1, 1_000);

// H4 #7 — IP-WIDE ceiling for the public storefront GET join/:token route
// (the actual ceiling applied to that route via its route-level @Throttle).
// This bounds the TOTAL number of distinct-token join GETs a single source
// IP can make per minute, on top of the per-(token,IP) composite layer
// (20/min). 120/min is deliberately generous for legitimate shared-NAT
// traffic: up to ~6 distinct real buyers behind one CGNAT/office IP can each
// hit their own token's 20/min composite ceiling before the IP-wide layer
// bites, while an enumeration sweep is bounded to 120 distinct-token probes/
// min/IP instead of the previously-unbounded (one fresh bucket per token).
const STOREFRONT_JOIN_IP_PER_MIN = readIntEnv('STOREFRONT_JOIN_IP_PER_MIN', 120, 1, 5_000);

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
  COACH_AI_CREDIT_PACK_CHECKOUT_PER_MIN,
  STOREFRONT_JOIN_IP_PER_MIN,
  COMMUNITY_MESSAGES_PER_MIN,
  COMMUNITY_MSG_EDIT_PER_MIN,
  COMMUNITY_POSTS_PER_MIN,
  COMMUNITY_COMMENTS_PER_MIN,
  COMMUNITY_DM_PER_MIN,
  COMMUNITY_REACTIONS_PER_MIN,
  COMMUNITY_REPORTS_PER_5MIN,
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
  // Recent-auth token issuance: 5/min, per authenticated user (UserThrottlerGuard
  // keys by user id when a JWT is present, falling back to IP). Tighter than
  // /auth/login because it gates sensitive actions like account deletion.
  { name: THROTTLER_NAMES.AUTH_RECENT_AUTH,    ttl: 60_000,       limit: 5 },
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
  // Coach AI credit-pack checkout: 5/min/user (Stream 1)
  { name: THROTTLER_NAMES.COACH_AI_CREDIT_PACK_CHECKOUT, ttl: 60_000, limit: COACH_AI_CREDIT_PACK_CHECKOUT_PER_MIN },
  // Coach AI generation: baseline 10/hour/user. Per-route @Throttle
  // decorators in coach-ai.controller.ts override this with tighter
  // limits (5/hr for workout-program + meal-plan, 10/hr for
  // client-insight). The named bucket exists so AI spend is
  // independently observable + tunable from the default bucket.
  { name: THROTTLER_NAMES.COACH_AI_GENERATION, ttl: 3_600_000, limit: 10 },
  // H4 #7 — IP-WIDE storefront join layer. The GLOBAL baseline limit here is
  // intentionally non-biting (10_000/min) because the NestJS throttler
  // evaluates EVERY named throttler against EVERY route; only the GET
  // join/:token route opts into the real tight ceiling
  // (STOREFRONT_JOIN_IP_PER_MIN) AND the IP-only tracker via its route-level
  // @Throttle override. All other routes fall through to this non-biting
  // baseline (and the guard's default composite/IP tracker), so they are
  // unaffected by this throttler.
  { name: THROTTLER_NAMES.STOREFRONT_JOIN_IP, ttl: 60_000, limit: 10_000 },
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
// ---------------------------------------------------------------------------
// R2 P1 — Redis-down GRACEFUL DEGRADATION (fail-open).
//
// The throttler's Redis client is constructed with `enableOfflineQueue:false`
// and `maxRetriesPerRequest:1`, so when Redis is configured but UNAVAILABLE a
// storage `increment()` rejects (e.g. "Stream isn't writeable and
// enableOfflineQueue options is false"). With no guard around that call, the
// rejection propagates out of the ThrottlerGuard and turns EVERY globally
// throttled route — including the public storefront join route — into a 5xx.
//
// Decacorn policy: a transient infra hiccup must NEVER break the user flow.
// We therefore FAIL OPEN — on a storage error we allow the request through,
// emit a high-severity structured warning, and bump a low-cardinality metric
// so the outage is loud in observability without converting it into a wall of
// user-facing 500s. Fail-open is the correct trade here: the throttler is a
// defense-in-depth abuse brake, not the only control on these routes (the
// public surface also has opaque tokens, DTO validation, and a separate
// long-window IP limiter on the money paths), and the failure window is the
// brief period Redis is down. We log + meter so on-call sees it immediately.
//
// `recordThrottlerStorageFailures` is exported so the global throttler-storage
// failure count can be read (e.g. by the /metrics surface or tests) without
// this module taking a DI dependency on MetricsService — keeping the fix
// inside the H4 write-set.
// ---------------------------------------------------------------------------

export interface ThrottlerStorageDegradeHooks {
  /** Structured warn-level logger. Defaults to a `ThrottlerConfig` Logger. */
  logger?: Pick<Logger, 'warn'>;
  /** Metric sink, e.g. `MetricsService.increment.bind(metrics)`. Optional. */
  onFailure?: (metric: string, labels: Record<string, string>) => void;
}

// Process-local fail-open counter. Mirrors the metric so the degraded state is
// observable even when no external metric sink is wired. Keyed by throttler
// name (low cardinality — bounded by THROTTLER_LIMITS).
const throttlerStorageFailureCounts = new Map<string, number>();

/** Read (and reset, when `reset`) the per-throttler fail-open counter. */
export function recordThrottlerStorageFailures(
  reset = false,
): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const [name, n] of throttlerStorageFailureCounts) snapshot[name] = n;
  if (reset) throttlerStorageFailureCounts.clear();
  return snapshot;
}

/**
 * Wrap a ThrottlerStorage so a backend (Redis) failure FAILS OPEN instead of
 * propagating a 5xx. On error we log a high-severity warning, bump a metric +
 * a process-local counter, and return a non-blocking record (0 hits, not
 * blocked) so the request is allowed and the user flow is never broken by a
 * transient infra hiccup.
 */
export function withFailOpenStorage(
  storage: ThrottlerStorage,
  hooks: ThrottlerStorageDegradeHooks = {},
): ThrottlerStorage {
  const logger = hooks.logger ?? new Logger('ThrottlerConfig');
  return {
    async increment(
      key: string,
      ttl: number,
      limit: number,
      blockDuration: number,
      throttlerName: string,
    ): Promise<ThrottlerStorageRecord> {
      try {
        return await storage.increment(
          key,
          ttl,
          limit,
          blockDuration,
          throttlerName,
        );
      } catch (err) {
        const name = throttlerName || 'unknown';
        throttlerStorageFailureCounts.set(
          name,
          (throttlerStorageFailureCounts.get(name) ?? 0) + 1,
        );
        // High-severity structured warning. No PII / no raw key (keys embed a
        // hashed tracker) — only the throttler name and the error message.
        logger.warn({
          message: 'throttler.storage_unavailable.fail_open',
          throttler: name,
          error: err instanceof Error ? err.message : String(err),
        });
        // Low-cardinality metric (labelled by throttler name only).
        try {
          hooks.onFailure?.('throttler_storage_failures_total', {
            throttler: name,
          });
        } catch {
          // A broken metric sink must never break the fail-open path.
        }
        // FAIL OPEN — allow the request through. 0 hits, not blocked.
        return {
          totalHits: 0,
          timeToExpire: Math.ceil(ttl / 1000),
          isBlocked: false,
          timeToBlockExpire: 0,
        };
      }
    },
  };
}

export async function buildThrottlerOptions(
  redisUrl: string | undefined,
  logger: Logger = new Logger('ThrottlerConfig'),
  degradeHooks: ThrottlerStorageDegradeHooks = {},
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

  // R2 P1 — wrap the Redis storage so a backend outage FAILS OPEN (logged
  // warning + metric) rather than turning every throttled route into a 5xx.
  // The hooks default the logger to this module's logger; `degradeHooks.
  // onFailure` (if the caller wires a MetricsService sink) emits a
  // low-cardinality `throttler_storage_failures_total` counter.
  const redisStorage = new (ThrottlerStorageRedisService as any)(
    client,
  ) as ThrottlerStorage;

  return {
    throttlers,
    storage: withFailOpenStorage(redisStorage, {
      logger,
      ...degradeHooks,
    }),
  };
}