# Staging Execution Tracker

Operator-facing checklist + executable command pack for standing up the
**staging** Growth Project backend. Companion to `docs/deploy-runbook.md`
(authoritative narrative) and `docs/stripe-setup.md` (Stripe specifics).

This file is the single tracker for the staging cutover: copy each block,
fill in the placeholders, run, and tick the checkbox. Do **not** commit
real secret values — every credential lives in `fly secrets` or your
local `.env.local`.

> Production runs the same sequence with different values and an extra
> confirmation step before every destructive command. Use the
> `TARGET_ENV=production` variants of the helper scripts to surface the
> exact production matrix.

---

## 0. Inventory & placeholders

Decide and record the values **before** running anything below. Keep this
table local; do not commit filled-in values.

| Placeholder | Meaning | Example |
| --- | --- | --- |
| `<staging-app>` | Fly app name for the staging API | `tgp-api-staging` |
| `<staging-ref>` | Supabase project ref for staging | `abcdefghij` |
| `<staging-db-url>` | Supabase session-pooler Postgres URL | `postgres://...pooler.supabase.com:5432/postgres` |
| `<console-origin>` | Coach console origin allowed by CORS | `https://console-staging.thegrowthproject.app` |
| `<api-host>` | Public hostname for the Fly app | `api-staging.thegrowthproject.app` |
| `<owner-emails>` | Comma-separated OWNER emails | `bradley@x.com,dynasia@x.com` |

Confirm tooling is present and authenticated:

```sh
flyctl version
flyctl auth whoami
supabase --version          # optional; only needed if linking via CLI
gh --version
node -v && npm -v
```

---

## 1. Print the required-secrets matrix (no values)

Use the helper to confirm the env matrix that boot will enforce. This
reads `src/common/env-validation.ts` so it never drifts from runtime.

```sh
# Human-readable table for staging:
TARGET_ENV=staging npm run secrets:print

# Same, formatted as a `fly secrets set` template with placeholder values:
TARGET_ENV=staging npm run secrets:print:fly

# Show what's CURRENTLY missing in your shell (exit 1 if any required
# var is unset). Useful right before `fly secrets set` to catch typos.
TARGET_ENV=staging npm run secrets:missing
```

Tick when the matrix matches what you expect to set:

- [ ] Reviewed `secrets:print` output for `TARGET_ENV=staging`.
- [ ] Reviewed `secrets:print` output for `TARGET_ENV=production`
      (preview only — not setting prod secrets in this run).

---

## 2. Supabase — link & migrate the staging project

Staging Supabase is a **separate project** from production. Never reuse
service-role keys across environments.

```sh
# 2.1 Confirm the staging Supabase project ref. Settings → General → "Reference ID".
echo "STAGING_SUPABASE_REF=<staging-ref>"

# 2.2 (Optional) Link the Supabase CLI to the staging project so dashboard
#     drift can be diffed locally. Auth uses `supabase login` browser flow.
supabase login
supabase link --project-ref <staging-ref>

# 2.3 Generate the Prisma client locally (no DB connection required).
npx prisma generate

# 2.4 Apply migrations against staging. Run from a workstation only when
#     you have the staging DB URL exported and have taken a backup. The
#     normal path is to let Fly's release_command apply them on deploy
#     (§4 below). Use this only for an ad-hoc sync.
DATABASE_URL="<staging-db-url>" npx prisma migrate deploy

# 2.5 If the DB has data and is not yet migration-managed, baseline rather
#     than db-push. See `scripts/release.sh` lines 35-55 for the runtime
#     guard logic and `docs/deploy-runbook.md` §3 for the full procedure.
```

Tick:

- [ ] Supabase staging project identified (`<staging-ref>`).
- [ ] Auth providers, JWT expiry, email templates set in Supabase
      dashboard (manual — see deploy-runbook §8).
- [ ] `prisma migrate deploy` succeeded (or deferred to release_command).

---

## 3. Fly — provision the staging app & secrets

```sh
# 3.1 Provision (skip if `<staging-app>` already exists).
fly apps create <staging-app> --org <fly-org>
fly ips allocate-v4 -a <staging-app>
fly ips allocate-v6 -a <staging-app>

# 3.2 Confirm the app & current secret names (no values are printed).
fly status -a <staging-app>
fly secrets list -a <staging-app>

# 3.3 Set the required secrets in one shot. Generate the template with:
TARGET_ENV=staging npm run secrets:print:fly
#
#     Fill in real staging values, then run a single `fly secrets set`
#     command — Fly batches and triggers exactly one restart.
#
#     Example skeleton (DO NOT COMMIT FILLED VALUES):
fly secrets set -a <staging-app> \
  NODE_ENV=staging \
  DATABASE_URL=<staging-db-url> \
  SUPABASE_URL=https://<staging-ref>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<svc-role> \
  PUBLIC_INVITE_BASE_URL=https://staging.thegrowthproject.app/join \
  PUBLIC_WEB_SIGNUP_URL=https://staging.thegrowthproject.app/signup \
  APP_STORE_URL=https://apps.apple.com/app/idXXXXXXXXX \
  PLAY_STORE_URL=https://play.google.com/store/apps/details?id=YOUR_ID \
  CORS_ORIGINS=<console-origin> \
  STRIPE_SECRET_KEY=sk_test_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  STRIPE_PRICE_ID_FITNESS=price_... \
  SENTRY_DSN=https://<key>@o0.ingest.sentry.io/0
```

Tick:

- [ ] Fly app `<staging-app>` exists and shows IPs allocated.
- [ ] All HARD + PROD-tier secrets set (compare with §1 output).
- [ ] `CORS_ORIGINS` lists explicit origins — no `*`.
- [ ] `STRIPE_SECRET_KEY` starts with `sk_test_` (NOT `sk_live_`).
- [ ] No secret value is a literal placeholder (`<...>`, `XXXXXXXX`,
      `REPLACE_ME`, `changeme`). Boot rejects these by name; rerun
      `TARGET_ENV=staging npm run secrets:missing` against the staging
      shell to confirm the `placeholder` rows are empty.
- [ ] `FLY_API_TOKEN` is set as a GitHub Actions repository secret. The
      `Fly Deploy` workflow now **fails red** on push to `main` when this
      is unset — see `docs/deploy-runbook.md` §8.1 for the provisioning
      and trigger steps.

---

## 4. Deploy & first boot

```sh
# 4.1 Tag the commit you intend to deploy.
git tag -a staging-$(date +%F) -m "staging deploy $(date +%F)"
git push origin staging-$(date +%F)

# 4.2 Deploy from the tagged commit. release_command runs first
#     (scripts/release.sh: prisma migrate deploy, with guarded fallback).
fly deploy -a <staging-app> --remote-only

# 4.3 Tail the boot log. You want to see the env validation log line.
fly logs -a <staging-app>
#   Healthy boot prints:
#     [Bootstrap] Env validation passed for NODE_ENV=staging. ...
#     [Bootstrap] The Growth Project API running on port 3000

# 4.4 If the deploy aborts on release_command, fix the migration and
#     redeploy. Fly leaves the previous machines running on abort.
```

Tick:

- [ ] `fly deploy` exit code 0.
- [ ] Boot log shows `Env validation passed for NODE_ENV=staging`.
- [ ] No unexpected `WARN` lines about missing prod-tier vars.

---

## 5. OWNER bootstrap

After the first deploy that includes the OWNER + CoachProfile migration,
promote the OWNER emails. The script is idempotent.

```sh
# 5.1 Preferred — run inside a Fly machine so DATABASE_URL stays out of
#     local shells.
BOOTSTRAP_OWNER_EMAILS="<owner-emails>" \
  fly ssh console -a <staging-app> -C "node dist/scripts/bootstrap-owners.js"

# 5.2 Alternative — run locally against staging DB (read/write).
BOOTSTRAP_OWNER_EMAILS="<owner-emails>" \
  DATABASE_URL="<staging-db-url>" \
  npx ts-node scripts/bootstrap-owners.ts

# 5.3 Verify owners can hit BFF + admin endpoints once they sign in
#     against the staging Supabase project:
#       GET  /api/v1/coach/me           → 200
#       POST /api/admin/promote-coach   → 200
```

Tick:

- [ ] `bootstrap-owners` printed `promoted=N skipped_missing=0 ...`.
- [ ] At least one OWNER reached `/api/v1/coach/me` with a 200.

---

## 6. Stripe — staging (test mode) wiring

Reference: `docs/stripe-setup.md` §1–2 (product/price), §3 (webhooks),
§6 (account separation). No code change required — every step is in the
Stripe dashboard or via Fly secrets.

```sh
# 6.1 Confirm staging is using test-mode keys (sk_test_ prefix).
fly ssh console -a <staging-app> -C "node -e 'console.log((process.env.STRIPE_SECRET_KEY||\"\").startsWith(\"sk_test_\"))'"

# 6.2 Local replay smoke (no Stripe account needed) — proves the webhook
#     handler + signature gate work end-to-end against the running boot.
NODE_ENV=development \
  STRIPE_WEBHOOK_SECRET=whsec_local_test \
  npx ts-node scripts/stripe-webhook-smoke.ts

# 6.3 Real test-mode webhook spot-check using the Stripe CLI (auth via
#     `stripe login` browser flow — the CLI never reads from this repo):
stripe login
stripe listen --forward-to https://<api-host>/api/v1/webhooks/stripe
#   In another shell:
stripe trigger invoice.paid
#   Expect: a 2xx in the Fly log and a row in the Stripe event log.
```

Tick:

- [ ] `STRIPE_SECRET_KEY` confirmed `sk_test_` in staging.
- [ ] Webhook endpoint configured in Stripe dashboard pointing at
      `https://<api-host>/api/v1/webhooks/stripe`.
- [ ] `STRIPE_WEBHOOK_SECRET` matches that endpoint's signing secret.
- [ ] `stripe trigger` produced a 2xx in Fly logs.

Production live-mode switch is **not** part of this tracker — see
`docs/stripe-setup.md` §6 and `docs/deploy-runbook.md` §6.

---

## 7. CORS / coach console env

The coach console is hosted out of `tgp-coach-console` and reads its
backend URL from its own env. Backend-side only:

```sh
# 7.1 Confirm CORS_ORIGINS lists the console origin exactly (scheme +
#     host + port). Wildcard is rejected at boot.
fly secrets list -a <staging-app> | grep CORS_ORIGINS

# 7.2 If you need to add origins (e.g. preview deploys):
fly secrets set -a <staging-app> \
  CORS_ORIGINS="https://console-staging.thegrowthproject.app,https://console-preview-*.vercel.app"
```

Console-side env (not in this repo) must include:

```text
NEXT_PUBLIC_API_BASE_URL=https://<api-host>
NEXT_PUBLIC_SUPABASE_URL=https://<staging-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
```

Tick:

- [ ] `CORS_ORIGINS` includes every console origin you expect to use.
- [ ] Coach console can call `GET /api/v1/coach/me` without a CORS error.

---

## 8. Smoke tests

```sh
# 8.1 Backend smoke — no Stripe/Supabase creds needed.
SMOKE_BASE_URL=https://<api-host> npm run smoke:staging
#   PASS criteria are encoded in scripts/smoke.ts:
#     - GET /health → 200 { ok: true }
#     - GET /api/auth/signup-policy → 200 JSON
#     - GET /api/invite/<code>/preview → 200 or 404 JSON
#     - GET /api/v1/coach/me → 401 (BFF mounted + guarded)
#     - POST /api/v1/webhooks/stripe (no signature) → 400
#     - GET /join/<code> → text/html, no 5xx
#     - GET /api/ai/context/preview → 401 without SMOKE_TOKEN

# 8.2 Optional — include the AI context check with a real Supabase JWT.
SMOKE_BASE_URL=https://<api-host> SMOKE_TOKEN="$STAGING_JWT" npm run smoke:staging

# 8.3 Optional — exercise an actual invite code preview.
SMOKE_BASE_URL=https://<api-host> SMOKE_INVITE_CODE=GP-XYZ12 npm run smoke:staging
```

Tick:

- [ ] `smoke:staging` printed `[smoke] all checks passed`.

---

## 9. End-to-end QA sweep

After smoke is green, run the manual cross-repo QA sweep documented in
`docs/e2e-qa-runbook.md`. Section index:

- §1 — Test environment + seed data
- §2 — Owner onboarding (promote + bootstrap-owners verification)
- §3 — Coach onboarding via OWNER (`/admin/promote-coach`)
- §4 — Student signup via email + invite code
- §5 — Student signup via Google + invite code
- §6 — Coach↔client messaging + nudges
- §7 — Stripe billing gating (test-mode `BILLING_ENFORCEMENT` flip)
- §8 — Negative paths (gate enabled, expired invite, inactive coach)

Tick:

- [ ] e2e §1–§5 passed (auth, invite, signup-policy, attach-invite-code).
- [ ] e2e §6 passed (BFF messaging end-to-end).
- [ ] e2e §7 passed under `BILLING_ENFORCEMENT=observe` (rollout default).
- [ ] e2e §8 negative paths produced the expected 4xx codes.

---

## 10. Final flag flip & sign-off

Per `docs/deploy-runbook.md` §4, flip flags only after every coach is
onboarded:

```sh
# 10.1 Enable the invite-code gate once every coach has a CoachProfile
#      with an invite_code (re-deploy for the change to take effect).
fly secrets set -a <staging-app> COACH_CODE_GATE_ENABLED=true
fly deploy -a <staging-app> --remote-only

# 10.2 Move billing from observe → enforce only after every active coach
#      has a CoachSubscription row.
fly secrets set -a <staging-app> BILLING_ENFORCEMENT=enforce
fly deploy -a <staging-app> --remote-only
```

Tick:

- [ ] Operator sign-off recorded with date + git SHA of the deploy.
- [ ] Production cutover scheduled (separate ticket; see deploy-runbook §6).

---

## Appendix A — Quick reference

```sh
# What env vars does staging need?
TARGET_ENV=staging npm run secrets:print

# What's missing in my current shell?
TARGET_ENV=staging npm run secrets:missing

# Generate a `fly secrets set` template:
TARGET_ENV=staging npm run secrets:print:fly

# Validate locally before deploy:
NODE_ENV=staging npm run env:check

# Smoke a deployed staging environment:
SMOKE_BASE_URL=https://<api-host> npm run smoke:staging

# Replay a Stripe webhook locally (no live Stripe account):
STRIPE_WEBHOOK_SECRET=whsec_local_test npx ts-node scripts/stripe-webhook-smoke.ts
```

## Appendix B — Cross-references

- `docs/deploy-runbook.md` — narrative deploy procedure + rollback.
- `docs/stripe-setup.md` — Stripe dashboard config + live-mode switch.
- `docs/e2e-qa-runbook.md` — cross-repo manual QA sweep.
- `docs/invite-landing.md` — `/join/:code` HTML contract.
- `docs/coach-console-integration.md` — BFF contracts the console consumes.
- `src/common/env-validation.ts` — source of truth for ENV_RULES.
- `scripts/release.sh` — Fly release_command (migrations + guarded baseline).
- `scripts/bootstrap-owners.ts` — OWNER promotion + invite-code backfill.
- `scripts/smoke.ts` — post-deploy smoke checks.
- `scripts/print-required-secrets.ts` — env matrix printer (this PR).
