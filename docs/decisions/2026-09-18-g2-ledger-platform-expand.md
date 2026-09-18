# G2-E: nullable reconstruction-ledger provenance

Status: Tier4 local candidate, not deployment, identity activation or contract freeze.

## Scope and preserved source

E adds only nullable `ScoutReconstructionLedger.source_platform`, without a default.
Existing uniqueness, RLS, staging, runtime writers/readers and API contracts remain
unchanged. Existing old writers omit platform and continue creating NULL provenance;
newly generated E clients can materialize that historical NULL. This is a schema
landing zone for a later compatibility writer, not the wider identity repair.

Reuse is from the actual preserved [integrity donor6b263c2](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/6b263c2f342a561ca8a64e5efa077e6c90601a4a):
public-object guards, bounded transactional SQL and real-PG/target-validation test
mechanisms. Its ancestor-relative27-file delta on c23 reconstructs preserved recovery
tree `a8908132a9c4882dbe80f9fbc1052532c7e68c3b`. The final-state atomic migration and
five-part runtime writer are deliberately not copied into E. Its complete21-case
proof remains a donor for subsequent stages, not a claimed E test result.

This follows the [canonical staged rollout](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/160928b98c57a6034cd8b7bcfba537e81c63f054/handoffs/op81/CONTINUATION_AND_ROMAN_IMPORT_PLAN.md):
**E → T/Q0 → B/drain → R → N/Q1 → C**. #522's family-only widening is not a substitute.

## Compatibility and rollback

Both narrow indexes must still have their exact valid unique definitions on the
expected public tables, with ENABLE+FORCE RLS retained. Once-only migration entry
checks refuse a pre-existing column rather than blessing an unknown state. Locks
are bounded to5seconds, statements to30seconds; timeout is failure, not permission
to increase budgets without rehearsal. No policy is recreated or privilege granted.

Prefer leaving the harmless nullable column in place on application rollback.
Destructive down is allowed only after an operator has drained all platform-aware
writers and verified the exact E state. SQL cannot prove that operational drain.
Down refuses **any non-NULL provenance**, even if it appears recoverable elsewhere,
and errors when row visibility cannot establish safety. It never disables forced RLS,
grants bypass, derives replacement provenance or deletes records to make rollback pass.
Empty and all-NULL populated rollback are exercised separately from refusal cases.

Old writers' existing narrow conflict targets remain; an update does not erase assigned
provenance. Cross-family/platform source-ID collisions still deduplicate under those
narrow keys. Existing source-ID-only pagination is therefore unchanged, **not fixed**.
The later T/Q0 and N/Q1 writer/reader bridges, bounded backfill/drain and C activation
must establish the full semantics before wider identities are permitted.

## Proof and release limits

The E proof selects a dedicated disposable database, validates endpoint/confirmation
and server identity before mutations, applies actual SQL and uses isolated generated
925/E Prisma clients in separate OS processes with actual unchanged services. It checks
success/skip/database-failure paths, old selectors and SQL, nullable reads, unchanged
assignment on replay, pagination/status/owner reads, RLS and rollback refusal. SQL
lock contention is independently connected; it is not a claim of a T/N mixed rollout.

Local PG18.6 proof is not hosted PG15 or deployed-role acceptance. The default Jest
lane excludes root `rls-*` specs and existing hosted helper/MWB jobs do not select
this E spec; neither green ordinary CI nor the preserved donor's old21-case result
can substitute for this behavioral proof. No CI or dependency change is included.

Before promotion: exact-head dual review, deployed migration/history reconciliation
(including any independently applied unmerged repair), schema/runtime inventory,
actual deployment-role visibility, representative volume/lock rehearsal and explicit
rollback ownership. E/R/C must be separately promoted artifacts because the release
script applies all pending migrations before the rolling application. Do not package
the later tightening/contraction migrations into E's deployment. Main-push deployment,
policy alignment and C1 composition remain separately owned and blocked.
