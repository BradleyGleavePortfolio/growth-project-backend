# L3 — `replay_terminal_enumeration` completeness basis and family-set closure

Status: implemented on `cand/x43/l3-basis` (draft PR to `integration/importer`). Extends
`docs/decisions/2026-09-26-s10-induction.md` (D-S10-1, D-S10-8) and the L0 record
`docs/decisions/2026-09-27-learn-and-remember.md` (D-L0-6, D-L0-6.1 r2). Nothing here names a
source platform; every rule below is data over structure.

## Owner decision this implements

D1 (2026-09-28, verbatim): _"lets do complete to mean 'All past client and coaching records in
this site are now in TGP'"_.

A run settles `complete` only when **every** predicate below holds. The AI never decides any of
them; anything short settles an honest `partial` with `coverage_basis_unknown`
(`RUN_REASON_CODES` unchanged).

## 1. The kind (append-only)

`COMPLETENESS_BASIS_KINDS` is now `['none', 'source_signed_enumeration',
'replay_terminal_enumeration']`. Only `source_signed_enumeration` is verifier-bound
(`VERIFIER_BOUND_BASIS_KINDS`); a learned or derived manifest may list the replay kind with
`verifiers: []` (V5 relaxed to verifier-bound kinds only). A file package that does not list the
kind for a family still cannot be proven by it (E3 unchanged).

## 2. Evidence shape `ReplayTerminalEvidenceV1` (one row per platform × scope × family)

Strict keys: `evidence_version: 1`, `source_platform`, `account_scope_id_digest`, `family`,
`basis_kind: 'replay_terminal_enumeration'`, `mapping_spec_digest`, `challenge_b64` (the run
declaration's 32-byte challenge), `steps[]` (1..16), `observed_unique`, `id_set_digest`
(D-S10-2 digest rule). Each step: `step`, `stop ∈ short_page | absent_next | budget_stop |
refused_page | retry_exhausted | aborted`, `pages_fetched`, `max_pages`, `refused_pages`,
`fan_out: null | {expected, fetched}`. Uploaded through the existing `runs/observation` route; the
OpenAPI schema `ScoutRunObservationEvidenceSchema` gained the kind-specific optional fields and
`ScoutRunReplayStepTerminalSchema` (contract regenerated).

## 3. Evaluator rule (verify.ts, per unit)

A unit is proven iff: the row binds to this run (coach, intent, epoch, challenge, scope, spec
digest); the reported step set ⊇ the spec's steps for the family and every reported step is one
of those or the family token; every step stopped at `short_page`/`absent_next`, with
`refused_pages === 0`, `pages_fetched < max_pages` and, for fan-out, `fetched === expected`; and
(E6) `id_set_digest` **and** `observed_unique` equal the staged side. Then
`{known: true, basis_kind: 'replay_terminal_enumeration', observed_unique, covers_staged_identities: true}`.

Negative cases (each ⇒ `known: false`, count dropped, never `0`): a truncated crawl (any
`budget_stop`, `refused_page`, `retry_exhausted`, `aborted`), a step that hit `maxPagesPerStep`
(`pages_fetched ≥ max_pages`, even with a terminal stop), a refused page, a fan-out short of its id
set, a step set short of the spec, a step the spec does not map to the family, a digest or count
mismatch, another run's challenge, another coach/intent/epoch, a duplicate or missing row, a
manifest that does not list the kind, and two kinds proving one family across platforms.

## 4. Family-set closure input (D-L0-6.1 (i) with the r2 review defaults)

`CoverageEvaluationInput.closure?: readonly FamilySetClosureV1[] | null` — **default `null`
= not known = every declared family `known: false`** ⇒ `partial/coverage_basis_unknown`. Until
the learn slice exists, the settle path passes `reviewedPackageClosures(registry)`: every
repository (file) package is a reviewed spec, so its record is `{origin: 'reviewed_package'}`
bound to the package's `specDigest`.

A learned package's record is `{origin: 'observed_templates', rule_version: 1, digest_truncated,
refused_collections, unexplored_targets, templates[]}`; a mapped template carries
`unexplored_variants` (a count of non-pagination query-key values the replay did not enumerate —
never the values); an excluded template carries the claimed `reason` and the rule's structure-only
`signals {path, key, shape, veto, empty_shape}`. The evaluator re-derives the verdict on every
run; nothing stored says "confirmed".

`complete` is blocked, with a named gap, by ANY of: `digest_truncated`; `collection_refused`
(count); `target_unexplored` (count); `variant_unexplored` (template, count);
`template_unsupported_coaching_data`; `template_unknown`; `template_exclusion_unconfirmed`
(template, reason, signals) — the rule confirms only an `out_of_scope_*` reason with path **and**
key **and** shape evidence, no veto (coaching vocabulary in path tokens or keys, or an
email/phone-like key) and a non-empty item shape; `family_without_template`;
`template_family_undeclared`; `template_duplicated`; `closure_unknown`,
`closure_platform_mismatch`, `closure_spec_mismatch`, `closure_malformed` (strict keys, bounds
≤256 templates). Gaps are exposed through `evaluateCoverageDetailed().closure[platform]`.

## 5. Reason channel (what was added and why)

No coach-facing detail channel for gaps exists in the settle path today (the S9 report and
`reason-codes.ts` were out of L3's scope). L3 therefore adds one append-only, in-process
carrier — `evaluateCoverageDetailed()` returning `{facts, closure}` beside the unchanged
`evaluateCoverage()` — so a later slice can persist or render the gaps without touching the
evaluator. The verdict itself is unchanged: an open closure is `partial/coverage_basis_unknown`.
