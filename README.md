# The Growth Project — Backend

NestJS 10 + Prisma 5 + Supabase API for a fitness/nutrition coaching app. Deployed to Fly.io.

## Stack

- **NestJS 10** — HTTP framework
- **Prisma 5** — Postgres ORM against Supabase Postgres
- **Supabase** — auth (ES256-signed session tokens) and user storage
- **OpenAI / Perplexity** — AI chat
- **USDA FoodData Central + OpenFoodFacts** — food lookup

## Setup

```bash
npm install
cp .env.example .env   # then fill in values — see below
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

The API listens on `http://localhost:3000` with all routes under `/api/*`, except `/health` which is intentionally unprefixed.

## Environment variables

All of these are required at runtime (set them in `.env` locally and in Fly secrets for production):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Postgres connection string used by Prisma |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key (used for email/password login) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (used for `getUser(token)` in `JwtAuthGuard`) |
| `SUPABASE_REDIRECT_URL` | Deep-link target for email confirmation (e.g. `tgp://verified`) |
| `CORS_ORIGINS` | Comma-separated allowlist of origins, or `*` for mobile-only deployments |
| `JWT_SECRET` | Reserved — currently unused; Supabase tokens are verified via `supabase.auth.getUser()` |
| `USDA_API_KEY` | Key for USDA FoodData Central search. Do **not** ship `DEMO_KEY` to production |
| `PERPLEXITY_API_KEY` | Key for the AI-coach endpoint (`/api/ai/chat`) |
| `PORT` | HTTP port (default `3000`; Fly.io overrides this) |
| `NODE_ENV` | `development` or `production` |

## Prisma migrations

Migrations are **mandatory** now — the schema is tracked via `prisma/migrations/` and applied with `prisma migrate deploy` at boot. The legacy handwritten `migrations/001_create_water_logs.sql` has been superseded by the Prisma baseline. Never edit Postgres schema out-of-band.

## Scripts

| Command | What it does |
|---|---|
| `npm run start:dev` | Watch-mode Nest dev server |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:prod` | Run the compiled server (`node dist/main`) |
| `npm run lint` | Run ESLint over `src/` |

## Health check

`GET /health` → `{ ok: true, uptime, timestamp }`. Unauthenticated. Used by Fly.io's health probe; safe to call from anywhere.

## Deployment

Fly.io, via the GitHub Actions workflow at `.github/workflows/fly-deploy.yml`. The Dockerfile runs `node dist/main.js` directly — there is no `start.sh`.

## Project layout

```
src/
  auth/         Supabase-backed auth + guards
  profile/      User profile + macro math
  food/         Food DB (local + USDA + OpenFoodFacts)
  log/          Logged food entries
  workout/      Routines and sessions
  fasting/      Fasting windows
  weight/       Weight logs
  habits/       Habit tracker + logs
  ai/           AI coach chat
  coach/        Coach-facing endpoints (clients, alerts)
  community/    Leaderboard / wins
  notifications/ User push-notification preferences
  lessons/      Coach-authored lesson content
  water/        Water intake tracking
  health/       Liveness probe (GET /health)
  filters/      Global exception filters
```

## Test

```bash
npm test
```

## CI

`.github/workflows/ci.yml` runs on every PR and push to `main`:
install, `prisma generate`, lint (if configured), `tsc --noEmit`, build, test.
