# G2-C: narrow-key contraction and the collision-refusing reverse

Status: Tier4 local candidate, not deployment, production enablement or customer acceptance.

## Scope and preserved source

C is the last step of the [canonical staged rollout](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/160928b98c57a6034cd8b7bcfba537e81c63f054/handoffs/op81/CONTINUATION_AND_ROMAN_IMPORT_PLAN.md)
**E → T/Q0 → B/drain → R → N/Q1 → C**. It ships one migration,
`20270121000000_scout_identity_contract`, that drops exactly the two narrow unique
indexes (`ScoutIngestEntity_coach_id_intent_id_source_id_key` and the 63-character
truncation of `ScoutReconstructionLedger_coach_id_intent_id_entity_type_source_id_key`)
and its `down.sql`. Nothing else moves: R's wide identity keys, both canonical CHECKs,
the ledger's NOT NULL provenance, B's fence, RLS (ENABLE+FORCE), policies, grants and
every row are untouched, and no data is derived, deleted or rewritten. The schema
declarations of the two narrow `@@unique`s leave `prisma/schema.prisma` in the same
change; the wide `@@unique(..., map: "..._identity_key")` declarations stay.

No runtime code changes. The real `ScoutIngestService` already writes
`createMany({ skipDuplicates: true })` (an `ON CONFLICT DO NOTHING` naming no conflict
target), and the accepted N writer already upserts on the wide identity: once the
narrow indexes are gone, one `source_id` across families and across platforms is
admitted as distinct identities, full-tuple replays stay deduped, and the Q1 readers
already page real ties `(source_id, source_platform)`. C is the contract those
writers and readers were built for; it activates nothing new in code.

Entry gates are once-only and exact: `migration.sql` refuses (`G2-C unexpected
identity prerequisite`) unless both narrow keys have their exact accepted definitions
on the expected forced-RLS public tables, and refuses (`G2-C wide identity absent`)
unless R's wide keys, CHECKs, `NOT NULL` provenance (TEXT, no default) and a NULL-free
ledger are present. Locks are bounded to 5 seconds and statements to 30 seconds
under `SET LOCAL`; a timeout is a failure to retry later, never permission to raise
budgets without rehearsal. Every object reference is schema-qualified so a session
`search_path` cannot redirect either direction.

## D-C1: no seal on the ingest window (carried to S9)

An ingest that lands between the writer's staged count and its page read is left
staged and unaccounted in that run's tally; the next idempotent replay converges and
the tally equals the ledger. C does not add a fence, seal or drain state for that
window: it is bounded, observable (present in staging, absent from the ledger, no
target) and self-healing under the existing replay. The row is never marked
reconstructed by anything other than a real reconstruction. Sealing an intent's
staging is S9 reconciliation scope and is carried forward, not silently dropped.

## Rollback and the C.down refusal

`down.sql` recreates both narrow keys byte-exact (schema-qualified, the same DDL as
the accepted 20261222000000 / 20261223000200 migrations) and asserts the recreated
shape in the same transaction. It is the ONLY reverse that can lose information, so it
is forward-repair-only on any collision: before either `CREATE UNIQUE INDEX` it groups
staging by `(coach_id, intent_id, source_id)` and the ledger by
`(coach_id, intent_id, entity_type, source_id)`, and if any group has more than one
row it raises a fixed text with `ERRCODE = 'unique_violation'` (23505). The text names
no table, column, coach, intent, source or count, and no `DETAIL: Key (...)` is
produced because no index is created; the tables are checked before either CREATE,
so no half-narrow state exists. The two staging refusals and the ledger-only refusal
leave every row and target in place. An operator who needs the narrow shape back
with collisions present must resolve those identities forward (delete or merge the
duplicates under the wide key, through the product, with the customer's intent), not
edit the down.

Entry to `down.sql` is guarded the same way as the forward: `G2-C contract absent`
when either narrow name already resolves in `public` (an index or a decoy relation of
any kind), or when R's shape is not exactly present. It does not touch history: after
a production C.down, S1 records
`prisma migrate resolve --rolled-back 20270121000000_scout_identity_contract` as its
own step, and until then `prisma migrate deploy` reports nothing pending while the
narrow keys are back (recorded here, not judged).

Runbook order for a full reverse is C → R → B → E, each refusing out of order:

- R.down, B.down and E.down on a database with C applied refuse with
  `G2-R unexpected identity prerequisite`, `G2-B unexpected identity prerequisite`
  and `G2-E unexpected identity prerequisite` respectively (their entry gates
  require the narrow keys).
- After C.down the accepted order applies; E.down still refuses
  `G2-E refuses removal of assigned provenance` until the ledger holds no assigned
  provenance, and the forward chain E.up → B.up → R.up → C.up restores the C shape
  with staging byte-equivalent and the ledger re-derivable by the writers.
- A held reader or an uncommitted ingest makes either C direction hit
  `canceling statement due to lock timeout` (55P03) after its own 5-second budget
  with nothing applied; the operator retries later rather than widening the budget.

## D-C2: stepwise promotion and production preconditions

C is promoted one environment at a time behind the same preconditions its migration
enforces, plus the operational ones SQL cannot prove:

1. N/Q1 accepted and deployed everywhere the database is reachable; no T/Q0 or older
   writer remains (B's fence blocks obsolete NULL-provenance writers; C adds no fence).
2. R's wide keys valid, both CHECKs validated, ledger `NOT NULL`, zero NULL rows.
3. `readDrainState`'s `mismatch` is an over-count once C is applied: it joins the
   narrow `(coach_id, intent_id, entity_type, source_id)` and counts every legitimate
   cross-platform identity as a disagreement. It is retired with the backfill CLI (the
   R drain is complete by precondition 2) rather than rewritten against the wide key.
4. Rehearsed on the isolated PG17 lane (`test/rls-g2-c-contract.spec.ts`, fresh
   N/Q1-shaped bootstrap, candidate `prisma migrate deploy`), then staging, then
   production, each with the lock budget observed and the two-index catalog delta
   confirmed before the next.

Production enablement, canary and any customer-facing switch remain owner-reserved
decisions; nothing in this record authorizes them.

## Proof boundary

The lane proof establishes only what is new in C on synthetic data: deploy exactness
(only the two narrow indexes leave), activation of cross-family and cross-platform
identities through the real ingest service and the N writer, retained idempotency,
candidate/old races converging to one row and one target, the lock budgets, real Q1
ties on both heads, security posture before and after C.down, the late-ingest window,
the three collision refusals, decoy and shadow-`search_path` refusals, the older
downs' refusals with C applied, and the collision-free reverse and forward chain.
CI's migration dry-run runs PostgreSQL 15 on an empty database: it exercises entry
gates and syntax, not the collision refusal (which needs rows) nor PG17 parity. Local
proof is not deployment, drain of any real database, or customer acceptance.

## Sources

- Rollout order: https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/160928b98c57a6034cd8b7bcfba537e81c63f054/handoffs/op81/CONTINUATION_AND_ROMAN_IMPORT_PLAN.md
- E record: docs/decisions/2026-09-18-g2-ledger-platform-expand.md
- T/Q0 record: docs/decisions/2026-09-18-g2-transition-writer-cursors.md
- Migrations: prisma/migrations/20270118000000_scout_ledger_platform_expand,
  20270119000000_scout_ledger_obsolete_writer_fence, 20270120000000_scout_identity_ready,
  20270121000000_scout_identity_contract
