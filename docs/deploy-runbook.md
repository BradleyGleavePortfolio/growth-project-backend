# Deploy Runbook — Staging & Production

End-to-end runbook for deploying the Growth Project backend to a Fly.io
environment. Covers env validation, migrations, OWNER bootstrap, feature
flag rollout, Stripe wiring, smoke tests, and rollback. The goal is that
a single operator can stand up staging from this document without
reading the codebase.

> Companion docs:
> - `docs/stripe-setup.md` — Stripe dashboard configuration.
> - `docs/coach-console-integration.md` — coach console BFF contracts.
> - `docs/invite-landing.md` — public invite landing layout.
> - `docs/e2e-qa-runbook.md` — manual QA sweep (run after smoke tests).

---

## 0. Prerequisites

- `flyctl` installed and authenticated against the right org.
- Access to the Supabase project for the target environment (staging vs
  production are separate Supabase projects — never share keys).
- Stripe dashboard access for the matching Stripe account (staging =
  test mode, production = live mode — also separate accounts; see
  `docs/stripe-setup.md` §6).
- A Postgres client (`psql`) for the Supabase DB if a manual backup is
  needed.

Confirm you are deploying the intended app:

```sh
fly status -a <app-name>
fly secrets list -a <app-name>
```

### 0.1 Confirm you are pointing at the right Supabase project

Every `SUPABASE_*` value must come from a **single** Supabase project.
The most common operator mistake is mixing values across two projects
(e.g. `SUPABASE_URL` from project A and `SUPABASE_SERVICE_ROLE_KEY`
from project B). The boot does not detect this — the keys are valid
JWTs, just signed by the wrong project — and every authenticated
request then fails with `JWT verification failed: kid not in JWKS`
because the JWKS endpoint at `SUPABASE_URL` does not know the keys
the tokens were signed with.

Pin all four `SUPABASE_*` values to the same project ref:

```sh
# Settings → API in the Supabase dashboard, scroll to Project URL.
echo "$SUPABASE_URL"
# Should print https://<project-ref>.supabase.co

# Settings → API, "Project API keys" section.
# anon key + service_role key are listed under the SAME project ref.
# Copy them from this project, not from a sibling project you happen
# to also have open in another tab.

# Sanity check: the JWT `iss` of any user token in this project is
# https://<project-ref>.supabase.co/auth/v1
node -e "process.stdout.write(JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64').toString()).iss+'\n')" "$ANY_USER_TOKEN"
```

If staging and production use the same Supabase project, you have a
shared-tenancy bug, not a configuration problem. Provision a second
project and do not share keys.

### 0.2 App `OWNER` role ≠ Supabase project owner

Two unrelated concepts that have caused operator confusion:

- **`Role.owner`** is an application-level role on the `User` table in
  this backend. It is set by `scripts/bootstrap-owners.ts` and bypasses
  `RolesGuard`, `CoachGuard`, `CoachOrOwnerGuard`, and
  `SubscriptionGuard`. It has nothing to do with Supabase.
- **Supabase project owner / member** is the dashboard-level
  permission that lets a human log into supabase.com and edit auth
  providers, rotate keys, or see database settings. It is configured
  in the Supabase dashboard under Settings → Team and is unrelated to
  the rows in the `User` table.

A user being `Role.owner` in this backend grants them no Supabase
dashboard access; granting a teammate Supabase project owner does not
elevate their app role. Promote OWNER via `bootstrap-owners.ts` (see
§4) and grant Supabase dashboard access via Supabase's team settings
separately.

---

## 1. Environment variable matrix

`src/common/env-validation.ts` is the source of truth for which vars are
required at boot. The boot fails loudly when hard or prod-tier vars are
missing. The summary below restates the rules so you can prepare
`fly secrets set` ahead of time.

| Variable | Tier | Notes |
| --- | --- | --- |
| `DATABASE_URL` | hard | Postgres connection string from Supabase → Settings → Database. Use the **session pooler** for runtime queries. |
| `SUPABASE_URL` | hard | `https://<project-ref>.supabase.co`. Used for JWKS and admin API. |
| `SUPABASE_SERVICE_ROLE_KEY` | hard | Service-role key. Treat as a secret. |
| `PUBLIC_INVITE_BASE_URL` | prod | `https://app.trygrowthproject.com/join`. Drives invite-code URLs. |
| `PUBLIC_WEB_SIGNUP_URL` | prod | Landing page used when no app is installed. Until a marketing signup page exists, point this at the durable backend route `https://app.trygrowthproject.com/signup`. |
| `APP_STORE_URL` | prod | Final iOS App Store URL. **Do not invent a placeholder Apple ID** — until the listing is live, point this at the durable backend route `https://app.trygrowthproject.com/download/ios`. Flip to the real URL when the App Store listing is approved. |
| `PLAY_STORE_URL` | prod | Final Google Play URL. **Do not invent a placeholder package id** — until the listing is live, point this at the durable backend route `https://app.trygrowthproject.com/download/android`. Flip to the real URL when the Play listing is approved. |
| `CORS_ORIGINS` | prod | Comma-separated list of allowed origins for the coach console. **Wildcard is rejected at boot.** |
| `STRIPE_SECRET_KEY` | prod | `sk_test_…` for staging, `sk_live_…` for production. |
| `STRIPE_WEBHOOK_SECRET` | prod | `whsec_…` from Stripe → Developers → Webhooks. |
| `STRIPE_PRICE_ID_FITNESS` | prod | `price_…` of the flat coach plan. |
| `SENTRY_DSN` | prod | Server-side DSN. Without this, prod errors are invisible. |
| `POSTHOG_KEY` | optional | Product analytics. AnalyticsModule no-ops when unset. |
| `PERPLEXITY_API_KEY` | optional | AI chat falls back to a deterministic responder when unset. |
| `USDA_API_KEY` | optional | Food search returns errors at call time when unset. |
| `COACH_CODE_GATE_ENABLED` | optional | Feature flag — `true` to require an invite code on signup. |
| `BILLING_ENFORCEMENT` | optional | `enforce` to block writes for past_due/canceled coaches. Default = observe-only. |
| `STRIPE_PRICE_ID_FINANCE` | optional | Reserved for a future finance-vertical price. |

To preflight a `.env` file locally before pushing it as Fly secrets:

```sh
NODE_ENV=staging node -e \
  "require('./dist/common/env-validation').assertEnv()"
```

If `assertEnv` throws, fix the missing/invalid vars before deploying.

---

### 1.1 Fly secrets are write-only — plan rotation accordingly

`fly secrets list -a <app>` only shows **name, digest, and created_at**.
The values cannot be read back from Fly. Implications:

- Treat the GitHub Actions secret store and Fly secrets as the
  authoritative copies — there is no third "view current value"
  surface to fall back on.
- When rotating a credential, update **both** the source-of-truth
  (vendor dashboard or Actions secret) **and** Fly. A successful
  rotation is signalled by a changed `digest` in `fly secrets list`,
  not by reading the new value.
- A failed deploy that leaves Fly secrets stale cannot be diagnosed
  by reading the secret — only by re-pushing it. If you cannot find
  the prior value to compare, assume you have to push fresh from the
  source.
- Do not try to recover a lost secret by SSH-ing into a running Fly
  machine and reading the env. The runtime sees the value, but
  copying it out of a production shell is the security failure the
  write-only design is meant to prevent.

The corollary: rotating a Stripe / Sentry / Supabase credential is a
two-step write. (1) rotate at the vendor and update the GitHub Actions
secret of the same name. (2) re-run the operator workflow described in
§7b (or for the non-workflow vars, push from a trusted shell). Then
verify by `fly secrets list -a <app>` and watch the `digest` change.
Until the digest changes, the app is still serving the old credential
even if the dashboard shows the new one.

## 2. Staging deploy

1. **Tag the commit you intend to deploy.**

   ```sh
   git tag -a staging-$(date +%F) -m "staging deploy $(date +%F)"
   git push origin staging-$(date +%F)
   ```

2. **Set Fly secrets.** Use the matrix above. Example for the prod-tier
   block (replace values with staging credentials):

   ```sh
   fly secrets set -a <staging-app> \
     DATABASE_URL=... \
     SUPABASE_URL=https://<staging-ref>.supabase.co \
     SUPABASE_SERVICE_ROLE_KEY=... \
     PUBLIC_INVITE_BASE_URL=https://staging.thegrowthproject.app/join \
     PUBLIC_WEB_SIGNUP_URL=https://staging.thegrowthproject.app/signup \
     APP_STORE_URL=https://apps.apple.com/app/... \
     PLAY_STORE_URL=https://play.google.com/store/apps/details?id=... \
     CORS_ORIGINS=https://console-staging.thegrowthproject.app \
     STRIPE_SECRET_KEY=sk_test_... \
     STRIPE_WEBHOOK_SECRET=whsec_... \
     STRIPE_PRICE_ID_FITNESS=price_... \
     SENTRY_DSN=https://...@sentry.io/...
   ```

3. **Take a DB snapshot before any deploy that includes a migration.**
   Supabase backs up nightly, but a pre-deploy snapshot makes rollback
   point-in-time precise:

   ```sh
   pg_dump "$STAGING_DATABASE_URL" \
     --no-owner --no-acl \
     --file backups/staging-$(date +%F-%H%M).sql
   ```

   Store the dump somewhere durable (1Password vault attachment, S3
   bucket, etc.) — never commit it.

4. **Deploy.**

   ```sh
   fly deploy -a <staging-app> --remote-only
   ```

   The `release_command` (see `scripts/release.sh`) runs first. It will
   run `prisma migrate deploy`. If that fails with P3005 (the DB has not
   been baselined yet), the script will only fall back to `prisma db
   push --accept-data-loss` when **all** of the following hold:

   - `RELEASE_ALLOW_DB_PUSH=1` is set as a Fly secret, **and**
   - the database does NOT already contain a `_prisma_migrations` table.

   Both guards are additive — leave `RELEASE_ALLOW_DB_PUSH` unset on any
   environment that holds real data. Set it only for a one-time bootstrap
   on a fresh DB after taking a backup.

5. **Watch the release log.**

   ```sh
   fly logs -a <staging-app>
   ```

   Healthy boot prints:

   ```
   [Bootstrap] Env validation passed for NODE_ENV=staging. ...
   [Bootstrap] The Growth Project API running on port 3000
   ```

6. **Run the smoke script** (see §5).

---

### 2.1 Production needs a Prisma migration baseline before the first deploy

`prisma migrate deploy` requires the target database to either be
empty *or* to already have a populated `_prisma_migrations` table that
matches the repository's migration history. A production database that
was created out-of-band (Supabase SQL editor, restored snapshot,
sandbox copy, etc.) has neither, and `release.sh` will then refuse to
proceed: it sees a populated schema but no `_prisma_migrations` table,
and the `RELEASE_ALLOW_DB_PUSH=1` fallback **deliberately does not
fire** on a populated DB (see `scripts/release.sh`).

This is a one-time setup — once baselined, every subsequent deploy
just runs `prisma migrate deploy` cleanly. The baseline contract:

1. **Empty DB** (greenfield staging): no action needed. `prisma migrate
   deploy` creates the schema and seeds `_prisma_migrations` itself.
2. **Populated DB that was built by a prior `prisma migrate deploy`**:
   `_prisma_migrations` already exists. No action needed.
3. **Populated DB that was NOT built by Prisma** (manual schema, raw
   SQL, restored from a non-Prisma source): one-time baseline required
   before the first deploy. Run, on a maintenance window:

   ```sh
   # From a trusted shell with DATABASE_URL pointed at the DB.
   # Lists the migrations directory; mark each as already applied.
   for d in prisma/migrations/*/ ; do
     name=$(basename "$d")
     npx prisma migrate resolve --applied "$name"
   done

   # Confirm the baseline is in place.
   psql "$DATABASE_URL" -c '\d _prisma_migrations'
   ```

   Then re-run the deploy. `release.sh` will pick up the now-baselined
   DB and `prisma migrate deploy` will be a no-op until the next real
   migration lands.

**Never use `RELEASE_ALLOW_DB_PUSH=1` against a database that holds
real data.** The escape hatch is for greenfield bootstraps only and is
guarded by a presence-of-`_prisma_migrations` check precisely because
`db push --accept-data-loss` would otherwise rewrite tables and
silently truncate columns.

## 3. Migration backup & rollback

For every migration:

1. **Backup before deploy** with `pg_dump` (§2 step 3).
2. **Run the migration via the release command** (Fly auto-runs it; do
   not invoke `prisma migrate deploy` from your laptop against the
   prod DB).
3. **If the deploy aborts**, Fly leaves the previous machines running.
   Investigate the release log and re-deploy a fix; no manual revert is
   needed for a failed release.
4. **If the deploy succeeded but the new code is broken**, roll the
   image back:

   ```sh
   fly releases -a <app>
   fly deploy -a <app> --image registry.fly.io/<app>:<previous-tag>
   ```

   The previous image still expects the new schema, so the rollback is
   safe as long as the migration was additive (added columns/tables,
   nullable defaults). For destructive migrations (drop column, rename),
   restore the pre-deploy snapshot instead:

   ```sh
   psql "$STAGING_DATABASE_URL" < backups/staging-<timestamp>.sql
   ```

   Only restore against a DB you control end-to-end. Never restore
   production from a stale snapshot without first rotating Supabase
   service-role keys.

---

## 4. OWNER bootstrap & feature flag order

Run these once per environment, in order, after the first deploy that
includes the OWNER role + CoachProfile migration (PR #52):

1. **Promote OWNER emails.** The bootstrap script is idempotent — re-runs
   are safe.

   ```sh
   BOOTSTRAP_OWNER_EMAILS="bradley@x.com,dynasia@x.com" \
     fly ssh console -a <app> -C "node dist/scripts/bootstrap-owners.js"
   ```

   Or, if you prefer running locally against the env (read-only network
   ok):

   ```sh
   BOOTSTRAP_OWNER_EMAILS="..." \
     DATABASE_URL="$STAGING_DATABASE_URL" \
     npx ts-node scripts/bootstrap-owners.ts
   ```

2. **Verify** that owners can hit `GET /api/v1/coach/me` and the admin
   routes (e.g. `POST /api/admin/promote-coach`).

3. **Feature flag rollout order.** Toggle in this sequence so the system
   never enters a state that locks users out:

   1. `COACH_CODE_GATE_ENABLED` stays **unset** during onboarding —
      lets the team sign up without an invite. Flip to `true` only after
      every intended coach has a CoachProfile row with an `invite_code`.
   2. `BILLING_ENFORCEMENT` stays **unset / observe-only** during the
      Stripe rollout. Flip to `enforce` only after every coach has a
      `CoachSubscription` row in `active` state.
   3. Production-only: re-deploy with the flags set so they are in effect
      on the next boot.

---

## 5. Smoke tests

After every deploy:

```sh
SMOKE_BASE_URL=https://api-staging.thegrowthproject.app \
  npm run smoke:staging
```

The script (see `scripts/smoke.ts`) checks:

- `/health` returns 200 with `ok: true`.
- `/api/auth/signup-policy` returns the gate state.
- `/api/invite/<code>/preview` returns a JSON shape with `ok`/`exists`.
- `/api/v1/coach/me` returns 401 (auth required) — confirms BFF mount.
- `/api/v1/webhooks/stripe` returns 400 without a Stripe signature —
  confirms the route exists and the signature gate works.
- `/join/<code>` HTML landing page renders without 5xx.
- `/api/ai/context` (if `SMOKE_TOKEN` is set) returns a context shape;
  otherwise asserts 401.

Exit code is non-zero on any failure. Wire it into the deploy pipeline
or run it manually after `fly deploy`.

### 5.0.1 Admin + federation smoke — credentialled OWNER probe

`scripts/admin-federation-smoke.ts` (`npm run smoke:admin-federation`) is
the credentialled companion to `smoke.ts`. It hits the nine OWNER-only
admin/federation routes the console depends on and asserts each comes
back with a 200 and a recognisable response shape — including a finance
status that's a member of the `FinanceFederationStatus` union (see
`src/admin/console/finance-federation.service.ts`).

Required env:

- `BACKEND_URL` — same value as `SMOKE_BASE_URL`.
- `OWNER_JWT` — a Supabase access token for an `owner`-role user. Pull
  it from a fresh sign-in; do NOT reuse a long-lived token.
- `SMOKE_COACH_ID` — a real coach `User.id` on the target environment.
- `SMOKE_CLIENT_ID` — a real student `User.id` on the target environment.

Optional:

- `SMOKE_FINANCE_EXPECTED_STATUS` — pin the expected
  `/api/admin/finance/health` and `/api/admin/product/usage` `status`
  field. Use `ok` once the finance federation is wired in production;
  use `not_configured` in environments where finance is intentionally
  off. Without this pin, any value in the
  `FinanceFederationStatus` union counts as a pass — the script still
  catches a malformed response or 500.
- `SMOKE_VERBOSE=1` — keep full ids in the log line and include
  truncated response bodies. Off by default so terminal output stays
  paste-safe.

```sh
BACKEND_URL=https://api-staging.thegrowthproject.app \
OWNER_JWT=eyJ... \
SMOKE_COACH_ID=<coach-user-id> \
SMOKE_CLIENT_ID=<student-user-id> \
SMOKE_FINANCE_EXPECTED_STATUS=ok \
  npm run smoke:admin-federation
```

The script checks (in order):

1. `GET /health` — 200 `{ ok: true }`.
2. `GET /api/admin/metrics` — 200, numeric `total_users`.
3. `GET /api/admin/users?limit=5` — 200, JSON array.
4. `GET /api/admin/coaches` — 200, JSON array.
5. `GET /api/admin/search?q=` — 200, federation block shape.
6. `GET /api/admin/coaches/:id/overview` — 200, `user_id` set.
7. `GET /api/admin/clients/:id/unified` — 200, `user_id` set.
8. `GET /api/admin/product/usage` — 200, finance status valid.
9. `GET /api/admin/finance/health` — 200, finance status valid.

Exit code 1 on any failed assertion, 2 on missing required env or
runtime crash. The bearer is never logged; ids are redacted to a
prefix/suffix unless `SMOKE_VERBOSE=1` is set.

### 5.1 Migration smoke — required on every backend deploy

`scripts/smoke.ts` covers HTTP shape, not schema. Every backend deploy
must additionally confirm the migration ran and the new columns/tables
the deploy depends on are actually present. The check is two
commands: one against `_prisma_migrations`, one against the latest
table the deploy is supposed to have created or altered.

```sh
# 1. The most recently applied Prisma migration. Should match the
#    newest folder under prisma/migrations/ in the deployed commit.
psql "$DATABASE_URL" -c \
  "select migration_name, finished_at from _prisma_migrations
     order by finished_at desc nulls last limit 5;"

# 2. Spot-check the schema for the table/column the deploy added.
#    Pick the column the deploy actually shipped — this is a guard
#    against a deploy that flipped traffic before release_command
#    finished, leaving migrate-deploy "succeeded" but the columns
#    absent on the live machine.
psql "$DATABASE_URL" -c '\d "AuditLog"'
psql "$DATABASE_URL" -c '\d "User"' | grep -E 'deletion_scheduled_at|deleted_at'
```

If `_prisma_migrations` does not contain the migration that landed in
the commit you deployed, treat the deploy as failed even when
`/health` returns 200 — Fly will keep serving against an old schema
until the next release. Re-run `release.sh` (or `npx prisma migrate
deploy` from a trusted shell pointed at the deployed DB) before
proceeding to the manual QA sweep.

The migration smoke is intentionally manual: putting a `psql` step in
the smoke script would require `DATABASE_URL` and the SSL bundle in
the smoke environment, which is the credentialled posture
`scripts/smoke.ts` exists to avoid. Operators run the migration smoke
from a trusted shell with `DATABASE_URL` set; keep it in your
post-deploy checklist next to the HTTP smoke.

Then run the manual QA sweep in `docs/e2e-qa-runbook.md`.

---

## 6. Stripe — test-mode setup & live-mode switch

Full setup lives in `docs/stripe-setup.md`. Operational summary:

- **Staging = test mode.** Use `sk_test_…`, a separate Stripe account,
  `whsec_…` from the test-mode webhook endpoint. `bin/stripe listen
  --forward-to <staging>/api/v1/webhooks/stripe` is fine for spot-checks.
- **Production = live mode.** A separate Stripe account, `sk_live_…`,
  separate webhook endpoint. Never reuse a staging signing secret in
  production.
- **Console live-mode switch.** When ready to flip the coach console
  from test to live:

  1. Confirm every CoachProfile has a Stripe Customer in live mode (the
     mirror creates one on the first portal-session call; OWNER can
     trigger this manually).
  2. Set `STRIPE_*` Fly secrets to live values.
  3. Update the webhook endpoint URL in the Stripe live dashboard to
     the production API host.
  4. Re-deploy the backend so env-validation re-runs.
  5. Set `BILLING_ENFORCEMENT=enforce` only after the first invoices
     succeed and `CoachSubscription` rows are present for every coach.

---

## 7. Rollback playbook

| Symptom | Action |
| --- | --- |
| Deploy aborted on `release_command`. | No-op — Fly keeps the previous machines. Fix the migration, redeploy. |
| App boots but env-validation throws. | Add the missing secret, redeploy. Boot logs identify the missing var. |
| Health endpoint stays red after deploy. | `fly logs -a <app>` for the stack trace. If unrelated to schema, redeploy the previous image (§3). |
| Stripe webhooks 400-ing in production. | Verify `STRIPE_WEBHOOK_SECRET` matches the live endpoint. Check Sentry for the rejection reason. |
| Coach console hits CORS error. | Check `CORS_ORIGINS` for the exact origin (scheme + host + port). Wildcard is rejected. |
| Invite landing page empty. | Verify `PUBLIC_INVITE_BASE_URL`, `APP_STORE_URL`, `PLAY_STORE_URL`, `PUBLIC_WEB_SIGNUP_URL`. Empty values fall through to placeholder defaults baked into `invite-landing.controller.ts`. |
| Need to fully roll back a destructive migration. | Restore the pre-deploy `pg_dump` snapshot, then redeploy the previous image (§3). |

---

## 7b. Production secrets via the operator workflow

Production Fly secrets are pushed via a workflow_dispatch-only GitHub
Actions workflow rather than a local `fly secrets set` shell — that way
the values never sit in an operator's terminal history and the only
place they exist outside Fly is the GitHub Actions secret store, which
the org already audits.

Workflow file: `.github/workflows/fly-secrets-set.yml`
Workflow name: **Fly Secrets Set (operator)**

What it sets:

| Variable | Source |
| --- | --- |
| `PUBLIC_INVITE_BASE_URL` | hardcoded — `https://app.trygrowthproject.com/join` |
| `PUBLIC_WEB_SIGNUP_URL` | hardcoded — `https://app.trygrowthproject.com/signup` |
| `APP_STORE_URL` | hardcoded — `https://app.trygrowthproject.com/download/ios` |
| `PLAY_STORE_URL` | hardcoded — `https://app.trygrowthproject.com/download/android` |
| `CORS_ORIGINS` | hardcoded — `https://console.trygrowthproject.com` |
| `STRIPE_PRICE_ID_FITNESS` | hardcoded — `price_1TQij2DUoC5CCVhSDxe9Bin1` |
| `STRIPE_SECRET_KEY` | GitHub Actions secret of the same name |
| `STRIPE_WEBHOOK_SECRET` | GitHub Actions secret of the same name |
| `SENTRY_DSN` | GitHub Actions secret of the same name |

What it does NOT set: `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `USDA_API_KEY`, `PERPLEXITY_API_KEY`,
`POSTHOG_KEY`, `POSTHOG_HOST`. Those are scoped to a different operator
because they belong to other vendors' dashboards; set them with a
direct `fly secrets set` from a trusted shell. The env-validation tier
in `src/common/env-validation.ts` is unchanged, so a missing hard-tier
var still fails boot loudly.

Prerequisites:

1. The repo already has a `FLY_API_TOKEN` Actions secret (used by
   `Fly Deploy`).
2. Add three Actions secrets under
   Settings → Secrets and variables → Actions:
   - `STRIPE_SECRET_KEY` — `sk_live_…` from Stripe (live mode).
   - `STRIPE_WEBHOOK_SECRET` — `whsec_…` from the live webhook
     endpoint in Stripe → Developers → Webhooks.
   - `SENTRY_DSN` — server DSN from the production Sentry project.
   The workflow fails with a list of missing names if any of these
   are absent.

To run:

```sh
gh workflow run "Fly Secrets Set (operator)" \
  -f app=backend-spring-lake-3890 \
  -f confirm=SET
```

The `confirm=SET` input is a literal-string guard against accidental
dispatches from the GitHub UI.

What it logs:

- The names of the secrets that were set, and the output of
  `fly secrets list -a <app>` (which only includes name, digest, and
  created-at — never values).
- Validation that every expected name appears in the list.

What it does NOT do:

- It does not run `fly deploy`. `fly secrets set` itself triggers a
  Fly machine restart so the new env reaches the running process; no
  separate deploy is needed for a config-only change.
- It does not rotate keys. Rotation flow: rotate in the vendor
  dashboard → update the GitHub Actions secret → re-run this workflow
  → verify with `flyctl secrets list -a <app>` that the digest changed.

When to re-run:

- After rotating any of the Stripe or Sentry credentials.
- After changing one of the hardcoded public URLs (e.g. flipping
  `APP_STORE_URL` to the real App Store listing once it is approved).
  Update the workflow file in the same PR — the values are intentionally
  in source so the change is reviewable.

---

## 7c. Cross-product federation token rotation

`FINANCE_SERVICE_TOKEN` is a static service-to-service bearer used by
this backend to call the finance backend (`tgp-finance-app`) for the
admin console federation surface (`/admin/federation/*`,
`/admin/clients/:id/unified`, `/admin/finance/health`,
`/admin/integrations/status`). It must match on **both apps** at all
times — it is a single shared secret, not a pair of independent
credentials.

The two-app posture is the failure mode operators hit:

- Setting `FINANCE_SERVICE_TOKEN` on **only** the fitness app produces
  401s from the finance backend, surfaced as
  `finance.status="http_error"` on the unified payloads. The fitness
  side looks fine; the finance side is rejecting every call.
- Setting `FINANCE_SERVICE_TOKEN` on **only** the finance app produces
  `auth_unconfigured` from the federation service in this repo
  because the env var is unset; no network call is even attempted.
- Rotating on one side without the other puts the federation surface
  in a hard-broken state until the second side catches up. There is
  no graceful overlap.

Rotation procedure (do this in one short maintenance window):

1. Generate the new shared token (any opaque, high-entropy string —
   `openssl rand -hex 32` is fine).
2. Update the GitHub Actions secret `FINANCE_SERVICE_TOKEN` on **both**
   the fitness backend repo and the finance backend repo.
3. Push the new value to both Fly apps. From a trusted shell:

   ```sh
   fly secrets set -a <fitness-app> FINANCE_SERVICE_TOKEN=$NEW_TOKEN
   fly secrets set -a <finance-app> FINANCE_SERVICE_TOKEN=$NEW_TOKEN
   ```

4. Verify by hitting `/admin/finance/health` as an OWNER. The probe
   should return `status: ok` (or `not_found` against the well-known
   probe email — also healthy). `auth_unconfigured` or `http_error`
   means one side missed the rotation.
5. Until the digest changes on both `fly secrets list` outputs, the
   apps are still serving the old token (Fly secrets are write-only;
   see §1.1).

When **both** apps are missing the token, the federation surface
short-circuits to `auth_unconfigured` without making a network call —
that is the safe default. The dangerous state is one-side-only, which
the verification step above is designed to catch.

`FINANCE_API_BASE_URL` lives only on this backend; rotating the
finance app's hostname is a one-side change and does not require the
two-app dance.

---

## 8. Manual infra steps that this runbook does NOT automate

These are operator-only — the backend cannot do them on its own:

- Provision the Fly app, region, and IPv4/IPv6 addresses.
- **Add a `FLY_API_TOKEN` GitHub Actions repo secret.** Until this is set,
  the `Fly Deploy` workflow now **fails red** on every push to `main` —
  see §8.1 below. A red workflow is the intended signal that production
  is not deploying; a stale production binary running while the workflow
  silently green-skips is a release-blocker.
- Configure Supabase project (auth providers, JWT expiry, email templates).
- Configure Stripe account (products, webhook endpoint, customer portal).
- Configure Sentry / PostHog projects and copy DSN/key into Fly secrets.
  For production, push `SENTRY_DSN` (and the Stripe credentials) via the
  operator workflow described in §7b instead of a local shell.
- Wire DNS records for `api.*`, `console.*`, `app.*`.
- Provision the iOS Apple Universal Link / Android App Links files at
  `https://app.tgp.com/.well-known/apple-app-site-association` and
  `assetlinks.json` so deep links resolve to the installed app.

When these are complete, the deploy pipeline above takes over.

### 8.1 Provisioning `FLY_API_TOKEN` and triggering the first deploy

Run these steps once per repo+app pair. The token never lives in this
repo or in any `.env` file — it lives only in the GitHub Actions secret
store and in `fly tokens`.

1. **Generate a Fly deploy token scoped to the target app.** Deploy
   tokens are app-scoped and can be revoked individually, so prefer them
   over personal access tokens.

   ```sh
   fly tokens create deploy -a <app-name> --expiry 8760h
   ```

   Copy the token from the command output. It is shown only once.

2. **Add the token as a repository secret.** GitHub UI path:

   - Repository → **Settings** → **Secrets and variables** → **Actions**
   - **New repository secret**
   - Name: `FLY_API_TOKEN` (exact, case-sensitive)
   - Secret: paste the token from step 1
   - **Add secret**

   Or via `gh`:

   ```sh
   gh secret set FLY_API_TOKEN --app actions --body "$FLY_TOKEN_FROM_STEP_1"
   ```

3. **Trigger a deploy.** Either:
   - Push any commit to `main` (most common), or
   - Re-run the latest failed `Fly Deploy` workflow:
     `gh run list --workflow="Fly Deploy" --limit 1` then
     `gh run rerun <run-id>`.

4. **Watch the run go green.** The `Verify FLY_API_TOKEN is configured`
   step prints the token *length* (not the value) and the deploy
   proceeds. If the run still fails red, check the step log for one of:

   - `FLY_API_TOKEN GitHub Actions secret is not set` — the secret was
     not saved against this repository (check org-level vs repo-level).
   - `looks like a placeholder value` — the secret was saved with
     literal `<token>` / `REPLACE_ME` / similar; replace with the real
     token from step 1.
   - `suspiciously short` — only a fragment of the token was pasted.

5. **Confirm production is current.** After the workflow finishes:

   ```sh
   fly releases -a <app-name> | head -5
   gh api repos/:owner/:repo/commits/main --jq .sha   # main HEAD SHA
   ```

   The latest Fly release should match the deploy that just ran. If
   `fly releases` lags behind `main`, treat it as a stale-prod incident:
   the workflow may be green for a no-op reason (concurrency lock,
   manual `workflow_dispatch` against an old SHA). Re-trigger and watch
   `fly logs -a <app-name>` for the boot banner.

> **Stale production deploy is a release blocker.** Do not roll forward
> mobile or coach-console releases that depend on backend changes until
> `fly releases` shows the matching backend SHA. A green CI run on `main`
> is necessary but not sufficient — the deploy job must have actually
> uploaded an image. The `Fly Deploy` workflow is the contract; its red
> state is load-bearing.

---

## 9. App store readiness — public trust pages

The App Store and Google Play review processes require that the
listing point at real, reachable URLs for privacy policy, terms of
service, support contact, and (for Apple) a marketing/landing page.
We satisfy that requirement by serving durable, server-rendered
"trust" pages from this backend at the same `app.trygrowthproject.com`
host the invite-landing and download status pages already use.

| Page | URL | Purpose |
| --- | --- | --- |
| Privacy | `https://app.trygrowthproject.com/privacy` | Plain-language privacy policy. App Store / Play Store privacy URL. |
| Terms | `https://app.trygrowthproject.com/terms` | Terms of service. Required by Stripe Customer Portal business info and by app review. |
| Security | `https://app.trygrowthproject.com/security` | Practical security posture and incident-reporting channel. |
| Status | `https://app.trygrowthproject.com/status` | Honest description of public surface today; replace with a live status feed when monitoring is wired in. |

These pages live in `src/public-pages/` next to the existing
`/download/*` and `/signup` status pages, and they are excluded from
the `/api` global prefix in `src/main.ts` so they resolve as bare
paths under the public hostname.

What the operator should do when filing the App Store / Play Store
listing:

1. **Privacy URL** — paste `https://app.trygrowthproject.com/privacy`
   into App Store Connect → App Privacy and into Play Console →
   Policy → App content → Privacy policy.
2. **Terms / EULA URL** — paste
   `https://app.trygrowthproject.com/terms`. App Store Connect uses
   the standard Apple EULA by default; if you want to override it,
   point the EULA URL at `/terms`.
3. **Marketing / support URL** — paste
   `https://app.trygrowthproject.com/signup` (App Store Connect →
   App Information → Marketing URL) and `Bradley@Bradleytgpcoaching.com`
   as the support email.
4. **Stripe Customer Portal** — under Business Information, set
   privacy policy URL to `/privacy`, terms of service URL to `/terms`,
   and support email to `Bradley@Bradleytgpcoaching.com`.

Editorial guard rails (enforced by `test/trust-pages.spec.ts`):

- The pages name the **operator-confirmed** support contact
  (`Bradley@Bradleytgpcoaching.com`) on every page so a reviewer or
  customer always has a real human to email.
- The Security page lists transport, storage, auth, logging, vendor
  posture, and incident response in concrete terms. It explicitly
  states we do **not** currently hold SOC 2 / ISO 27001 / HIPAA
  certifications — making a fake claim is the failure mode this
  module is designed to prevent.
- The Status page lists today's real public endpoints and points at
  the support email for incident reporting. When a third-party
  monitoring feed is wired in, it can be embedded under the same URL
  without changing the contract published to the stores.
- Each page carries a `Last reviewed` date so reviewers and customers
  see freshness. Bump `POLICY_LAST_REVIEWED` in
  `src/public-pages/trust-pages.html.ts` when copy changes.

Reviewing copy with counsel: the pages are written as a company-drafted
statement of practice, not as legal text. Before any public launch
outside an invite-only beta, route the rendered copy through legal
review and update the file in a follow-up PR. A footnote on each page
already says this; counsel can sign off on or replace the language
without moving the URLs.

---

## 10. Deploy-affecting PR rule — operator docs must update with the code

Any PR that changes how the platform is deployed, configured, or
operated **must** update the operator-facing docs in the same PR. The
canonical surfaces are:

- `README.md` (root) — every env var, every feature flag, every route
  contract, and the README-with-every-PR rule itself.
- `docs/deploy-runbook.md` (this file) — secret matrix, deploy steps,
  rotation procedures, manual smoke.
- `docs/audit-and-gdpr.md` — when the change touches the audit log,
  GDPR lifecycle, scrub worker, or any privileged endpoint that writes
  audit rows.
- `.env.example` — when the change adds or removes an env var. The
  comment block above each variable is part of the contract; keep it
  current with the validator tier in `src/common/env-validation.ts`.
- The relevant module README (`src/<module>/README.md`) — when the
  change touches that module's surface.

A "deploy-affecting" change is anything an operator must do, set, or
verify to make the deploy land healthy. Concrete triggers:

- New or removed env var, or a tier change in `env-validation.ts`.
- New feature flag, or a default flip on an existing flag.
- New route that an operator must smoke-check, or a contract change
  on an existing route an operator already runs.
- New cron / worker / script (e.g. `scripts/gdpr-scrub.ts`).
- Migration that requires a baseline, a backfill, or an order-sensitive
  rollout (see §2.1, §3).
- Change to the secret-rotation procedure (Stripe, Sentry, Supabase,
  federation token).
- Any change that flips an external dependency (Stripe webhook URL,
  Supabase JWKS, finance backend host, App Store / Play listing).

Why this is a hard rule: the failure mode of a code-only change is a
deploy that boots green, passes the HTTP smoke, and silently breaks an
operator workflow that the runbook still describes the old way. The
operator then debugs against stale docs, which is slower and more
error-prone than reading the code directly. The fix is to keep the
runbook tight against the merge — same PR, same review, same blast
radius.

CI does not enforce this rule end-to-end. The narrowest piece of the
contract that is enforced is `test/route-doc-drift.spec.ts`, which
asserts that documented endpoint paths still resolve to controllers
that mount them. The rest is on the author and reviewer of the PR.
