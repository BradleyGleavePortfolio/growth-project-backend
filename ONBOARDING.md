# Backend Onboarding

You are joining `growth-project-backend`, the NestJS 10 + Prisma 5 + Supabase API powering the fitness pillar of The Growth Project. This document is the first thing to read after `git clone`. Budget about two hours.

Last verified: 2026-05-09.

---

## What this repo does

This backend serves the mobile app (`growth-project-mobile`), the coach console BFF, the public invite landing pages, the public trust pages, and the Stripe webhook receiver. It is one of two backends in the empire — the other is the finance pillar (`tgp-finance-app/backend`). The two are federated under one identity by the cross-pillar surfaces.

---

## Local setup

```bash
git clone git@github.com:BradleyGleavePortfolio/growth-project-backend.git
cd growth-project-backend
npm install
cp .env.example .env
# fill in DATABASE_URL, SUPABASE_*, JWT_SECRET, COACH_ACCESS_CODE, PERPLEXITY_API_KEY
npx prisma generate
npx prisma migrate deploy
npm run start:dev
# API listens on http://localhost:3000
```

The boot validator (`src/common/env-validation.ts`) crashes the process if any hard-tier env var is missing or contains a placeholder like `<value>` or `REPLACE_ME`. Read the README's variable matrix before filling `.env`.

For local-dev, you need:

- Node.js 20+
- A Supabase project (the cheapest tier is fine; never share the staging or production project's keys with local dev).
- A Redis instance (Upstash free tier or local `redis-server` on `localhost:6379`). Optional in dev, but the throttler falls back to in-memory and rate limits then do not cross machines.

---

## Codebase tour

The `src/` layout is one folder per feature module. Important ones:

| Folder | What lives here |
|---|---|
| `auth/` | Sign-in, sign-up, password reset, Apple sign-in, Google OAuth via Supabase |
| `users/` | Profile, account access status, data-export plus account-delete handlers |
| `coach/` | Coach OS surfaces: coach controller, alerts, effectiveness signals, onboarding |
| `invite-codes/` | Coach-issued invite codes (revoke, redeem, redemption metadata) |
| `invite-landing/` | Public invite landing pages (no auth, served outside the `/api` prefix) |
| `messaging/` | Coach-to-client direct messaging |
| `community/` | Coach-to-team posts plus community feed |
| `analytics/` | Coach analytics, dashboard aggregates, retention math |
| `lessons/`, `habits/`, `food/`, `meal-plans/`, `recipes/`, `weight/`, `water/`, `fasting/`, `workout/` | Per-feature product modules used by the mobile app |
| `workout-builder/`, `exercise-library/` | Sprint B / Phase 11 — coach-side workout builder plus ExerciseDB-backed catalog |
| `ai/` | AI coach gateway (Perplexity sonar-pro with deterministic fallback) |
| `notifications/` | Push (Expo) plus in-app inbox plus digest cron |
| `nudges/` | Coach-issued check-in nudges |
| `health/` | Liveness and readiness probes |
| `system/` | Trust Center capabilities, release-info endpoint, support contact resolution |
| `admin/` | OWNER-gated admin surfaces |
| `audit/`, `consent/`, `filters/`, `throttler/`, `common/` | Cross-cutting plumbing |
| `billing/` | Stripe portal, subscription management, webhook receiver |
| `prisma/`, `prisma.service.ts` | Prisma client wrapper |
| `v1/` | Versioned route surfaces (when a contract change is mobile-visible) |
| `lists/` | Generic list endpoints |
| `first-win/` | First-week onboarding signal |
| `build-week/`, `ptm/`, `prep-guide/`, `check-ins/`, `diagnostic/`, `leaderboard/` | Coach OS PTM and onboarding surfaces |
| `timeline/` | Cross-feature timeline endpoint for the mobile home screen |
| `public-pages/` | Public trust + privacy + terms pages |
| `supabase/` | Supabase admin SDK wrapper |
| `app.module.ts`, `main.ts` | Boot — validators, global pipe, prefix, CORS, Sentry init |

Federation lives across `admin/` (owner-gated console BFF) and the federation client used by the cross-pillar surfaces; the bearer is `FEDERATION_SERVICE_TOKEN` and is shared with the finance backend.

The Holistic Insights engine ships in Sprint B Build 5 — when you read this, look for a top-level module exposing `/insights/holistic`.

---

## Conventions

- **Strict TypeScript.** No `any`, no `@ts-ignore`. The CI typecheck rejects either.
- **Prisma fields are `snake_case`.** TypeScript-side code is `camelCase`. The mapping is automatic via `@map` in the schema where needed.
- **DTOs are allow-lists.** The global `ValidationPipe` runs `whitelist=true, forbidNonWhitelisted=true`, so any field not declared on the DTO is rejected at the controller boundary. Never pass through raw bodies.
- **Tenancy assertions.** Every coach-side service method that reads or writes a client record asserts the client belongs to the calling coach with the same 404-not-403 convention as `MealPlansService`. Foreign ownership returns 404, not 403, so callers cannot probe for valid client ids.
- **Endpoints touching coach role require rate limiting plus audit logging.** See `src/throttler/` and the audit log helpers used by the coach module.
- **No emoji. No exclamation points.** Anywhere — code, copy, commits, PRs, README. House style.
- **README with every PR.** New endpoint or env var = update the matching README in the same PR. Removed code = README references removed in the same PR. Tombstones (`// removed`, "deprecated", "coming soon") are not a substitute for current truth.
- **Reversible migrations.** Forward-only in production, but author the down step in source for emergencies. Never edit a migration that has shipped.

---

## Auth model — the short version

- Supabase Auth issues ES256 JWTs.
- The backend verifies tokens locally against the Supabase JWKS — no round-trip to Supabase Auth on every request.
- The `JwtAuthGuard` is registered as a global `APP_GUARD`. Public endpoints opt in with `@Public()`, not the other way around.
- Role guards (`@UseGuards(RoleGuard)` plus `@Roles(...)`) sit on top of the auth guard for coach- and owner-only routes.
- Tokens carry the user's Supabase `sub`; the backend maps to `users.id` on first use.

If you see `JWT verification failed: kid not in JWKS`, your `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are mixed across two Supabase projects. See `docs/deploy-runbook.md` §0.1.

---

## Federation — the short version

- The finance backend (`tgp-finance-api`) exposes `/api/admin/federation/*` gated by `FEDERATION_SERVICE_TOKEN`.
- This fitness backend is the consumer; it presents `Authorization: Bearer <FEDERATION_SERVICE_TOKEN>` to read coach plus client summaries from finance.
- Identity mapping is email-based (case-insensitive). Every federation response surfaces `identityMapping: 'email'` so a one-sided match is loud.
- A `shared_identity_id` is the long-term plan; the email path remains as a fallback.

---

## Where to start when a ticket says…

| Ticket says | Start in |
|---|---|
| "Mobile is getting 401 / 403 from /coach/X" | `src/auth/` plus the relevant coach module — check the role guard plus tenancy assertion |
| "Coach console isn't seeing a client's data" | `src/admin/` plus the federation client; check `FEDERATION_SERVICE_TOKEN` parity across both Fly apps |
| "Push notification didn't arrive" | `src/notifications/` plus the digest cron; verify the Expo push token in `users` |
| "Stripe webhook is being rejected" | `src/billing/` — `STRIPE_WEBHOOK_SECRET` is the HMAC secret; the receiver is `/v1/webhooks/stripe` (outside `/api`) |
| "Boot is crashing on staging" | Read the boot logs; the env validator names the failing rule |
| "Throttler isn't blocking" | `REDIS_URL` likely unset; check `flyctl secrets list -a backend-spring-lake-3890` |
| "Need a new endpoint" | `docs/api-conventions.md` — `@ApiOperation` plus `@ApiResponse` are required |

---

## Day-one checklist

- [ ] Clone the repo and run `npm install`.
- [ ] Provision a personal Supabase project for local dev.
- [ ] Generate a `JWT_SECRET` with `openssl rand -hex 32`.
- [ ] Fill `.env`; run `npx prisma migrate deploy`; run `npm run start:dev`.
- [ ] Hit `http://localhost:3000/health` — should return ok.
- [ ] Open `http://localhost:3000/docs` (Swagger UI in dev) — confirm endpoint groups render.
- [ ] Run `npm test` — all 1,049 tests should pass.
- [ ] Read `RUNBOOK.md`, `docs/deploy-runbook.md`, `docs/api-conventions.md`.
- [ ] Read the README's "Route contracts" section once end-to-end.

If anything in the day-one checklist fails, that is the first ticket.

---

## Companion docs

- `README.md` — operator-facing reference (env vars, route contracts, deployment shape)
- `RUNBOOK.md` — daily-ops handbook (deploy, rollback, logs, incidents)
- `docs/deploy-runbook.md` — first-time staging stand-up
- `docs/coach-console-integration.md` — coach console BFF contracts
- `docs/api-conventions.md` — endpoint annotation rule
- `docs/stripe-setup.md` — Stripe dashboard configuration
