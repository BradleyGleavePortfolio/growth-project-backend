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
| `POSTHOG_KEY` | optional | PostHog dashboard | Project key. AnalyticsModule no-ops when unset. |
| `POSTHOG_HOST` | optional | PostHog dashboard | Override host (only set when self-hosting PostHog). |
| `PERPLEXITY_API_KEY` | optional | Perplexity dashboard | API key for `/api/ai/chat`. The deterministic fallback responder runs when unset or on provider error. |
| `USDA_API_KEY` | optional | USDA FDC | Key for food search. Required for non-degraded food results in production; do not ship `DEMO_KEY`. |
| `COACH_CODE_GATE_ENABLED` | optional | Backend operator | Feature flag. When `true`, `/auth/signup-with-code` requires a valid coach invite code. |
| `BILLING_ENFORCEMENT` | optional | Backend operator | Feature flag. `enforce` blocks coach writes for `past_due` past grace and for `canceled` / `paused`. Anything else is observe-only. |
| `STRIPE_PRICE_ID_FINANCE` | optional | Stripe dashboard | Reserved for the second vertical. Currently unused. |
| `JWT_SECRET` | legacy | n/a | Reserved. Token verification is JWKS-based; the value is not consulted. |
| `RELEASE_ALLOW_DB_PUSH` | optional | Backend operator | One-time bootstrap escape hatch in `scripts/release.sh`. Allows `prisma db push --accept-data-loss` only when the DB has no `_prisma_migrations` table. Leave unset on any environment that holds real data. |
| `BOOTSTRAP_OWNER_EMAILS` | optional | Backend operator | Comma-separated emails consumed by `scripts/bootstrap-owners.ts` to seed the initial OWNER list. Idempotent. |
| `PORT` | optional | Fly.io | HTTP port. Defaults to 3000; Fly overrides this. |
| `NODE_ENV` | optional | Backend operator | `development`, `staging`, or `production`. Drives the validation tier and the AI debug payload. |

### Feature flags

| Flag | Default | Effect |
|---|---|---|
| `COACH_CODE_GATE_ENABLED` | unset (off) | When `true`, `/auth/signup-with-code` rejects requests that lack a valid coach invite code. The `/auth/signup-policy` endpoint reflects this so mobile can hide or show the field. |
| `BILLING_ENFORCEMENT` | unset (observe-only) | When `enforce`, `SubscriptionGuard` denies coach writes for `past_due` (past 7-day grace), `canceled`, `paused`, `incomplete`, and `unpaid` subscriptions. Anything else lets every request through, with the verdict still computed. |

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
three set, the webhook accepts events, the coach-billing controller
returns a real mirror, the OWNER-only start-subscription endpoint can
provision new coaches, and `SubscriptionGuard` has data to reason
over.

When any of the three is unset (the default in dev), the routes stay
mounted but return deterministic responses: the webhook returns 400
`Stripe webhook secret not configured`, the start-subscription and
portal-session endpoints return `STRIPE_NOT_CONFIGURED`, and
`SubscriptionGuard` is observe-only. The console renders the right
empty state without a real Stripe key.

For the full setup (products, prices, webhook signing secret, customer
portal), see [`docs/stripe-setup.md`](docs/stripe-setup.md).

### Sentry, PostHog, Supabase, Fly variables

- **Sentry**: `SENTRY_DSN` is the only required variable. The Sentry
  client is initialized in `src/instrument.ts` before the Nest app is
  created so auto-instrumentation can patch the runtime.
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
  meals per day, water goal, calorie display, and the
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

### Audit and GDPR posture

The platform does not currently expose a GDPR endpoint to the user.
The pieces in place today are:

- `User.archived_at` for soft-archive on a roster.
- `ActivityEvent` for actor-attributed history.
- `StripeProcessedEvent` for billing event provenance.
- The Sentry and PostHog integrations both no-op when their
  credentials are unset, which is the default in development; PII
  exposure to those vendors is therefore opt-in per environment.

A user-facing "delete my data" path is not implemented. The
operator-driven path is to (1) archive the row, (2) wait out the
retention window, and (3) delete via SQL after taking a backup.
Treat the absence of a self-service GDPR endpoint as a known gap;
do not invent a fake one in client-facing copy.

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
| `POST` | `/auth/become-coach` | authed | Password re-auth, then role elevation. |
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
| `POST` | `/v1/webhooks/stripe` | public, signature-verified | HMAC-SHA256 v1, 300s tolerance. |
| `GET` | `/v1/coach/me/billing` | coach | Reads `CoachSubscription` for the caller. |
| `POST` | `/v1/coach/me/billing/portal-session` | coach + subscription gate | Creates a Stripe Customer Portal session. Returns `STRIPE_NOT_CONFIGURED` until `STRIPE_SECRET_KEY` is set. |
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
| `POST` | `/coach/clients/:id/archive`, `/coach/clients/:id/unarchive`, `/coach/guidelines/:client_id` | coach or owner | Roster mutations and guideline upsert. |
| `GET` | `/admin/coaches`, `/admin/coaches/:id`, `/admin/users` | owner | OWNER-only inventory. |
| `POST` | `/admin/users/:id/promote` | owner | Role change with lazy `CoachProfile` provisioning. |

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
4. **Deploy**: `fly deploy -a <app>`. The `release_command` runs
   `prisma migrate deploy` first; if the DB has not been baselined
   it falls back to `prisma db push --accept-data-loss` only when
   `RELEASE_ALLOW_DB_PUSH=1` is set and the DB has no
   `_prisma_migrations` table.
5. **Watch the boot log** for the env-validation banner and the
   `port` line.
6. **Run the smoke script** (see below).
7. **Bootstrap OWNERs and flip flags** in the order documented in
   the runbook (OWNER promote, then `COACH_CODE_GATE_ENABLED`, then
   `BILLING_ENFORCEMENT=enforce`).

`Dockerfile` runs `node dist/main.js` directly. There is no
`start.sh`. CI lives in `.github/workflows/ci.yml` and runs
`npm install`, `prisma generate`, `tsc --noEmit`, build, and
`npm test` on every PR and push to `main`.

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
  ai/            GP assistant: context, prompt, guardrails, fallback
  analytics/    PostHog passthrough (no-op when key unset)
  auth/          Supabase-backed auth, JWKS verification, role gating
  billing/       Stripe webhook, mirror, SubscriptionGuard, OWNER + coach billing
  check-ins/     Daily and weekly check-ins
  coach/         Coach mobile surface (roster, timeline, alerts, guidelines)
  common/        Shared decorators, guards, env validation
  community/     Leaderboard and wins
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
  public-pages/  /download/*, /signup, /privacy, /terms, /security, /status
  recipes/       Recipe library
  supabase/      Supabase Realtime helper
  users/         User self-service
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

## Test

```bash
npm test
```

CI runs the same suite plus `tsc --noEmit` on every PR.

## Health check

`GET /health` returns `{ ok: true, uptime, timestamp }` and is
unauthenticated. It is the Fly liveness probe and is safe to call
from anywhere.
