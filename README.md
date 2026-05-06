# The Growth Project, Backend

NestJS 10 + Prisma 5 + Supabase API for a coaching platform with per-seat
SaaS billing for coaches. Deployed to Fly.io. The backend hosts the
mobile API, the coach-console BFF, the public invite landing, the public
trust pages, and the Stripe webhook receiver.

This README is the operator-facing entry point. It explains every
environment variable, every feature flag, the high-level data
structures used to run the platform, the route contracts the mobile
app and the coach console depend on, and the deployment + smoke-test
shape of a live environment. For per-module behavior, follow the
links into [`docs/README.md`](docs/README.md) and the module READMEs.

## Stack

- **NestJS 10** for the HTTP framework, `APP_GUARD` global auth,
  global validation pipe, and request-scoped role guards.
- **Prisma 5** for the data layer, against Supabase Postgres.
  Migrations are forward-only and applied at boot via
  `prisma migrate deploy`.
- **Supabase Auth** for sign-in. Tokens are verified locally against
  the Supabase JWKS (ES256) so authenticated requests do not round-trip
  to Supabase Auth.
- **Stripe** for coach SaaS billing. The Stripe SDK is not a runtime
  dependency: webhook signatures are verified locally with HMAC, and
  invoice/subscription state is mirrored into Postgres.
- **Sentry** for server-side error reporting and **PostHog** for
  product analytics. Both no-op when their credentials are not set.
- **Perplexity** (OpenAI-compatible endpoint) for the in-app AI coach.
  Falls back to a deterministic responder when the API key is unset.
- **USDA FoodData Central** + **OpenFoodFacts** for food lookup.
- **Fly.io** for deploys; `Dockerfile` + `release_command` apply
  migrations before traffic flips.

## Setup

```bash
npm install
cp .env.example .env
# fill in values; see "Environment variables" below
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

The API listens on `http://localhost:3000`. All routes are mounted
under `/api/*` except the unprefixed paths listed in
[Public, unprefixed routes](#public-unprefixed-routes) below, which
are excluded from the global prefix in `src/main.ts`.

## Environment variables

`src/common/env-validation.ts` is the source of truth for which
variables are required at boot. Each rule carries a tier:

- **hard**: required in every environment, including local
  development. Boot crashes if missing or if the value looks like an
  unfilled placeholder (such as `<value>`, `REPLACE_ME`, or a long run
  of `X`).
- **prod**: required when `NODE_ENV` is `production` or `staging`.
  Optional in development; the boot logs an info line, not an error.
- **optional**: never required. The associated feature degrades or
  no-ops when the variable is unset.

The validation helper rejects placeholder values for hard- and
prod-tier vars and rejects `CORS_ORIGINS=*` outright.

### Variable matrix

| Variable | Tier | Owner | Purpose |
|---|---|---|---|
| `DATABASE_URL` | hard | Supabase | Postgres connection string used by Prisma. Use the session pooler for runtime queries. |
| `SUPABASE_URL` | hard | Supabase | Project URL. Used as the JWKS source, the admin SDK base, and the pinned token issuer. |
| `SUPABASE_SERVICE_ROLE_KEY` | hard | Supabase | Service-role key. Used by the auth admin SDK and by `SupabaseService` for realtime broadcast. Treat as a secret. |
| `SUPABASE_ANON_KEY` | hard | Supabase | Anon key. Used by the auth controller for `signInWithPassword`, `signUp`, and `resetPasswordForEmail`. |
| `SUPABASE_REDIRECT_URL` | hard | Supabase + mobile | Email-confirm deep-link target consumed by the Supabase email template (for example `tgp://verified`). |
| `PUBLIC_INVITE_BASE_URL` | prod | Backend operator | Base URL surfaced on `/coaches/me/invite-link` and on the invite landing pages. |
| `PUBLIC_WEB_SIGNUP_URL` | prod | Backend operator | Web-signup destination linked from the invite landing when no app is installed. Until a marketing landing exists, point this at the durable backend route under the public host. |
| `APP_STORE_URL` | prod | Backend operator | iOS App Store URL surfaced on the invite landing. Point at the backend `/download/ios` page until the App Store listing is live. |
| `PLAY_STORE_URL` | prod | Backend operator | Google Play URL. Point at the backend `/download/android` page until the Play listing is live. |
| `CORS_ORIGINS` | prod | Backend operator | Comma-separated allow-list of browser origins. Wildcard is rejected at boot. Empty deny-all is the default and is correct for mobile-only environments. |
| `STRIPE_SECRET_KEY` | prod | Stripe dashboard | API key used by the portal-session and start-subscription handlers. `sk_test_` in staging, `sk_live_` in production. |
| `STRIPE_WEBHOOK_SECRET` | prod | Stripe dashboard | HMAC signing secret for `/v1/webhooks/stripe`. Without it every webhook is rejected with 400. |
| `STRIPE_PRICE_ID_FITNESS` | prod | Stripe dashboard | Price id of the flat coach SaaS plan. |
| `SENTRY_DSN` | prod | Sentry dashboard | Server-side DSN. Without it, production errors are not forwarded. |
| `REDIS_URL` | prod | Backend operator | `redis://` or `rediss://` URL used by `ThrottlerModule` for shared rate-limit state across Fly machines. When unset, the throttler falls back to in-memory tracking (safe for dev/test or single-machine deploys, but limits do **not** cross machines). Required before scaling out. See "Rate limiting" below. |
| `POSTHOG_KEY` | optional | PostHog dashboard | Project key. AnalyticsModule no-ops when unset. |
| `POSTHOG_HOST` | optional | PostHog dashboard | Override host (only set when self-hosting PostHog). |
| `PERPLEXITY_API_KEY` | optional | Perplexity dashboard | API key for `/api/ai/chat`. The deterministic fallback responder runs when unset or on provider error. |
| `USDA_API_KEY` | optional | USDA FDC | Key for food search. Required for non-degraded food results in production; do not ship `DEMO_KEY`. |
| `COACH_CODE_GATE_ENABLED` | optional | Backend operator | Feature flag. When `true`, `/auth/signup-with-code` requires a valid coach invite code. |
| `BILLING_ENFORCEMENT` | optional | Backend operator | Feature flag. `enforce` blocks coach writes for `past_due` past grace and for `canceled` / `paused`. `active`, `trialing`, and `grandfathered` are always allowed. Anything else is observe-only. Run `npm run backfill:coach-subscriptions` before flipping to `enforce`. |
| `STRIPE_PRICE_ID_FINANCE` | optional | Stripe dashboard | Reserved for the second vertical. Currently unused. |
| `FINANCE_API_BASE_URL` | optional | Backend operator | Absolute `http(s)` base URL for the finance backend (`tgp-finance-app`). Drives the cross-product admin federation. Unset = federation reports `not_configured`; the operator console still renders the fitness block. Validated as absolute http(s); placeholders rejected at boot. |
| `FINANCE_SERVICE_TOKEN` | optional | Finance backend operator | Static service-to-service bearer used on every federation call. Required when `FINANCE_API_BASE_URL` is set; without it federation reports `auth_unconfigured` and never reaches the network. |
| `FINANCE_FEDERATION_TIMEOUT_MS` | optional | Backend operator | Per-call timeout for finance federation. Defaults to 2500 ms; clamped to `[250, 15000]`. |
| `LAST_SECURITY_DEPLOY_AT` | optional | Backend operator | ISO-8601 timestamp surfaced verbatim by `/api/system/trust-meta` as `lastSecurityUpdate`. When unset, the trust meta endpoint returns `null` rather than fabricating a date. Set on every production deploy of a security fix. |
| `JWT_SECRET` | legacy | n/a | Reserved. Token verification is JWKS-based; the value is not consulted. |
| `RELEASE_ALLOW_DB_PUSH` | optional | Backend operator | One-time bootstrap escape hatch in `scripts/release.sh`. Allows `prisma db push --accept-data-loss` only when the DB has no `_prisma_migrations` table. Leave unset on any environment that holds real data. |
| `BOOTSTRAP_OWNER_EMAILS` | optional | Backend operator | Comma-separated emails consumed by `scripts/bootstrap-owners.ts` to seed the initial OWNER list. Idempotent. |
| `ALLOW_SELF_SERVICE_BECOME_COACH` | optional | Backend operator | Feature flag. Default unset = `POST /auth/become-coach` returns `403 self_service_promotion_disabled`. Set to `true` only for a one-off legacy migration where any logged-in non-OWNER user may self-elevate after a password re-auth; the role change is then audited as `user.role_changed` with `metadata.via=self_service_become_coach`. The canonical promotion path is OWNER-only `POST /admin/users/:id/promote`. |
| `GDPR_SCRUB_DRY_RUN` | optional | Backend operator | When `true`, `scripts/gdpr-scrub.ts` and `POST /admin/gdpr/scrub` report candidate users without writing — no `deleted_at`, no PII tombstoning, no audit row. Used to land the cron schedule in staging observably-inert before flipping to a real scrub. |
| `GDPR_SCRUB_BATCH_LIMIT` | optional | Backend operator | Per-run cap on `GdprScrubService.run`. Defaults to 100 candidates per tick; raise only after you have watched a few cron runs complete cleanly. |
| `PTM_SCORING_ENABLED` | optional | Backend operator | Feature flag — when `false`, the nightly PTM recompute cron is a no-op and the admin teaching endpoints are disabled. Defaults to engine-runs. Use as a kill switch when a heuristic regression ships. |
| `PTM_SCORING_CRON` | optional | Backend operator | Override for the nightly PTM recompute cron expression. Defaults to `0 4 * * *` (04:00 UTC, one hour after the GDPR scrub at 03:00 UTC). Must be a valid 5-field cron expression. |
| `PTM_RECOMPUTE_BATCH_LIMIT` | optional | Backend operator | Per-run cap on the number of clients the PTM nightly cron recomputes. Defaults to 5000; clamped to `[1, 50000]`. Larger rosters are processed across multiple nights. |
| `PTM_WEIGHTED_ACTIVATION_OUTCOMES` | optional | Backend operator | Override the minimum number of labelled `ClientOutcome` rows before the weighted v2 engine activates. Defaults to 20. Below this threshold every recompute uses `heuristic_v1`. |
| `PTM_RISK_BOARD_PAGE_SIZE` | optional | Backend operator | Default page size for `GET /admin/ptm/risk-board`. Defaults to 50; clamped to `[1, 100]` regardless of caller-supplied limit. |
| `COACH_EFFECTIVENESS_ENABLED` | optional | Backend operator | Feature flag — when `false`, the nightly Coach Effectiveness recompute cron is disabled. Defaults to `true`. See [`src/coach/README.md`](src/coach/README.md#coach-effectiveness-score-phase-6a) and [`docs/coach-signals.md`](docs/coach-signals.md). |
| `COACH_EFFECTIVENESS_CRON` | optional | Backend operator | Override for the nightly Coach Effectiveness recompute cron. Defaults to `0 5 * * *` (05:00 UTC, one hour after the PTM recompute). |
| `COACH_ALERT_RED_TRANSITION_ENABLED` | optional | Backend operator | Feature flag — when `false`, the PTM-recompute hook does NOT create `CoachAlert` rows on green/amber → red transitions. Defaults to `true`. Use to silence the alert channel without disabling the underlying recompute. |
| `COACH_ALERT_BATCH_LIMIT` | optional | Backend operator | Per-request cap on `/coach/alerts` and `/admin/coach-alerts`. Defaults to 50; clamped to `[1, 200]`. |
| `COACH_ONBOARDING_AUTO_START` | optional | Backend operator | Phase 6D — when `true` (default), `AdminService.promoteUser` auto-starts the 6-step onboarding wizard for newly-promoted coaches. Set to `false` to disable (e.g. during bulk back-fills). Wizard creation failures never block promotion regardless of this flag. |
| `VOICE_NOTE_MAX_DURATION_SEC` | optional | Backend operator | Phase 6C — server-enforced max duration for voice attachments on coach <-> client messages. Defaults to `300` s; clamped to `[10, 600]`. Validated at upload-URL issuance and again at message-send. |
| `VOICE_NOTE_MAX_SIZE_MB` | optional | Backend operator | Phase 6C — server-enforced max file size for voice attachments. Defaults to `5` MB; clamped to `[1, 25]`. |
| `SUPABASE_VOICE_BUCKET` | optional | Backend operator | Phase 6C — Supabase Storage bucket name for voice attachments. Defaults to `voice-notes`. Bucket must exist in Supabase Storage; the signed-upload flow returns `501 VOICE_STORAGE_UNAVAILABLE` if the bucket is unreachable or the JS SDK is too old. |
| `DIAGNOSTIC_AI_ENABLED` | optional | Backend operator | Set to `false` to skip Perplexity calls for `POST /api/diagnostic/submit` and store a placeholder roadmap. Defaults to `true`. Useful for CI / preview deploys without a Perplexity key. |
| `DIAGNOSTIC_RATE_LIMIT_PER_HOUR` | optional | Backend operator | Per-IP hourly cap on `POST /api/diagnostic/submit` (named throttler `diagnostic-submit`). Defaults to 5; clamped to `[1, 1000]`. The endpoint is unauthenticated by design (lead capture), so the limit is the primary defense. |
| `BUILD_WEEK_ENABLED` | optional | Backend operator | Feature flag — when `false`, the Phase 4 Build Week controllers refuse new writes and the admin funnel reports zeroed counts. Defaults to `true`. See [`src/build-week/README.md`](src/build-week/README.md) and [`docs/build-week.md`](docs/build-week.md). |
| `BUILD_WEEK_AUTO_START_ON_SIGNUP` | optional | Backend operator | Feature flag — when `true`, new client signups auto-enrol in Build Week. Defaults to `false`. The flag is exposed for staged rollout; auto-enrolment wiring lands in a follow-on PR. |
| `PORT` | optional | Fly.io | HTTP port. Defaults to 3000; Fly overrides this. |
| `NODE_ENV` | optional | Backend operator | `development`, `staging`, or `production`. Drives the validation tier and the AI debug payload. |

### Feature flags

| Flag | Default | Effect |
|---|---|---|
| `COACH_CODE_GATE_ENABLED` | unset (off) | When `true`, `/auth/signup-with-code` rejects requests that lack a valid coach invite code. The `/auth/signup-policy` endpoint reflects this so mobile can hide or show the field. |
| `BILLING_ENFORCEMENT` | unset (observe-only) | When `enforce`, `SubscriptionGuard` denies coach writes for `past_due` (past 7-day grace), `canceled`, `paused`, `incomplete`, and `unpaid` subscriptions. `active`, `trialing`, and `grandfathered` are always allowed. Anything else lets every request through, with the verdict still computed. Run `npm run backfill:coach-subscriptions` before flipping this to `enforce` so existing alumni keep their access. |
| `ALLOW_SELF_SERVICE_BECOME_COACH` | unset (off — hard gate) | When unset, `POST /auth/become-coach` always returns `403 self_service_promotion_disabled` and points the caller at `POST /admin/users/:id/promote`. When `true`, the legacy self-service path re-opens behind a Supabase password re-auth; OWNERs are still refused and the role change is audited as `user.role_changed` with `metadata.via=self_service_become_coach`. Production should leave this unset. |
| `GDPR_SCRUB_DRY_RUN` | unset (real scrub) | When `true`, the GDPR scrub worker reports candidates without writing. Use to land the cron schedule in staging observably before flipping the flag off. |

### Public URL variables

The four public URL variables are consumed by the invite landing
controller (`src/invite-landing/`) and the public download/signup
pages (`src/public-pages/`):

- `PUBLIC_INVITE_BASE_URL` is the base used to build the per-coach
  invite URLs returned from `/coaches/me/invite-link`.
- `PUBLIC_WEB_SIGNUP_URL` is the destination linked from the invite
  landing when no native app is installed.
- `APP_STORE_URL` and `PLAY_STORE_URL` are the App Store / Play Store
  destinations linked from the invite landing.

Until the App Store and Play listings are live, point `APP_STORE_URL`,
`PLAY_STORE_URL`, and `PUBLIC_WEB_SIGNUP_URL` at the durable
server-rendered routes under the public hostname (`/download/ios`,
`/download/android`, `/signup`). These routes are the destinations the
invite landing falls back to when the listings do not yet exist; they
are intentionally stable so reviewers and customers always reach a
real page.

### Stripe variables

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
`STRIPE_PRICE_ID_FITNESS` together drive the billing surface. With all
three set, the webhook accepts events and is idempotent on
`stripe_event_id`, the coach-billing controller returns a real mirror,
the OWNER-only `/v1/admin/coaches/:id/start-subscription` endpoint
provisions a new coach subscription against a real Stripe customer +
subscription, the coach-only `/v1/coach/me/billing/portal-session`
endpoint mints a live Stripe Customer Portal session, and
`SubscriptionGuard` has data to reason over.

When any of the three is unset (the default in dev), the routes stay
mounted but return deterministic responses: the webhook returns 400
`Stripe webhook secret not configured`, the start-subscription and
portal-session endpoints return `STRIPE_NOT_CONFIGURED`, and
`SubscriptionGuard` is observe-only. The console renders the right
empty state without a real Stripe key.

Webhook idempotency: `BillingService` records every event id on
`StripeProcessedEvent` in a `finally` block so a Stripe retry — even
on a poison-pill payload that throws — never double-counts. The
processed-event row carries `event_type` and a creation timestamp so
operators can audit which events have already been consumed.

For the full setup (products, prices, webhook signing secret, customer
portal), see [`docs/stripe-setup.md`](docs/stripe-setup.md).

### Sentry, PostHog, Supabase, Fly variables

- **Sentry**: `SENTRY_DSN` is the only required variable. The Sentry
  client is initialized in `src/instrument.ts` before the Nest app is
  created so auto-instrumentation can patch the runtime. Sourcemaps are
  uploaded to Sentry on every Fly deploy via
  `scripts/sentry-upload-sourcemaps.sh`; see the **Sentry sourcemaps**
  section below for the build-time secrets that gate the upload.
- **PostHog**: `POSTHOG_KEY` and the optional `POSTHOG_HOST`. The
  `AnalyticsModule` is a no-op when the key is unset, so all
  `analytics.track(...)` calls in the codebase are safe to leave
  in place during local development.
- **Supabase**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_REDIRECT_URL`. Two
  separate Supabase projects (staging + production) must be used; do
  not share keys.
- **Fly**: no `FLY_*` variables are read by the runtime. The platform
  exposes `PORT`, and the deploy pipeline uses `flyctl` against
  `fly.toml`. The deploy workflow at `.github/workflows/fly-deploy.yml`
  needs a `FLY_API_TOKEN` GitHub Actions secret; production secrets
  are pushed via the operator-only workflow at
  `.github/workflows/fly-secrets-set.yml`. See
  [`docs/deploy-runbook.md`](docs/deploy-runbook.md) section 7b for
  the operator workflow contract.

### Sentry sourcemaps

The compiled JavaScript Sentry sees on Fly is one bundled, transpiled
file per module. Without sourcemaps, every captured stack trace is a
list of `dist/*.js:row:col` lines that nobody can debug from. The
deploy pipeline uploads sourcemaps to Sentry on every release so the
dashboard renders the original TypeScript source.

The upload runs in `scripts/sentry-upload-sourcemaps.sh` from inside
the Docker build, after `npm run build`. The release name is the
commit SHA, passed as the `RELEASE_VERSION` build arg, and is also
exported as a runtime ENV so `src/instrument.ts` tags captured events
with the same release. Events and sourcemaps line up by construction.

The script no-ops gracefully when any of the four credentials are
unset, so `docker build` and local `npm run build` work without Sentry
configured. Required GitHub Actions secrets for the upload to actually
run on prod deploys (set on the repository, not on Fly):

| Secret              | Where to find it                                                                |
| ------------------- | ------------------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN` | Sentry → Settings → Auth Tokens → Create. Scope: `project:releases`.            |
| `SENTRY_ORG`        | Sentry org slug, e.g. `the-growth-project`.                                     |
| `SENTRY_PROJECT`    | Sentry project slug for this app, e.g. `growth-project-backend`.                |
| `SENTRY_DSN`        | Already required; reused so the build can confirm the project before uploading. |

One-time operator setup (GitHub repo → Settings → Secrets → Actions):

```bash
gh secret set SENTRY_AUTH_TOKEN --body '<token>' --repo BradleyGleavePortfolio/growth-project-backend
gh secret set SENTRY_ORG        --body 'the-growth-project' --repo BradleyGleavePortfolio/growth-project-backend
gh secret set SENTRY_PROJECT    --body 'growth-project-backend' --repo BradleyGleavePortfolio/growth-project-backend
```

`SENTRY_DSN` is already set as a Fly secret; mirror it into the GitHub
Actions environment with the same `gh secret set` form so the build
can read it. The runtime DSN on Fly stays the source of truth — the
GitHub copy is build-time only.

## Rate limiting

Rate limiting is wired through `ThrottlerModule` (`src/app.module.ts`)
with `UserThrottlerGuard` (`src/throttler/user-throttler.guard.ts`)
registered as a global `APP_GUARD`. The guard inherits everything from
`@nestjs/throttler`'s `ThrottlerGuard` and overrides one method —
`getTracker(req)` — so the bucket key is **the user-id when the
request is authenticated** (`req.user.id` set by `JwtAuthGuard`) and
**the client IP otherwise**. This avoids shared-NAT lockouts (offices,
campuses, coffee shops, mobile CGNAT) and keeps per-user fairness on
authenticated routes.

### Backend storage

When `REDIS_URL` is set the throttler uses
`@nest-lab/throttler-storage-redis` over `ioredis` so limits hold
across all Fly machines in a region. When unset, the built-in
in-memory tracker is used; that is the right default for `npm run
dev`, Jest, and single-machine deploys, but limits will **not** cross
machines, so production must set `REDIS_URL`. Boot logs the chosen
backend at `LOG` level under the `ThrottlerConfig` context.

### Named throttlers

| Name | Limit | Surface (decorator at controller) |
|---|---|---|
| `auth-login` | 10 / minute | `POST /auth/login` |
| `auth-signup` | 5 / hour | `POST /auth/register`, `POST /auth/signup-with-code` |
| `auth-password-reset` | 5 / 15 min | `POST /auth/forgot-password` |
| `default` | 60 / minute | every other route that uses `@Throttle({ default: ... })` |

Limits live in one place — `src/throttler/throttler.config.ts` —
imported by `app.module.ts` via `ThrottlerModule.forRootAsync()`. To
add a new named throttler, append to `THROTTLER_LIMITS` and reference
it from the controller via `@Throttle({ '<name>': { ttl, limit } })`.

When the limit is exceeded, `ThrottlerExceptionFilter`
(`src/filters/throttler-exception.filter.ts`) returns a 429 with a
generic body — no leak of which named throttler tripped, no echo of
the user's input.

## Public, unprefixed routes

`src/main.ts` excludes the following paths from the `/api` global
prefix because they have to resolve as bare paths under the public
hostname:

| Path | Purpose |
|---|---|
| `/health` | Liveness probe used by Fly. Returns `{ ok, uptime, timestamp }`. |
| `/join/:code`, `/invite/:code` | HTML invite landing for a coach link. The universal-link config (`apple-app-site-association`, `assetlinks.json`) targets these paths. |
| `/download/ios`, `/download/android` | Durable status pages used as the destinations of `APP_STORE_URL` and `PLAY_STORE_URL` until the real listings exist. |
| `/signup`, `/signup/:code` | Durable status page used as the destination of `PUBLIC_WEB_SIGNUP_URL`, with optional invite-code passthrough. |
| `/privacy`, `/terms`, `/security`, `/status` | Public trust pages required by the App Store, Play Store, and Stripe Customer Portal listings. |

The JSON alias for the invite preview lives at
`/api/invite/:code/preview` and is intentionally left under `/api`
alongside the other JSON routes.

## Domain structures

These are the platform-level entities. The full schema lives in
[`prisma/schema.prisma`](prisma/schema.prisma). The structures called
out below are the ones an enterprise operator needs to reason about
when sizing tenancy, billing, and audit work.

### Roles: OWNER, COACH, STUDENT

The `Role` enum has three values: `owner`, `coach`, `student`.
Hierarchy is OWNER > COACH > STUDENT.

- **OWNER** is the platform-wide superuser. OWNER bypasses
  `RolesGuard`, `CoachGuard`, `CoachOrOwnerGuard`, and
  `SubscriptionGuard`. OWNER is added in Phase 1A and is opt-in;
  existing rows are unaffected.
- **COACH** is a paying seat. A COACH operates on the clients linked
  to them via `User.coach_id`. COACH writes flow through
  `SubscriptionGuard` once `BILLING_ENFORCEMENT=enforce`.
- **STUDENT** (also referred to as CLIENT in the messaging,
  guidelines, and meal-plan paths) is the end user of the mobile app.
  A student is bound to at most one coach via `User.coach_id`.

Self-service role elevation is restricted: `/auth/select-role` only
permits self-set to `student`. Coach elevation goes through the
admin module (`/admin/users/:id/promote`) or the bootstrap script
(`scripts/bootstrap-owners.ts`).

### User

The base identity row. One row per Supabase user.

Key columns: `supabase_id` (unique), `email`, `name`, `role`,
`coach_id` (self-referential FK to another `User.id` for the
coach -> student link), `archived_at` (soft-archive marker on a
roster), `created_at`. The `coach_id` column is the durable coach
link: invite-code rotations and re-redemptions do not change it.

The companion 1:1 rows on `User` are:

- `UserProfile`: macros, height/weight, sex, activity level, goal
  type, workout experience, target macros, avatar, weight unit,
  meals per day, water goal, calorie display, dietary pattern,
  dietary restrictions, weekly workout cadence, and the
  `onboardingCompleted` flag.
- `UserPreferences`: home-module ordering, notification cadence,
  motivational tone, units, first day of week.
- `NotificationPreferences`: per-channel toggles, quiet hours,
  timezone.

### CoachProfile

Per-coach business and billing metadata. One row per coach. Lazy-
created when a student is promoted to coach via the admin module.

Columns of operational interest:

- `invite_code` (unique): the default per-coach link, formatted
  `GP-XXXXXX` over the unambiguous alphabet
  `23456789ABCDEFGHJKMNPQRSTUVWXYZ`. Rotating this code does not
  break existing roster links.
- `business_name`, `bio`, `timezone`, `branding_accent_color`,
  `branding_logo_url`: surfaced on the public invite preview and on
  the coach console.
- `stripe_customer_id`: resolved by the webhook to find the matching
  coach when applying a Stripe event.
- `stripe_subscription_id`, `subscription_status`, `plan_tier`,
  `current_period_end`, `trial_end`: the short-form mirror used by
  Phase 2A. The longer-form mirror lives on `CoachSubscription`.
- `ai_monthly_spend_cap_cents`: per-coach AI spend cap.
- `created_by_owner_id`: audit pointer to the OWNER who provisioned
  the coach.

### CoachSubscription (Stripe mirror)

Local mirror of Stripe subscription state. One row per coach.
Stripe is the source of truth; this row is a denormalized
projection so the coach console reads subscription state without
touching Stripe directly.

Columns: `stripe_customer_id`, `stripe_subscription_id` (unique),
`stripe_price_id`, `status` (`active`, `trialing`, `past_due`,
`canceled`, `paused`, `incomplete`, `unpaid`),
`current_period_end`, `trial_end`, `cancel_at_period_end`,
`last_payment_failed_at`, `failed_payments_this_month`,
`billing_email`, `card_last4`.

`SubscriptionGuard` reads this table. The 7-day `past_due` grace is
computed against `last_payment_failed_at`. OWNER bypasses the guard.

### Invoice and PaymentFailure

Stripe-driven audit rows.

- `Invoice`: one row per `stripe_invoice_id` (unique). Records
  amounts, currency, status (`open`, `paid`, `void`,
  `uncollectible`), period bounds, the hosted-invoice URL, and the
  PDF URL. Indexed on `(coach_id, created_at)` for the billing
  history surface.
- `PaymentFailure`: one row per failure event. Records
  `stripe_invoice_id`, `stripe_event_id`, the dunning amount, and a
  freeform `reason`. The webhook also increments
  `CoachSubscription.failed_payments_this_month` so the OWNER outreach
  trigger has a concrete signal.

### StripeProcessedEvent

Idempotency table for the webhook. Unique on `stripe_event_id`,
written in a `finally` block in `BillingService` so a poison-pill
payload still gets recorded and does not loop through Stripe's
retry queue.

### MessageDraft

Compose-state autosave for the coach console. One row per
`(coach_id, client_id)` pair (composite unique
`MessageDraft_coach_client_key`). Autosave overwrites in place; the
send path clears the draft as part of the same transaction.

### ActivityEvent

Audit / activity event stream. One row per discrete event. Schema
follows the integration notes:

- `actor_id`, `actor_role`: who triggered the event.
- `coach_id`, `client_id`: which coach and which client (either may
  be null when not applicable).
- `type`: a string identifier; the consumer reads the catalog.
- `summary`: short human-readable line.
- `payload` (jsonb): the event body. Schemas are per-type; the
  column is intentionally untyped so adding a new event type does
  not require a migration.

The console reads this table for the recent-activity feed; future
fan-out workers will read it for push and email notifications. The
combination `(actor_id, type, created_at)` is also the most useful
audit index for incident response.

### AuditLog

Append-only record of sensitive actions, written by `AuditService`.
One row per privileged event. Columns of operational interest:

- `action`: canonical event name, e.g. `user.role_changed`,
  `user.data_export_requested`, `user.account_deletion_scheduled`.
  The full constant set lives at `AuditAction` in
  `src/audit/audit.service.ts`.
- `actor_id`, `actor_role`, `actor_email_snapshot`: who acted, with
  the email captured at write time so it survives a later PII scrub.
- `target_user_id`, `target_type`, `target_id`: what the action
  affected.
- `tenant_coach_id`: the coach whose tenant the action touched, so
  OWNER queries can be scoped to one tenant.
- `ip`, `user_agent`: best-effort transport context; `ip` is
  `x-forwarded-for[0]` from Fly's edge.
- `metadata` (jsonb): action-specific structured data.
- `created_at`: indexed for cursor pagination.

Append-only by convention; `AuditService.write` never updates or
deletes. The OWNER-only read surface is `GET /api/admin/audit-log`,
documented under the route contracts below. The full schema, index
list, and currently wired call sites are in
[`docs/audit-and-gdpr.md`](docs/audit-and-gdpr.md).

### DataExportRequest

One row per fulfilled GDPR data-export request. Holds the assembled
JSON snapshot of the requesting user's personal data (no coach-tenant
rows; messages or nudges sent by the user as a coach are deliberately
excluded so a coach export does not leak other clients' data).
Strictly scoped to `user_id = req.user.id`; cross-user reads return
404. Schema and the inline-vs-S3 trade-off are documented in
[`docs/audit-and-gdpr.md`](docs/audit-and-gdpr.md).

### Audit and GDPR posture

The self-service GDPR surface shipped in PR #73:

- `POST /api/users/me/data-export` synchronously assembles a JSON
  snapshot and persists it on `DataExportRequest`.
- `GET /api/users/me/data-export/:id` fetches the assembled payload.
  Cross-user reads return 404, not a redaction.
- `DELETE /api/users/me/account` soft-deletes with a 30-day grace
  window via `User.deletion_scheduled_at`. Idempotent within the
  grace window.
- `POST /api/users/me/account/cancel-deletion` clears the flag.
- `GET /api/users/me/account/deletion-status` returns the current
  state.

Auth-guard lockout: once `deletion_scheduled_at` is set, every route
returns 403 except the two recovery routes
(`/users/me/account/cancel-deletion`, `/users/me/account/deletion-status`,
plus the mobile alias `/users/me/account/status`), which opt in via
the `@AllowDeletionScheduled()` decorator. Once `deleted_at` is set
by the post-grace scrub, every route — recovery included — returns
403; the account is terminal.

The PII scrub worker shipped in PR #81 (`src/users/gdpr-scrub.service.ts`,
`scripts/gdpr-scrub.ts`, OWNER-only `POST /admin/gdpr/scrub?dry_run=&limit=`).
After `deletion_scheduled_at + 30d` it tombstones identifying columns
on `User` (`email` → `deleted-{id}@scrub.invalid`, `name` → `Deleted user`,
`phone` → null, `supabase_id` → `deleted-{id}` so the unique
constraint holds), zeroes PII on `UserProfile`, sets `deleted_at` and
`archived_at`, and writes one immutable `user.account_deleted` audit
row per scrubbed user with `metadata.scope='gdpr_scrub_worker'` and
the original email captured in `metadata.original_email_snapshot` for
forensic traceability. Worker is fully idempotent and per-user
transaction failures are reported but never poison the rest of the
batch. Run via cron (`scripts/gdpr-scrub.ts`), the OWNER endpoint, or
direct service call; all three share `GdprScrubService.run`. Set
`GDPR_SCRUB_DRY_RUN=true` to land the cron schedule observably-inert
in staging; `GDPR_SCRUB_BATCH_LIMIT` caps the per-tick batch (default
100). Full operator runbook in [`docs/audit-and-gdpr.md`](docs/audit-and-gdpr.md).

The remaining audit / privacy posture:

- `User.archived_at` for soft-archive on a roster.
- `ActivityEvent` for actor-attributed product-side history (used by
  the recent-activity feed).
- `AuditLog` for actor-attributed sensitive-action history (the
  compliance audit trail).
- `StripeProcessedEvent` for billing event provenance.
- Sentry and PostHog both no-op when their credentials are unset;
  PII exposure to those vendors is opt-in per environment.

The full operator runbook (applying the migration, reading the audit
log, honoring a manual GDPR delete, follow-ups) lives in
[`docs/audit-and-gdpr.md`](docs/audit-and-gdpr.md).

### CheckIn, MealPlan, CoachGuideline, CommunityWin

- `CheckIn` is the daily client log (mood, energy, soreness,
  sleep_hours, weight_kg, type). Unique on `(user_id, date)` so
  `POST /check-ins` is an idempotent daily upsert. `coach_id` is
  denormalized at write so historical check-ins stay attached to
  the coach-of-record.
- `MealPlan` is the coach-authored, server-persisted plan for a
  specific client. `items` is jsonb, validated at the DTO boundary.
  `archived_at` is the soft-delete column.
- `CoachGuideline` is one document per `(coach_id, client_id)` pair
  (composite unique `CoachGuideline_coach_client_key`).
- `CommunityWin` is the client-authored post; `coach_id` is
  denormalized for the roster feed.

The remaining models (`Habit`, `Lesson`, `LessonCompletion`,
`WaterLog`, `WeightLog`, `WorkoutSession`, `ExerciseSet`,
`WorkoutRoutine`, `RoutineExercise`, `FastingWindow`, `Recipe`,
`SavedRecipe`, `ListItem`, `FoodItem`, `LoggedFoodEntry`,
`UserBadge`, `WinReaction`, `CoachMessage`, `CoachNudge`,
`InviteCode`) cover the user-facing tracking surfaces and the
messaging + invite flows. Their per-module READMEs are the source
of truth.

### Profile completeness

The AI structured-context endpoint can only coach against the
fields that actually live on `UserProfile`. The columns that
matter for that decision today are:

| Column | Purpose | Notes |
|---|---|---|
| `height_cm`, `current_weight_lbs`, `date_of_birth`, `sex` | Mifflin-St Jeor TDEE — without these the macro target falls back to a 30-year-old default. | Set by lean onboarding (`LeanQ4MetricsScreen`) and editable on `ProfileScreen`. |
| `goal_type`, `activity_level`, `workout_experience` | Macro split + intensity heuristics. | Set by lean onboarding Q1–Q3. |
| `target_weight_lbs` | Aggressiveness gauge for fat-loss / muscle-gain plans. | Editable on `ProfileScreen`. |
| `has_gym_membership` | Coarse "gym vs not" signal kept for legacy clients that still write only the boolean. | Editable on `ProfileScreen`. New clients should also set `equipment_access`. |
| `equipment_access` | Granular `String[]` of available equipment. The DTO restricts new writes to `{full_gym, home_gym, dumbbells, kettlebells, barbell, resistance_bands, pull_up_bar, cardio_machine, bodyweight_only, other}`; reads of any token stay valid. Empty array is "unanswered" — the explicit confirmed-bodyweight answer is `["bodyweight_only"]`. | New. AI prompt forwards under `equipment:` so the workout-builder can pick between barbell, dumbbell, band, and bodyweight programming without a clarifying question. |
| `dietary_pattern` | Free-form diet shape — `none`, `vegan`, `vegetarian`, `keto`, `pescatarian`, `paleo`, `other`. The DTO validates writes against that list, but the column is `String?` so future values do not require a migration. | New in this surface. AI prompt forwards it under `diet:` and treats `null` as "unknown" rather than "none". |
| `dietary_restrictions` | Allergens / avoid-list as `String[]`. Empty array is the explicit "no restrictions" answer. | New. The AI must not fabricate restrictions when the list is absent. |
| `workout_days_per_week` | Self-reported weekly training cadence (0–7). | New. Lets the AI size weekly volume targets without assuming "3 days a week." |

Anything missing surfaces in `client-ai-context.service.ts`'s
`renderForPrompt` as the literal token `unknown` so the AI prompt
can decide whether to ask before answering.

## Route contracts

Everything below is mounted under `/api`. Tenancy and role gating
are listed alongside the path. For full per-route behavior, follow
the link to the module README.

### Auth, invite, and signup

Module: [`src/auth/`](src/auth/README.md),
[`src/invite-codes/`](src/invite-codes/README.md).

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/auth/register` | public | 10 / hour / IP. |
| `POST` | `/auth/login` | public | 10 / minute / IP. |
| `POST` | `/auth/google` | public | Verifies the token's provider before linking. |
| `POST` | `/auth/signup-with-code` | public | 10 / hour / IP. Requires invite code when `COACH_CODE_GATE_ENABLED=true`. |
| `POST` | `/auth/become-coach` | authed | **Hard-gated off by default.** Returns `403 self_service_promotion_disabled` unless `ALLOW_SELF_SERVICE_BECOME_COACH=true`. Canonical promotion is OWNER-only `POST /admin/users/:id/promote`. When the legacy gate is open, requires Supabase password re-auth and writes a `user.role_changed` audit row with `metadata.via=self_service_become_coach`; OWNERs are still refused. |
| `POST` | `/auth/select-role` | authed | Self-service to `student` only. |
| `POST` | `/auth/attach-invite-code` | authed | Atomic invite-code redemption. OWNER refused. |
| `POST` | `/auth/validate-invite-code` | public | 20 / minute / IP. |
| `GET` | `/auth/signup-policy` | public | Reflects `COACH_CODE_GATE_ENABLED`. |
| `POST` | `/auth/forgot-password` | public | Always 200 to prevent enumeration. |
| `GET` | `/auth/me` | authed | Returns the current `User` row. |
| `GET` | `/invite/:code/preview` | public | 30 / minute / IP. JSON. Coach card or `{ valid: false }`. |
| `POST` | `/auth/attach-coach-code` | authed | Older alias of `attach-invite-code`. |
| `GET` | `/coaches/me/invite-link` | coach | Default per-coach link, lazy-created. |
| `POST` | `/coaches/me/invite-link/regenerate` | coach | Rotates the default link. |
| `GET`, `POST`, `DELETE` | `/coach/invite-codes*` | coach | Legacy multi-row codes (`expires_at`, `max_uses`). |

### AI context and chat

Module: [`src/ai/`](src/ai/README.md).

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/ai/chat` | authed | 20 / hour / user. `userId` is taken from `req.user`; body cannot influence identity. |
| `GET` | `/ai/context` | authed | Returns the `ClientAIContext` used to build the prompt. |
| `GET` | `/ai/structured-context` | authed | Same shape as `/ai/context`, used by the mobile disclosure screen. |

The fallback responder runs whenever `PERPLEXITY_API_KEY` is unset
or the upstream call fails. Guardrails (calorie floor, macro
contradiction, referral, banned-substance redaction, AI-tell scrub)
run on every reply.

### Messaging

Module: [`src/messaging/`](src/messaging/README.md).

Coach surface:

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/coach/clients/:client_id/messages?before=&limit=` | coach | Paginated thread. |
| `POST` | `/coach/clients/:client_id/messages` | coach | 30 / minute / caller. |
| `POST` | `/coach/clients/:client_id/messages/read` | coach | Idempotent. |
| `GET` | `/coach/messages/unread-count` | coach | `{ total, by_client }`. |

Client surface:

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/messages?before=&limit=` | student | Thread with the assigned coach. |
| `POST` | `/messages` | student | 30 / minute / caller. Requires `coach_id` set. |
| `POST` | `/messages/read` | student | Idempotent. |
| `GET` | `/messages/unread-count` | student | Returns `{ total: 0 }` when no coach is assigned. |

The coach console BFF uses
[`src/v1/`](src/v1/README.md) instead, with `SubscriptionGuard`
mounted on the two write paths.

### Billing

Module: [`src/billing/`](src/billing/README.md).

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/v1/webhooks/stripe` | public, signature-verified | HMAC-SHA256 v1, 300s tolerance. Webhook applies emit `billing.subscription_updated` / `_canceled` / `.invoice_paid` / `.invoice_payment_failed` audit rows with `metadata.stripe_event_id`. |
| `GET` | `/v1/coach/me/billing` | coach | Reads `CoachSubscription` for the caller. Coach-console BFF surface (full payload). |
| `POST` | `/v1/coach/me/billing/portal-session` | coach | Creates a Stripe Customer Portal session. With `STRIPE_SECRET_KEY` set, mints a per-coach session via the Stripe SDK. With it unset and `STRIPE_CUSTOMER_PORTAL_LOGIN_URL` pointing at a hosted Stripe portal login link, returns `{ url, fallback: true, coachId }`. Otherwise returns `STRIPE_NOT_CONFIGURED`. **Not** behind `SubscriptionGuard` — `canceled`/`past_due` coaches must reach the portal to update payment. |
| `GET` | `/coach/billing/status` | coach | **Mobile alias** of the BFF billing read. Trimmed payload — subscription summary only. Returns `status='unprovisioned'` when no subscription mirror exists (does not synthesize an `active` response). Shares `BillingService.getCoachBilling` with the BFF surface so the wire contract cannot drift. Shipped in PR #81. |
| `POST` | `/coach/billing/portal-session` | coach | **Mobile alias** of the BFF portal-session route — identical behavior, including the `STRIPE_CUSTOMER_PORTAL_LOGIN_URL` static-link fallback when `STRIPE_SECRET_KEY` is unset. Shipped in PR #81. **Not** behind `SubscriptionGuard` for the same reason as the BFF route. |
| `POST` | `/v1/admin/coaches/:id/start-subscription` | owner | Provisions a new subscription for a coach. Returns `STRIPE_NOT_CONFIGURED` until `STRIPE_SECRET_KEY` is set. |

`SubscriptionGuard` policy matrix:

| Status | Behavior |
|---|---|
| `active`, `trialing` | Allow. |
| `past_due` | Allow within 7 days of `last_payment_failed_at`. Deny when enforce mode is on past 7 days. |
| `canceled`, `paused` | Deny when enforce mode is on. |
| `incomplete`, `unpaid`, unknown | Deny when enforce mode is on. |
| Missing `CoachSubscription` row | Allow (rollout state). |

OWNER bypasses the guard.

### Coach console BFF

Module: [`src/v1/`](src/v1/README.md). Path layout mirrors
`tgp-coach-console/INTEGRATION_NOTES.md`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/v1/coach/me` | coach or owner | Coach identity, branding, subscription summary. |
| `GET` | `/v1/coach/me/clients` | coach or owner | Console roster (presence, adherence, risk). |
| `GET` | `/v1/coach/me/threads` | coach or owner | Thread list with last-message preview. |
| `GET` | `/v1/coach/me/threads/:clientId` | coach or owner | Thread + draft. |
| `POST` | `/v1/coach/me/threads/:clientId/messages` | coach or owner + subscription gate | 30 / minute. |
| `GET` | `/v1/coach/me/threads/:clientId/draft` | coach or owner | Reads the draft. |
| `POST` | `/v1/coach/me/threads/:clientId/draft` | coach or owner + subscription gate | 120 / minute. Idempotent upsert keyed on `(coach_id, client_id)`. |

OWNER may pass any `coachId`. COACH must act as themselves; passing
a foreign id returns 403.

### Coach mobile surface and admin

Modules: [`src/coach/`](src/coach/README.md),
[`src/admin/`](src/admin/README.md).

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/coach/dashboard`, `/coach/clients`, `/coach/clients/:id/timeline`, `/coach/clients/:id/summary`, `/coach/alerts`, `/coach/guidelines/:client_id`, `/coach/my-guidelines` | coach or owner | Roster, timeline, alerts, guidelines reads. |
| `POST` | `/coach/clients/:id/archive`, `/coach/clients/:id/unarchive`, `/coach/guidelines/:client_id` | coach or owner | Roster mutations and guideline upsert. Archive / unarchive write `coach.client_archived` / `coach.client_unarchived` audit rows scoped to the client's `tenant_coach_id`; idempotent re-archive on an already-archived client writes no audit row. |
| `GET` | `/admin/coaches`, `/admin/coaches/:id`, `/admin/users` | owner | OWNER-only inventory. |
| `POST` | `/admin/users/:id/promote` | owner | Role change with lazy `CoachProfile` provisioning. Canonical coach-promotion path; `/auth/become-coach` defers to this when the legacy self-service flag is off. |
| `GET` | `/admin/metrics?since_days=` | owner | Authoritative counters from Postgres. `since_days` clamped to `(0, 365]`, defaults to 30. Stripe-sourced figures come from the webhook mirror; no synthesized money figures. Documented in [`docs/metrics.md`](docs/metrics.md). |
| `GET` | `/admin/audit-log` | owner | Cursor-paginated read over `AuditLog`. Filters: `action`, `target_user_id`, `tenant_coach_id`, `before` (ISO timestamp), `limit` (clamped `[1, 200]`, default 50). |
| `POST` | `/admin/gdpr/scrub?dry_run=&limit=` | owner | Manual / dry-run trigger for the GDPR PII scrub worker. Same code path as `scripts/gdpr-scrub.ts`. `dry_run=true` reports candidates without writing; `limit` clamps the per-call batch. The audit row is attributed to the calling OWNER (`actor_email_snapshot`); cron-driven runs leave actor null and `actor_role='system'`. Shipped in PR #81. Full operator runbook in [`docs/audit-and-gdpr.md`](docs/audit-and-gdpr.md). |
| `GET` | `/admin/clients/:id/consent` | owner | Read-only consent matrix for one client across every coach they have ever interacted with. Each row is `{coach_id, scope, granted, granted_at, revoked_at, updated_at}`. Backed by `ConsentService.listForClientAdmin`. See "Consent layer (client → coach data access)" below and [`docs/audit-and-gdpr.md`](docs/audit-and-gdpr.md). |
| `GET` | `/coach/alerts?acknowledged=&limit=&before=` | coach or owner | Phase 6B — own-coach red-flag inbox. Cursor on `created_at`. See [`src/coach/README.md`](src/coach/README.md#red-flag-alerts-phase-6b) and [`docs/coach-signals.md`](docs/coach-signals.md). |
| `POST` | `/coach/alerts/:id/acknowledge` | coach | Phase 6B — idempotent ack. Foreign-coach calls 404. |
| `GET` | `/admin/coach-effectiveness` | owner | Phase 6A — latest score per active coach, sorted score DESC. |
| `GET` | `/admin/coach-effectiveness/:coachId` | owner | Phase 6A — `{ latest, history }` for one coach. `?limit=` clamped `[1, 365]`. |
| `GET` | `/admin/coach-alerts?coach_id=&since=&limit=` | owner | Phase 6B — cross-coach red-flag aggregator. |

### Consent layer (client → coach data access)

Clients control which slices of their data their coach can see. The
consent table (`ClientCoachConsent`) holds one row per
`(client_id, coach_id, scope)`. Effective state is derived:
*granted* iff `granted_at IS NOT NULL` and (`revoked_at IS NULL` or
`revoked_at < granted_at`). Both timestamps are kept on the row so the
last transition is recoverable; the canonical history lives in
`AuditLog` under `consent.granted` / `consent.revoked`.

Scope strings are validated in `ConsentService` (not a SQL enum), so
adding a new scope is a code change with no migration. Today's scopes:

- **Fitness**: `fitness.profile`, `fitness.body_metrics`,
  `fitness.workouts`, `fitness.food_macros`, `fitness.habits_progress`
- **Finance**: `finance.summary`, `finance.balances`,
  `finance.transaction_categories`, `finance.transaction_line_items`,
  `finance.reports`

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/consent/scopes` | any | Static list of canonical scope strings for the mobile UI to render toggles against. |
| `GET` | `/consent/me?coach_id=` | client | Full per-scope state for one coach (defaults to the caller's primary coach). Always returns one row per known scope; unset scopes are `granted: false`. |
| `POST` | `/consent/grant` | client | Body `{coach_id, scope}`. Idempotent — re-granting an already-granted scope does not double-write the audit log. Writes a `consent.granted` audit row scoped to `tenant_coach_id`. |
| `POST` | `/consent/revoke` | client | Body `{coach_id, scope}`. Idempotent. Writes a `consent.revoked` audit row only when transitioning away from a truly granted state. |
| `GET` | `/consent/check/:client_id/:scope` | coach or owner | Coach-side read: is this caller granted access to `client_id` for `scope`? Owners always get `true`. |
| `GET` | `/admin/clients/:id/consent` | owner | OWNER-only consent matrix across all coaches for one client. |

Coach reads (`/coach/clients/:id/timeline`, `/coach/clients/:id/summary`)
gate per slice: scopes the client has not granted return an empty array
on that slice rather than 403, and the response carries a `consent`
block so the console can render a "client revoked access" affordance.
Owner callers bypass the check entirely (audit log records the access).

### Admin console (Healthie/EHR-style)

The admin console is the OWNER-only operator surface that surfaces a
single screen across both the fitness backend (this repo) and the
finance backend (`tgp-finance-app`). It is **admin-only** by
definition — every route below is class-gated by
`JwtAuthGuard + RolesGuard + @Roles('owner')`, and a coach or student
token gets a clean 403. The console never exposes itself to client
roles, and the federation layer never substitutes synthetic data when
finance is unreachable.

The console's backend surface is split into two cooperating layers:

1. **Federation primitives** under `/api/admin/federation/*`
   (`src/admin/federation/`). These are the canonical cross-product
   reads, keyed on email today and forward-compatible with a durable
   `account_id` join key once the finance backend emits one. Shipped
   in PR #79.
2. **Console aliases** under `/api/admin/{search,coaches/:id/overview,clients/:id,clients/:id/unified,finance/health,integrations/status}`
   (`src/admin/console/`). These are id-keyed verbs the console
   renders against; they translate id → fitness email and delegate to
   the federation layer so the unified payload is identical to the
   federation response. Shipped in PR #80.

Modules: [`src/admin/federation/`](src/admin/federation/README.md),
[`src/admin/console/`](src/admin/console/README.md).

#### Federation primitives

| Method | Path | Notes |
|---|---|---|
| `GET` | `/admin/federation/search?q=&limit=` | Unified search across fitness Postgres and the finance backend. Hits are merged by lowercased email and carry a `products` array (`["fitness"]`, `["finance"]`, or both). `limit` clamped `[1, 50]`. |
| `GET` | `/admin/federation/clients/lookup?email=` | One-client unified view. Returns `fitness` block (role, coach, archived, 7d activity), `finance` block, and a derived product split. |
| `GET` | `/admin/federation/coaches/lookup?email=` | One-coach unified view. Roster + subscription side by side from each product. |

Every response carries an explicit `finance.status`:
`ok`, `not_found`, `not_configured`, `auth_unconfigured`, `timeout`,
`network_error`, `http_error`, `malformed_response`. `finance.data`
is `null` for every status except `ok`.

Every record-level federation response (and every console-alias record
response) also carries a first-class `entitlements` block summarising
*what the account has access to*: a `bundle` of `none` / `fitness_only`
/ `finance_only` / `performance_os`, an `overall` of
`active` / `past_due` / `canceled` / `suspended` / `inactive` /
`unknown`, and a per-product `{status, reason}` for each of fitness and
finance. A degraded finance call surfaces as `unknown` (never silently
`inactive`) so the console can render "temporarily unavailable" instead
of misleading the operator. See [`docs/entitlements.md`](docs/entitlements.md)
for the full status table, the GDPR-grace-period suspension rule, and
the additive Phase-2 override-table sketch (no migration in Phase 1).

#### Console aliases

| Method | Path | Backed by |
|---|---|---|
| `GET` | `/admin/search?q=&limit=` | `FederationService.unifiedSearch` |
| `GET` | `/admin/coaches/:id/overview` | `AdminConsoleService.getCoachOverview` |
| `GET` | `/admin/clients/:id` | `AdminConsoleService.getClientUnified` |
| `GET` | `/admin/clients/:id/unified` | `AdminConsoleService.getClientUnified` |
| `GET` | `/admin/clients/:id/entitlements` | `AdminConsoleService.getClientEntitlements` — first-class entitlement read (bundle, per-product status). See [`docs/entitlements.md`](docs/entitlements.md). |
| `GET` | `/admin/coaches/:id/entitlements` | `AdminConsoleService.getCoachEntitlements` — same shape, 404 for non-coach roles. |
| `GET` | `/admin/finance/health` | `FinanceFederationService.getHealth` (real probe; status is `ok` / `not_found` (still healthy) / `not_configured` / `auth_unconfigured` / `degraded` with `reason`). |
| `GET` | `/admin/integrations/status` | `FinanceFederationService.getIntegrationsStatus` |

`/admin/finance/health` runs a real probe against the finance backend's
`lookup` endpoint with a deterministic, well-known probe email
(`admin-console-health-probe@trygrowthproject.com`) and reports the
actual outcome. No values are synthesized; missing config short-circuits
the probe and surfaces the missing piece directly.

#### Cross-app finance federation

The finance backend (`tgp-finance-app`) is a separate service. The
join key today is lowercased email; the wire format already carries
an optional `account_id` so a future durable shared identity can
replace email without a wire break. The federation layer:

- **Never falls back to synthetic data.** When finance is
  unreachable, the response carries the underlying status and
  `finance.data: null`. The console renders a degraded-state pill
  from the status; no fake numbers are shown to operators.
- **Times out and retries once** on transient failures (timeout, 5xx,
  network error). 404 maps to `not_found` and is not retried.
- **Authenticates** with a static service-token bearer plus
  `X-Federation-Source: fitness-backend`. The finance backend is
  expected to verify both. When the finance backend later moves to
  short-lived JWTs, the only swap is in
  `FinanceAdminClient.attempt`; the contract types are unaffected.

#### Product usage split

Each unified client / coach payload carries a `products` field with
the per-product blocks alongside a derived split:

- **Fitness block**: role, coach assignment, `archived_at`, and the
  7-day activity counts (logs, workouts, messages) computed from the
  fitness Postgres in this repo. The 7-day window is hard-coded; if a
  follow-up needs 30/90-day history, widen it server-side and do not
  push the date filter to the client.
- **Finance block**: the finance backend's record for the same
  identity, with the `finance.status` envelope above.
- **Product split**: `["fitness"]` if the user is unknown to finance
  but exists in the fitness backend, `["finance"]` for the inverse,
  `["fitness", "finance"]` when both blocks resolve. The split is
  what drives the Healthie-style product-pill UI on the console.

### GDPR account lifecycle

Module: [`src/users/`](src/users/README.md) (lifecycle handlers),
[`docs/audit-and-gdpr.md`](docs/audit-and-gdpr.md) (full operator
runbook).

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/users/me/data-export` | authed | Synchronously assembles the caller's data into a `DataExportRequest`. Strict `user_id = req.user.id` scoping. Audited as `user.data_export_requested` / `_fulfilled` / `_failed`. |
| `GET` | `/users/me/data-export/:id` | authed | Fetches the assembled JSON payload. Cross-user reads return 404, not a redaction. |
| `DELETE` | `/users/me/account` | authed | Sets `User.deletion_scheduled_at = now()` and starts the 30-day grace clock. Idempotent within the window. Audited as `user.account_deletion_scheduled`. |
| `POST` | `/users/me/account/cancel-deletion` | authed (deletion-scheduled OK) | Clears `deletion_scheduled_at`. Audited as `user.account_deletion_canceled`. Opt-in via `@AllowDeletionScheduled()`. |
| `GET` | `/users/me/account/deletion-status` | authed (deletion-scheduled OK) | Returns the current state (`active` / `scheduled` / `deleted`). |
| `GET` | `/users/me/account/status` | authed (deletion-scheduled OK) | **Mobile alias** of `deletion-status` — same shape, same service call. Shipped in PR #81 to align with the mobile contract; both routes share `AccountService.getDeletionStatus` so the wire contract cannot drift. |

Once `deletion_scheduled_at` is set, `JwtAuthGuard` rejects every
request from that user with 403 except the two recovery routes
above. Once `deleted_at` is set by the post-grace scrub worker,
every route — including the recovery routes — returns 403; the
account is terminal.

### Trust meta and public trust pages

Module: [`src/system/`](src/system/) (read-only meta),
[`src/public-pages/`](src/public-pages/README.md) (HTML pages).

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/system/trust-meta` | public | Returns `{ lastSecurityUpdate }` from the `LAST_SECURITY_DEPLOY_AT` env var verbatim. When unset, `lastSecurityUpdate` is `null`; no date is fabricated. |

The unprefixed public trust pages (`/privacy`, `/terms`, `/security`,
`/status`) read from this same source so the date the page renders
matches the JSON.

## Deployment

The deploy contract lives in
[`docs/deploy-runbook.md`](docs/deploy-runbook.md). The short form:

1. **Tag the commit** intended for deploy.
2. **Set Fly secrets**. Use the variable matrix above. For
   production, push the credentialled subset via the operator
   workflow `Fly Secrets Set (operator)` so values do not sit in an
   operator's terminal history; the workflow drives `fly secrets
   set` against the GitHub Actions secret store. The remaining
   vendor credentials (`DATABASE_URL`, `SUPABASE_*`, `USDA_API_KEY`,
   `PERPLEXITY_API_KEY`, `POSTHOG_KEY`, `POSTHOG_HOST`) are pushed
   from a trusted shell.
3. **Take a DB snapshot** before any deploy that includes a
   migration.
4. **Deploy**: `fly deploy -a <app>`. The `release_command`
   (`bash ./scripts/release.sh`) runs `prisma migrate deploy` first;
   if the DB has not been baselined it falls back to
   `prisma db push --accept-data-loss` only when
   `RELEASE_ALLOW_DB_PUSH=1` is set and the DB has no
   `_prisma_migrations` table.

   The release command invokes the script through **`bash`**, not
   `sh`. Dash (Debian's `/bin/sh`) rejects shell scripts that contain
   any CRLF line endings, aborting the deploy with the cryptic
   `./scripts/release.sh: 25: set: Illegal option -`. `.gitattributes`
   pins `*.sh` to LF endings repo-wide so a Windows commit cannot
   reintroduce CRLF. See `docs/deploy-runbook.md` §7.1 for the failure
   signature, prevention rule, and repair recipe.
5. **Watch the boot log** for the env-validation banner and the
   `port` line.
6. **Run the smoke script** (see below).
7. **Bootstrap OWNERs and flip flags** in the order documented in
   the runbook (OWNER promote, then `COACH_CODE_GATE_ENABLED`, then
   the coach-subscription backfill, then `BILLING_ENFORCEMENT=enforce`).
   The backfill — `npm run backfill:coach-subscriptions` — gives
   every existing coach a `grandfathered` `CoachSubscription` row so
   the flag flip does not lock alumni out of the coach console. The
   guard treats `grandfathered` the same as `active`. The script is
   idempotent; safe to re-run.

`Dockerfile` runs `node dist/main.js` directly. There is no
`start.sh`. CI lives in `.github/workflows/ci.yml` and runs
`npm install`, `prisma generate`, `tsc --noEmit`, build, and
`npm test` on every PR and push to `main`.

### No production migrations

Production never receives a destructive Prisma operation. The deploy
contract is forward-only `prisma migrate deploy`. The
`db push --accept-data-loss` fallback in `scripts/release.sh` is
gated by **two** conditions: `RELEASE_ALLOW_DB_PUSH=1` must be set,
and the target database must have no `_prisma_migrations` table
(i.e. it has never been baselined). Both of those are only true on a
fresh staging shard. On a database that holds real data, the fallback
is unreachable.

Concretely:

- Every recent migration ships **additive** DDL only. The
  `add_audit_log_and_gdpr_lifecycle` migration that backs PR #73 adds
  two nullable columns to `User` (`deletion_scheduled_at`,
  `deleted_at`) and creates `AuditLog` + `DataExportRequest` with
  their indexes; no existing row is mutated, no existing index is
  touched.
- `release_command` in `fly.toml` runs `prisma migrate deploy` before
  traffic flips. A failed migration aborts the deploy.
- Out-of-band SQL is forbidden. Honoring a manual GDPR delete goes
  through `DELETE /api/users/me/account` (which writes the audit
  row), not through hand-edits of `User.deleted_at`.

## README-with-every-PR rule

Every PR must update the corresponding README and module docs in the
same change. The convention is:

- **Module change** → update the module's `README.md` (e.g. a billing
  controller change updates [`src/billing/README.md`](src/billing/README.md)).
- **New env var, new feature flag, or contract-level surface change**
  → also update this root README and `.env.example` so an operator
  reading the root README sees the variable with its tier and owner.
- **Cross-cutting policy change** (deploy steps, smoke-test contract,
  audit posture) → also update `docs/README.md` and the relevant
  runbook under `docs/`.
- **No placeholders** — no `TODO`, `FIXME`, `<value>`, `REPLACE_ME`,
  fake dates, or example secrets. The env-validation pass at boot
  rejects these in hard / prod tiers; the docs follow the same bar.

### Deploy-affecting PRs are a stricter case

If a PR changes how the platform is **deployed**, **configured**, or
**operated**, the operator-facing docs must update in the same PR.
Triggers (full list in [`docs/deploy-runbook.md`](docs/deploy-runbook.md) §10):

- New / removed env var, or a tier change in
  `src/common/env-validation.ts`.
- New feature flag or a default flip on an existing flag.
- New cron / worker / script (e.g. `scripts/gdpr-scrub.ts`).
- Migration that requires a baseline, backfill, or order-sensitive
  rollout.
- Change to the secret-rotation procedure (Stripe, Sentry, Supabase,
  federation token).
- Any change that flips an external dependency (Stripe webhook URL,
  Supabase JWKS, finance backend host, App Store / Play listing).

The minimum surfaces a deploy-affecting PR must touch are this root
README, `.env.example`, the relevant module README, and either
`docs/deploy-runbook.md` or `docs/audit-and-gdpr.md` depending on
which contract changed. The failure mode this rule prevents is a
deploy that boots green and silently breaks an operator workflow the
runbook still describes the old way.

The `route-doc-drift.spec.ts` test (added in PR #78) is the
regression net for the subset of this rule that can be machined: it
asserts that publicly documented endpoint paths still resolve to
controllers that mount them. It is intentionally narrow; the
README-with-every-PR rule covers the rest, and the
deploy-affecting-PR rule above is the stricter cut for the operator
surface.

## Open work and merge order

The merged-vs-open layering across the most recent shipped work, so
operators reading this in order know which PR is the source of truth
for each surface:

| PR | Title | State | Surface |
|---|---|---|---|
| #69 | enterprise module READMEs | merged | per-module READMEs |
| #72 | public trust pages | merged | `/privacy`, `/terms`, `/security`, `/status` |
| #73 | audit log + GDPR data-export & soft-delete foundation | merged | `AuditLog`, `DataExportRequest`, `/users/me/data-export*`, `/users/me/account*`, `/admin/audit-log` |
| #74 | PostHog event taxonomy + admin metrics endpoint | merged | `src/analytics/events.ts`, `/admin/metrics` |
| #75 | invite-code contract aligned with mobile QA | merged | `/auth/signup-with-code`, `/auth/attach-invite-code` |
| #76 | live Stripe Customer Portal + start-subscription + webhook idempotency | merged | `/v1/coach/me/billing/portal-session`, `/v1/admin/coaches/:id/start-subscription`, `StripeProcessedEvent` |
| #78 | trust meta + operator-doc `/api` prefix + E2E prereqs + doc-drift regression test | merged | `/api/system/trust-meta`, `LAST_SECURITY_DEPLOY_AT`, `route-doc-drift.spec.ts` |
| #77 | root README + docs index for enterprise vars and structures | merged | this file + `docs/README.md` |
| #79 | cross-product federation for admin console | merged | `/admin/federation/*`, `FINANCE_API_BASE_URL`, `FINANCE_SERVICE_TOKEN`, `FINANCE_FEDERATION_TIMEOUT_MS` |
| #80 | console-friendly alias routes (search / coach overview / client unified / finance health / integrations status) | merged | `/admin/{search,coaches/:id/overview,clients/:id,clients/:id/unified,finance/health,integrations/status}` |
| #81 | hard-gate become-coach + GDPR scrub worker + broader audit + mobile coach billing/account aliases | merged | `ALLOW_SELF_SERVICE_BECOME_COACH`, `GDPR_SCRUB_DRY_RUN`, `GDPR_SCRUB_BATCH_LIMIT`, `/admin/gdpr/scrub`, `/coach/billing/status`, `/coach/billing/portal-session`, `/users/me/account/status`, audit actions `coach.client_archived`/`coach.client_unarchived`/`billing.subscription_updated`/`_canceled`/`.invoice_paid`/`.invoice_payment_failed` |

Operator actions for the recently merged work:

- After #79 / #80: set `FINANCE_API_BASE_URL`, `FINANCE_SERVICE_TOKEN`,
  and optionally `FINANCE_FEDERATION_TIMEOUT_MS` in Fly secrets on
  **both** this backend and the finance backend; the token is shared
  and a one-side-only set produces 401s on the federation surface.
  Rotation procedure in [`docs/deploy-runbook.md`](docs/deploy-runbook.md) §7c.
  Until configured, the federation surface returns `not_configured`
  and the console renders the "finance not configured" pill.
- After #76 (already merged): set `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_ID_FITNESS` in Fly
  secrets to flip the billing surface from `STRIPE_NOT_CONFIGURED` to
  live.
- After #73 (already merged): no operator action; the migration is
  fully additive and ran at the merge deploy. Honor manual GDPR
  delete requests via `DELETE /api/users/me/account` per
  [`docs/audit-and-gdpr.md`](docs/audit-and-gdpr.md).
- After #78 (already merged): set `LAST_SECURITY_DEPLOY_AT` to the
  ISO-8601 timestamp of the deploy on every production cut that
  ships a security fix. Until set, `/api/system/trust-meta` returns
  `lastSecurityUpdate: null`.
- After #81 (already merged): leave `ALLOW_SELF_SERVICE_BECOME_COACH`
  unset so `/auth/become-coach` stays hard-gated to its
  `403 self_service_promotion_disabled` response — coach promotion
  goes through OWNER-only `/admin/users/:id/promote`. Wire
  `scripts/gdpr-scrub.ts` to a Fly cron / Kubernetes CronJob with
  `GDPR_SCRUB_DRY_RUN=true` initially; watch a few cron runs report
  candidates correctly, then flip the flag off. The mobile coach
  aliases (`/coach/billing/status`, `/coach/billing/portal-session`,
  `/users/me/account/status`) require no operator action — they are
  thin aliases over services already in use.

## Smoke tests

`scripts/smoke.ts`, exposed as `npm run smoke:staging` (and a
production variant). The script is safe to run anonymously against
any environment; every check is either anonymous or asserts an
unauthenticated 401 / 400 shape. It exits non-zero on the first
failure.

What the smoke covers:

- `GET /health` returns 200 with `{ ok: true }`.
- `GET /api/auth/signup-policy` returns the gate state.
- `GET /api/invite/<code>/preview` returns a JSON shape with
  `valid` / `exists`.
- `GET /api/v1/coach/me` returns 401 without a token.
- `POST /api/v1/webhooks/stripe` returns 400 without a Stripe
  signature.
- `GET /join/<code>` HTML landing renders without 5xx.
- `GET /api/ai/context` returns 401 without a token, or the context
  shape when `SMOKE_TOKEN` is set.

### What "live" means

A green smoke is a boot-and-shape signal, not a SaaS end-to-end
signal. Specifically, smoke green means:

- The app booted and the env-validation banner is clean.
- The global guards, the global validation pipe, and the BFF mount
  are all wired.
- The Stripe webhook signature gate is active.
- The invite landing renders.

It does **not** mean a real user can sign up, redeem a coach invite,
exchange a message, generate an AI reply, and complete a Stripe
checkout end-to-end. Those flows require credentialled mobile,
console, and Stripe assets that the smoke script intentionally does
not exercise. The full end-to-end QA pass lives in
[`docs/e2e-qa-runbook.md`](docs/e2e-qa-runbook.md) and is a manual
sweep that runs after smoke.

In short: backend live equals smoke green, not full SaaS E2E green.

## Project layout

```
src/
  admin/         OWNER-only platform admin
                  federation/  cross-product reads (fitness + finance)
                  console/     id-keyed alias routes the admin console renders
  ai/            GP assistant: context, prompt, guardrails, fallback
  audit/         AuditLog writer + AuditAction constants
  analytics/    PostHog passthrough (no-op when key unset)
  auth/          Supabase-backed auth, JWKS verification, role gating
  billing/       Stripe webhook, mirror, SubscriptionGuard, OWNER + coach billing
  build-week/    7-day Build Week guided experience (catalog + enrolment + funnel)
  check-ins/     Daily and weekly check-ins
  coach/         Coach mobile surface (roster, timeline, alerts, guidelines)
  common/        Shared decorators, guards, env validation
  community/     Leaderboard and wins
  diagnostic/    40-point diagnostic + AI roadmap (public lead capture)
  fasting/       Fasting windows
  filters/       Global exception filters
  food/          Food DB (local + USDA + OpenFoodFacts)
  habits/        Habit tracker and logs
  health/        Liveness probe (GET /health)
  invite-codes/  Per-coach invite codes (default link + legacy multi-row)
  invite-landing/ HTML landing for /join/:code and /invite/:code
  lessons/       Coach-authored lesson content
  log/           Logged food entries
  meal-plans/    Coach-authored meal plans
  messaging/     Coach + client messaging, Realtime ping, read markers
  notifications/ User push-notification preferences
  nudges/        Coach-authored nudges
  prep-guide/    Onboarding prep guide
  profile/       User profile, macro math
  ptm/           Predictive Tracking Model: signal collection, scoring, recompute
  public-pages/  /download/*, /signup, /privacy, /terms, /security, /status
  recipes/       Recipe library
  supabase/      Supabase Realtime helper
  system/        Trust meta read (LAST_SECURITY_DEPLOY_AT)
  users/         User self-service + GDPR account lifecycle
  v1/            Coach console BFF (subscription-gated)
  water/         Water intake
  weight/        Weight logs
  workout/       Routines and sessions
prisma/          Schema, migrations, seed
scripts/         release.sh, bootstrap-owners.ts, env-secret printer, smoke
docs/            Operator runbooks and reading-order index
```

Each major module has its own README. Start with
[`docs/README.md`](docs/README.md) for the index and the suggested
reading order.

## Scripts

| Command | What it does |
|---|---|
| `npm run start:dev` | Watch-mode Nest dev server. |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm run start:prod` | Run the compiled server (`node dist/main`). |
| `npm run lint` | Run ESLint over `src/`. |
| `npm test` | Run the Jest test suite. |
| `npm run smoke:staging` | Anonymous smoke check against the staging API. |
| `npm run smoke:prod` | Anonymous smoke check against production. |
| `npm run backfill:coach-subscriptions` | One-time backfill that gives every existing coach a `CoachSubscription` row with status `grandfathered` so flipping `BILLING_ENFORCEMENT=enforce` does not lock alumni out of the coach console. Idempotent. Run before the flag flip. Logs scanned / backfilled / already-had counts. |

## Test

```bash
npm test
```

CI runs the same suite plus `tsc --noEmit` on every PR.

## Health check

`GET /health` returns `{ ok: true, uptime, timestamp }` and is
unauthenticated. It is the Fly liveness probe and is safe to call
from anywhere.

## API documentation

The API publishes an OpenAPI 3.1 spec generated from controllers and
DTOs via `@nestjs/swagger`. Two endpoints are mounted, and **both are
gated** so production stays opt-in:

| Path         | Purpose                                              |
| ------------ | ---------------------------------------------------- |
| `/docs`      | Interactive Swagger UI (Try-it-out, schema browser). |
| `/docs-json` | Raw OpenAPI 3.1 JSON, for SDK generators / diffing.  |

**Gating.** Docs are enabled when `NODE_ENV !== 'production'`, OR when
`ENABLE_API_DOCS=true` is set explicitly. To turn docs on in prod:

```bash
fly secrets set ENABLE_API_DOCS=true
```

In dev, just hit `http://localhost:3000/docs` after `npm run start:dev`.
Note: these paths are mounted **outside** the global `/api` prefix.

**Auto-generated artifact.** A snapshot of the spec lives at
[`docs/openapi.json`](docs/openapi.json). Regenerate it with:

```bash
npm run openapi:export
```

CI can use this to publish the spec to a partner portal or to diff for
breaking changes between PRs.

**Annotation convention.** Auth, user-account, and health endpoints are
fully annotated with `@ApiOperation`, `@ApiResponse`, and DTO-level
`@ApiProperty`. Every other controller carries an `@ApiTags(...)` so
endpoints group correctly in Swagger UI. **All new endpoints must add
`@ApiOperation` + `@ApiResponse`** — see
[`docs/api-conventions.md`](docs/api-conventions.md) for the rule and
the reference example.
