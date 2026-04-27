# scripts

Operator-facing utilities. None of these run automatically as part of
the request path — every script is invoked manually or by a CI / Fly
release-command step.

## Inventory

| Script | Purpose |
|---|---|
| `release.sh` | Fly `release_command`. Runs `prisma migrate deploy`; falls back to a guarded `db push` only when explicitly authorized. |
| `bootstrap-owners.ts` | Promote a fixed list of OWNER emails and back-fill `CoachProfile` rows for existing coaches. Idempotent. |
| `print-required-secrets.ts` | List required / prod-required / optional env vars for a target `NODE_ENV`. Multiple output formats: `table`, `fly`, `env`, `missing`. |
| `smoke.ts` | Post-deploy smoke check against a running API. Hits public + 401 paths and exits non-zero on first failure. |
| `stripe-webhook-smoke.ts` | Replay Stripe fixture events at a running dev server. No real Stripe account required. |

## release.sh

Runs once per Fly deploy in a one-off VM with the full env. Two-step
behavior:

1. `npx prisma migrate deploy`. Succeeds → exit 0.
2. On a baseline-not-found error (`P3005`, "database schema is not
   empty", "is not managed by Prisma Migrate", "No migration found")
   the script falls back to `prisma db push --accept-data-loss` — but
   only when both:
   - `RELEASE_ALLOW_DB_PUSH=1` is set as a Fly secret, and
   - the database has no `_prisma_migrations` table.

   If a `_prisma_migrations` table already exists, the script
   **aborts** rather than push — silently orphaning a populated
   migration history is the failure mode this guard exists to prevent.

3. Any other migrate-deploy failure → non-zero exit. Fly aborts the
   deploy and existing machines keep running.

`RELEASE_ALLOW_DB_PUSH` is intentionally unset in production. Setting
it is the operator's signal that the database is empty / test data
only.

## bootstrap-owners.ts

Phase 1A bootstrap — run after the OWNER + `CoachProfile` migration
is applied. Two idempotent jobs:

1. Promote a fixed list of emails to `role = owner`.
2. For every coach without a `CoachProfile`, create one with a
   unique `invite_code`.

```bash
npx ts-node scripts/bootstrap-owners.ts
BOOTSTRAP_OWNER_EMAILS="alice@example.com,bob@example.com" \
  npx ts-node scripts/bootstrap-owners.ts
```

Re-running is safe — existing rows are not modified.

## print-required-secrets.ts

Reads `ENV_RULES` from `src/common/env-validation.ts` so the listing
stays in sync with what the boot enforces. No secret values are read
or written; only env var names and placeholder values.

```bash
# Default — staging table
npx ts-node scripts/print-required-secrets.ts

# Production rules
TARGET_ENV=production npx ts-node scripts/print-required-secrets.ts

# Fly secrets template
TARGET_ENV=staging FORMAT=fly npx ts-node scripts/print-required-secrets.ts

# .env stub
TARGET_ENV=staging FORMAT=env npx ts-node scripts/print-required-secrets.ts

# Show which required vars are missing in your shell now (exits 1 if any)
TARGET_ENV=staging FORMAT=missing npx ts-node scripts/print-required-secrets.ts
```

This is the script the deploy runbook recommends running before
`fly secrets set`.

## smoke.ts

Post-deploy verification. Hits a small set of routes that together
prove the app booted, the global guards are wired, the BFF is mounted,
and the public invite landing renders. Every check is anonymous or
asserts a deterministic 401 / 400 shape, so it is safe to run against
production without any Supabase / Stripe credentials.

```bash
SMOKE_BASE_URL=https://api-staging.thegrowthproject.app \
  npx ts-node scripts/smoke.ts

# Optional: include the AI context route check by passing a JWT
SMOKE_BASE_URL=… SMOKE_TOKEN=eyJ… npx ts-node scripts/smoke.ts

# Optional: smoke an invite preview against a real code
SMOKE_INVITE_CODE=GP-XYZ12 npx ts-node scripts/smoke.ts
```

Exits non-zero on the first failure. Manual redirects are NOT followed
— a 30x is a real change in routing semantics that the operator
should notice.

## stripe-webhook-smoke.ts

Replays the fixture events under `test/fixtures/stripe/*.json` against
a running dev server. Useful when iterating on `BillingService`
without a Stripe account — no network egress, no real Stripe key.

```bash
# in one terminal
STRIPE_WEBHOOK_SECRET=whsec_dev_local npm run start:dev

# in another terminal
STRIPE_WEBHOOK_SECRET=whsec_dev_local \
  npx ts-node scripts/stripe-webhook-smoke.ts

# or feed a single fixture by name
npx ts-node scripts/stripe-webhook-smoke.ts subscription.created
```

## Failure modes and operational notes

- `release.sh` aborting on `_prisma_migrations` table presence is
  intentional. Investigate why migrate-deploy failed against a
  baselined DB before re-running.
- `print-required-secrets.ts FORMAT=missing` is the canonical "before
  you deploy, are you missing anything?" check. Wire it into the
  pre-deploy step of any release runbook.
- `smoke.ts` is the canonical post-deploy verification. The Fly deploy
  workflow runs it via `npm run smoke` against staging on every push.
- `stripe-webhook-smoke.ts` and `bootstrap-owners.ts` are local /
  one-off; CI does not run them.

## Related docs

- [`../docs/deploy-runbook.md`](../docs/deploy-runbook.md) — full deploy
  procedure including secret provisioning.
- [`../docs/staging-execution-tracker.md`](../docs/staging-execution-tracker.md)
  — staging cut-over checklist.
- [`../src/common/env-validation.ts`](../src/common/env-validation.ts)
  — the rule set that `print-required-secrets.ts` reads.
