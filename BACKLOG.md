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

---

## BL-DATA-CAPTURE — Top-3 must-do of 2026: event-first data capture foundation (data capture NEED TO DO)

**Status:** OPEN — owner-declared top-3 must-do of 2026. **Multi-PR program (26-42 operators across 2026).** No automatic trigger; promoted into a wave when operator explicitly says so.

**Aliases for locator lookup (operator may search for any of these):** `data capture NEED TO DO`, `pull up the to-do work for data capture`, `data-capture to-do`, `BL-DATA-CAPTURE`, `event-first data capture`, `ZION data capture checklist`.

**Opened by:** Operator (Bradley Gleave) on 2026-06-26 during Op 50 (post PR #486/#488 burn-down, mid H6 dispatch).
**Priority:** P0-strategic. Not a launch-gate per se (launch can ship without it), but every operator that lands without event capture creates training-data debt that compounds.
**Owning doctrine:** R83 (event-first design), R125 (RLS tiers on every new table), §12 (idempotency + tenant isolation).

### Background

Operator authored a 254-line program-of-work checklist describing the event-first data foundation that unblocks behavioral personalization (A20), predictive churn (A16), AI training corpora (A14, A15), longevity / biomed evidence (A22+), and franchise benchmarking when Stage 4 lands. The checklist is the canonical source-of-truth for this BL item and is committed in-repo at `docs/data-capture/ZION_DATA_CAPTURE_CHECKLIST.md` so it survives independent of any external upload location.

**The rule that overrides everything else in the checklist:** if a datapoint can help answer one of these six questions, store it.

1. What happened?
2. Why did it happen?
3. What changed?
4. Who approved it?
5. Did it work?
6. What should happen next?

**Strategic frame (verbatim from operator):** "All this data is MASSIVE for future AI training in a memory-driven world. Storing every event, every coach decision, every client outcome creates a defensible training corpus." Storage cost is rounding error; cost of NOT storing is catastrophic.

### Operator ruling (D-H6-3 cross-reference, 2026-06-26)

When H6 D-H6-3 (`withAuditLog()` wrap on the 12 PII-touching services) was being locked, operator said: "I want every message saved on our DataBase for future AI training - attached document talking more what future data routing I plan to expand upon!" The attached document is this checklist. **Effect:** D-H6-3's withAuditLog wrapping is the first concrete delivery toward BL-DATA-CAPTURE; the audit_log H6 schema decided in D-H6-1 (13 columns with `reason text null`, REVOKE UPDATE/DELETE, 7-year retention with S3 Object Lock archive) is the substrate that subsequent BL-DATA-CAPTURE PRs extend.

### Scope summary (full detail in checklist)

The checklist organizes capture into 14 sections. Highlights:

- **§1 Core Identity** — user, account type, tenant, role, coach/client/team hierarchy, membership, consent flags, privacy tier, access scope.
- **§2 Coaching and Product** — programs, workouts, exercises, set/rep targets, program version history, AI recommendations + coach accept/edit/reject, check-ins, milestones, streaks, churn risk events.
- **§3 Wearable and Recovery** — HRV, RHR, sleep, recovery score, active energy, strain, step count, device source, sync time, missing-data flags, daily/weekly rollups.
- **§4 Support and Troubleshooting** — Crisp tickets, category, platform area, resolution, response time, attachments, repro steps, bug/doc/feature-gap mapping.
- **§5 Operational Memory** — feature flags per tenant/coach/user, audit logs for permission checks, package deliverables, billing events, onboarding/migration state.
- **§6 AI Training** — prompt, retrieved context, final answer, user rating, coach override, approved/rejected drafts, code-fix runs, outcome labels.
- **§7 Longevity / Biomed** — baseline biomarker panels, interventions (type/dose/timing/duration), telomere/inflammation/metabolic markers, longitudinal outcomes.
- **§8 Gym / Franchise (Stage 4)** — check-in patterns, class demand, membership lifecycle, staff performance, facility utilization; multi-location benchmarking is the category-defining moat vs Mindbody/Daxko/Glofox.
- **§9 Event-first design** — `client_created`, `program_assigned`, `workout_completed`, `checkin_submitted`, `support_ticket_opened`, `feature_flag_changed`, `package_delivered`, `payment_failed`, `biomarker_collected`, `protocol_applied`, `code_fix_proposed`, `test_passed`. Plus money-flow events (A13 dependency), gym events (Stage 4), and AI/behavioral events.
- **§10 Minimum tables** — 24 starter tables enumerated, including `users`, `coaches`, `clients`, `programs`, `program_versions`, `workout_logs`, `checkins`, `wearable_readings`, `support_tickets`, `feature_flags`, `audit_logs`, `packages`, `package_items`, `ai_actions`, `biomarker_events`, `code_fix_runs`, `team_hierarchy`, `money_flow_rules`, `money_flow_events`, `member_events`, `staff_events`, `location_events`, `behavioral_profiles`, `intervention_events`, `exercise_demos`, `demo_usage_events`.
- **§11 Strategic frame** — defensible training corpus enabling A20/A16/A14/A15/A22+ AND a sellable anonymized data asset to research institutions.
- **§12 Doctrine flags** — RLS tier 1 on `audit_logs`, `money_flow_events`, `biomarker_events`; idempotency keys on every event row; consent/privacy-tier enforcement via `users.privacy_tier` join; per-table retention policy; `tenant_id` on every event row, no cross-tenant query path at data layer.
- **§13 Sequencing** — 6 PRs proposed, 26-42 operators total across 2026.
- **§14 Open operator questions** — 4 questions still requiring operator ruling before PR1 (retention windows per table, PII scrubbing timing, real-time vs batch streaming, coach data-export rights on departure).

### Suggested PR sequencing (from §13, not yet operator-locked)

1. **PR1 — Event scaffolding:** `ai_actions`, `audit_logs` (expanded — overlaps with H6 D-H6-1 schema), `money_flow_events`. **5-8 operators.** *Operator-locked schema for `audit_logs` already decided in D-H6-1; PR1 must reuse that exact 13-column shape, not re-design it.*
2. **PR2 — Identity + team hierarchy expansion:** `team_hierarchy` self-referential N-level (HC/SC/JC/etc). **3-5 operators.**
3. **PR3 — Behavioral profile capture:** `behavioral_profiles`, `intervention_events`. **5-8 operators.**
4. **PR4 — Biomed scaffold:** `biomarker_events`, longevity protocol tracking. **5-8 operators.**
5. **PR5 — Crowdsourced demos:** `exercise_demos`, `demo_usage_events`. Lands with A19. **3-5 operators.**
6. **PR6 — Gym event scaffold:** `member_events`, `staff_events`, `location_events`. Lands with Stage 4. **5-8 operators.**

### Dependencies and ordering

- **Blocks (soft):** A14 (AI program gen refinement), A15 (AI response drafting in coach voice), A16 (predictive churn), A20 (behavioral personalization), A22+ (biomed/longevity), Stage 4 (gym/franchise). Each of these is degraded — not blocked outright — by the absence of historical event data.
- **Blocked by:** nothing strictly, but PR1 should land AFTER H6 (D-H6-1 through D-H6-5) merges so the `audit_log` table is built once with the locked schema rather than retrofitted.
- **Conflicts with:** none currently. The H6 wave intentionally lands the audit_log substrate; BL-DATA-CAPTURE PR1 extends it rather than competing with it.
- **Trigger:** explicit operator command only. The doctrine line operator gave is "pull up the to-do work for data capture" — at that point this BL item is the entry point and the checklist at `docs/data-capture/ZION_DATA_CAPTURE_CHECKLIST.md` is the spec.

### Acceptance criteria (per-PR; the BL item itself completes only when all 6 PRs ship)

- Every new table has RLS policy applied at creation (R125).
- Every event-insertion endpoint is idempotent on a `(tenant_id, idempotency_key)` unique index (§12).
- Every event row carries `tenant_id` and a no-cross-tenant-read RLS policy (§12).
- Retention policy is documented in-table-comment AND in `docs/data-capture/retention-matrix.md` (to be authored in PR1).
- Per-PR test coverage meets R3/R8 norms (no test-LOC exemption requested without a TEST-EXEMPT rider).
- ADR committed per PR at `docs/decisions/<date>-data-capture-pr<N>-<topic>.md`.

### Reference evidence (preserved for future operator)

- Source document: `docs/data-capture/ZION_DATA_CAPTURE_CHECKLIST.md` (254 lines, owner-authored 2026-06-26).
- Cross-reference: OPERATOR_DECISIONS_LOG.md entry `2026-06-26 · LOCK · D-H6-3` ties withAuditLog() wrapping to this BL.
- Cross-reference: OPERATOR_DECISIONS_LOG.md entry `2026-06-26 · LOCK · D-H6-1` defines the canonical `audit_log` schema that PR1 must reuse.
- Hyperscaler precedent for event-first design: Stripe's payment-mutation RFC (https://hackmd.io/xHyDSe73TjOj4x3V3BIyHg), AWS CloudTrail event-record schema, Segment's event-spec doctrine.

### Open operator questions (from §14 — must be resolved before PR1)

1. **Per-table retention windows** — defaults proposed in checklist (raw wearable 5y, rollups indefinite, support tickets 7y, AI prompt/response indefinite); owner final ruling required.
2. **PII scrubbing for training corpus** — at insert time (loses fidelity) or at training-prep time (more storage, more flexibility). Checklist recommends training-prep time; operator to confirm.
3. **Real-time event streaming vs nightly batch** — checklist recommends real-time for money + support + intervention, batch for analytics rollups. Operator to confirm.
4. **Coach data-export rights on departure** — likely yes within consent boundaries, but format and limits must be spec'd.

### Out of scope for this item

- Implementing any individual PR. This BL is the index entry; each PR opens its own scoped operator.
- Migrating historical data. By construction, TGP is pre-launch with zero live users at file time — there is no historical event data to backfill, and the foundation lands clean.
- Any data-export API for end-clients. Tracked separately if/when needed.

## BL-CI-REVERSIBILITY-PSQL — Strip `?schema=` from `DATABASE_URL` before psql calls in `ci.yml` (parity with migration-dry-run.yml)

**Filed:** 2026-06-26 by operator (Bradley Gleave), Op 50.5 dispatch (Option A).
**Severity:** P2 — latent landmine. Currently accidentally-safe because `ci.yml`'s `DATABASE_URL` has no `?schema=` query param, but ANY future PR that adds `?schema=` to that URL (e.g., to satisfy a Prisma test that wants explicit schema scoping) will silently break every `psql "$DATABASE_URL"` call in the workflow — `psql` does NOT accept `?schema=` as a libpq URI parameter and fails with an opaque connection error.

### Gap (verified 2026-06-26)

- **`.github/workflows/migration-dry-run.yml`** ALREADY strips `?schema=` before every `psql` call:
  ```yaml
  # Lines 168-173 and 301-306 (both occurrences)
  # Strip the ?schema= query param because psql does not accept it as a libpq URI
  PSQL_URL="${DATABASE_URL%%\?*}"
  psql "$PSQL_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/_supabase_bootstrap.sql
  ```
- **`.github/workflows/ci.yml`** does NOT strip — psql calls at lines 264, 267, 272, 279 (and 367) call `psql "$DATABASE_URL"` directly. Currently safe because `ci.yml`'s `DATABASE_URL` (lines 233, 337) is `postgresql://postgres:postgres@localhost:5432/postgres` with no query string. The day any future PR appends `?schema=public` (or any other libpq-incompatible param), all five psql invocations break.

### The fix (Option A — codified for builder)

Apply the same strip pattern to every `psql "$DATABASE_URL"` call in `ci.yml`. Single-PR scope:

```yaml
# Before:
- name: bootstrap supabase shim
  run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ci/supabase-shim.sql

# After:
- name: bootstrap supabase shim
  run: |
    # Strip ?schema= because psql does not accept it as a libpq URI
    PSQL_URL="${DATABASE_URL%%\?*}"
    psql "$PSQL_URL" -v ON_ERROR_STOP=1 -f scripts/ci/supabase-shim.sql
```

Apply to each of:
- Line 264 (`scripts/ci/supabase-shim.sql`)
- Line 267 (`scripts/ci/rls01-live-bootstrap.sql`)
- Line 272 (`prisma/migrations/20260704000000_rls01_helper_searchpath_hibp/migration.sql`)
- Line 279 (inline `-c` GRANT statement)
- Line 367 (MWB3 RLS bootstrap, identical pattern)

### Why this is filed as a backlog item, not a hot fix

- No PR is currently being blocked by this gap (every existing CI run uses the no-`?schema=` `DATABASE_URL`).
- The H6 wave (H6A/B/C) does NOT introduce a `?schema=` query param to `ci.yml`'s `DATABASE_URL`, so the H6 sequence is not at risk.
- The fix is mechanical (5 identical 2-line wrappers) and can be batched with any other CI workflow touch.
- Option A (codify the gap + planned fix as a backlog item) was operator-chosen on 2026-06-26 over Option B (hot-fix on its own PR right now) for sequencing reasons: keep PR #491 focused on the data-capture checklist + this backlog amendment, dispatch the actual `ci.yml` patch as a separate small PR when convenient.

### Acceptance criteria

- All 5 `psql "$DATABASE_URL"` call sites in `.github/workflows/ci.yml` strip `?schema=` (and any future query params) via the `${DATABASE_URL%%\?*}` pattern.
- The CI test matrix passes unchanged on the existing no-query-string `DATABASE_URL`.
- A regression test (`scripts/ci/verify-psql-url-strip.sh` or equivalent — optional, low-priority) asserts the strip pattern is present in any new psql call sites added in future PRs.
- The fix lands as a single small PR titled `ci(reversibility): strip ?schema= before psql in ci.yml (BL-CI-REVERSIBILITY-PSQL)` with the per-line diff in the PR body.

### Cross-references

- Source: `.github/workflows/migration-dry-run.yml` lines 168-173, 301-306 (the canonical strip pattern, already shipped via #488).
- Affected: `.github/workflows/ci.yml` lines 264, 267, 272, 279, 367.
- Doctrine: R82 (migration reversibility) — every `psql` invocation in CI must be portable across Prisma's `?schema=` URL convention and psql's libpq URI requirements; failure to strip is a latent reversibility breakage.
- Operator decision: 2026-06-26, Op 50.5 dispatch, Option A chosen verbatim ("amend BL-CI-REVERSIBILITY-PSQL onto PR #491 (Option A) — workflow YAML patch stripping ?schema= before psql, second commit on existing branch").

### Out of scope for this item

- Refactoring `ci.yml` to consolidate the 5 psql calls into a single helper script — separate cleanup, lower priority.
- Changing the `DATABASE_URL` shape used by Prisma elsewhere in the workflow.
- Migrating away from psql to a Prisma-native bootstrap path — orthogonal architectural decision, not in this BL's scope.
