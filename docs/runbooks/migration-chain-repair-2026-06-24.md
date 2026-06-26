# Migration Chain Repair — 2026-06-24

**Author:** Bradley Gleave <bradley@bradleytgpcoaching.com>
**Branch:** `chore/migration-chain-full-repair`
**Base:** `main` @ `be1cdb751c54a7882a59c96918e886dca19ac634`
**CI gate targeted:** `Migration Dry-Run` → job `Forward migration applies cleanly`
(`.github/workflows/migration-dry-run.yml`)

---

## TL;DR

The `Forward migration applies cleanly` gate has **two** checks:

1. **Apply** — `npx prisma migrate deploy` against a disposable Postgres must
   succeed (subject to a grandfather clause for PRs that do not touch
   `prisma/migrations/**`).
2. **Schema parity** — `npx prisma migrate diff --from-url $DATABASE_URL
   --to-schema-datamodel prisma/schema.prisma --exit-code` must return `0`.
   This step runs **only when Apply succeeds** (`if: steps.apply.outcome ==
   'success'`) and is **not** subject to the grandfather clause.

This repair **fixes every defect that blocked check #1** — the 153+ migration
chain now applies cleanly end-to-end (exit 0, all migrations applied) against a
fresh Postgres with the Supabase-equivalent bootstrap.

Fixing the apply failures **exposes** check #2, which **never ran on `main`**
because `main`'s chain fails to apply (so `steps.apply.outcome` was never
`success`). Check #2 reveals ~114 pre-existing `schema.prisma` ↔ migration
drift items that **predate this work** and require **production / schema-
architecture decisions** to resolve. Those decisions are surfaced below; they
are **not** shipped, because the safe options that would make the gate green
either (a) require destructive operations on populated production tables, or
(b) require an invasive redesign of the central `User` model. Per the repair
mandate ("STOP and surface" on destructive prod migrations; "do not open a
half-baked PR"), no PR is opened until a maintainer chooses a path.

---

## Part 1 — Forward-deploy defects fixed (check #1 now passes)

All committed in the WIP snapshot under `Bradley Gleave
<bradley@bradleytgpcoaching.com>` (author + committer).

### Fix A — Supabase-equivalent CI bootstrap
- **File:** `.github/workflows/migration-dry-run.yml` (+ new
  `prisma/migrations/_supabase_bootstrap.sql`)
- **Why:** Production runs on Supabase-managed Postgres, which provides the
  `auth` schema (`auth.uid()`) and the `service_role` / `authenticated` /
  `anon` roles. The bare `postgres:15.18` CI service provides none of them, so
  migrations that reference those objects (RLS policies, etc.) cannot apply.
- **What:** Added a CI step that runs the idempotent
  `_supabase_bootstrap.sql` (leading underscore ⇒ Prisma's migration engine
  ignores it) after `npm ci`, stripping the `?schema=` query param
  (`${DATABASE_URL%%\?*}`) because `psql` does not accept it as a libpq URI
  parameter.

### Fix B — Two migration directory renames (ordering)
Renamed via `git mv` (content unchanged) so they sort into the correct
position relative to the tables they depend on:
- `20250724120000_subcoach_invite_token_hash` →
  `20260604000001_subcoach_invite_token_hash`
- `20250724120001_team_audit_revenue_sharing_changed` →
  `20260510000001_team_audit_revenue_sharing_changed`

### Fix C — `sub_coach` Role enum value
- **Files:** `prisma/schema.prisma` (added `sub_coach` to the `Role` enum) +
  new `prisma/migrations/20260701235900_add_sub_coach_role_value/migration.sql`
  (`ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'sub_coach'`, marked
  `-- IRREVERSIBLE` because Postgres cannot drop an enum value).

### Fix D — `CONCURRENTLY` index migrations split out of transactions
`prisma migrate deploy` wraps each multi-statement migration file in a
transaction, and `CREATE INDEX CONCURRENTLY` cannot run inside a transaction
(SQLSTATE 25001).
- `20260704000001_coach_brief_cwa_index_concurrent/migration.sql`: removed the
  `COMMIT; … BEGIN;` bookends and corrected the index name to
  `ClientWorkoutAssignment_assigned_by_coach_id_approved_by_co_idx`.
- `20261207000000_pr14_..._guest_subscription/migration.sql`: removed the
  inline `CONCURRENTLY` block; moved it into a new single-statement migration
  `20261207000001_pr14_client_purchase_landing_page_idx_concurrent/`.

### Fix E — `CommunityWin.visibility` column ordering
A later RLS migration (`tier5_community`) referenced
`CommunityWin.visibility` before it existed. Added
`20260425030001_add_community_win_visibility/` (TEXT `DEFAULT 'circle'`) to
create the column before it is referenced.

### Fix F — `named_regimes_and_partial_refund_decision` ordering
Renamed `20261214000000_named_regimes_and_partial_refund_decision` →
`20261215000300_named_regimes_and_partial_refund_decision` because it ALTERed
`WorkoutProgram` before the migration that creates that table.

### Fix G — uuid/text reconciliation (Bradley's decision: keep `User.id` TEXT)
Per the explicit decision to keep `User.id` as TEXT (matching baseline + prod),
the community columns that reference `User.id` were downgraded from `@db.Uuid`
to plain TEXT in **both** `schema.prisma` (17 columns) and the affected
migrations (community_v1_1_schema, community_classroom_posts,
community_voice_notes, community_wearable_prompts,
community_wearable_prompts_uuid_id). This eliminated the `uuid = text` FK type
mismatch that previously blocked apply.

**Result:** `npx prisma migrate deploy` → **exit 0**, all migrations applied
(verified locally on PostgreSQL 18.3 with the Supabase bootstrap; CI uses
`postgres:15.18`, and every defect above is a version-independent DDL/ordering
error).

---

## Part 2 — Schema-parity drift (check #2) — REQUIRES A DECISION

After Part 1, `migrate diff --from-url <applied-db> --to-schema-datamodel
prisma/schema.prisma --exit-code` returns **non-zero**: ~114 differences
between what the migration chain builds and what `schema.prisma` declares.
**This drift is pre-existing on `main`** — it was simply never surfaced,
because `main`'s chain never applies, so the diff step never ran.

Full machine-readable diff: `prisma migrate diff … --script` output is saved at
`verdicts/migration_full_repair_drift_full.sql`.

### 2a. SAFE / additive (no decision needed; ready to ship)
- **4 tables + 1 enum the app already queries but no migration creates:**
  `Recipe`, `SavedRecipe`, `ListItem`, `UserPreferences`, enum `ListType`.
  The Prisma client uses these: `prisma.recipe` (×7), `prisma.savedRecipe`
  (×6), `prisma.listItem` (×9), `prisma.userPreferences` (×3) in
  `src/recipes`, `src/lists`, `src/users`. **These tables are missing on prod
  too** unless created out-of-band — this is a latent application bug, not just
  a CI nit.
- **Additive columns:** `User.archived_at`, `UserProfile.{bio, calorie_display,
  meals_per_day, onboardingCompleted, water_goal_oz, weight_unit}`,
  `NotificationPreferences.{daily_checkin_enabled, new_client_alerts,
  weekly_summary_enabled}`.
- **19 index renames** (`ALTER INDEX … RENAME`) — metadata only, safe.
- **7 index redefinitions** (drop + recreate same name with new column order /
  predicate) — safe.
- A ready-to-ship additive migration body is staged at
  `verdicts/migration_full_repair_additive_reconcile_up.sql`.

### 2b. Type / default annotation mismatches (safe to fix in schema.prisma, but only matter if 2c is also resolved)
The migrations created columns with conventions that `schema.prisma` does not
declare. Declarative annotations (no behavior change, no data change) would
close these:
- **`@updatedAt` vs `DEFAULT CURRENT_TIMESTAMP`** on 16 `updated_at` columns
  (Bloodwork*, CoachBrief*, CoachDailyLog, CoachLandingPage, CoachProfile,
  WorkoutBuilderIdempotencyKey, …). Fix: add `@default(now())` to each.
- **`@db.Timestamptz` vs `TIMESTAMP(3)`** on `recent_auth_nonce.{expires_at,
  created_at}` and `CoachLandingLead.next_eligible_at`. Migrations use
  `TIMESTAMPTZ`; schema maps `DateTime` → `TIMESTAMP(3)`. Fix: add
  `@db.Timestamptz`.
- **`@db.VarChar(20)` vs TEXT** on `WorkoutBuilderIdempotencyKey.status`
  (migration is `VARCHAR(20)`). Fix: `@db.VarChar(20)`.
- **DB defaults not declared in schema:** `payload`/`field_mapping`
  `@default("{}")`, `synced_to`/`package_ids`/`lead_capture_fields`
  `@default([])`, `Notification.id`/`NotificationDigestLog.id`
  `@default(dbgenerated("(gen_random_uuid())::text"))`,
  `community_*.id` `@default(dbgenerated("gen_random_uuid()"))`. All declarative.

### 2c. DESTRUCTIVE / architecture-level — STOP-AND-SURFACE
Closing the diff to `0` requires resolving these, and **every available option
is a production decision, not a CI fix.** Full list saved at
`verdicts/migration_full_repair_destructive_residual.sql`.

1. **18 net foreign-key removals on intentional SQL-layer FKs.** The
   talent-marketplace (`JobListing`, `Applicant`, `Application`, `CoachOffer`)
   and community (`community_messages`, `community_search_entries`,
   `community_wearable_prompts`, `community_wearable_prompt_sources`) tables
   declare their FKs **only at the SQL layer** by deliberate design — see the
   `schema.prisma` comments: *"every user/listing/application FK is a SCALAR
   column (TEXT, matching User.id); the foreign-key + RLS policies are authored
   in the SQL migration … which is the single source of truth for referential
   integrity"* and *"no cross-subsystem Prisma relation; FK at SQL layer."*
   Prisma's `migrate diff` cannot see SQL-layer-only FKs, so it proposes
   `DROP CONSTRAINT` for all 18.
   - **Option A (drop them):** DESTRUCTIVE — removes real referential integrity
     that RLS and the app rely on. Not acceptable.
   - **Option B (model them):** add `@relation` fields to `schema.prisma`,
     which requires adding ~18 back-relations to the central `User` model
     (plus `community_workspaces`, `community_cohorts`, `WearableSample`,
     `Recipe`). This is an invasive redesign of the most-referenced model,
     changes the generated Prisma client surface, and contradicts the
     documented append-only / scalar-FK design. **Needs a maintainer's
     explicit sign-off.**

2. **2 orphan tables Prisma wants to DROP:**
   - `DROP TABLE "DataExportRequest"` (PascalCase). The live model maps to
     `@@map("data_export_request")` (snake_case), created later by
     `20260508000000_add_data_export`; the PascalCase table from
     `20260427120000_add_audit_log_and_gdpr_lifecycle` is a superseded orphan.
     Dropping it is safe for the app but **may discard GDPR export rows written
     before the snake-case cutover** on prod → data decision.
   - `DROP TABLE "deletion_audit"`. **Used by `src/account-deletion`** (via raw
     SQL — it is not a `schema.prisma` model). Dropping it would **break
     account-deletion in production.** The correct fix is to **model it in
     `schema.prisma`** (so diff stops wanting to drop it), not to drop it.

3. **`DROP COLUMN community_search_entries.search_tsv`** — a generated
   `tsvector` column with a GIN index, **used by
   `src/community/search/community-search.repository.ts`**. Dropping it breaks
   community search. Correct fix: model the generated column in `schema.prisma`.

4. **3 `ALTER COLUMN … SET DATA TYPE` on populated tables** — covered by 2b as
   declarative fixes (`@db.Timestamptz`, `@db.VarChar`); flagged here because if
   instead applied as a migration they would be `ALTER TYPE` on populated prod
   tables (the explicit STOP trigger). **Resolve in `schema.prisma`, never as a
   data migration.**

5. **`CoachPackage_share_token_key` partial vs full unique index.** The
   migration (`20260801000000_r43_storefront_phase1`) intentionally creates a
   **partial** unique index (`… WHERE share_token IS NOT NULL`, documented R43
   rationale — share tokens are minted on demand, mostly NULL). `schema.prisma`
   declares `share_token String? @unique`, which Prisma renders as a **full**
   unique index, so diff proposes a colliding `CREATE UNIQUE INDEX`. Prisma's
   schema language cannot express a partial unique index, so this drift cannot
   be closed in `schema.prisma` and cannot be closed by a migration without
   dropping/recreating the index. **Design decision required.**

---

## Recommended path (for maintainer)

1. **Ship Part 1 now** — it fixes the actual broken chain and is low-risk.
   (Note: opening the PR triggers check #2, which will be red until Part 2 is
   resolved — see below.)
2. **Resolve 2a + 2b** — additive migration for the 4 missing app tables +
   columns, plus declarative `schema.prisma` annotations. This also fixes a
   latent prod bug (missing `Recipe`/`SavedRecipe`/`ListItem`/`UserPreferences`
   tables the app queries).
3. **Decide 2c** explicitly:
   - Model `deletion_audit` and `community_search_entries.search_tsv` in
     `schema.prisma` (do NOT drop — the app uses them).
   - Choose Option B (add `@relation`s) for the 18 SQL-layer FKs, or formally
     accept that the `migrate diff` gate cannot be `0` under the current
     scalar-FK design and adjust the gate (e.g. allow-list the known SQL-layer
     FKs) instead.
   - Decide the fate of the `DataExportRequest` PascalCase orphan (drop with a
     data-backfill check, or `@@ignore` it in schema).
   - Decide the `CoachPackage_share_token_key` partial-index policy.

Until step 3 is decided, **no PR is opened**, per the mandate: *"Do NOT open PR
if local migrate deploy fails OR migrate diff exit-code != 0"* and *"If you
discover something that requires a destructive prod data migration … STOP and
surface."*

---

## Verification commands (local)

```bash
cd <repo>
TESTDB="migration_repair_$(date +%s)"
psql "postgresql://postgres:postgres@localhost:54399/postgres" -c "CREATE DATABASE $TESTDB"
export DATABASE_URL="postgresql://postgres:postgres@localhost:54399/$TESTDB"
export DIRECT_URL="$DATABASE_URL"
PG_URL="${DATABASE_URL%%\?*}"
psql "$PG_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/_supabase_bootstrap.sql
npx prisma migrate deploy            # -> exit 0 (Part 1 fixed)
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma --exit-code   # -> non-zero (Part 2 drift)
```
