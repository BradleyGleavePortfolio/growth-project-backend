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
| `REDIS_URL` | prod (feature-tier; warn-only) | `redis://` or `rediss://` URL backing the rate-limit storage. Required once the app runs on >1 Fly machine — without it, throttler counters are per-machine and an attacker can multiplex across replicas. Boot logs the chosen backend at LOG level under `ThrottlerConfig`. Use the Fly-managed Upstash add-on (`fly redis create`) or a managed instance. |
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

3. **Take a reference dump before any deploy that includes a migration**,
   and be precise about what it is:

   ```sh
   pg_dump "$STAGING_DATABASE_URL" \
     --file backups/staging-$(date +%F-%H%M).sql
   ```

   Store the dump somewhere durable (1Password vault attachment, S3
   bucket, etc.) — never commit it. Do **not** add `--no-owner --no-acl`:
   the S1 privilege/RLS migration's state *is* owners, grants and
   policies, and a dump that excludes them cannot reproduce it. Even a
   full dump is a reference copy for diagnosis and comparison; **this
   repository contains no demonstrated restore procedure for a live
   database** (no drill, no ACL/owner restoration proof), so a dump load
   must not be presented or planned as the rollback route (see §3 step 4).

4. **Deploy.**

   ```sh
   fly deploy -a <staging-app> --remote-only
   ```

   The `release_command` (see `scripts/release.sh`) runs first: verifier
   contract preflight, `prisma migrate status`, `prisma migrate deploy`,
   status re-check, catalog verifiers (§11.2). If status reports P3005
   (schema present but not baselined) the release **aborts** with a
   pointer to §2.1. There is **no** `db push --accept-data-loss` fallback
   and no `RELEASE_ALLOW_DB_PUSH` switch in the current script; earlier
   revisions of this runbook described one that no longer exists.

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
proceed (P3005 abort in step 1, see `scripts/release.sh`). There is no
automatic fallback of any kind.

This is a one-time setup — once baselined, every subsequent deploy
just runs `prisma migrate deploy` cleanly. The baseline contract:

1. **Empty DB** (greenfield staging): no action needed. `prisma migrate
   deploy` creates the schema and seeds `_prisma_migrations` itself.
2. **Populated DB that was built by a prior `prisma migrate deploy`**:
   `_prisma_migrations` already exists. No action needed.
3. **Populated DB that was NOT built by Prisma** (manual schema, raw
   SQL, restored from a non-Prisma source): a baseline is required before
   the first deploy, and **marking migrations applied is a claim about the
   schema, not a fix for it**. `prisma migrate resolve --applied <name>`
   writes a ledger row without checking that the DDL is present; looping
   it over every directory fabricates history and a later
   `migrate deploy` would then skip migrations the database never
   received. The established route is:

   1. prove equivalence first — `prisma migrate diff --from-url
      "$DIRECT_URL" --to-migrations prisma/migrations --shadow-database-url
      <disposable DB>` must report no difference (or every difference must
      be understood and closed by a forward migration);
   2. only then mark the *proven-present* migrations applied, one by one,
      from a trusted shell against `DIRECT_URL`, under separate production
      authorization, recording the diff output alongside;
   3. re-dispatch `Fly Deploy`; step 1 must now show no P3005 and step 4's
      catalog verifier must pass — the verifier, not the ledger, is the
      truth about the S1 privilege/RLS state.

   This procedure has **not** been drilled against the production
   database in this repository; treat it as the required shape of the
   work, not as a completed proof.

**Never run `prisma db push --accept-data-loss` against a database that
holds real data.** The release command has no such path; do not add one
by hand.

## 3. Migration backup & rollback

For every migration:

1. **Backup before deploy** with `pg_dump` (§2 step 3).
2. **Run the migration via the release command** (Fly auto-runs it; do
   not invoke `prisma migrate deploy` from your laptop against the
   prod DB).
3. **If the deploy aborts**, first *observe* what is running — do not
   presume it. A `release_command` failure means Fly did not roll out the
   new image, but confirm with `fly machines list -a <app>` (or the
   `machines-before.json` manifest) that the previous image is still
   serving; `verify-fly-release.sh`/`/readyz` can also fail *after* the
   rollout, in which case the new image is serving (stage C in
   `docs/delivery-controls.md` §7). Then *where* it aborted decides
   whether the database changed:
   - **`release.sh` step 0 or 1** (verifier contract preflight, status
     check), the evidence gate, or the image build: nothing was applied.
     Fix forward and re-dispatch; no production action.
   - **`release.sh` step 2 or later** (`prisma migrate deploy` ran, then a
     status/verifier/accounting step refused): applied migrations **stay
     applied** while machines keep the old image — the database may be
     ahead of the running code. Follow §11.4 before re-dispatching. Never
     "undo" this by deleting the migration directory (see step 4).
4. **If the deploy succeeded but the new code is broken**, the gated
   path is **forward-only**: revert the offending *code* on `main` through
   a reviewed PR, let CI / CodeQL / SBOM run on the new head, then dispatch
   `Fly Deploy` with that head as `release_sha` (see
   `docs/delivery-controls.md` §7). The gate accepts only the current
   `main` head (`release_sha == github.sha`); **re-dispatching an older
   sha is refused**, so "re-run the previous release" is not a recovery
   route.

   A revert commit must **never delete or edit an applied migration
   directory**: `prisma migrate deploy` would then find a history mismatch
   and refuse — that fails the *next* release closed, it does not roll the
   schema back. Revert application code only; if schema must move, ship a
   new forward migration (S1-owned content).

   The previous running image is recorded in the release manifest
   (`machines-before.json`, field `image_ref.tag`). Read the tag from there
   — do not derive it from a commit. For the **first gated release** the
   running production image (GH_SHA `5076a07a`, deployed 2026-09-18 outside
   this workflow) carries a Fly `deployment-*` tag, not `sha-*`; only
   images built by `Fly Deploy` are tagged `sha-<release_sha>`.

   **Emergency, UNGATED route** (bypasses the evidence gate and
   `verify-fly-release.sh`; record who ran it and why, and follow with a
   gated release):

   ```sh
   fly releases -a <app>
   fly deploy -a <app> --image registry.fly.io/<app>:<image_ref.tag from machines-before.json>
   ```

   Before using it, establish **explicitly** that the previous image is
   compatible with the schema now in the database — "the migration was
   additive" is not that proof. Check: (a) the applied migration list
   (`_prisma_migrations` via `DIRECT_URL`) against the previous image's
   `prisma/migrations`; (b) for privilege/RLS migrations such as S1's
   `20261224000000_rls_close_public_exposure`, that every role the previous
   image connects as still holds the privileges its queries need (the
   migration deliberately removes grants and adds policies; an older
   caller may lose access rather than "keep working"); (c) that the
   catalog verifier still passes after the code rollback. If (b) fails,
   the recovery is a forward code fix, not an image rollback.

   Restoring a database from a dump is **not** an established procedure
   here: a `pg_dump` load into a database that has since changed is
   undemonstrated, and no owner/ACL restoration, drain/containment or
   key-rotation drill exists in this repository. Do not schedule it as the
   recovery for a destructive or privilege migration; treat such a
   migration as requiring its own reviewed reverse migration (S1-owned
   content) before it ships.

5. **After any rollback or restore, run the catalog verifiers** —
   `prisma migrate status` reads `_prisma_migrations`, not the catalog, and
   will say "up to date" after an out-of-band `down.sql`. Truth is
   `prisma/migrations/<m>/verify.sql` (run automatically by
   `scripts/release.sh` step 4 on the next release). Do **not** run
   `prisma migrate resolve --rolled-back` for a migration that *succeeded*
   and was reversed by hand: it refuses (P3012) or no-ops if an older failed
   row exists. Re-apply forward transactionally instead
   (`psql "$DIRECT_URL" --single-transaction -v ON_ERROR_STOP=1 -f migration.sql`),
   then the verifier. See `docs/delivery-controls.md` §7.1.

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
3. `GET /api/admin/users?limit=5` — 200, `{ users: [...], next_cursor }` envelope.
4. `GET /api/admin/coaches` — 200, `{ coaches: [...], next_cursor }` envelope.
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
| Deploy aborted on `release_command` at step 0/1 (`FAIL at line` inside the preflight/status block; log shows no `step 2:`). | Nothing applied — Fly keeps the previous machines and the schema is unchanged. Fix forward (missing/invalid required-verifier contract, P3005 baseline, connectivity), re-dispatch. |
| Deploy aborted on `release_command` at step 2 or later (log shows `step 2: applying pending migrations` before the failure). | Fly keeps the previous machines **but applied migrations stay applied**. Do not delete the migration directory. Follow §11.4: read `_prisma_migrations`, decide fix-forward vs. transactional manual reverse (S1 content, separate authorization), then re-dispatch. |
| `release_command` refused at step 4 `catalog verifier FAILED`. | Schema drift or incomplete migration detected in `pg_catalog` after `migrate deploy`. The migration rows say applied; the catalog disagrees. Investigate the named `verify.sql`; §11.4 step 6. |
| `release_command` failed with `./scripts/release.sh: 25: set: Illegal option -` (or any `set: Illegal option -<single-char>`). | CRLF in a shell script. `dash` (Debian's `/bin/sh`) rejects `set -e\r` because it treats the `\r` as a flag character. Fix: ensure `scripts/*.sh` are committed with LF endings (enforced by `.gitattributes`), and that `fly.toml`'s `release_command` invokes the script via `bash ./scripts/release.sh` rather than `sh ./scripts/release.sh`. To audit locally: `git ls-files -z 'scripts/*.sh' \| xargs -0 file \| grep CRLF` should return nothing. To repair an in-tree CRLF script: `dos2unix scripts/release.sh && git add scripts/release.sh && git commit -m 'fix: normalize release.sh to LF'`. |
| App boots but env-validation throws. | Add the missing secret, redeploy. Boot logs identify the missing var. |
| Health endpoint stays red after deploy. | `Fly Logs (operator)` workflow (read-only, `fly-logs.yml`) or `fly logs -a <app>` for the stack trace. If unrelated to schema, roll back the *code* via a revert PR through the gated path; the ungated image route in §3 is emergency-only and its target tag comes from `machines-before.json`. |
| Stripe webhooks 400-ing in production. | Verify `STRIPE_WEBHOOK_SECRET` matches the live endpoint. Check Sentry for the rejection reason. |
| Coach console hits CORS error. | Check `CORS_ORIGINS` for the exact origin (scheme + host + port). Wildcard is rejected. |
| Invite landing page empty. | Verify `PUBLIC_INVITE_BASE_URL`, `APP_STORE_URL`, `PLAY_STORE_URL`, `PUBLIC_WEB_SIGNUP_URL`. Empty values fall through to placeholder defaults baked into `invite-landing.controller.ts`. |
| Need to fully roll back a destructive or privilege/RLS migration. | No demonstrated restore route exists (§3 step 4). Ship a reviewed forward reverse migration (S1-owned) and, if the previous image must serve meanwhile, prove caller/schema compatibility explicitly first. |

### 7.1 Shell script line-ending hazard (release_command)

**Failure signature.** Fly release log shows the deploy aborting before any migration runs, with a line like:

```
./scripts/release.sh: 25: set: Illegal option -
```

The trailing dash is literal — there is no flag character after it because Dash (Debian's `/bin/sh`, the interpreter Fly's release VM uses for `sh ./scripts/release.sh`) is reading `set -e\r` and printing the truncated error.

**Root cause.** A shell script committed with CRLF line endings. `dash` does not strip the trailing `\r` before parsing builtin arguments; `bash` is more forgiving but the only durable fix is to keep CRLF out of these files in the first place.

**Standing prevention rule.** Every shell script that runs inside the Fly image (anything under `scripts/*.sh`, plus any helper sourced by `Dockerfile` or `release_command`) **must**:

1. Be committed with LF line endings. Enforced repo-wide by `.gitattributes` (`*.sh text eol=lf`). A Windows clone that converts on checkout cannot push CRLF back without git rewriting it.
2. Use `#!/usr/bin/env bash` as the shebang and be invoked through `bash` from `fly.toml`'s `release_command` (currently `bash ./scripts/release.sh`). bash is present in `node:20-slim`, tolerates the occasional stray CR more gracefully, and gives consistent semantics for `set -euo pipefail`-style guards if they are added later.
3. Be audited locally before any Fly deploy: `git ls-files -z 'scripts/*.sh' | xargs -0 file | grep -i CRLF` should return nothing.

**Repair recipe.** If a CRLF script is already in the tree:

```sh
dos2unix scripts/release.sh   # or: sed -i 's/\r$//' scripts/release.sh
git add scripts/release.sh
git commit -m "fix(deploy): normalize release.sh to LF (dash rejects CRLF)"
git push
fly deploy -a <app>           # release_command will now succeed
```

This is a **deploy hygiene rule**, not a one-off. It belongs alongside the JWT/Supabase/federation rotation rules in the operator-mismatch family — same shape, same blast radius (a clean rollback because no machines flipped), same prevention pattern (durable repo-level guard + a one-line audit command).

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
- **Add a `FLY_API_TOKEN` GitHub Actions secret** (repository-level today;
  the intended home is the `production` environment, see
  `docs/delivery-controls.md`). Merging to `main` no longer deploys;
  `Fly Deploy` runs only on explicit dispatch and **fails red** if the
  token is missing — see §8.1 below. A red workflow is the intended
  signal; a silently green-skipping workflow is a release-blocker.
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

3. **Trigger a deploy** — always an explicit dispatch from `main` with the
   exact commit (pushing to `main` does not deploy):

   ```sh
   SHA=$(git rev-parse origin/main)
   gh workflow run fly-deploy.yml --ref main -f release_sha="$SHA" -f confirm=deploy
   # add -f migrations=apply-migrations ONLY when prisma/migrations or schema changed
   ```

   The `Release evidence gate` job must pass and the `production`
   environment reviewer must approve before anything reaches Fly.

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

## 11. Release-command contract (scripts/release.sh)

The `release_command` declared in `fly.toml` runs `bash scripts/release.sh`
in a one-off Fly VM every time `flyctl deploy` ships a new image. It is
the only mechanism that applies Prisma migrations to production.

This script is the load-bearing safety rail between "the code in `main`"
and "the schema in `db.rpyfdsgxxltzutgqeouk.supabase.co`". It MUST:

- **Succeed visibly** — exit 0 only after Prisma confirms the DB is up to
  date. The success line `[release] ALL_APPLIED=<n>` is what monitoring
  greps for.
- **Fail visibly** — exit non-zero on any unhandled error. The `trap on_error`
  prints the failing line and the last 60 lines of Prisma's output. Fly
  aborts the deploy on non-zero exit and existing machines keep running.
- **Be idempotent** — re-running with no new migrations is a no-op.

### 11.1. Why `set -Eeuo pipefail` is non-negotiable

A prior version of this script used `if cmd | tee log; then`. Without
`pipefail` a pipeline returns the exit code of the LAST command (always
`tee` → always 0). `prisma migrate deploy` failed silently for **weeks**
in May 2026 — production drifted ~25 migrations behind without any
deploy turning red. The shell flags now in place make that mode of
silent failure structurally impossible.

| Flag | What it catches |
|------|-----------------|
| `-E` | ERR trap inherited by functions / subshells / `$(...)` |
| `-e` | Exit on any unhandled non-zero exit code |
| `-u` | Unset variable = error (catches typos in env var names) |
| `-o pipefail` | Pipeline exit = first non-zero, not last command |

If you ever need to "tolerate" a failure (e.g. `migrate status` returning 1
when migrations are pending), guard the specific call with `|| true` and
inspect the captured output. Never `set +e`.

### 11.2. The steps

0. **Verifier contract preflight** (no database contact) — enumerate
   `prisma/migrations/*/verify.sql` through a checked pipeline and require
   `scripts/release-required-verifiers.txt` to exist, list ≥1 bare
   migration directory name (no `/`, no `..`, no duplicates, no CRLF), and
   have every entry resolve to a discovered `verify.sql`. Any failure exits
   non-zero **before** `migrate deploy`; a broken enumeration is never read
   as "zero verifiers". The contract path is pinned (no env override).
1. **Status check** — `prisma migrate status` enumerates pending migrations
   and (critically) surfaces a P3005 "not baselined" error before we touch
   anything. P3005 aborts the release with a runbook pointer to §2.1 of
   this document; we never auto-`db push --accept-data-loss` from CI.
   On the pinned Prisma 6.19.3 the pending list is printed as bare
   migration names under "have not yet been applied:", which is what
   `pending_migrations_detected` counts.
2. **Apply** — `prisma migrate deploy`. Forward-only. Never resets the DB.
   Stops at the first migration that fails and propagates the exit code.
3. **Verify** — re-run `migrate status` and require the literal string
   `Database schema is up to date` or `No pending migrations`. This catches
   the (rare) class of failure where `migrate deploy` claims success but
   leaves a partially-applied migration row in `_prisma_migrations`. It
   attests **only the ledger**: a migration marked `rolled_back_at` by
   `prisma migrate resolve --rolled-back` also satisfies "up to date" on
   Prisma 6.19.3 (observed in the real composition run, S1S2-B-07), and an
   out-of-band reversal is invisible to it. Step 4 is the truth.
4. **Catalog verifiers** — run every `verify.sql` discovered in step 0 via
   `prisma db execute --url "$DIRECT_URL" --file <verifier>`; a `RAISE`
   is a non-zero exit and fails the release. Then assert
   `ran == discovered ≥ required ≥ 1`. Verifier content is S1-owned.

### 11.3. Observing a release

```
fly logs -a backend-spring-lake-3890 --no-tail \
    | grep '\[release\]'
```

The structured banner at the top of each run prints `machine_id`, `git_sha`,
`release_ver`, Node and Prisma versions. On success the script emits a single
grep-able final line:

```
[release] ✔ release_command completed successfully
[release]   ALL_APPLIED=<count>
[release]   pending_before=<n>
[release]   verifiers_passed=<ran> verifiers_required=<required>
[release]   release_id=<machine-id>
```

The `FAIL` banner is printed by an EXIT/ERR trap; a process killed
outright (SIGKILL/OOM, release machine destroyed) prints nothing — in that
case Fly's release status is the only signal.

### 11.4. Recovery — what to do if a release_command fails

1. Read the `[release] ❌ FAIL` block in `fly logs`. It contains the failing
   line in `release.sh` and the last 60 lines of Prisma's output.
2. The rollout is aborted by Fly: existing app machines keep the previous
   image. **Determine the stage** before anything else:
   - failure before `step 2: applying pending migrations` appears (step 0
     contract preflight, step 1 status): the database is untouched;
   - failure after it (step 2 migrate deploy, step 3 status, step 4
     verifiers): migrations that `migrate deploy` applied remain applied.
     The database may now be ahead of the running code. Read
     `_prisma_migrations` (`DIRECT_URL`) to see exactly which.
3. If the failure is a transient DB connectivity issue (P1001) at step 1/2,
   re-run the workflow from GitHub Actions — no code change needed.
4. If a migration is genuinely broken: **do not delete its directory** in
   the revert (the next `migrate deploy` would refuse on history mismatch).
   Ship a fix-forward migration, or — if the applied change must be
   reversed — a transactional manual reverse under separate production
   authorization (`psql "$DIRECT_URL" --single-transaction -v
   ON_ERROR_STOP=1 -f <reverse.sql>`), then re-dispatch the current `main`.
   Migration/verifier content is S1-owned.
5. If `_prisma_migrations` holds a *failed* row (`finished_at IS NULL`,
   `rolled_back_at IS NULL`) for the S1 migration — its DDL ran in one
   transaction and was rolled back — the operator runs
   `prisma migrate resolve --rolled-back <name>` against `DIRECT_URL` and
   **re-dispatches the release**: `migrate deploy` re-applies it (proven on
   the disposable PG 17.6 fixture, control C8). Do not use `--applied` on a
   failed row unless the catalog has been verified to contain the DDL — it
   would only fabricate history. This is a deliberate manual step — CI never
   resolves migrations.
5b. After `resolve --rolled-back`, `prisma migrate status` reports
   "Database schema is up to date" although the migration is not applied
   (S1S2-B-07). Never read that as done: always re-run the release and let
   step 4's catalog verifier decide.
6. If step 4 reports `catalog verifier FAILED: prisma/migrations/<m>/verify.sql`:
   the migration rows say applied but `pg_catalog` disagrees (out-of-band
   reversal, partial DDL, missing grant/policy). Do **not** run
   `prisma migrate resolve --rolled-back` for a migration that succeeded.
   Re-apply forward transactionally and re-run the verifier by hand, then
   re-dispatch. See `docs/delivery-controls.md` §7.1.
7. If step 0 reports `REQUIRED catalog verifier missing` or a contract
   error: the image is incomplete or `scripts/release-required-verifiers.txt`
   is malformed. Nothing touched the database. Fix the candidate (compose
   the S1 migration / correct the contract) and re-dispatch.
