# Backlog

Tracked follow-up items that are too large or too disruptive for the current PR
but must not be lost.

---

## BL-GDPR-BRIEF-2 — Client PII embedded in `CoachBrief.brief_context` JSON has no FK scrub path

**Status:** RESOLVED — TTL prune implemented (branch `chore/post-PR266-cleanup`; commit `8008563`)
**Resolved by:** `feat(gdpr): TTL prune stale CoachBrief rows (BL-GDPR-BRIEF-2)` — commit `8008563`
**Opened by:** A1-PR266-P1-1 fix (PR #266, commit `fix(gdpr): scrub Coach Brief tables on soft-delete`)
**Priority:** P2 (no new violation introduced; gap pre-dates this PR and is acknowledged)
**Regulation:** GDPR Art. 17 (erasure) / Art. 5(1)(e) (storage limitation)

### Background

The P1 fix in PR #266 adds four `deleteMany` calls inside `GdprScrubService.scrubOne`
to hard-delete a **scrubbed coach's** own `CoachBrief`, `CoachDailyLog`,
`CoachBriefPreferences`, and `CoachBriefPushLedger` rows.

However, `CoachBrief.brief_context` is a Json blob assembled server-side from
**multiple clients' data** (`coach-brief.service.ts:963-984, 544-598`):
client first names, weight deltas, check-in notes, and message previews.  There
is **no `client_id` FK column** on `CoachBrief` — the client identity is embedded
as text inside the Json value.

Consequence: when a **client** is scrubbed (not the coach), that client's first
name and metrics remain embedded in every head/sub/solo coach's `brief_context`
whose daily brief was generated while the client was active.  The four `deleteMany`
calls added in PR #266 operate on `coach_id`, so they do not address this
client-name-in-other-coaches'-briefs scenario.  No FK-cascade path exists even
in principle for this case.

### Proposed mitigations (either satisfies GDPR Art. 17)

**(a) TTL-drop brief rows older than 24 h (preferred near-term fix)**
Daily briefs are superseded immediately on regeneration; a cron that drops
`CoachBrief` rows where `brief_date < now() - INTERVAL '1 day'` eliminates
stale PII within 24 h of generation.  Briefs in active use (today's brief)
are unaffected.  Simple, low-risk, achievable in a small PR.

**(b) Re-architect `brief_context` to store `client_id` only, resolve names at render time**
`brief_context` stores `client_id` (UUID) alongside the plain-text fields.
At brief-render time the service resolves names from the live `User` table.
After a client is scrubbed, their `User.name` is already tombstoned to
`'Deleted user'`, so render-time resolution automatically redacts the name
without needing to touch the brief row.  Higher engineering effort; requires
a migration + service change + client-app cache invalidation review.

### Acceptance criteria for whichever mitigation is chosen

- A scrubbed client's first name is no longer present in any coach's
  `brief_context` within the GDPR Art. 17 response window (30 days).
- Existing tests in `test/gdpr-scrub.service.spec.ts` continue to pass.
- A regression test covers the client-scrub → coach-brief redaction path.

### Out of scope for this item

- The coach-side scrub (already fixed by PR #266 P1-1).
- `CoachDailyLog.content` text search (no `client_id` reference; mitigated by
  the fact that logs are keyed to the coach, and coach scrub already deletes
  them; client names typed by a coach into a log are a separate editorial concern
  tracked under general free-text PII hygiene).

---

## BL-GDPR-BRIEF-3 — Re-architect `brief_context` to store `client_id` references only

**Opened by:** BL-GDPR-BRIEF-2 resolution (TTL approach chosen as near-term fix)
**Priority:** P3 (lower priority; only pursue if telemetry shows `brief_context` blob size
  becoming a performance or storage concern)
**Regulation:** GDPR Art. 17 (erasure) / Art. 5(1)(e) (storage limitation)

### Background

BL-GDPR-BRIEF-2 was resolved via a 7-day TTL prune (path a). Path (b) — the
architectural approach — remains as a follow-up if the TTL approach proves
insufficient or if `brief_context` blob size grows.

### Proposed approach

`brief_context` should store `client_id` (UUID) alongside the plain-text fields
instead of resolved client names. At brief-render time the service resolves names
from the live `User` table. After a client is scrubbed, their `User.name` is
already tombstoned to `'Deleted user'`, so render-time resolution automatically
redacts the name without needing to touch the brief row.

### Scope

- Migration: add nullable `client_id` array or JSONB restructure to `CoachBrief`.
- Service change: `aggregateSoloContext` stores `client_id` instead of plain name.
- Render path: `toResponse` resolves names at serialization time.
- Client-app cache invalidation review: cached briefs may hold stale names.
- Migration of historical rows (or accept that old rows retain embedded names
  until TTL prune ages them out).

### Trigger

Do only if telemetry shows `brief_context` average blob size exceeding ~10 KB
or if a GDPR DPA requires a shorter erasure window than the 7-day TTL provides.

---

## BL-MIGRATION-REBASELINE — Replace 156-migration chain with a single declarative baseline before GA

**Status:** OPEN — launch-gate item (no time trigger; sequence-only)
**Opened by:** Operator 50 investigation, 2026-06-26 (chain-vs-prod-vs-schema drift surfaced by Op 49's `chore/migration-chain-full-repair` branch and confirmed by deep research against hyperscaler practice)
**Priority:** P2 (build-hygiene, not user-visible — pre-launch, zero users)
**Owner:** Next operator scheduled against this item

### Problem

Three sources of truth disagree:

1. `prisma/schema.prisma` — declares `Recipe`, `SavedRecipe`, `ListItem`, `UserPreferences`, and other models queried by live controllers and wired into `AppModule`.
2. `prisma/migrations/` — 156 migrations that, replayed from empty on a clean Postgres, do not create those tables and do not match the final declared schema. Fails CI's `migration-dry-run.yml` gate, which is currently bypassed by a grandfather clause.
3. Production DB (Fly app `backend-spring-lake-3890`, Supabase us-west-1) — has the tables, plus ~18 out-of-band SQL-layer foreign keys, 2 orphan tables, a generated `tsvector` column, and a partial unique index. None of those appear in `schema.prisma`. Got there via manual DDL accumulated over 18 months.

Production is healthy because each migration applied incrementally as it was added. A fresh-from-empty replay fails. The CI gate cannot be flipped from advisory to blocking until the chain is reconciled.

### Why this is filed and not done

Pre-launch with zero users. None of the in-flight work (A1–A13, H-class, Dependabot ladder) depends on the chain replaying from empty. The chain does not degrade by waiting; each new additive migration appends cleanly on top of running prod. This item must be resolved **before GA / first real user**, not before next feature merge.

### Documented procedure (per Prisma official squashing guide)

Reference: https://www.prisma.io/docs/orm/prisma-migrate/workflows/squashing-migrations

1. **Reconcile `schema.prisma` to actual production state first.** Run `prisma db pull` against prod. Inspect the diff against the committed `schema.prisma`. Manually merge the 18 out-of-band FKs, the 2 orphan tables, the `tsvector` generated column, and the partial unique index into `schema.prisma` so the declarative model reflects production reality. Anything Prisma cannot model declaratively (generated columns, partial indexes, custom FK ON DELETE/UPDATE clauses) must be captured as a SQL note for step 4.
2. **Archive the existing chain.** Move `prisma/migrations/*` (except `migration_lock.toml`) to `prisma/migrations/_archive/`. Git already preserves them; the archive directory provides local navigability.
3. **Generate the baseline.** Create `prisma/migrations/000000000000_baseline/`. Run:
   ```bash
   npx prisma migrate diff \
     --from-empty \
     --to-schema-datamodel ./prisma/schema.prisma \
     --script > ./prisma/migrations/000000000000_baseline/migration.sql
   ```
4. **Manually append any non-declarative SQL** (generated columns, partial indexes, custom FK clauses, orphan-table DDL) to the bottom of the generated `migration.sql`. Prisma's squashing guide explicitly anticipates this: *"any manually changed or added SQL in your migration.sql files will not be retained… ensure to re-add them after your migrations were squashed."*
5. **Mark the baseline as applied on production** (prod already has the schema; this prevents `migrate deploy` from trying to recreate tables):
   ```bash
   npx prisma migrate resolve --applied 000000000000_baseline
   ```
6. **Verify a fresh-from-empty replay succeeds.** Spin up a clean Postgres, run `prisma migrate deploy`, run `prisma db pull` against it, diff against `schema.prisma` — expect zero drift.
7. **Flip `migration-dry-run.yml` from advisory to blocking** on the same PR or the immediately following one. Remove the grandfather clause.
8. **Add a `prisma db pull` drift-detection step** to scheduled CI (weekly is sufficient) so any future out-of-band change is surfaced within a week, per Atlas drift-detection guidance.

### Acceptance criteria

- `prisma migrate deploy` against a clean Postgres produces a schema with zero diff against `prisma/schema.prisma`.
- `migration-dry-run.yml` is blocking, not advisory, and is green on `main`.
- Production `_prisma_migrations` table reflects the new baseline as applied; existing app traffic is unaffected (zero downtime expected since no DDL runs against prod — only the metadata row is added).
- All 18 previously-out-of-band FKs, the 2 orphan tables, the `tsvector` column, and the partial unique index are present in either `schema.prisma` or the baseline `migration.sql`. None remain out-of-band.
- Old chain is preserved under `prisma/migrations/_archive/`.
- An ADR is committed at `docs/decisions/<date>-pre-launch-migration-rebaseline.md` documenting the decision, the rejected alternative (in-place 114-item repair via `chore/migration-chain-full-repair`), and the consequences.

### Dependencies and ordering

- **Blocks:** GA / first real user. Must be done before launch.
- **Blocked by:** nothing. Can be executed at any time. No prior work required.
- **Conflicts with:** `chore/migration-chain-full-repair@542dcffb91` (Op 49's in-place repair branch). When this item is executed, that branch is superseded and should be archived as a tag (`git tag archive/chain-repair-2026-06-24 542dcffb91`) and deleted, not merged.
- **Adjacent hygiene:** any Prisma major version bump from Dependabot may force this work earlier if the newer Prisma CLI tightens drift detection or refuses to deploy against an inconsistent chain. Treat such a Dependabot major bump as a soft trigger.

### Reference evidence (preserved for future operator)

- Grep of all 156 migrations + baseline returns zero CREATE TABLE statements for `Recipe`, `SavedRecipe`, `ListItem`, `UserPreferences` (verified 2026-06-26 on local clone of `main@be1cdb7`).
- `prisma/schema.prisma` declares all four models at lines 1390, 1411, 1438, 1459.
- `src/app.module.ts:40-41,223-224` wires `RecipesModule` and `ListsModule`; routes registered on `src/recipes/recipes.controller.ts` and `src/lists/lists.controller.ts`.
- Op 49's chain-repair runbook at `docs/runbooks/migration-chain-repair-2026-06-24.md` enumerates ~114 Part 2 drift items (52 safe additive, 24 declarative, 18 SQL-layer FKs, 2 orphan tables, 1 generated column, 1 partial index). Op 49 deliberately did not open a PR; the branch tip is `542dcffb91`.
- Deep research validates Option 1 (this approach) as the documented hyperscaler practice across Prisma, Flyway, Liquibase, Alembic, Atlas, Skeema, Supabase, GitHub, Shopify, Stripe, GitLab, and Martin Fowler / Evolutionary Database Design literature. Strong confidence.

### Out of scope for this item

- Any further work on the 114-item Part 2 drift in `chore/migration-chain-full-repair`. Superseded by this rebaseline.
- Migrating user data. By construction, there is no user data to migrate at execution time.
- Changing `scripts/release.sh`. The release pipeline continues to run `prisma migrate deploy` and the new baseline migration applies as a no-op on prod (via `migrate resolve --applied`).
