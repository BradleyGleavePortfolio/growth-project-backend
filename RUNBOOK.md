# Backend Runbook

Daily-ops handbook for `backend-spring-lake-3890` (Fly.io app, region `sjc`). Read this first when something is on fire. For first-time staging stand-up, see `docs/deploy-runbook.md` (882 lines, comprehensive). This file is the at-a-glance command reference.

Last verified: 2026-05-09. Latest commit on `main`: `16638670 feat(stage-3): coach-facing cross-pillar federation surface`.

---

## App identity

| Field | Value |
|---|---|
| Fly app | `backend-spring-lake-3890` |
| Region | `sjc` (primary) |
| Public host | per `fly.toml` `[http_service]` and the `growth-project-backend` Fly machines |
| Database | Supabase Postgres (separate projects for staging vs production) |
| Cache / throttle | Redis at `REDIS_URL` (Upstash) |
| Release script | `bash ./scripts/release.sh` (invoked by Fly's `release_command`) |

---

## Deploy

```bash
flyctl deploy -a backend-spring-lake-3890
```

The release-VM runs `bash ./scripts/release.sh`, which wraps `prisma migrate deploy` with baseline-recovery fallback for Prisma errors P3005, P3009, P3018. If migration fails for any other reason the release aborts and no traffic is shifted.

To run migrations only (without redeploying the app):

```bash
flyctl ssh console -a backend-spring-lake-3890 -C "npx prisma migrate deploy"
```

To inspect a migration before applying:

```bash
flyctl ssh console -a backend-spring-lake-3890 -C "npx prisma migrate status"
```

---

## Roll back

There is no `fly releases rollback` shortcut for a botched release that already passed migrations. The safe pattern is:

1. Identify the last-good image:
   ```bash
   flyctl releases -a backend-spring-lake-3890
   ```
2. Re-deploy that image:
   ```bash
   flyctl deploy -a backend-spring-lake-3890 --image registry.fly.io/backend-spring-lake-3890:<tag>
   ```
3. If the bad release ran a forward migration that introduced a breaking schema change, roll the migration back manually before re-deploying. Migrations are forward-only in production; the down step lives in source for emergencies but is not auto-applied. See `docs/deploy-runbook.md` for the recovery procedure.

Never rebuild from a stale local checkout. Always deploy from `main` HEAD plus the explicit image tag.

---

## Logs

Live tail:

```bash
flyctl logs -a backend-spring-lake-3890
```

Filter by machine:

```bash
flyctl logs -a backend-spring-lake-3890 -i <machine-id>
```

The structured log format is JSON; pipe through `jq` locally.

---

## Status and health

```bash
flyctl status -a backend-spring-lake-3890
flyctl machine list -a backend-spring-lake-3890
flyctl checks list -a backend-spring-lake-3890
```

The app exposes `GET /health` (unprefixed). Route through the Fly hostname plus `https://`. The check inside `fly.toml` polls this path.

---

## Smoke

Local smoke against an environment:

```bash
# Staging
npm run smoke:staging
# Admin federation surface
npm run smoke:admin-federation
```

Both pull the target host from environment variables — see `package.json` and `scripts/`.

---

## Database (Supabase)

`DATABASE_URL` points at Supabase Postgres. Use the session pooler for runtime queries; the direct connection pooler is for migrations. Production pool sizing: append `?connection_limit=10&pool_timeout=10` to the URL. Full pool guidance in `docs/database-pool.md` (referenced from the README env-var matrix).

Open psql against production (read-only-ish — be careful):

```bash
psql "$DATABASE_URL"
```

Common queries:

```sql
-- Promote a user to coach (one-off, post-bootstrap)
UPDATE users SET role = 'coach' WHERE email = 'someone@example.com';

-- Find a user by email
SELECT id, email, role, created_at FROM users WHERE email ILIKE '%example%';

-- Recent migrations
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations
ORDER BY finished_at DESC
LIMIT 10;
```

---

## Redis (throttler + cache)

`REDIS_URL` is Upstash. The throttler falls back to in-memory tracking when unset, but rate limits then do not cross Fly machines — set `REDIS_URL` before scaling out.

Diagnostics:

```bash
flyctl secrets list -a backend-spring-lake-3890 | grep REDIS
flyctl ssh console -a backend-spring-lake-3890 -C "node -e 'require(\"ioredis\").createClient(process.env.REDIS_URL).ping().then(console.log)'"
```

If Upstash returns connection errors during business hours, check the Upstash dashboard for plan-quota exhaustion (free tier hits the daily request cap quickly).

---

## Secrets

```bash
flyctl secrets list -a backend-spring-lake-3890
flyctl secrets set FOO=bar -a backend-spring-lake-3890   # triggers a redeploy
flyctl secrets unset FOO -a backend-spring-lake-3890     # also redeploys
```

The boot validator (`src/common/env-validation.ts`) rejects placeholder values for hard-tier and prod-tier vars and rejects `CORS_ORIGINS=*`. If a deploy fails immediately on boot, check the logs for the validation summary — it lists every missing or placeholder variable.

### Rotating `FEDERATION_SERVICE_TOKEN`

This bearer gates `/api/admin/federation/*` on the finance backend. Rotation must be coordinated.

```bash
NEW=$(openssl rand -hex 32)
flyctl secrets set FEDERATION_SERVICE_TOKEN=$NEW -a backend-spring-lake-3890
flyctl secrets set FEDERATION_SERVICE_TOKEN=$NEW -a tgp-finance-api
```

Both apps must hold the same value or admin-federation calls fail with `401 FEDERATION_UNAUTHENTICATED` (or `503 FEDERATION_DISABLED` on the finance side if its var is unset).

---

## Sentry

DSN lives at `SENTRY_DSN`. When unset, errors are not forwarded — the boot logs the no-op state at info level. `RELEASE_SHA` is surfaced on `/system/release-info`; verify the value matches the running deploy when triaging an error.

Inbox: `growth-project-backend` project on Sentry. Alert routing is configured in the Sentry dashboard, not in code.

---

## Stripe webhook

Webhook receiver: `/v1/webhooks/stripe` (unprefixed by design — Stripe needs a stable URL). `STRIPE_WEBHOOK_SECRET` is the HMAC secret; rotate from the Stripe dashboard and update Fly secrets in lockstep. Webhook events are HMAC-verified locally and persisted to `stripe_webhook_events` for replay.

When debugging:

```bash
# Find recent webhook events
psql "$DATABASE_URL" -c "SELECT type, status, created_at FROM stripe_webhook_events ORDER BY created_at DESC LIMIT 20;"
```

---

## Prisma migrations — daily commands

| Command | Purpose |
|---|---|
| `npx prisma generate` | Regenerate client after schema change (run on `npm install` already) |
| `npx prisma migrate dev --name <name>` | Author a new migration locally |
| `npx prisma migrate status` | Show pending vs applied migrations |
| `npx prisma migrate deploy` | Apply migrations (production via Fly release-VM) |
| `npx prisma migrate resolve --applied <name>` | Mark an out-of-band migration applied (recovery) |

Migrations are forward-only in production. Author the down step in source for emergencies, but never edit a migration that has shipped.

---

## Common incidents

### Boot loop on deploy

Most often a missing or placeholder env var. The boot validator logs every failing rule. Set the missing secret with `flyctl secrets set` and Fly will redeploy automatically.

### `JWT verification failed: kid not in JWKS`

Mixed Supabase project keys. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_REDIRECT_URL` must all come from the same Supabase project ref. See `docs/deploy-runbook.md` §0.1 for the full diagnosis.

### Throttler letting calls through that should have been blocked

`REDIS_URL` likely unset; the throttler is using the in-memory fallback per machine. Set `REDIS_URL` and verify with the diagnostic above.

### Federation surface returning 503

`FEDERATION_SERVICE_TOKEN` not set on the finance backend, or set to a different value than this app holds. Compare with `flyctl secrets list -a tgp-finance-api`.

### Migration P3005 / P3009 / P3018 on deploy

The release script handles these via baseline-recovery; if it still fails, the schema is in an unexpected state. Open `docs/deploy-runbook.md` and follow the baseline-repair procedure.

---

## Companion docs

- `docs/deploy-runbook.md` — full staging stand-up plus production deploy procedure (882 lines).
- `docs/coach-console-integration.md` — coach console BFF contracts.
- `docs/stripe-setup.md` — Stripe dashboard configuration.
- `docs/invite-landing.md` — public invite landing layout.
- `docs/e2e-qa-runbook.md` — manual QA sweep after smoke tests.
- `docs/api-conventions.md` — `@ApiOperation` plus `@ApiResponse` rule for new endpoints.
