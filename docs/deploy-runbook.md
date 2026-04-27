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
