# ADR — IMPORTER-H: One Parameterized Reconstruction Engine over Multiple Entity Families

- **Status:** Accepted
- **Date:** 2026-07-19
- **Decision owner:** Bradley Gleave (repo owner)
- **Lane:** IMPORTER-H — extend the clients-only reconstruct path to `workouts`
  and `client_history` under D2, keeping the engine site-agnostic.
- **Canonical context:** D2 DECIDED (Op 59) + Op-63 operator decision
  **"Defer messaging"**, context main `06abec4472aef8c326bb31f2427397791cb69b82`.
- **Affected files:** `prisma/schema.prisma`,
  `prisma/migrations/20261223000300_scout_reconstructed_entity/{migration,down}.sql`,
  `src/scout/scout-reconstruct.dto.ts`, `src/scout/scout-reconstruct.service.ts`,
  `src/scout/scout-reconstruct.controller.ts`,
  `src/scout/mappers/truecoach-entity.mapper.ts`,
  `src/scout/reconstruct/families.ts`, `docs/contracts/importer-openapi.json`
  (regenerated), plus new mapper/engine/migration specs and the golden fixtures
  `test/fixtures/truecoach/{workouts,client-history}.golden.json`.

## Context

IMPORTER-F reconstructs a settled crawl intent's staged `clients` into
invite-pending, non-login, tenant-owned roster `Person` records. The engine was
hard-coded to the single `clients` family: the entity_type was a constant, the
mapper was the client mapper, and the persist step wrote `Person`. The next
proving families under D2 are `workouts` and `client_history`. Messaging is
deferred (Op-63) and billing is a permanently excluded family.

The temptation is to clone the reconstruct service per family. That would
triple the settled/bounded gates, the paging loop, the per-row transaction, the
P2002 retry, the poison-row isolation, and the ledger accounting — the exact
duplication R138 exists to prevent.

## Problem

Reconstruct `workouts` and `client_history` into canonical records under D2,
with the SAME family-independent guarantees the clients path already proves
(post-settle gate, bounded fan-out, idempotent replay, poison-row isolation,
honest accounting, no credential minted, email never a key), **without** cloning
the pipeline and **without** letting an unsupported family (e.g. billing) ever
be reconstructed.

## Root cause

The engine conflated two concerns: the generic reconstruction MECHANISM (gates,
paging, transaction, retry, ledger) and the family-SPECIFIC steps (how to map a
staged row and where to persist it). Only the second varies per family. The fix
is to separate them: the engine keeps the mechanism; each family contributes a
pure `map` and a `persist`.

## Options considered

- **(a) Clone the reconstruct service per family.** REJECTED — triples every
  invariant and its tests; guaranteed drift the moment one clone is patched and
  another is not. Directly violates R138 (delete duplication).
- **(b) A canonical table per non-person family (`Workout`, `ClientHistory`).**
  REJECTED — each new family would need a new table + migration + two mandatory
  RLS security tests, i.e. duplication pushed into the schema instead of the
  service. Adding a family should be a code change, not a migration.
- **(c) [CHOSEN] One parameterized engine + a family registry, and ONE generic
  canonical `ScoutReconstructedEntity` table for every non-person family.**
  `clients` still targets `Person` (unchanged); `workouts`/`client_history`
  target the generic table, keyed on the tenant-scoped external_ref
  `(coach_id, source_platform, entity_type, source_id)`. Adding a non-person
  family is a registry entry + a mapper, with no new table and no new migration.

## Musk five-step result

- **Questioned:** Does each family need its own pipeline? No — only `map` and
  `persist` differ. Does each non-person family need its own table? No — a
  generic tenant-owned entity table with `entity_type` in the key serves all of
  them. Does reconstruction need billing? No — billing is excluded, so it must
  be _unrepresentable_, not merely unused.
- **Deleted:** The hard-coded `clients` constant in the engine, the would-be
  per-family service clones, and the would-be per-family tables — all removed in
  favor of one mechanism + one generic table. Billing is deleted from the
  allow-list, so it fails closed at validation AND at the engine boundary.
- **Simplified:** A `FamilyReconstructor` is exactly `{ entityType, map,
persist }`. The engine is unchanged in shape — it now looks up the family in a
  registry and calls `family.map` / `family.persist`, owning everything generic
  around them. `map`/`persist` are declared as interface **methods** (bivariant)
  so a `FamilyReconstructor<MappedClient>` and `<MappedEntity>` both assign to
  the erased registry type with **zero** `as`-casts at the boundary (R75).
- **Accelerated:** Idempotency stays structural — the generic table's
  `@@unique([coach_id, source_platform, entity_type, source_id])` and the
  existing ledger `@@unique` are both upserted, so replay mints nothing and
  returns identical counts.
- **Automated last:** the frozen OpenAPI slice is regenerated and pinned
  byte-for-byte by the drift test; golden fixtures per family drive the mappers
  against bytes Chrome actually emitted.

## R138 four-question engineering decision

1. **Is the requirement real and its owner named?** Yes — extend reconstruction
   to `workouts`/`client_history` under D2, owner Bradley Gleave, canonical Op-63
   ("Defer messaging"). Messaging and billing are explicitly out.
2. **Can the requirement be deleted?** The per-family _pipelines_ and per-family
   _tables_ are deleted (options a, b). The families themselves are required. The
   billing family is deleted from representability entirely.
3. **Can it be simplified / merged into one mechanism?** Yes — one engine keyed
   on `entity_type` via a registry + one generic canonical table. Adding a family
   is a `map`+`persist` pair.
4. **Can the proof be automated?** Yes — deterministic golden fixtures per
   family, a parametrized engine spec proving identical guarantees for both new
   families, a structural migration guard, and the byte-identical contract drift
   test.

## Idiot-index result

Theoretical minimum is "one reconstruction mechanism + one honest ledger + one
canonical target, written idempotently." Option (c) is at that floor: the
engine is reused verbatim, one generic table serves every non-person family, and
per-family code is only the pure mapper + the two-line persist. No cloned
service, no per-family table, no per-family migration.

## Extreme test

- **Poison row:** unchanged per-row transaction + try/catch; one malformed
  `workouts`/`client_history` row is recorded `failed` with a non-PII reason and
  its siblings still reconstruct.
- **Replay (Nx):** re-running upserts the same `ScoutReconstructedEntity` rows
  and the same ledger rows; `staged === reconstructed + skipped + failed` holds
  identically every pass across both new families.
- **Unsupported family:** `billing` (or any unlisted family) is rejected `400`
  at DTO validation (`@IsIn`) AND fails closed at the engine boundary BEFORE any
  settled check, read, mint, ledger write, or event — proven by spec.
- **Running intent:** the shared `assertSettled` gate is family-independent; a
  live intent is `409` regardless of family.
- **Cross-tenant / cross-family probe:** `coach_id` is token-derived; every
  query, upsert, and tally is scoped by `(coach_id, entity_type)`; RLS is FORCED
  on the generic table (service_role PERMISSIVE, anon/authenticated RESTRICTIVE
  deny-all). One family's tally never leaks another's.
- **Billing/email exclusion:** the generic mapper never reads email or any
  billing/price field; the golden fixtures embed a client email and billing
  noise (`price`, `invoice_id`, `amount_due`, `balance`) precisely so an
  accidental read fails the mapper specs. The schema has no email or billing
  column (structural guard).

## Hyperscaler lens

- **Reliability:** the blast radius of a new family is a `map`+`persist` pair;
  the hardened engine (transactions, retry, ledger) is reused, not re-derived.
- **Security:** no credential minted; email never read or keyed; identity is the
  opaque source id; tenant isolation is enforced in the DB (FORCE RLS) and by the
  token-derived `coach_id`; billing is unrepresentable.
- **Reversibility:** additive migration + `down.sql`; the endpoint stays flag-off
  by default (`FEATURE_SCOUT_RECONSTRUCT`); `entity_type` defaults to `clients`,
  so every existing caller is byte-compatible.
- **Observability:** the existing one-event-per-pass telemetry now carries the
  family `entity_type`; still counts + correlation ids only, no PII.

## Good without bad

Benefit preserved: a settled crawl's `workouts` and `client_history` become
canonical, idempotent, honestly-counted records via the same proven engine.
Failure modes excluded: no cloned pipeline, no per-family table sprawl, no
billing reconstruction, no email key, no cross-family/cross-tenant leakage, no
banned casts at the registry boundary, no broken existing clients contract.

## LOC-EXEMPT justification (R100.A3)

This vertical adds a canonical RLS-bearing table, which forces a migration
(~70 lines) plus its two MANDATORY RLS security tests and a structural guard.
With migrations counted toward the LOC cap and the required test density
(≥ 2.0), the smallest _correct_ slice that honors the repeated "reconstructed
into canonical entities" requirement structurally exceeds the 400 net-LOC cap.
Measured locally: **net ≈ 1196 LOC**, **test:src ≈ 2.12** (density satisfied
without dropping tests). A ledger-only slice would fit under 400 but would fail
the canonical-entities requirement, so the PR ships with an operator-signed
`[LOC-EXEMPT: <reason>]` marker (the gate's designed escape valve, precedent
#427 / IMPORTER-F), NOT a test cut.

## Dependency split (if scope were reduced)

If a single PR were rejected, the smallest coherent slices, in order, are:
(1) generic canonical table + migration + RLS + structural guard; (2) generic
mapper + golden fixtures + mapper spec; (3) family registry + engine
parametrization + engine spec + DTO/controller wiring + contract regen. Slices
2–3 depend on 1. They are shipped together here because the vertical is only
meaningful end-to-end and splitting it would triple review of the shared engine.

## Rollback / stop

Unset/`!== 'true'` `FEATURE_SCOUT_RECONSTRUCT` (the default) to dark the route,
or revert the PR and apply `down.sql` (drops only the new generic table).
**Stop condition:** if density falls below 2.0, add tests rather than a
`[TEST-EXEMPT]`.

## Deliberate non-goals

- **No messaging family.** Deferred by Op-63.
- **No billing family.** Permanently excluded — never captured, staged, logged,
  or reconstructed; unrepresentable in the allow-list and the schema.
- **No change to ingest/staging, pairing, auth, tenant derivation, or the
  roster-read response shape.** IMPORTER-H extends; it does not break contracts.
- **No claim/link flow and no real-account validation** (V5).
- **No UX diff / mobile work** — honest counts + reasons only.
