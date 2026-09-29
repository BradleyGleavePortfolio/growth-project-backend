# L3 — `replay_terminal_enumeration` evidence: a proven per-family SOURCE COUNT (no closure yet)

Status: implemented on `cand/x43/l3-basis` (draft PR #589 to `integration/importer`), r2 after
the T4 reviews R589-A / R589-B and the **executive reset of 2026-09-29**
(`reviews/EXEC_RESET_2026-09-29.md` §1, §6, §8 — binding). Extends
`docs/decisions/2026-09-26-s10-induction.md` (D-S10-1, D-S10-8) and the L0 record
`docs/decisions/2026-09-27-learn-and-remember.md` r4 D-L0-6 ("Pagination exhaustion is proven per
endpoint, positively"; `StepEvidenceV1`; "L3 evidence cardinality"). D-L0-6.1's closure
machinery (`RunClosureV1`, `reviewed_package`, `observed_templates`) is deleted by the reset and
is **not** implemented here. Nothing here names a source platform; every rule below is data over
structure.

## Owner decision and what this slice may claim

D1 (2026-09-28, verbatim): _"lets do complete to mean 'All past client and coaching records in
this site are now in TGP'"_. D1 is unchanged — and, per the reset §1, **cannot be claimed yet**:
until a separate, later completeness-closure record lands, **no package type (learned,
file/reviewed, legacy) has a run-level closure**. Closure is null for every package. Consequently:

- `replay_terminal_enumeration` evidence can prove a family's **source count** ("48 of 48") —
  `evaluateCoverageDetailed().families[family] = {source_count, count_basis: 'proven',
basis_kind, reasons}` — for the one run-status projection (reset §6, slice L2);
- it **never** yields a `CoverageFact` with `known: true`. `evaluateCoverage()` (the S9 facts the
  reconciler reads) reports every replay family `known: false`, the run settles
  `partial/coverage_basis_unknown` (existing `RUN_REASON_CODES`), and the projection gap is
  `completeness_not_proven`. A false `complete` through this evidence is impossible by
  construction: the reconciler cannot see the replay kind at all;
- `complete` stays reachable only through the existing `source_signed_enumeration` basis, which
  S12-B2 already refuses outside dev/test. The r2 tests prove both halves
  (`test/scout/induction/replay-basis.spec.ts`, `replay-basis-r2.spec.ts`: a composed package and
  a package read by the real file loader both settle `partial` with every family counted).

## 1. The kind (append-only)

`COMPLETENESS_BASIS_KINDS` is `['none', 'source_signed_enumeration',
'replay_terminal_enumeration']`. Only `source_signed_enumeration` is verifier-bound
(`VERIFIER_BOUND_BASIS_KINDS`); a learned, derived **or file** manifest may list the replay kind
with `verifiers: []` (V5 relaxed to verifier-bound kinds only) — listing it opts the family into
source-count evidence, nothing more. A package that does not list the kind for a family cannot
have that family counted by it (E3 unchanged). The r1 load-time refusal of the kind on file
manifests is gone with the closure it protected.

## 2. Evidence shape `ReplayTerminalEvidenceV1` (one row per platform × scope × family)

Strict keys: `evidence_version: 1`, `source_platform`, `account_scope_id_digest`, `family`,
`basis_kind: 'replay_terminal_enumeration'`, `mapping_spec_digest`, `challenge_b64` (the run
declaration's 32-byte challenge), `steps[]` (1..64, L0 r4 D-L0-6 "L3 evidence cardinality"),
`observed_unique`, `id_set_digest` (D-S10-2 digest rule over the union of the steps' id sets).
The family's single observation row aggregates one `ReplayStepEvidenceV1` per step, `:s`/`:q`
variant or probe feeding the family (no unique-key change). Each step is L0 r4 `StepEvidenceV1`
on the wire in snake_case: `step_key`, `pages_fetched`, `raw_items`, `distinct_raw_ids`,
`duplicate_ids`, `synthetic_ids`, `missing_id_items`, `stop ∈ absent_next | empty_page |
short_page | none_proven | budget | cycle | error | advertised_next`, `advertised_next: boolean`,
`refused_pages`, `fan_out: null | {expected, fetched, parent_step}`, `id_set_digest` (this
step's own D-S10-2 digest). Deviations from r4, both additive: `fan_out.parent_step` names the
step the fan-out iterated (the package has no `parentEdge` yet, so the evaluator cannot infer it);
the r4 `stepKey` is `step_key` on the wire like every other key. Uploaded through the existing
`runs/observation` route; `ScoutRunObservationEvidenceSchema` carries the kind-specific optional
fields and `ScoutRunReplayStepEvidenceSchema` replaces the r1 `…StepTerminalSchema` (contract
regenerated).

Body bound (r4 D-L0-6): the route checks the received bytes against 64 KiB first, parses the
envelope, then re-checks against 32 KiB unless **every** entry is the replay kind. A mixed or
signed-only body between 32 and 64 KiB is therefore refused as `too_large` after parsing rather
than before (the same 400, one parse later); nothing is stored either way.

Parser refusals (`parseEvidence`, never throws): any unknown/missing key, a non-integer or
negative counter, a `stop` outside the closed set, a non-boolean `advertised_next`, a non-hex64
step digest, a duplicate `step_key`, more than 64 steps, and — r4 "unknown is never 0" — a
**root step with `pages_fetched: 0`** (`bad_count`): it observed no terminal, so it is not even
stored as evidence. A fan-out step may report `pages_fetched: 0` (it may have had no parent
context to visit); the evaluator decides it.

## 3. Evaluator rule (verify.ts, per unit) — a proven source count

A unit's count is proven iff: the row binds to this run (coach, intent, epoch, challenge, scope,
spec digest); the reported step set ⊇ the spec's steps for the family and every reported step is
one of those or the family token; and every step is **positively exhausted**: `stop ∈
{absent_next, empty_page, short_page}` after `pages_fetched ≥ 1` (root steps),
`advertised_next === false`, `refused_pages === 0`, `synthetic_ids === 0`, `missing_id_items ===
0`; counters consistent (`distinct_raw_ids + duplicate_ids ≤ raw_items`; the family's
`observed_unique ≤ Σ distinct_raw_ids`; a single-step family's step count and digest ARE the
family's); a fan-out step visited every expected parent context (`fetched === expected ===
pages_fetched`) and its `expected` **equals the parent step's proven `distinct_raw_ids`** (a step
of a family this platform proved in the same pass, fixpoint: an unproven parent unproves the
child); and (E6) `id_set_digest` **and** `observed_unique` equal the staged side. An empty family
is counted `0` only by a positive proof (one fetched page that came back `empty_page`, r4
D-L0-6). Two basis kinds proving one family across platforms fail closed
(`basis_kind_conflict`).

The rule is style-agnostic: the package carries no pagination style, so the terminal set is the
union over styles. A `next_url` style (reset §1: follow the response's own next link, confined to
authorized/contacted origins) fits the grammar without a new field — its terminal is
`absent_next`, an unfollowed link is `advertised_next: true` (never counted), and a first page
is never certified. The origin confinement is a device-side replay rule (X2b), not something the
evidence can prove, so no `style` field is added here; noted for X2b. Flagged for the L0 record:
r4's `StopReason` has no positive value for a proven `style: 'none'` step — L3 expects X2b to
report `short_page`/`empty_page` for it.

Negative cases (each ⇒ `source_count: null`, `count_basis: 'unknown'`, never `0`, with a closed
reason code): `crawl_truncated` (a non-terminal stop, an advertised next link, a refused page),
`zero_pages_fetched`, `identity_unproven`, `evidence_inconsistent`, `step_set_mismatch`,
`fan_out_short`, `fan_out_parent_unproven`, `fan_out_count_mismatch`, `staged_mismatch`,
`staged_digest_missing`, `evidence_unbound`, `evidence_missing`, `evidence_duplicate`,
`evidence_malformed`, `basis_kind_conflict`, `platform_undeclared`, `package_missing`,
`declaration_missing`, `partition_disagreement`, `multi_scope`, `evaluator_failure`
(`COVERAGE_REASON_CODES`, append-only, counts only).

## 4. Closure — none exists (reset §1, §8; R589-A-1/-2, R589-B-A1/-A2, R581-A2-04)

Deleted in r2: the `observed_templates` variant and its producer-supplied exclusion signals and
template logic; the `reviewed_package` variant (the r4 re-reviews found reviewed file packages
bypass run-specific site closure, R581-A2-04); the loader-set `origin` field; the
`CoverageEvaluationInput.closure` input; `src/scout/induction/closure.ts`. No closure record,
type or input remains in `src/scout/induction`; a `closure` key smuggled into the evaluator input
is ignored (tested). The findings of R589-A/B on closure are inputs to the future
completeness-closure record, not to this slice.

## 5. What reaches the coach (reset §6; R589-A-5, R589-B-B2)

No projection is built here. `evaluateCoverageDetailed()` returns `{facts, families}` beside the
unchanged `evaluateCoverage()`: `families[family] = {source_count: int | null, count_basis:
'proven' | 'unknown', basis_kind, reasons: {code, platform | null}[]}` — the typed structure the
ONE run-status projection (`RunStatusProjectionV1.families[].source_count/count_basis`,
`gaps[]`, slice L2, owned by L0) consumes. A replay-proven family carries exactly
`completeness_not_proven`; a source-signed covering family carries `[]`. Nothing here is
persisted or shown yet; the projection's `'observed'` count basis (staged rows without proof) is
L2's, computed from staged facts. The settle path (`facts.service.ts`) still stores only the S9
facts.
