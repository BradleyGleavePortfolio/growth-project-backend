# Redis Throttler — Provisioning Runbook

> **Who this is for:** Operators deploying `backend-spring-lake-3890` on Fly.io with more than one machine instance. If you run a single machine (default), the in-memory throttler works fine. The moment you scale to two or more machines, rate-limit counters become per-machine and the shared cap is lost — Redis fixes that.

---

## Why Redis is required at scale

The NestJS throttler stores request counters in memory by default. Each Fly machine has its own memory space: a client whose requests hit Machine A cannot "see" the counters on Machine B. In practice this means:

- A client limited to **10 login attempts / minute** can actually make **10 × N** attempts simply by being round-robined across N machines.
- Credential-stuffing and signup-spam protections are silently ineffective the moment you `fly scale count 2`.

Adding a shared Redis store (one key namespace, all machines) restores the intended per-user / per-IP caps regardless of which machine handles each request.

---

## Provisioning steps

### 1. Create the Upstash Redis instance

```bash
fly redis create --name tgp-throttler --region sjc
```

Fly will print the private `redis://` URL after creation.

> **Cost:** Upstash Free Starter plan — ~**$1.94 / month** at low traffic. No minimum commitment. Scale-up pricing is request-based if you exceed the free tier.

### 2. Confirm the instance is running

```bash
fly redis status tgp-throttler
```

Expect output like:

```
Name:           tgp-throttler
Plan:           Free
Primary Region: sjc
Read Regions:   -
Private URL:    redis://default:xxxxx@fly-tgp-throttler.upstash.io
```

### 3. Set the secret on your Fly app

Copy the `Private URL` from step 2 and set it as a Fly secret:

```bash
fly secrets set REDIS_URL="redis://default:xxxxx@fly-tgp-throttler.upstash.io" \
  -a backend-spring-lake-3890
```

Fly rotates secrets in-place; the app does **not** restart yet.

### 4. Deploy

```bash
fly deploy
```

The app reads `REDIS_URL` at startup via `buildThrottlerOptions()` in `src/throttler/throttler.config.ts`.

---

## Verifying it worked

After deploy, check the Fly log stream:

```bash
fly logs -a backend-spring-lake-3890
```

You should see **both** of these lines (one per machine):

```
Redis throttler backend initialized (named throttlers: auth-login, auth-signup, auth-password-reset, diagnostic-submit, default).
Throttler using Redis store at fly-tgp-throttler.upstash.io
```

If you instead see:

```
REDIS_URL not set — using in-memory throttler tracker. Limits do NOT cross Fly machines.
```

the secret was not injected. Re-check `fly secrets list -a backend-spring-lake-3890` and redeploy.

---

## Named throttlers protected

| Throttler | Window | Limit | Scope |
|---|---|---|---|
| `auth-login` | 1 minute | 10 | user-id / IP fallback |
| `auth-signup` | 1 hour | 5 | user-id / IP fallback |
| `auth-password-reset` | 15 minutes | 5 | user-id / IP fallback |
| `diagnostic-submit` | 1 hour | 5 (env-tunable) | IP |
| `default` | 1 minute | 60 | user-id / IP fallback |

---

## Environment variable reference

| Variable | Purpose | Required |
|---|---|---|
| `REDIS_URL` | Upstash / ioredis-compatible Redis URL | **Required when running ≥ 2 Fly machines** |

Safe default: when `REDIS_URL` is absent the app falls back to in-memory tracking and logs a warning. Single-machine deployments are unaffected.

---

## Related files

- `src/throttler/throttler.config.ts` — builds `ThrottlerModuleOptions`; Redis path uses `@nest-lab/throttler-storage-redis`
- `src/throttler/user-throttler.guard.ts` — user-id keyed guard (IP fallback for unauthenticated routes)
- `src/filters/throttler-exception.filter.ts` — HTTP 429 response shaping

---

## References

- [Fly Redis (Upstash) pricing](https://fly.io/docs/reference/redis/)
- [`@nest-lab/throttler-storage-redis` package](https://github.com/jmcdo29/nest-lab/tree/main/packages/throttler-storage-redis)
- [NestJS ThrottlerModule docs](https://docs.nestjs.com/security/rate-limiting)