# L3 — `replay_terminal_enumeration` evidence: a per-family SOURCE COUNT with a stated basis (no closure yet)

Status: implemented on `cand/x43/l3-basis` (draft PR #589 to `integration/importer`), r4 after
the T4 reviews R589-A / R589-B (r2), R589-c7A / R589-c7B (r3) and R589-c7A2 / R589-c7B2 (r4; §7),
under the **executive reset
of 2026-09-29** (`reviews/EXEC_RESET_2026-09-29.md` §1, §6, §8 — binding). Extends
`docs/decisions/2026-09-26-s10-induction.md` (D-S10-1, D-S10-8) and the L0 record
`docs/decisions/2026-09-27-learn-and-remember.md` **r7** (`origin/cand/x43/learn-doc-r2` at
`e79e6578`; the D-L0-6 text and L15 this slice implements are byte-identical in r5, r6 and r7):
D-L0-6 "Per-family counting evidence is kept" (`StepEvidenceV1`, `StopReason`, positive
exhaustion per step, fan-out, family count basis, evidence cardinality), D-L0-6.3
`FamilyRowV1.count_basis` and `GapCode`, D-L0-9 slices L3a/L3b, acceptance L14/L15. The r7
D-L0-9 L3a row lists what #589 owed before it is r7-conformant — drop `short_page` from the
terminal stops (a short page is observed, never proof), rename `none_proven` →
`first_page_only`, add `'observed'` to `FAMILY_COUNT_BASES` computed per D-L0-6, the L15
early-short-page negative — all four are done in r3 (§2, §3; `replay-basis-r3.spec.ts`); the
L3b remainder that needs the L2b pin is §6. D-L0-6.1's closure machinery is deleted
by the reset and is **not** implemented here. Nothing here names a source platform; every rule
below is data over structure.

## Owner decision and what this slice may claim

D1 (2026-09-28, verbatim): _"lets do complete to mean 'All past client and coaching records in
this site are now in TGP'"_. D1 is unchanged — and, per the reset §1 and L0 r7 D-L0-6
"`complete` is unreachable until CL", **cannot be claimed yet**: no package type (learned,
file/reviewed, legacy) has a run-level closure. Consequently:

- `replay_terminal_enumeration` evidence can establish a family's **source count** with a basis —
  `evaluateCoverageDetailed().families[family] = {source_count, count_basis: 'proven' |
'observed' | 'unknown', basis_kind, reasons}` — for the one run-status projection (D-L0-6.3,
  slice L2d);
- it **never** yields a `CoverageFact` with `known: true`. `evaluateCoverage()` (the S9 facts the
  reconciler reads) reports every replay family `known: false`, the run settles
  `partial/coverage_basis_unknown` (existing `RUN_REASON_CODES`), and the projection gap is
  `completeness_not_proven`. A false `complete` through this evidence is impossible by
  construction: the reconciler cannot see the replay kind at all;
- `complete` stays reachable only through `source_signed_enumeration` **in an explicit
  development/test runtime**. r3 closes `R589-c7A-01`: the runtime loader
  (`parseInductionManifestForRuntime(raw, origin, refuseTestOnly = true)`) refuses **every**
  manifest that lists a verifier-bound kind for any family, marked or not
  (`listsVerifierBoundKind`), in addition to the S12-B2 marker rules. **r4 (`R589-c7B2-01`) moves
  the rule to the one boundary every package passes:** `buildInductionRegistry` (the S10-C
  cross-check every registry is built through — the file loader's manifests, a run's pinned or
  learned package via `composeRunArtifacts` → `buildSourceRegistries`, a mapper partition via
  `partitionInductionRegistry`, the proof workers) drops any manifest listing a verifier-bound
  kind unless `NODE_ENV` is explicitly development/test (`InductionRegistryInput.refuseVerifierBoundKinds`,
  default `!testOnlyArtifactsAllowed(NODE_ENV)`), after validating it. On `e5b990b6` the same
  unmarked signed manifest, supplied as `RunPackage.manifest` and composed under
  `NODE_ENV=production`, settled `complete` (auditor B's repro); it now yields `package_missing`
  for every family and `partial/coverage_basis_unknown`, through `composeRunArtifacts`, through
  `SourceRegistryProvider.forRun` with an overriding `RUN_PACKAGE_SOURCE` and through a partition
  (`test-only-exclusion.spec.ts` "R589-c7B2-01", failing on `e5b990b6`). The loader's own refusal
  stays as the earlier, redundant gate. Reproduced by auditor A and
  settled against auditor B's statement: on `61b0d251` an unmarked, otherwise valid signed
  manifest with valid signed evidence loaded under refusal and reached `complete`
  (`test-only-exclusion.spec.ts` "R589-c7A-01", fails on the old head). The r2 "positive control"
  (unmarked signed manifest proves with refusal on) was that exact path and is inverted; the
  discriminating control (the same evidence proves in the allowing mode) stays. The S10/S11
  harnesses and the S11 worker (`parseInductionManifest`) are unaffected.

## 1. The kind (append-only)

`COMPLETENESS_BASIS_KINDS` is `['none', 'source_signed_enumeration',
'replay_terminal_enumeration']`. Only `source_signed_enumeration` is verifier-bound
(`VERIFIER_BOUND_BASIS_KINDS`); a learned, derived **or file** manifest may list the replay kind
with `verifiers: []` (V5 relaxed to verifier-bound kinds only) — listing it opts the family into
source-count evidence, nothing more. A package that does not list the kind for a family cannot
have that family counted by it (E3 unchanged). Note for the S10 record (`R589-c7B-C2`): the
r1 text "every manifest carries ≥ 1 verifier" is superseded by "≥ 1 verifier iff a verifier-bound
kind is listed"; the S10 record is another lane's file and is not edited here.

## 2. Evidence shape `ReplayTerminalEvidenceV1` (one row per platform × scope × family)

Strict keys: `evidence_version: 1`, `source_platform`, `account_scope_id_digest`, `family`,
`basis_kind: 'replay_terminal_enumeration'`, `mapping_spec_digest`, `challenge_b64` (the run
declaration's 32-byte challenge), `steps[]` (1..64, D-L0-6 "Evidence cardinality"),
`observed_unique`, `id_set_digest` (D-S10-2 digest rule over the union of the steps' id sets).
The family's single observation row aggregates one `ReplayStepEvidenceV1` per step, `:s`/`:q`
variant or probe feeding the family (no unique-key change). Each step is L0 r5–r7
`StepEvidenceV1` on the wire in snake_case: `step_key`, `pages_fetched`, `raw_items`,
`distinct_raw_ids`, `duplicate_ids`, `synthetic_ids`, `missing_id_items`, `stop`,
`advertised_next: boolean`, `refused_pages`, `fan_out`, `id_set_digest` (this step's own
D-S10-2 digest).

`stop ∈ StopReason = { absent_next, empty_page, short_page, first_page_only, budget, cycle,
error, advertised_next }` (`REPLAY_STEP_STOPS`, verbatim r5–r7; the r2 `none_proven` is gone),
partitioned for the evaluator into `REPLAY_EXHAUSTED_STOPS = {absent_next, empty_page}`,
`REPLAY_OBSERVED_STOPS = {short_page, first_page_only}`, `REPLAY_ABORTED_STOPS = {budget, cycle,
error}` plus `advertised_next` (observed).

`fan_out: null | { parent_step, parent_ids_digest, contexts_expected, contexts_fetched,
contexts_exhausted }` — the r5–r7 fields plus `parent_step` (additive): the step whose id set
the fan-out iterated. The pinned package (L2b) carries no `forEach`/parent edge yet, so the
evaluator cannot infer the parent; when the pin lands, the evaluator must check `parent_step`
against it and the field may become derivable. `parent_step === step_key` is refused by the
parser (`bad_step`). The r2 `{expected, fetched}` pair is gone.

**Identity scope (normative; D-L0-6 "Identity", D-L0-4 C0; `R589-c7A-05`, `R589-c7B-05`).** Every
step count and digest is over the **staged identity**: under `idScope: 'parent'` the composed
`parent:id`, otherwise the raw id. Two parents sharing a child raw id are two identities; a raw
(collapsed) digest never verifies against the staged rows (`step_staged_mismatch`, tested).

Uploaded through the existing `runs/observation` route. **Published schema (r4, `R589-c7A2-02`):**
`ScoutRunObservationDto.observations[]` is a discriminated `oneOf` (`discriminator: basis_kind`)
over two closed component schemas, `ScoutRunSourceSignedEvidenceSchema` and
`ScoutRunReplayTerminalEvidenceSchema`; each requires **every** wire key of its kind, pins
`basis_kind` to a one-value enum and sets `additionalProperties: false`;
`ScoutRunReplayStepEvidenceSchema` (all 12 keys required, counters `integer ≥ 0`) and
`ScoutRunReplayFanOutSchema` (all 5 keys required) are closed the same way; `fan_out` is
`oneOf: [FanOut, {type: null}]`; decoded byte lengths (32-byte challenge, 64-byte signature,
≤ 1024-byte statement) are padded-base64 patterns. The r3 loose union
(`ScoutRunObservationEvidenceSchema`, common keys required and both tails optional) is gone.
`test/contracts/importer-contract.spec.ts` pins the structure and runs an independent JSON
Schema validator (`ajv`) against `parseEvidence` over a corpus that drops, adds, retypes and
ranges every key of both kinds, the step and the fan-out: they agree on every syntactic case,
and the handful of rules no schema can state (root `pages_fetched: 0`, self-parent, duplicate
`step_key`, canonical base64 padding bits, canonical-JSON statement) are schema-valid and
parser-rejected, never the reverse. The contract artifact is regenerated.

Body bound (D-L0-6): the route checks the received bytes against 64 KiB first, parses the
envelope, then re-checks against 32 KiB unless **every** entry is the replay kind. A mixed or
signed-only body between 32 and 64 KiB is therefore refused as `too_large` after parsing rather
than before (the same 400, one parse later); nothing is stored either way.

**`pages_fetched` is normative (r4, `R589-c7B2-02`):** it counts **every** page the step fetched,
the terminal page **included** — a page-style list of two data pages whose page 3 came back
empty is `pages_fetched: 3`; a cursor-style list reports its data pages. X2b builds against this.
**`raw_items` is exactly partitioned (r4, `R589-c7A2-01`; D-L0-4 C0):** `raw_items ===
distinct_raw_ids + duplicate_ids + synthetic_ids + missing_id_items` — every reported item is a
first-seen real identity, a repeat of one, a synthetic id or an item without an id.

Parser refusals (`parseEvidence`, never throws): any unknown/missing key, a non-integer or
negative counter, a `stop` outside the closed set, a non-boolean `advertised_next`, a non-hex64
step or parent digest, a duplicate `step_key`, a self-parent, more than 64 steps, and — "unknown
is never 0" — a **root step with `pages_fetched: 0`** (`bad_count`): it observed no terminal, so
it is not even stored as evidence. A fan-out step may report `pages_fetched: 0` (it may have had
no parent context to visit); the evaluator decides it.

## 3. Evaluator rule (verify.ts, per unit) — count basis proven / observed / unknown

Binding first: the row binds to this run (coach, intent, epoch, challenge, scope, spec digest);
the reported step set is **exactly** the spec's steps for the family — the family token alone
when the spec maps no step to it (`R589-B-C7`); a missing, extra or duplicate step is
`step_set_mismatch`. Per step: `synthetic_ids`/`missing_id_items ≠ 0` ⇒ `identity_unproven`;
**inexact accounting** (r4: `raw_items ≠ distinct_raw_ids + duplicate_ids + synthetic_ids +
missing_id_items`; r3 checked only `>`, so `raw_items: 2, distinct_raw_ids: 1` with nothing else
accounted certified `proven 1` — auditor A2's counterexample) ⇒ `evidence_inconsistent`; an
aborted stop (`budget`/`cycle`/`error`) ⇒ `crawl_truncated`; a root step with no page, or a
fan-out with contexts to visit and no page ⇒ `zero_pages_fetched`; fan-out counters contradicting
each other or the page total (`fetched > expected`, `exhausted > fetched`, `pages_fetched <
fetched`) ⇒ `fan_out_short`; **an `empty_page` stop with no room for the fetched empty terminal
page** (r4: `raw_items > 0` with root `pages_fetched < 2`, or fan-out `pages_fetched ≤
contexts_fetched` — auditor B2's T19 "17 items on one page labelled `empty_page`" and T20) ⇒
`evidence_inconsistent`, i.e. unknown, not even `observed` (the row is self-contradictory; an
honest first page is `first_page_only`/`short_page` and is `observed`). `raw_items: 0` with
`pages_fetched: 1` and `empty_page` stays the positive proof of an empty collection. The family
totals must be consistent with the steps (`observed_unique ≤ Σ distinct_raw_ids`; a single-step
family's count and digest ARE the family's).

**Per-step staged verification (`R589-c7A-04`, `R589-c7B-C4/S4`).** `StagedPlatformFacts.steps`
(new, required: `entity_type → IdentitySetDigest | null`, emitted by `stagedPlatformFacts` for
every spec step and family token, empty digest when no row) is the reference: every step's
`id_set_digest` **and** `distinct_raw_ids` must equal the rows staged under that step token
(`staged_digest_missing` / `step_staged_mismatch`). Garbage per-step digests with a correct family
union no longer prove. (E6) the family's `id_set_digest` and `observed_unique` must equal the
staged family digest (`staged_mismatch`); E6 is required for `observed` too.

**Fan-out (`R581-A2-06`, `R589-c7A-03`, `R589-c7B-02`).** `parent_step` must be a verified step
of the same platform in this pass (fixpoint; ambiguous keys across families are dropped) else
`fan_out_parent_unproven`; `parent_ids_digest` must equal that step's verified `id_set_digest`
else `fan_out_parent_mismatch`; `contexts_expected` must equal its verified `distinct_raw_ids`
else `fan_out_count_mismatch` (so `expected: 0` with a non-empty parent is refused); the parent
chain must reach a root step without revisiting a step else `fan_out_cycle` (mutual zero-page
parents never prove 0). Exhausted iff `contexts_fetched === contexts_expected ===
contexts_exhausted`; `pages_fetched` is the page total across contexts (H > 1 pages per context
proves). A fan-out over a parent that is only `observed` is at most `observed`.

**Count basis (D-L0-6 "Family count basis").** `proven` iff every step is positively exhausted:
`stop ∈ {absent_next, empty_page}` after ≥ 1 page, `advertised_next === false`, `refused_pages
=== 0`, fan-out fully exhausted, and the parent chain proven. `observed` iff every step fetched
and verified but at least one is not positively exhausted — `short_page`, `first_page_only`,
`advertised_next` (stop or flag), `refused_pages > 0`, a fan-out with a context unfetched or
unexhausted, or an `observed` parent — with reasons `list_not_exhausted` (the D-L0-6.3 gap) +
`completeness_not_proven`; `source_count` is the verified union count. `unknown` otherwise,
`source_count: null`, never `0`. Across platforms the weaker basis wins. An empty family is
`0` only by a positive proof (one fetched page that came back `empty_page`). Two basis kinds in
one family fail closed (`basis_kind_conflict`).

The rule is style-agnostic: the package carries no pagination style, so the evaluator applies the
r5–r7 rule per stop value — `page` ends `empty_page`, `cursor`/`next_url` end `absent_next`,
`none` is `first_page_only` (observed, never certified); the origin confinement of `next_url` is a
device-side replay rule (X2b), not something the evidence can prove. The r2 request that X2b
report `short_page`/`empty_page` for `style: 'none'` is **withdrawn** — r5–r7 provide
`first_page_only`.

Closed reason codes (`COVERAGE_REASON_CODES`, append-only, counts only): the r2 set plus
`list_not_exhausted`, `fan_out_parent_mismatch`, `fan_out_cycle`, `step_staged_mismatch`.

## 4. Closure — none exists (reset §1, §8; R589-A-1/-2, R589-B-A1/-A2, R581-A2-04)

Deleted in r2: the `observed_templates` variant and its producer-supplied exclusion signals and
template logic; the `reviewed_package` variant (R581-A2-04); the loader-set `origin` field; the
`CoverageEvaluationInput.closure` input; `src/scout/induction/closure.ts`. No closure record,
type or input remains in `src/scout/induction`; a `closure` key smuggled into the evaluator input
is ignored (tested). The findings of R589-A/B on closure are inputs to the future
completeness-closure record (L0 r7 §9), not to this slice.

## 5. What reaches the coach (reset §6; D-L0-6.3; R589-A-5, R589-B-B2, R589-c7B-04)

No projection is built here. `evaluateCoverageDetailed()` returns `{facts, families}` beside the
unchanged `evaluateCoverage()`: `families[family] = {source_count: int | null, count_basis:
'proven' | 'observed' | 'unknown', basis_kind, reasons: {code, platform | null}[]}` — the typed
structure `RunStatusProjectionV1.families[].source_count/count_basis` and `gaps[]` (slice L2d)
consume. `observed` here is the **evaluator's** basis (a verified but unexhausted list), never a
run basis. L0 r7 defines `observed` **only** from step evidence (D-L0-6 "Family count basis";
§3.4 "`source_count` is null without an `observed`/`proven` basis"): L2d shows a count only with
an evaluator basis and **never derives one from staged rows** — the r3 sentence licensing that is
withdrawn (`R589-c7B2-C02`; the D5 "unknown shown as unknown, never 0" rule).
`template_absent` and `residual_unknown` (r6/r7 `GapCode`s, D-L0-6.3) are not L3 evidence:
`template_absent` is L2d's mapping of a pin-recorded absent template (r7 D-L0-3; this evaluator
only ever sees the pin's step set and fails closed `step_set_mismatch` when a step is missing);
`residual_unknown` is FAM-0's content statement (r7 D-L0-6.3 "Legacy records have one
placement"), derived from the S9 report, never from replay evidence.
Nothing here is persisted or shown yet; the settle path (`facts.service.ts`) still stores only the
S9 facts.

## 6. Deferred to the L2b pin (recorded, not kicked)

Step **variants** (`:s`/`:q`; `R589-c7A-05`, `R589-c7B-C3`) are not representable until the pin
carries the compiled package: today's spec has step tokens only, so a variant key is an extra step
and fails closed (`step_set_mismatch`). When the pin lands, L3b must accept exactly the pin's
step-and-variant set and check `fan_out.parent_step` against the pin's `forEach`. Explicitly
(`R589-c7B2-C01`): once the pin carries `forEach`, a pinned fan-out step that reports `fan_out:
null` — or a pinned root step that reports a parent — is refused (`step_set_mismatch` or a new
closed code), so a fan-out cannot escape parent binding by calling itself a root; today the pin
has no edge and such a row verifies only against its own staged rows (auditor B2's T16).

## 7. r4 (R589-c7A2 / R589-c7B2) — what changed and what did not

- `R589-c7B2-01` (B): kind refusal at `buildInductionRegistry` for every package path (above).
- `R589-c7B2-02` (B): `pages_fetched` normative; `empty_page` consistency rule (§2, §3).
- `R589-c7A2-01` (B): exact `raw_items` accounting per step (§2, §3).
- `R589-c7A2-02` (B): closed, discriminated OpenAPI union; validator-vs-parser agreement test (§2).
- `R589-c7B2-C02` (C): the evidence-free `observed` sentence withdrawn (§5). `R589-c7B2-C01` (C):
  recorded in §6. `R589-c7B2-C05` (C): `indexSteps`' ambiguity branch (a step key verified in two
  families is dropped, so no fan-out binds to it) is defensive — `spec.steps` maps a step key to
  one family, so the case is reachable only through a spec that names a family token as another
  family's step; not exercised by a test in r4, recorded. `R589-c7B2-C03`/`C04` and
  `R589-c7A2` C notes are the L0 owner's (fan-out shortfall wording, `stepKey` casing) or X2b's
  (`next_url` confinement); not changed here.
- Unchanged: `reconcile.ts`, `coverage.ts`, `arbiter.ts`, `RUN_REASON_CODES`, the Prisma schema,
  the parser's grammar (the r4 rules are evaluator-level, so a stored T19/T20 row answers unknown).
