> Importer north star: docs/importer/NORTH_STAR.md.

# CL: completeness closure — when a family, then a run, is proven `complete` (contract)

- **Status:** T4 decision record (backend + extension), r1, doc only; changes no code, schema or API
  and claims nothing has run. **Owner:** Bradley Gleave. **Date:** 2026-09-30. Closes finding N-04
  (operator readback 2026-09-29 §3, §6) at the contract level; the slices in §7 implement it.
- **Base:** `integration/importer` at `249fd0d4`. **Inputs read at these heads:** S9 record
  (`2026-09-25-s9-reconciliation.md`, D-S9-2, D-S9-3), S10 record (`2026-09-26-s10-induction.md`,
  D-S10-2, D-S10-3), `src/scout/induction/contract.ts`, `src/scout/reconciliation/{reconcile,
coverage,types}.ts`, `src/scout/lifecycle/arbiter.ts` (all at `249fd0d4`); L0 r9 (PR #581 head
  `0459df85`, §7 "Deferred: CL", inputs C-01..C-16; the brief's "§9" is §7 in r9); L3 r4 (PR #589 head
  `263e8950`, `replay_terminal_enumeration`, `StepEvidenceV1`, `count_basis`, `source_count`);
  FAM-0 r11 (PR #590 head `696abd73`, §9 "Deferred: CL").
- **Supersedes, when CL-D lands and only under enforcement (§5):** L3 §"Owner decision" sentence
  "it **never** yields a `CoverageFact` with `known: true`". Nothing else in S9, S10, L0, L3 or FAM-0
  is changed; §10 lists what those records owe on their next round.

## 1. The problem, in contract terms

- The only `ProvingBasisKind` that yields `known: true` is `source_signed_enumeration` (Ed25519 over
  a source-issued statement; `contract.ts` L16-21). No real coaching source signs anything, and L3 r4
  refuses verifier-bound kinds outside development/test. **No real run can be `complete`.**
- D1: `complete` = "All past client and coaching records in this site are now in TGP". North Star:
  `complete` only when proven; deterministic software owns terminal truth; AI never decides it.
- L3 already proves a per-family **source count** from replay evidence (`count_basis: proven`), but
  a positively exhausted list is one witness only: it cannot see a silent server cap, a default
  filter, a family the run never enumerated, or a surface the page never exposed.
- CL defines the extra observable witnesses, the exposure rule and the run predicate, all computed
  from **stored, epoch-bound** rows. It adds no request, no probe, no producer-asserted closure object
  and no `confirmExclusion` (all rejected in L0 §6); it adds no terminal status and no
  `RUN_REASON_CODES` entry.

## 2. Package types (who may ever reach `complete`)

| Package                                                            | May a family close?              | May the run close?                                                    |
| ------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------- |
| **Learned** (L2b pin, `candidate` or `accepted`)                   | yes, by §3                       | yes, by §4 + §5                                                       |
| **File** (reviewed JSON under `src/scout/**/sources/`)             | yes, by §3 (same evidence rules) | only if the run also pinned a round-1 structure digest (X-0); else no |
| **Legacy** (quarantined oracle; any `mode != 'server'` run)        | **never** (`legacy_package`)     | **never**                                                             |
| `source_signed_enumeration` (verifier-bound, dev/test only, L3 r4) | unchanged S10 rule               | unchanged; production refusal unchanged                               |

- Package origin never relaxes a rule: learned and file packages obey the same §3/§4 text. A legacy
  run may show counts (`observed` at best) and is the parity oracle only (North Star "What this
  retires"); DEL removes it.
- Multi-scope platforms stay `known: false` (`multi_scope`, S10 E6 / L3 unchanged).

## 3. Family closure `FC(f)` — evaluator facts (CL-D, pure, `verify.ts`)

A family `f` of one declared `(platform, scope)` is **closed** iff every clause holds; the first
failing clause names the reason (closed codes, §6). Any family on any platform not closed ⇒ `f` not
closed (the weaker platform wins, as in L3).

- **FC-1 exhaustion (L3, unchanged).** L3 `count_basis === 'proven'` for `f`: exact step set; every
  step `stop ∈ {absent_next, empty_page}` after ≥ 1 page, `advertised_next: false`,
  `refused_pages: 0`, fan-out fully exhausted with a proven parent chain, `synthetic_ids ===
missing_id_items === 0`, exact `raw_items` accounting, per-step and family staged-digest equality
  (E6), binding to coach, intent, epoch, challenge, scope and spec digest.
- **FC-2 source total witness.** Every step reports `source_total` (evidence v2, §6) with
  `contexts_reporting === max(1, contexts_fetched)` and `varying_pages === 0`, and
  `source_total.sum === distinct_raw_ids` of that step (staged-identity scope, L3 "Identity scope").
  The total is read only from pages the step already fetched, at the package's validated
  `totalPath` (CL-B); it is never estimated, never read from DOM or page text.
- **FC-3 total is discriminated.** The total key is not a pagination-signal key of the template,
  `equals_page_param === false` (the total equals no page-size value: neither the request's page-size
  parameter nor a pagination-signal size key on the same page), and the key is **discriminated** for the
  template identity: on some fetched page of this run, or of an accepted run of the same pinned
  version for this coach, the reported total differed from that page's item count
  (`total_discriminated`, a structural bit on the version, no value stored).
- **FC-4 no duplicates.** `duplicate_ids === 0` in every step (a repeat shows the window moved or
  looped; the snapshot is not stable enough to prove).
- **FC-5 unnarrowed coverage.** `f` has ≥ 1 root step whose pinned template carries no narrowing
  query key (§3.1), and the staged union digest of `f` equals the staged union digest of its
  unnarrowed steps (server-computed from `StagedPlatformFacts.steps`): no narrowed variant (`:s`/`:q`,
  filter, status, date) contributes an identity the unnarrowed enumeration lacks. A family seen only
  through narrowed requests never closes.
- **FC-6 empty family.** `f` with zero identities closes only when FC-1 holds by a fetched empty
  terminal (every context's first page is the terminal, zero items) and FC-2 reads `sum === 0`;
  FC-3's discrimination clause is the one clause waived here (a zero total cannot hide items behind
  a page-count key), its other clauses still apply. An absent family row is unknown, never 0.

`known: true` in the S9 `CoverageFact` for a replay family ⇔ FC-1..FC-6 hold **and** enforcement is
on (§5); `covers_staged_identities` keeps its S10 meaning (E6). Otherwise the fact is `known: false`
and the L3 `count_basis`/`source_count` are reported unchanged.

### 3.1 Narrowing query keys (closed, server-side, fail-closed)

A query key of a pinned template is **neutral** iff it is the step's validated pagination parameter
or its tokens are all in `NEUTRAL_QUERY_KEY_VOCABULARY` (closed, versioned, vendor-neutral contract
code: sort, order, direction, include, expand, fields, locale, format, …). **Every other key is
narrowing**, including unknown ones. Classification reads key names from the pin only, never
values; it adds no request (replay keys are already confined to observed keys, D-L0-6.2).

## 4. Exposure and run closure (CL-E)

### 4.1 What the source "exposes" to this run (observable only)

`Exposure(run)` is computed server-side from the run's pinned round-1 ∪ round-2 digest (L0 D-L0-2,
D-L0-3), the pin, the stored evidence and the S9 facts — never from a device flag, a model field or a
count. It is **closed** iff X-0..X-6 hold; its family set is `EF(run)`.

- **X-0 digest present.** The run pinned a structure digest at this epoch (file packages included).
  None ⇒ `exposure_unknown`.
- **X-1 every exposed collection is accounted.** Each template with role `collection` in the digest
  (tab and admitted outside origins, landing and explore) is either a step of a catalogue family in
  the pin, or a **deterministic non-record** per the FAM-0 D-FAM-1 rule (singleton; items carry no
  distinct `idField` other than the bearer's own), computed by the same pure rule on the device
  shape classes and re-checked on the server. A model `unmapped` reason (`out_of_scope_*`,
  `unknown`) is never an exclusion ⇒ `collection_unmapped`. `unclassified` records count as a family.
- **X-2 navigation.** Every link template in the digest was visited in explore; a link refused by
  `MUTATING_VERB_VOCABULARY` is an action surface and does not open exposure but is recorded; a link
  not visited (budget, `navigation_unexplored`) opens exposure. Navigation is necessary, never
  sufficient (C-01).
- **X-3 no unobserved data path.** None of these run facts: `digest_truncated`, `slot_unbound`,
  `template_absent`, `non_get_data_unobserved` (`nonGetDataOrigins > 0`), `cross_origin_*`,
  `outside_origin_refused`, `source_auth_unavailable`, `tab_lost`, `worker_restarted`,
  `mutating_template_refused` on a collection template.
- **X-4 referential control (hidden families).** Every relationship edge the package declares from a
  staged record (`client_link`, `program_parent`, `child_order`, FAM-0 person edges) targets a
  family in `EF(run)` that has a step in the pin; an edge into a family with no step ⇒
  `family_unenumerated`; an edge whose target identity is not in the target family's enumerated set
  ⇒ S9 C-REL holds (unchanged).
- **X-5 family set.** `EF(run)` = pinned step families ∪ edge target families ∪ spec families of
  every declared platform. Every member enters S9 `required_families`.
- **X-6 single scope** per declared platform (C-16 and multi-scope stay deferred).

A family the source never shows to the coach's own logged-in session in any of these ways is outside
what any read-only observer can prove; that residual is declared (§9 R-2), not assumed away.

### 4.2 Run predicate `RC(run)` — decided only by `reconcile()` then `arbitrate()`

`complete` iff all hold, else the existing precedence below decides:

- **RC-1** server-mode run with declaration, challenge and pin; package not legacy (§2).
- **RC-2** `Exposure(run)` closed and `FC(f)` for every `f ∈ required_families ∪ EF(run)`.
- **RC-3** S9 D-S9-2 conditions all clear (C-FAM, C-ID, C-REL, C-COV); with FAM-R1, bucket j-p
  verified and every preserved record viewable (`PRESERVE_VIEWABLE`); media references ⇒ the media
  family, `destination_gate_closed` until FAM-M1.
- **RC-4** projection facts: `not_moved[] = []` (every reason, `excluded_by_policy` included) and
  `gaps[] = []`; under `proven`, `source_count = moved_native + preserved` per family.
- **RC-5** stored claim `success`; no fence; Σ(`moved_native` + `preserved`) ≥ 1.
- **RC-6** enforcement on (§5).

**Terminal precedence (arbiter; CL adds no step):** fence ⇒ its terminal; claim `failed` with zero
staged ⇒ `failed/transfer_failed`; learn failure ⇒ `failed/transfer_failed` + its `failure_code`;
**zero usable results ⇒ `failed/transfer_failed` + `no_usable_result` (L2d), even when every family
is closed and proven empty**; then the S9 verdict verbatim (`complete`, or `partial` with the first
held condition). A closed-but-empty source is therefore `failed`, never vacuously `complete`.

### 4.3 Seam (one authority)

- `ReconciliationFacts` gains `exposure: { closed: boolean; families: readonly string[] } | null`
  (`null` = not evaluated ⇒ not covered). `coverage.ts` alone reads it: `requiredFamilies` adds
  `exposure.families`; `coverageConditionHolds` also holds when `exposure` is `null` or not closed.
  The run-level code stays `coverage_basis_unknown`; the specific reasons reach the projection as
  gaps. **`reconcile.ts` and `arbiter.ts` are unchanged by CL** (the `no_usable_result` step is
  L2d's).
- The CL evaluator and the exposure builder produce facts; only `reconcile()` → `arbitrate()` →
  CAS terminal produce a verdict. The popup, mobile, the model and the extension never compute one.

## 5. Enforcement gate (release boundary)

- `SCOUT_CL_ENFORCE` (env, default **off**, fail-closed on any value other than exact `on`). Off:
  the evaluator computes `FC`/`Exposure` and reports them in the projection as a shadow
  (`closure_shadow: closed|open|null`, never a verdict), every replay `CoverageFact` stays
  `known: false`, runs settle `partial/coverage_basis_unknown` + `completeness_not_proven`. On:
  §3/§4 feed S9.
- Turning it on is owner-reserved (flags), after V1-C (§7 CL-G) on the pinned SHAs.

## 6. Contracts (append-only additions)

- **Replay evidence v2** (`evidence_version: 2`, same row, same unique key): each step gains
  `source_total: null | { sum: int ≥ 0; contexts_reporting: int ≥ 0; varying_pages: int ≥ 0;
equals_page_param: boolean; differs_from_items_pages: int ≥ 0 }`. v1 rows stay valid and read
  as `source_total: null`. Parser refusals: unknown/missing key, negative or non-integer counter,
  `contexts_reporting > max(1, contexts_fetched)`, `differs_from_items_pages > pages_fetched`. Counts
  only; no raw total per context, no value, id or key text leaves the device (INV-3).
- **Package field** (`LearnedProposalV1.steps[].totalPath`, and the file mapping spec step): a path
  relative to the page object, outside `itemsPath`, resolving to an admitted key of integer kind that
  is not a pagination-signal key (new validator V-L11; V-L6 unchanged). Absent ⇒ FC-2 fails.
- **`COVERAGE_REASON_CODES` += ** `source_total_absent`, `source_total_mismatch`,
  `source_total_unstable`, `source_total_ambiguous`, `duplicate_ids`, `variant_narrowed`,
  `legacy_package`, `closure_not_enforced`.
- **`GapCode` += ** (L0 D-L0-6.3, append-only) `source_total_absent`, `source_total_mismatch`,
  `source_total_ambiguous`, `variant_narrowed`, `family_unenumerated`, `exposure_unknown`,
  `duplicate_ids`. `completeness_not_proven` is shown iff the run is not `complete`.
- **Version column** `total_discriminated` per `(version, template identity)` on the L2b versions
  table (additive, coach-scoped, S10-B RLS); set only by the server from evidence; never a value.

## 7. Slices (T0-T4 doctrine; one writer per path)

| Id   | Repo      | Tier | Scope (owned paths)                                                                                                                                 | Deps                       |
| ---- | --------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| CL-0 | backend   | T4   | This record (`docs/decisions/2026-09-30-cl-completeness-closure.md`)                                                                                | —                          |
| CL-A | backend   | T4   | Evidence v2 grammar, codes, OpenAPI (`src/scout/induction/{contract,parse}.ts`, `observation.dto.ts`, `docs/contracts/importer-openapi.json`)       | L3 (#589) landed           |
| CL-B | backend   | T4   | `totalPath`, V-L11, `NEUTRAL_QUERY_KEY_VOCABULARY` + fixture mirror (`src/scout/learn/**` contract/validators, mapping-spec step field)             | L1 (#591), FAM-C1          |
| CL-C | extension | T4   | X2b reports `source_total` per step/context from fetched pages only; zero added requests; leak tests                                                | X2b, CL-A, CL-B            |
| CL-D | backend   | T4   | Evaluator FC-1..FC-6, `total_discriminated` column + RLS, enforcement gate (`src/scout/induction/verify.ts`, one migration)                         | CL-A, CL-B, L3b, L2b       |
| CL-E | backend   | T4   | Exposure builder X-0..X-6, `exposure` fact, `coverage.ts` predicate, `facts.service.ts` wiring (`src/scout/reconciliation/**` minus `reconcile.ts`) | CL-D, L2b, L2c             |
| CL-F | backend   | T4   | Projection gaps, `closure_shadow`, RC-4 assertion (L2d paths)                                                                                       | L2d, CL-E                  |
| CL-X | ext + mob | T2   | X4 / R2 copy for new gap codes (frozen contract)                                                                                                    | CL-F                       |
| CL-G | all       | T4   | V1-C acceptance on the owner's account at pinned SHAs; operator sets `SCOUT_CL_ENFORCE` after owner approval                                        | V1-P, CL-A..F, FAM-R1, S18 |

Graph: L3 → CL-A; L1 + FAM-C1 → CL-B; CL-A + CL-B + X2b → CL-C; CL-A + CL-B + L3b + L2b → CL-D →
CL-E → CL-F → CL-X; V1-P + CL-C + CL-F + FAM-R1 + S18 → CL-G. Every T4 slice: two independent
approvals at the exact head; the §9 cases it owns green on that head; no test weakened.

## 8. Invariants

- **CL-INV-1** `complete` is produced only by `reconcile()` then `arbitrate()`; CL code emits facts.
- **CL-INV-2** AI has no input to the verdict: model output reaches CL only as validated package
  structure (`totalPath`, steps, like `itemsPath`/`idField`); `rationale`, `unmapped` reasons and any
  model claim are never read. Changing them leaves the settled report byte-identical.
- **CL-INV-3** never proof alone: a short page, a first page only, `style: none`, absence of errors,
  a 2xx status, a GET-only assumption ("a list without params returns everything", "the default view
  includes archived records", "the navigation lists every surface"), a count equality without an
  identity-set equality, a staged total, a producer claim, a model assertion, a signature outside
  dev/test.
- **CL-INV-4** zero added source requests; D-L0-6.2 bounds unchanged; no hidden-surface probe.
- **CL-INV-5** every input is a stored row bound to (coach, intent, epoch); nothing producer-asserted
  (C-05); a prior epoch's evidence never binds.
- **CL-INV-6** unknown is never 0; `source_count` is `null` without an evaluator basis.
- **CL-INV-7** `complete` ⇒ `gaps[] = []`, `not_moved[] = []`, every `EF(run)` family closed.
- **CL-INV-8** zero usable results ⇒ `failed/no_usable_result`, closure notwithstanding.
- **CL-INV-9** no vendor name, host, endpoint or per-source branch; vocabularies are closed,
  append-only contract code (NEW SOURCE → CORE DIFF = 0).

## 9. Acceptance cases (fixed; pure specs unless marked PG or E2E)

Positives (enforcement on unless stated):

| Id  | Construction                                                                                         | Expected                            |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------------------- |
| P01 | Learned package, 1 platform, all families multi-page, totals constant and discriminated, all native  | `complete`                          |
| P02 | P01 with a fan-out family (per-parent totals, every context reporting) and preserved family (FAM-R1) | `complete`                          |
| P03 | P01 with one family proven empty (fetched empty terminal, total 0) and others non-empty              | `complete`                          |
| P04 | File package with a pinned round-1 digest, otherwise P01                                             | `complete`                          |
| P05 | P01 with enforcement off                                                                             | `partial`, `closure_shadow: closed` |

Negative matrix — every row settles non-`complete`; "family" = CL-D family result, "gap" = projection:

| Id  | Case                     | Construction                                                         | Family / exposure                        | Run verdict                                  |
| --- | ------------------------ | -------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| N01 | truncation (budget)      | a step stops `budget`                                                | `unknown`, `crawl_truncated`             | `partial/coverage_basis_unknown`             |
| N02 | silent cap               | `absent_next` after 500 items, total 812                             | not closed, `source_total_mismatch`      | `partial/coverage_basis_unknown`             |
| N03 | short page               | a step stops `short_page`                                            | `observed`, `list_not_exhausted`         | `partial/coverage_basis_unknown`             |
| N04 | first page only          | `first_page_only`, total equals items                                | `observed`                               | `partial/coverage_basis_unknown`             |
| N05 | early short page         | page 1 short, page 2 not fetched, `advertised_next`                  | `observed`                               | `partial/coverage_basis_unknown`             |
| N06 | hidden family (edge)     | workout logs reference programs; pin has no programs step            | exposure open, `family_unenumerated`     | `partial/coverage_basis_unknown`             |
| N07 | hidden family (unmapped) | a `collection` template in the digest, model says `unknown`          | exposure open, `collection_unmapped`     | `partial/coverage_basis_unknown`             |
| N08 | model exclusion          | a record-set template marked `out_of_scope_ui_config` by the model   | exposure open, `collection_unmapped`     | `partial/coverage_basis_unknown`             |
| N09 | unexplored surface       | link inventory larger than the explore budget                        | exposure open, `navigation_unexplored`   | `partial/coverage_basis_unknown`             |
| N10 | count mismatch (total)   | total 100, distinct 99                                               | `source_total_mismatch`                  | `partial/coverage_basis_unknown`             |
| N11 | count mismatch (staged)  | evidence distinct = total = 100, staged digest differs               | `staged_mismatch` (L3)                   | `partial/coverage_basis_unknown`             |
| N12 | pagination loop          | a step stops `cycle`                                                 | `unknown`, `crawl_truncated`             | `partial/coverage_basis_unknown`             |
| N13 | undetected loop          | repeated page yields `duplicate_ids: 20`, distinct = total           | `duplicate_ids`                          | `partial/coverage_basis_unknown`             |
| N14 | duplicate ids            | `duplicate_ids: 1`, distinct = total                                 | `duplicate_ids`                          | `partial/coverage_basis_unknown`             |
| N15 | source total absent      | no `totalPath`, or v1 evidence, all else proven                      | `proven` count, `source_total_absent`    | `partial/coverage_basis_unknown`             |
| N16 | total absent, 1 context  | fan-out, one context without a total                                 | `source_total_absent`                    | `partial/coverage_basis_unknown`             |
| N17 | total unstable           | total changes between pages (`varying_pages: 1`)                     | `source_total_unstable`                  | `partial/coverage_basis_unknown`             |
| N18 | total = page parameter   | `equals_page_param: true`                                            | `source_total_ambiguous`                 | `partial/coverage_basis_unknown`             |
| N19 | total undiscriminated    | single-page list, total always equals items, no prior discrimination | `source_total_ambiguous`                 | `partial/coverage_basis_unknown`             |
| N20 | narrowed only            | the only root template carries a status/filter key                   | `variant_narrowed`                       | `partial/coverage_basis_unknown`             |
| N21 | variant adds identity    | an archived variant stages an id the unnarrowed list lacks           | `variant_narrowed`                       | `partial/coverage_basis_unknown`             |
| N22 | unknown query key        | root template carries an unclassified key                            | `variant_narrowed` (fail-closed)         | `partial/coverage_basis_unknown`             |
| N23 | absence of errors        | every page 2xx, no error, `first_page_only`                          | `observed`                               | `partial/coverage_basis_unknown`             |
| N24 | model assertion          | P01 with rationale/`unmapped` text changed or claiming "all records" | identical report bytes to P01            | identical to P01                             |
| N25 | non-GET data             | the page fetched data by POST (`nonGetDataOrigins: 1`)               | exposure open, `non_get_data_unobserved` | `partial/coverage_basis_unknown`             |
| N26 | digest truncated         | `digest_truncated`                                                   | exposure open                            | `partial/coverage_basis_unknown`             |
| N27 | file package, no digest  | file package, run pinned no digest                                   | `exposure_unknown`                       | `partial/coverage_basis_unknown`             |
| N28 | legacy run               | `mode != 'server'` or quarantined oracle package                     | `legacy_package`                         | never `complete`                             |
| N29 | multi-scope              | platform declares 2 scopes                                           | `multi_scope`                            | `partial/coverage_basis_unknown`             |
| N30 | one not moved            | P01 with one `identity_conflict`                                     | closed                                   | `partial/unresolved_identities`              |
| N31 | policy exclusion         | P01 with one `excluded_by_policy`                                    | closed                                   | `partial` (RC-4)                             |
| N32 | preserved not viewable   | P02 before `PRESERVE_VIEWABLE`                                       | closed                                   | `partial` (`destination_gate_closed`)        |
| N33 | empty source proven      | every family closed with total 0                                     | closed                                   | `failed/transfer_failed`, `no_usable_result` |
| N34 | claim not success        | P01 with claim `partial`                                             | not known (S9 claim rule)                | `partial/coverage_basis_unknown`             |
| N35 | restart / tab lost       | `worker_restarted` or `tab_lost` gap                                 | exposure open                            | `partial/coverage_basis_unknown`             |
| N36 | stale epoch              | P01 evidence bound to epoch n-1                                      | unbound, `known: false`                  | `partial/coverage_basis_unknown`             |
| N37 | signed kind in prod      | unmarked signed manifest, `NODE_ENV=production`                      | `package_missing` (L3 r4 unchanged)      | `partial/coverage_basis_unknown`             |
| N38 | enforcement malformed    | `SCOUT_CL_ENFORCE=true` (not exact `on`)                             | `closure_not_enforced`                   | `partial/coverage_basis_unknown`             |
| N39 | empty without terminal   | family 0 identities, no fetched empty page                           | `unknown`, `source_count: null`          | `partial/coverage_basis_unknown`             |

- **Owners:** CL-A parser rows (N15-N18 grammar); CL-D N01-N05, N10-N23, N29, N36-N39; CL-E
  N06-N09, N24-N28, N35 and P01-P05 through `reconcile()`; CL-F N30-N34 through the arbiter and the
  projection (PG for P02, N32); CL-C device fixtures for N02, N13, N16-N19 (packaged extension, E2E);
  CL-G P01 on the owner's account.
- Each negative is paired with its nearest positive (one changed fact) so a test cannot pass by
  never closing.

## 10. Residuals, owner-reserved, deferred

- **R-1 silent cap with a mislabeled constant.** A source that silently caps a list, exposes no
  pagination signal and carries a per-page constant key equal to the cap, mislabeled as the total,
  on a template already discriminated, defeats FC-2/FC-3. Declared, like S10's lying-source
  boundary; V1-C checks visible counts (D-L0-8 item 3).
- **R-2 never-exposed surfaces.** A family the source never shows to the coach's session through a
  collection request, a link, or a reference edge cannot be observed by a read-only replayer; CL
  claims `complete` relative to §4.1. **Owner-reserved OQ-CL-1:** Bradley confirms that the §4.1
  exposure rule satisfies D1 as worded (the stop trigger "customer-promise change" applies); until
  confirmed, `SCOUT_CL_ENFORCE` stays off. **OQ-CL-2:** `excluded_by_policy` blocks `complete`
  (safe default: yes). **OQ-CL-3:** enabling enforcement (flag, owner).
- **Consequence stated, not decided:** a source without a usable total, or whose small lists never
  discriminate the total key, stays honestly `partial` with `source_total_absent`/`_ambiguous`.
- **Owed by other records on their next round:** L0 D-L0-6.3 appends the §6 `GapCode`s and
  `closure_shadow`; L3 notes the §1 supersession; FAM-0 §9 marks CL inputs closed; S10 notes
  `evidence_version: 2` for the replay kind. **Deferred:** multi-scope attribution, cross-coach
  discrimination (L2g), resumption (C-16), a page-chain signed kind.
