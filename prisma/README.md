# prisma

Schema, migrations, and seed data for the Postgres database (hosted on
Supabase). The schema is the single source of truth — `prisma migrate
deploy` runs at boot and on CI; no out-of-band SQL.

## Layout

| Path | Contents |
|---|---|
| `schema.prisma` | The full data model (36 models, 5 enums) |
| `migrations/` | Forward-only migration history; one folder per migration |
| `seed-recipes.ts` | Seed for the recipe library (idempotent insert-or-skip) |

## Migration policy

- **Forward-only.** Every migration has a `migration.sql` file. There
  are no `down` migrations; rollback is a new forward migration.
- **Apply at boot.** `node dist/main.js` is preceded by `prisma
  migrate deploy` in the deploy pipeline. CI also runs `prisma
  generate`.
- **No raw SQL out of band.** A schema drift caught by `prisma migrate
  status` against staging or production is a production incident.

## Migration index

| Folder | What it does |
|---|---|
| `00000000000000_baseline` | Initial schema as of the migration cutover — supersedes the legacy handwritten `migrations/001_create_water_logs.sql`. |
| `20260423190000_add_indexes_and_orphan_fks` | Hot-path covering indexes (logged_food_entry, workout_session) and the missing FKs that allowed orphans. |
| `20260424000000_add_invite_codes` | Legacy multi-row `InviteCode` table — `expires_at` + `max_uses` semantics. |
| `20260424120000_add_coach_messages` | `CoachMessage` table with the composite index `(coach_id, client_id, created_at)` that powers paginated thread reads. |
| `20260424180000_add_coach_nudges` | Coach-authored nudges. |
| `20260424200000_add_meal_plans_and_extend_checkins` | `MealPlan` rows and an extension to `CheckIn` for weekly intake. |
| `20260425030000_add_community_win_and_coach_guideline` | `CommunityWin` plus the per-pair `CoachGuideline` (composite unique on coach + client). |
| `20260427000000_add_owner_role_and_coach_profile` | Phase 1A platform pivot — adds the `owner` enum value and the `CoachProfile` table that carries the default invite link, branding, and `stripe_customer_id`. |
| `20260427000100_add_saas_billing_and_drafts` | `CoachSubscription`, `Invoice`, `PaymentFailure`, `StripeProcessedEvent`, and `MessageDraft` (one draft per coach × client). |

## Schema highlights

- `User.role` is a `Role` enum (`owner` / `coach` / `student`). OWNER
  was added in Phase 1A and is opt-in — existing rows are unaffected.
- `User.coach_id` is the durable coach ↔ client link. Even if the
  invite code rotates or the coach is later demoted, this column
  remains the source of truth for messaging, the AI context, and the
  coach console.
- `User.archived_at` is the soft-archive marker on a roster.
- `CoachProfile` has a unique `invite_code` (the default per-coach
  link) and a `stripe_customer_id` that the billing webhook resolves
  on (`findFirst`, not unique on this table).
- `CoachSubscription` is the local mirror of Stripe state, keyed by
  `coach_id`. `last_payment_failed_at` and
  `failed_payments_this_month` are written by the webhook; the
  console reads them.
- `StripeProcessedEvent` is the idempotency table for the webhook —
  unique on `stripe_event_id`, written in a `finally` block in
  `BillingService` so a poison-pill payload does not loop forever.
- `CoachMessage` is unidirectional in storage but bidirectional in
  semantics; `sender_id` distinguishes who spoke. `read_at` is the
  only mutation after insert.
- `MessageDraft` is keyed `(coach_id, client_id)` for one-draft-per-
  pair semantics.
- `CoachGuideline` shares the same composite-unique pattern, named
  `CoachGuideline_coach_client_key`.

## Foreign keys and orphan policy

The Phase-1B index migration (`20260423190000_add_indexes_and_orphan_fks`)
back-filled FKs that were missing on early-stage tables. New columns
referencing `User`, `CoachProfile`, etc. should always carry an FK and
should opt explicitly into the cascade behavior — the default has
been `Restrict` so a misuse blocks the migration.

## Environment variables

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string used by both `prisma generate` and the runtime client. Required. |

## Seed

`npx ts-node prisma/seed-recipes.ts` populates the recipe library.
Idempotent — re-running skips rows that already exist by canonical
name + slug.

## Operational notes

- Adding a new migration: `npx prisma migrate dev --name <name>` from
  a local Postgres. Commit both the new folder and the regenerated
  `schema.prisma`.
- Promoting to staging / production: deploy applies `prisma migrate
  deploy` automatically. Do not run `migrate dev` against a shared
  database — it will reset.
- Schema drift between code and database surfaces as a runtime error
  the first time a query references the missing column. To check
  ahead of time, run `prisma migrate status` against the target.
- Index changes that touch a large table (`logged_food_entry`,
  `workout_session`) should use `CREATE INDEX CONCURRENTLY` in raw
  SQL inside the migration. Prisma does not emit `CONCURRENTLY` on
  its own.
