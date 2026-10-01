# Rate limiting — `src/throttler/`

Rate limiting protects every API surface against credential-stuffing attacks,
runaway mobile clients, and accidental retry storms. It is wired globally
through `@nestjs/throttler` with a custom `UserThrottlerGuard` that keys
authenticated requests on user-id (not IP) so a shared office Wi-Fi or mobile
carrier CGNAT network cannot accidentally lock out an entire building.

---

## How it works in one paragraph

`ThrottlerModule.forRootAsync()` in `src/app.module.ts` registers a set of
named throttlers (each a `{ name, ttl, limit }` tuple). `UserThrottlerGuard`
is bound as a global `APP_GUARD` so every controller endpoint is
automatically subject to whichever `@Throttle(...)` decorator is present, or
falls back to the `default` named throttler. When a request exceeds the
limit, `ThrottlerExceptionFilter` returns `429 Too Many Requests` with a
`Retry-After` header (integer seconds) and a sanitized JSON body that does
not reveal which bucket fired or what the internal limit is.

**Isolation rule (C14).** Upstream `@nestjs/throttler` evaluates *every* named
throttler on *every* route at its module-level baseline unless the route opts
out per name with `@SkipThrottle`. With ~25 named buckets that capped an
anonymous `GET /auth/signup-policy` at 3 requests (auth-password-reset's 3/h
baseline). `UserThrottlerGuard.handleRequest` therefore applies a named
throttler **only to routes that declare it** via `@Throttle({ [name]: … })` on
the handler or controller; `default` still applies everywhere. Public reads
the app hits on launch / from a `/join` link use the dedicated `public-reads`
bucket (`PUBLIC_READS_PER_MIN`, 120/min/IP). Named rows that no route declares
(e.g. the community-* and bloodwork-write rows, whose routes use `default`
with route limits) are inert until a route opts in.

**Login throttling (C14 fix round).** Per-IP counters are **never reset** —
the earlier "reset on success" let one identity's success clear everybody's
attack budget behind that IP (and on the production Redis wrapper it was a
silent no-op that *added* hits). Instead:

- `/auth/login` per-IP windows are sized for a room on one network
  (`AUTH_LOGIN_PER_MIN` 20, `AUTH_LOGIN_PER_HOUR` 200).
- Password guessing is bounded per **account**: `LoginThrottleResetService`
  counts failures under `auth-login-account:<sha256(email)>`
  (`AUTH_LOGIN_ACCOUNT_FAILURES`, default 10 / 15 min → 15-min lock, any IP),
  checks the lock before the password, and on that account's own success
  clears **only that key**.
- `/auth/google` and `/auth/apple` have their own per-IP buckets
  (`auth-oauth-per-min` 60, `auth-oauth-per-hour` 400): 40 people signing up
  with Apple on one Wi-Fi all get through, no reset needed.
- Typed backend ops (`backendIsBlocked` / `backendReset` in
  `throttler.config.ts`, exposed as `isBlockedStrict` / `resetStrict` on the
  `withFailOpenStorage` wrapper) talk to the real adapter layouts: the
  in-memory record Map (`resetBlockdRequest`) and Redis
  `{key:name}:hits` / `{key:name}:blocked` (`EXISTS` / `DEL`). Unknown
  backends and storage errors throw, and the lock fails closed (503).
- The tracker never decodes an unverified Bearer token: only `req.user`
  (set by `JwtAuthGuard` after verification) selects a user bucket.

Tests: `test/login-account-lock.spec.ts` (real memory adapter, the
production wrapper, a Redis-layout regression of the audit probe, and live
Redis in CI), `test/throttler-isolation.spec.ts` (40-person room).

---

## Route → limit → window → tracker-key table

| Route                                     | Method | Throttler name          | Limit | Window | Tracker key            |
|-------------------------------------------|--------|-------------------------|-------|--------|------------------------|
| `POST /auth/login`                        | POST   | `auth-login-per-min`    | 20    | 1 min  | IP (never reset)       |
| `POST /auth/login`                        | POST   | `auth-login-per-hour`   | 200   | 1 hr   | IP (never reset)       |
| `POST /auth/login` (failures)             | POST   | `auth-login-account:*`  | 10    | 15 min | account (sha256 email) |
| `POST /auth/apple`                        | POST   | `auth-oauth-per-min`    | 60    | 1 min  | IP (never reset)       |
| `POST /auth/apple`                        | POST   | `auth-oauth-per-hour`   | 400   | 1 hr   | IP (never reset)       |
| `POST /auth/google`                       | POST   | `auth-oauth-per-min`    | 60    | 1 min  | IP (never reset)       |
| `POST /auth/google`                       | POST   | `auth-oauth-per-hour`   | 400   | 1 hr   | IP (never reset)       |
| `POST /auth/forgot-password`              | POST   | `auth-password-reset`   | 3     | 1 hr   | IP (unauthenticated)   |
| `POST /auth/register`                     | POST   | `auth-signup`           | 5     | 1 hr   | IP (unauthenticated)   |
| `POST /auth/signup-with-code` (no well-formed code) | POST | `auth-signup`   | 5     | 1 hr   | IP (unauthenticated)   |
| `POST /auth/signup-with-code` (well-formed `invite_code`) | POST | `auth-signup-with-code` | 100 (`AUTH_SIGNUP_WITH_CODE_PER_HOUR`) | 1 hr | IP (unauthenticated) |
| `POST /coach/clients/:id/messages`        | POST   | `coach-messages`        | 30    | 1 min  | user-id (authenticated)|
| `POST /coach/clients/:id/messages/voice-upload` | POST | `coach-messages`   | 20    | 1 min  | user-id (authenticated)|
| `PUT /notifications/preferences`          | PUT    | `notifications-prefs`   | 30    | 1 min  | user-id (authenticated)|
| `POST /bloodwork/*`                       | POST   | `bloodwork-write`       | 30    | 1 min  | user-id (authenticated)|
| `GET /coach/command-center/*`             | GET    | `coach-command-center`  | 60    | 1 min  | user-id (authenticated)|
| `POST /diagnostic/submit`                 | POST   | `diagnostic-submit`     | 5     | 1 hr   | IP (unauthenticated)   |
| All other routes                          | any    | `default`               | 300   | 1 min  | user-id or IP          |

**Health check whitelist:** `GET /health`, `GET /healthz`, `GET /readyz` are
exempt from all rate limiting. `UserThrottlerGuard.canActivate()` short-
circuits before any bucket is consulted for these paths. This is critical for
Fly.io liveness probes — the edge pings `/health` every few seconds and
consuming a quota per probe would cause false-positive rate limiting.

**Successful login resets nothing per-IP.** A success clears only that
account's own failure counter (see "Login throttling" above).

---

## 429 response shape

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Too many attempts. Please wait before trying again.",
  "retryAfter": 3600
}
```

The `Retry-After` HTTP header and the `retryAfter` body field are always
present and always agree (integer seconds). The value is the maximum TTL
window across all named throttlers — a conservative upper bound. The body
never reveals which named throttler fired, the actual limit, or the current
counter value.

---

## Environment variables

All env vars are read once at module load time. Changes require a server
restart. Every var has a safe default that is production-appropriate.

| Env var                       | Default | Min | Max    | Meaning                                                     |
|-------------------------------|---------|-----|--------|-------------------------------------------------------------|
| `RATELIMIT_ENABLED`           | `on`    | —   | —      | Set to `off` to disable all throttling (load-test use only).|
| `RATELIMIT_AUTHED_PER_MIN`    | `300`   | 1   | 10 000 | Default limit for authenticated requests per user per minute. |
| `RATELIMIT_ANON_PER_MIN`      | `100`   | 1   | 10 000 | Default limit for unauthenticated requests per IP per minute. |
| `PUBLIC_READS_PER_MIN`        | `120`   | 10  | 5 000  | Per-IP limit on public reads (`GET /auth/signup-policy`, `GET /invite/:code/preview`) via `public-reads`. |
| `AUTH_LOGIN_PER_MIN`          | `5`     | 1   | 1 000  | Per-IP login attempts per minute (all login endpoints share this). |
| `AUTH_LOGIN_PER_HOUR`         | `30`    | 1   | 5 000  | Per-IP login attempts per hour (sustained-attack brake). |
| `AUTH_PWD_RESET_PER_HOUR`     | `3`     | 1   | 1 000  | Per-IP password-reset emails per hour.                      |
| `AUTH_SIGNUP_WITH_CODE_PER_HOUR` | `100` | 5 | 500    | Per-IP `POST /auth/signup-with-code` requests per hour that carry a well-formed invite code. Sized for a 40+ patient clinic event on one Wi-Fi IP (retries included). Codeless signups keep the 5/hour `auth-signup` baseline; `previewCode` still gates account creation. |
| `COACH_MESSAGES_PER_MIN`      | `30`    | 1   | 1 000  | Per-user coach message sends per minute.                    |
| `NOTIF_PREFS_PER_MIN`         | `30`    | 1   | 1 000  | Per-user notification preference writes per minute.         |
| `BLOODWORK_WRITE_PER_MIN`     | `30`    | 1   | 1 000  | Per-user bloodwork POST writes per minute.                  |
| `COACH_CMD_CENTER_PER_MIN`    | `60`    | 1   | 1 000  | Per-user coach command-center GET reads per minute.         |
| `DIAGNOSTIC_RATE_LIMIT_PER_HOUR` | `5` | 1   | 1 000  | Per-IP diagnostic submit requests per hour (unauthenticated lead-capture endpoint). |
| `REDIS_URL`                   | unset   | —   | —      | When set, `ThrottlerModule` uses Redis storage so limits are shared across all Fly machines. When unset, in-memory storage is used (safe for dev/test; limits do NOT cross machines in prod). |

---

## Storage backend

The throttler abstraction (`ThrottlerStorage` from `@nestjs/throttler`) is the
injection point. Two backends are supported:

| Condition | Backend | Notes |
|---|---|---|
| `REDIS_URL` unset | Built-in in-memory | Safe for dev/test and single-Fly-machine deploys. Limits reset on restart. |
| `REDIS_URL` set | `@nest-lab/throttler-storage-redis` over `ioredis` | Limits are shared across all Fly machines. Required before scaling out. |

To swap in a Redis backend: set `REDIS_URL=redis://host:6379` in Fly secrets.
No code change required — `buildThrottlerOptions()` in `throttler.config.ts`
detects the env var and lazily imports `ioredis` and the storage adapter.

---

## Files

| File | Purpose |
|---|---|
| `throttler.config.ts` | Named throttler definitions (`THROTTLER_LIMITS`), env-var parsing, `buildThrottlerOptions()` factory. Single source of truth for all limit values. |
| `user-throttler.guard.ts` | `UserThrottlerGuard` extends `ThrottlerGuard`. Overrides `getTracker()` for user-id-vs-IP bucketing and `canActivate()` to skip health check paths. |
| `login-throttle-reset.service.ts` | `LoginThrottleResetService` clears per-IP login counters on successful authentication. Injected into `AuthController`. |
| `throttler.module.ts` | Lightweight `@Module` that exports `LoginThrottleResetService` for import into `AuthModule`. |

The main `ThrottlerModule.forRootAsync()` is registered in `src/app.module.ts`
alongside the global `APP_GUARD` binding for `UserThrottlerGuard`.

The 429 filter is at `src/filters/throttler-exception.filter.ts`.

---

## Tests

| File | What it asserts |
|---|---|
| `test/rate-limit.spec.ts` | Named limit table, `@Throttle` metadata on every throttled handler, `getTracker` IP resolution, health-path skip, 429 response shape + `Retry-After`, global `APP_GUARD` wiring, Redis/in-memory fallback, `THROTTLER_NAMES` uniqueness + completeness. |
| `test/redis-throttler.spec.ts` | Legacy: tracker key resolution, auth controller metadata (pre-Phase 10 named throttlers). Retained for regression coverage. |
| `test/auth-forgot-password-throttle.spec.ts` | Focused audit S-1 check: `auth-password-reset` metadata on `forgotPassword` handler. |

---

## Future work / known limits

- **Per-email password-reset keying.** The `auth-password-reset` throttler
  currently keys on IP (via `UserThrottlerGuard.getTracker()`). The spec
  calls for keying on email address so an attacker cannot evade the limit by
  rotating IPs while targeting one account. Implementing this requires a
  custom guard that reads `req.body.email` and feeds it as the tracker key.
  The named throttler and limit are already in place; only the guard
  override is missing.
- **Per-tenant dynamic limits.** Today all limits are static env vars. A
  future `TenantThrottlerService` could read per-tenant overrides from the
  database and apply them at request time.
- **Dynamic limit adjustment.** Limits could be lowered automatically in
  response to detected attack traffic (e.g. via a PostHog event count
  threshold) and raised again once the attack subsides.
- **Redis backend.** If `REDIS_URL` is not configured in production, limits
  do not cross Fly machines. Set `REDIS_URL` before scaling beyond one
  machine.
- **`bloodwork-write` and `coach-command-center` throttlers** are defined
  and tested in the config layer but not yet applied as `@Throttle`
  decorators to route handlers because the `/bloodwork/*` and
  `/coach/command-center/*` route families do not exist yet. When those
  modules ship, add `@Throttle({ [THROTTLER_NAMES.BLOODWORK_WRITE]: { ttl: 60_000, limit: 30 } })`
  and `@Throttle({ [THROTTLER_NAMES.COACH_COMMAND_CENTER]: { ttl: 60_000, limit: 60 } })`
  to the relevant handlers.
