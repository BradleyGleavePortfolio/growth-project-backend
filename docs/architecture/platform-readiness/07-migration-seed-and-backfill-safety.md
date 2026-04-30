# 07 — Migration, seed, & backfill safety

> **Last reviewed:** 2026-04-30. Docs-only. No runtime change.

## WHY

Prisma migrations are forward-only and applied at boot via
`prisma migrate deploy` (`Dockerfile` `release_command`). This
is the right shape for the platform — no manual production
migrations, no `prisma db push` once a database holds real data.
Recent fixes have hardened it (PR #104 strips the prisma CLI
update banner from the baseline migration; PR #2d22adbc
corrected the Dockerfile + CI dist path; the
`RELEASE_ALLOW_DB_PUSH` escape hatch is documented as
greenfield-bootstrap-only).

The next wave of features is the largest schema-shape change
since the platform's bootstrap:

- AI Program Builder (PR #117) introduces six new tables and a
  pgvector dependency.
- Team Mode (PR #118) introduces three new tables plus
  `acted_by_member_user_id` on existing rows + a five-phase
  migration plan in ADR §7.
- Check-ins v2 introduces a non-additive shape change to
  `CheckIn`.
- Templates marketplace introduces a `Template` table and a
  `TemplatePurchase` row that joins to `CoachSubscription`.

Without an explicit migration-shape rule, large changes risk:

- Long-running locks on the existing `User` / `CheckIn` rows
  (Postgres holds an `ACCESS EXCLUSIVE` lock on `ALTER TABLE`
  for the duration; on a hot table this is a customer outage).
- Backfill that runs partially, fails halfway, and is not
  re-runnable.
- Migrations that depend on a code path that the deployed image
  does not yet have (a forward-only schema change without the
  matching forward-only code change is a deploy gone wrong).

**Cross-feature impact:** every active feature in flight is a
schema change.

## WHEN

Settle this brief **before** any large schema change ships.
Concretely: before the first AI Program Builder runtime PR
(which adds the first new table) and before Team Mode wires its
first migration.

## WHERE

- `prisma/schema.prisma` — schema source of truth.
- `prisma/migrations/` — forward-only migrations.
- `prisma/README.md` — migration policy + index.
- `Dockerfile` — `release_command: prisma migrate deploy`.
- `scripts/release.sh` — the release path; `RELEASE_ALLOW_DB_PUSH`
  escape hatch.
- `docs/deploy-runbook.md` — already documents migration policy;
  extend with the three-phase shape change rule.

## WHO

- **Owner:** backend lead.
- **Reviewers:** OWNER (the operator who runs the deploy and
  monitors locks).
- **On the hook in production:** OWNER. Migration that locks a
  hot table is a P1 (lane #06).

## WHAT

### What already exists

- Prisma migrations are forward-only.
- Migrations are applied at boot via `prisma migrate deploy`.
- The `RELEASE_ALLOW_DB_PUSH` escape hatch is documented as
  greenfield-only.
- A baseline migration that pre-dates the migration table (PR
  #104 hardened the parser).
- One backfill precedent: `npm run
  backfill:coach-subscriptions` (PR #96).
- Seed-recipes script in `prisma/seed-recipes.ts`.

### What is missing

1. The **three-phase shape change rule** for non-additive
   migrations (parallel to lane #02's API rule). Today the
   policy is "forward-only", which forbids a backwards
   migration but does not prescribe how a non-additive change
   *enters* the schema. Proposed:
   - **Phase A:** add the new column / table next to the old.
     Both work. New code reads/writes both.
   - **Phase B:** backfill. Idempotent script. Re-runnable.
   - **Phase C:** remove the old column / table once the
     backfill is verified at 100% and the old code path has
     been deleted.
   The minimum gap between Phase A and Phase C is **one full
   release cycle**, not just one deploy.
2. A documented **lock-time budget**. Proposed: any `ALTER
   TABLE` on a row count >100k must be split into multiple
   migrations (add column nullable → backfill → enforce
   not-null in a separate migration). The Phase-A migration
   should never block writes for >5s.
3. A **backfill idempotency rule**. Every backfill script must
   be re-runnable without producing a different result. The
   script must log its progress to `AuditLog` (or, for very
   large backfills, a dedicated `Backfill` table; out of scope
   for this brief).
4. A **dry-run gate**. Every migration ships with a one-line
   "I have run this against a copy of production" assertion in
   the PR description. The operator copy-restores production
   to a Fly-staging Postgres for the largest migrations.
5. A **seed policy**. `prisma/seed-recipes.ts` is fine for the
   recipe data, but it's currently the only seed. Team Mode
   wants a "create one team with three staff" seed for local
   dev. Proposed: seeds live in `prisma/seed/*.ts`, each with a
   single named export, invoked by `npm run seed -- <name>`.
   Prod runs no seeds.
6. The **pgvector** dependency for AI Program Builder is a
   migration concern: pgvector is a Postgres extension. The
   first Builder migration runs `CREATE EXTENSION IF NOT
   EXISTS vector;`, which requires a superuser-equivalent
   privilege on Supabase. Document the operator step.

### Three-phase example: `CheckIn` schema change

Suppose check-ins v2 splits a single text body into structured
fields.

- **Phase A migration:** add columns
  `body_structured_v2 jsonb null`. Code writes both old and
  new. Reads still serve old.
- **Backfill:** populate `body_structured_v2` from the old text
  body. Idempotent — re-running produces the same result.
  Logged to `AuditLog`.
- **Phase A → B switch:** code reads the new field with a
  fallback to the old. Mobile begins reading the new field;
  see lane #02 for the API contract.
- **Phase C migration:** make the new column not-null
  (defaulting on rows that backfill missed) and drop the old
  text body column.

Minimum elapsed: one full mobile release cycle.

## HOW

### Operator handoff

- The runtime PR adds the migration. The PR description includes
  the lock-time estimate, the dry-run statement, and the
  intended Phase (A or C).
- OWNER reviews lock time before approving.
- OWNER monitors `pg_stat_activity` during the deploy.
- pgvector setup: documented one-time step in
  `docs/deploy-runbook.md` (added when the first Builder
  migration ships).

### Backfill pattern

Every backfill script:

1. Runs in batches (e.g., 1000 rows per batch). Idempotent.
2. Logs progress: starting row id, ending row id, rows
   touched, rows skipped (already migrated).
3. Reads checkpoint from `AuditLog` (or a dedicated table) so
   that re-running picks up where it left off.
4. Has a `--dry-run` flag that logs what it would do without
   writing.
5. Has a unit test against a fixture covering the resume case.

### Seed policy

- `prisma/seed/recipes.ts` — the existing recipe seed.
- `prisma/seed/team-mode-dev.ts` — future, gated by
  `NODE_ENV=development`.
- `prisma/seed/builder-fixtures.ts` — future, dev-only
  fixtures for the AI Program Builder eval set.
- Prod: zero seeds run.

## Risks

- **Long lock on a hot table.** Mitigation: lock-time budget
  and dry-run gate.
- **Backfill runs partially.** Mitigation: idempotent +
  resumable + logged.
- **pgvector unavailable on Supabase plan.** Mitigation: the
  operator confirms pgvector availability before the Builder
  runtime PR is opened. (Supabase supports pgvector on all
  plans; verifying explicitly is still the right move.)
- **Non-additive migration shipped without the matching code.**
  Mitigation: every non-additive migration is Phase A. Code
  ships first; Phase C migration follows after the cycle.
- **Seed runs in prod.** Mitigation: `prisma/seed/*.ts`
  scripts hard-fail when `NODE_ENV === 'production'`.

## Dependencies

- Lane #02 (API versioning) — non-additive schema and
  non-additive API often ship together.
- Lane #04 (data lifecycle) — every new table needs a row in
  the retention matrix.
- Lane #06 (observability) — migrations write to `AuditLog`,
  which the OWNER metrics surface.

## Acceptance criteria

1. ✅ `prisma/README.md` and `docs/deploy-runbook.md` are
   extended with the three-phase shape rule.
2. ✅ A lock-time budget is documented.
3. ✅ A backfill-idempotency template is documented (proposed:
   `scripts/backfill-template.ts` is a referenced shape, not a
   compiled file).
4. ✅ Seed policy is documented; future seeds live under
   `prisma/seed/*.ts`.
5. ✅ pgvector setup is documented as a one-time operator step
   when the first Builder migration ships.

## Test strategy

- **Unit:** every backfill script has a fixture-based test
  that covers initial run, partial run, resume, and re-run.
- **Integration:** the existing `prisma migrate deploy` runs
  on every CI build (against a CI Postgres).
- **Manual:** for any migration over the lock-time budget, the
  OWNER copy-restores production to a Fly-staging Postgres
  and dry-runs.

## Rollout & kill-switch

- Each migration ships in its own PR. The matching code
  changes ship in the same PR (Phase A) or a previous PR
  (Phase C).
- Kill switch for migrations: there isn't one — migrations are
  forward-only. The kill switch for the *feature* using the
  migration is the lane #01 flag (`BUILDER_ENABLED=false`,
  `TEAM_MODE_ENABLED=false`). The Phase-A column/table is
  harmless if the feature is disabled.
- Kill switch for backfills: `BACKFILL_ENABLED=false`
  (proposed env var). Defaults to on in dev/staging, off in
  prod until OWNER explicitly enables.
