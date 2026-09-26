# S9: native reconciliation verdict, report v1 and reason codes

- **Status:** T3 cross-slice contract decision for slices S9-A (pure reconciler), S9-B (facts
  service) and S9-C (wiring). Local candidate. Not merged, deployed, consumer-frozen or
  product-accepted. It changes no code, schema or API, and nothing here claims that any route,
  proof or test described below has run.
- **Date:** 2026-09-25
- **Decision owner:** Bradley Gleave (repo owner). The executing parent made the F1 and F2
  dispositions, the report-persistence choice and the ceiling disposition (D-S9-3 to D-S9-6). They
  are derivable from the accepted documents, truthful by default and not owner-reserved.
- **Base:** backend `integration/importer` `df713fd9217df524915348ef8a42c797f288dde1` (S7-L landed,
  PR #539). Unless stated otherwise, every `path Lx` citation is at this base.
- **Accepted sources:** "S7L-DOC" = `docs/decisions/2026-09-24-s7l-run-lifecycle.md`; "S8-DOC" =
  `docs/decisions/2026-09-24-s8-native-contract.md`. Both are byte-identical at `93389265` and
  `df713fd9`. The canonical plan is
  [CONTINUATION_AND_ROMAN_IMPORT_PLAN.md at 1ebbed7](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/1ebbed7/handoffs/op81/CONTINUATION_AND_ROMAN_IMPORT_PLAN.md)
  ("PLAN"), and the product mission is
  [M-IMPORTER-PRODUCT-MISSION_v1.md at 1ebbed7](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/1ebbed7/roadmap/M-IMPORTER-PRODUCT-MISSION_v1.md)
  ("MISSION").
- **Not yet landed at this base:** S8-C (native writers, `src/scout/reconstruct/native/**`, the
  `programs` family) and S8-G (the settle hook body). S9-B and S9-C bind to the S8-C and S8-G text
  as landed. They do not bind to any candidate.

## 1. Why this exists

PLAN L29 says no run may say "complete" while "a required family, historical period, relationship,
or native destination is unknown, missing, conflicted, or unverified". PLAN L319-321 says how:
reconcile unique source identities against verified native identities. "Success requires both
structural completeness and native relationship validation, not just equal counts. If the platform
provides no reliable completeness basis, final status remains incomplete." MISSION L91 requires a
reconciliation report for every import, with a reason for each outcome. MISSION L93 requires that a
forced partial never renders `complete`.

S7-L left one seam for this:

- Precedence step 3 of the arbiter takes "reconciliation verdict present (S9) → its outcome"
  (S7L-DOC L70). Without one, step 4 returns `partial` / `reconciliation_not_performed`
  (S7L-DOC L71-72).
- "`complete` is emitted only from a reconciliation verdict. S7-L never produces it."
  (S7L-DOC L74).
- In code, `ReconciliationVerdict {outcome, reason_code}` is at `src/scout/lifecycle/arbiter.ts`
  L22-25, and the arbiter takes it verbatim at L81-86.
- The settle hook still passes `reconciliation: null`
  (`src/scout/lifecycle/lifecycle.service.ts` L324).
- The four native buckets of `families[]` are hard-coded `null`, meaning "not yet known" and never
  0 (S7L-DOC L207-212; `lifecycle.service.ts` L557-562).

S8-DOC fixes what S9 must apply:

- the family-complete rule (S8-DOC L152-157);
- the native-kind-only counting rule (L146-149);
- the conflict outcomes (L210-221);
- the closed unresolved catalogue, which "the S9 reason-code catalogue (CQ-17) adopts" (L280-310);
- relationship closure (L316-319);
- the 10,000-row ceiling as "a truthful `partial` or `blocked` (S9)" (L472-473).

This document fixes that verdict, the report that justifies it and the codes both need.

## 2. Decisions

### D-S9-1: S9 computes; it never writes, fences or adds a route

- S9 is two parts. `reconcile(facts)` is a pure function with no I/O, no clock and no exceptions,
  like the arbiter (`arbiter.ts` L4-6). A facts service collects its input.
- S9 never writes `terminal_status`, `completed_at`, `reason_code`, ledger, provenance or native
  rows. The one terminal write stays the S7-L CAS (S7L-DOC L61-63, L139-142; invariant 1 at L180).
- At settle, S9 runs inside the transaction S8-G already holds under the run row lock, after
  reconstruct and before `arbitrate`. Its facts are therefore consistent with the CAS epoch.
- Precedence is unchanged. A fence (step 1) or claim `failed` with zero staged rows (step 2) wins
  over any S9 verdict (S7L-DOC L67-69).
- S9 is invoked only for `mode='server'` runs. Legacy runs never reach it and stay byte-identical
  (S7L-DOC L228-230).
- The report is recomputed on read by the same function (D-S9-5). There is no new route, and the
  reader gate `terminal_status IS NOT NULL` is unchanged (S7L-DOC L190).
- **Outcome set:** S9 emits only `complete` or `partial`. Other outcomes come from other owners:
  `blocked` only from the `revoked` fence (S7L-DOC L68; D-S9-6), `cancelled` and `timed_out` only
  from fences, and `failed` only from arbiter step 2.

### D-S9-2: the verdict predicate (family-complete, identity-set based)

**Grouping.** Each staged row is grouped to a canonical family through the accepted
`resolveStagedFamily` (`src/scout/reconstruct/source-mapper-registry.ts` L101-109;
`resolveStep` at `src/scout/reconstruct/mapping-spec.ts` L249-255).

- A row whose resolution fails forms an **unmapped entry** keyed by its staged token. The failure
  reason is `unresolved_family:<token>` or `unsupported_platform:<p>`.
- S7-L's `unmapped_families` (`lifecycle.service.ts` L392) is left untouched. S9 does not reuse it,
  because it groups by raw token, not by canonical family.

**Joins.** Staging and ledger are joined on the wide identity `(coach_id, intent_id, entity_type,
source_platform, source_id)` (`prisma/schema.prisma` L6996). Provenance is joined on the D-S8-3 key
(S8-DOC L93-98):

- `source_namespace = source_platform` until G3 (S8-DOC L96-98);
- `entity_type` = the resolved canonical family;
- the same `source_id`.

These are identity joins, never count comparisons (PLAN L321).

**Per-identity classification.** Every staged identity lands in exactly one bucket. The first match
wins. Each bucket also records a histogram key (D-S9-7).

| #   | Fact                                                                                                                                                      | Bucket                    | Histogram key                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a   | Unmapped entry with no ledger row                                                                                                                         | `unresolved` / `rejected` | The resolution reason: `unresolved_family:<token>` is unresolved, `unsupported_platform:<p>` is rejected                                                                                                                                                                                                                                   |
| b   | Mapped family with no ledger row for this intent                                                                                                          | `unresolved`              | `unresolved:pass_ceiling_exceeded` when the facts mark the family over `RECONSTRUCT_MAX_ROWS` (`scout-reconstruct.dto.ts` L98-107), else `unresolved:not_reconstructed`                                                                                                                                                                    |
| c   | Ledger `failed`                                                                                                                                           | `failed`                  | `failed` (the ledger reason text is never echoed)                                                                                                                                                                                                                                                                                          |
| d   | Ledger `skipped` with a rejection reason (`unsupported_platform:<p>`, `missing_source_id`; S8-DOC L288-289)                                               | `rejected`                | The reason, verbatim                                                                                                                                                                                                                                                                                                                       |
| e   | Any other ledger `skipped` (§3.7 unresolved reasons, S8-DOC L282-305)                                                                                     | `unresolved`              | The reason, verbatim if it parses in the closed catalogue, else `unresolved:reason_unrecognised`                                                                                                                                                                                                                                           |
| f   | Ledger `reconstructed` with `target_kind` NULL or `scout_entity` (evidence; S8-DOC L146-149)                                                              | `unresolved`              | Keyed per row (S8-DOC L148-149): `unresolved:no_native_client_principal` when the family is client-owned under the D-S8-2 interim (S8-DOC L72-74), the row carries a resolved client link (S8-DOC L320-323, read through the S8-A interpreter) or its ledger or provenance reason already names that code; else `unresolved:evidence_only` |
| g   | Ledger `reconstructed` with a native kind but no provenance row                                                                                           | `unresolved`              | `unresolved:provenance_missing`                                                                                                                                                                                                                                                                                                            |
| h   | Provenance `native_kind`/`native_id` differ from ledger `target_kind`/`target_id`, or the native row belongs to another coach or kind                     | `unresolved`              | `unresolved:identity_conflict` (S8-DOC L216)                                                                                                                                                                                                                                                                                               |
| i   | The native row is missing or archived (`archived_at` where the model has one)                                                                             | `unresolved`              | `unresolved:native_target_removed` (S8-DOC L215; C4)                                                                                                                                                                                                                                                                                       |
| j   | Ledger `reconstructed` with a native kind, provenance `created` or `already_present` with `native_id`, and the native row present, owned and not archived | `native_present_verified` | none                                                                                                                                                                                                                                                                                                                                       |
| k   | Catch-all: an identity that matches none of a-j (for example an unknown ledger `status`)                                                                  | `unresolved`              | `unresolved:reason_unrecognised`. The partition stays total without relying on database CHECKs                                                                                                                                                                                                                                             |

**Other facts collected:**

- `ledger_without_staged` (run-wide): ledger rows for this intent with no staged identity. This is
  a contradiction. It is counted at run level, whether or not the row's token or platform
  resolves, and it is also attributed to a family entry where one resolves. It is outside the
  staged partition.
- `unresolved_children`: child provenance rows with outcome `unresolved` under any bucket-j parent
  (S8-DOC L150-151, L166-170, L194-197, L435-438). They are counted per reason in `child_reasons`.
  Children are never ledger rows and never enter the staged partition.
- `relationship_unverified`: bucket-j identities whose declared closure edge fails (see below).

**Partition invariant.** For every entry,
`staged_unique = native_present_verified + rejected + unresolved + failed`. Buckets a-k are
total.

**Relationship closure edges (v1).** Parents are always read through provenance on the D-S8-3 key,
never by name, email or label (S8-DOC L316-317). A parent role is read through the accepted S8-A
interpreter.

- **E-R1:** a program-day plan's `WorkoutPlan.program_id` equals the verified native id of its
  parent `programs` identity. Its `(week_index, day_index)` equals the interpreter's derivation from
  the same staged row (S8-DOC L352-354).
- **E-R2:** a created child exercise's `workout_plan_id` equals its parent plan's native id. When
  the child `source_id` uses the `#ord:<n>` form (S8-DOC L174-181), its `order` equals `n`.
- **E-R3:** a `client_source_id` soft link on a counted identity resolves to a bucket-j `clients`
  identity (S8-DOC L318-319). Under the classification rule (S8-DOC L320-323), client-linked rows
  land in bucket f first. E-R3 is therefore reached only by a future client-owned writer.

A family with no declared edge reports `relationship_closure: 'not_applicable'`.

**Run-level conditions.** Each condition below is evaluated. `conditions` lists every one that
holds, in this order. `reason_code` is the first. `complete` holds only when the list is empty.

1. **C-FAM:** any unmapped entry, or any mapped family with no native destination
   (`unresolved:no_native_destination:<family>`, S8-DOC L292) → `partial` / `unresolved_family`
   (existing code; PLAN L307).
2. **C-ID:** in any mapped family, `unresolved + rejected + failed > 0` or
   `unresolved_children > 0`, or the run-wide `ledger_without_staged > 0` → `partial` /
   `unresolved_identities`. This is the S8-DOC L152-155 family-complete rule: every staged
   identity is `created` or `already_present`, and no child under any parent is `unresolved`.
3. **C-REL:** any `relationship_unverified > 0` → `partial` / `relationship_unverified`.
4. **C-COV:** → `partial` / `coverage_basis_unknown` (D-S9-3) when any of these holds:
   - `required_families` (defined below) is empty or cannot be determined;
   - any required family lacks `coverageKnown` (D-S9-3);
   - the stored claim is not `success`.

**Required families.** `required_families` is the union of three sets:

- the canonical families of the staged entries;
- the families named in the coverage map;
- every canonical family that the mapping spec of each staged `source_platform` declares (its
  `families` keys; `mapping-spec.ts` L249-255 resolves against the same spec).

The set cannot be determined in either of two cases:

- no staged row names a platform (zero staged rows);
- any staged `source_platform` has no registered spec, because that platform's declared families
  are unknown. C-FAM also fires in this case. A declared family that has no staged row gets a
  report entry with `staged_unique: 0`. It still needs `coverageKnown` before the run can be
  `complete`. The family set therefore never depends only on what the coverage evaluator chooses to
  list.

The order runs from structural to per-identity to relational to coverage. The first code is the
most actionable. The report carries all of them.

An empty run (zero staged identities) has an undeterminable `required_families`, so it meets
C-COV, whatever the coverage map says (`null`, `{}` or non-empty). It is `partial` /
`coverage_basis_unknown` and never vacuously `complete` (R18, R18b).

### D-S9-3 (F1): `complete` requires a recorded per-family completeness basis

- `complete` requires a per-family completeness basis that the facts record. "Every page we
  happened to visit succeeded" is not one (PLAN L321).
- `observed_unique` stays `null` until an observation contract exists (S7L-DOC L211-212, L268).
  Until S10 supplies one, no run reaches `complete` on native reconciliation alone. A
  native-clean run ends `partial` / `coverage_basis_unknown`.
- **Shape that lets S10 add the basis without a core change.** The facts carry
  `coverage: Readonly<Record<CanonicalFamily, CoverageFact>> | null`, where:

  ```ts
  type CoverageFact =
    | { readonly known: false }
    | {
        readonly known: true;
        readonly observed_unique: number;
        readonly covers_staged_identities: boolean;
      };
  ```

- `coverageKnown(f)` holds when all of these are true: `coverage !== null`, `coverage[f]` is
  present with `known: true`, and `covers_staged_identities` (an identity-set statement that S10
  establishes, not a count).
- `complete` additionally needs these conditions:
  - `required_families` (D-S9-2) is non-empty and determinable;
  - `coverageKnown(f)` holds for **every** `f` in it;
  - the stored claim is `success`.

  A family missing from the map counts as not known. S9-A's `coverage.ts` implements
  `required_families` and `coverageKnown` exactly as defined here.

- The manifest field `completeness_basis` is drawn from a closed enum, `COMPLETENESS_BASIS_KINDS`,
  which is `['none']` in v1. `none` ⇔ `known: false`.
- S10 adds its evaluator, its basis kinds (append-only) and any additive fields on the `known: true`
  branch. The predicate reads only `required_families`, `known`, `covers_staged_identities` and the
  claim.
- In v1, S9-B always passes `coverage: null`. The `known: true` branch is reachable only in the pure
  S9-A spec (R01a).
- A non-success or absent claim is a signal against coverage, never a basis for it. An
  extension-side "alternative basis" is an observation-contract question and belongs to S10.

### D-S9-4 (F2): the verified union only; the per-run split is `null`

Provenance is keyed without intent (`schema.prisma` L7023). `import_intent_id` is nullable
(L7012; S8-DOC L161-162, L481-482), and the S8-C writer leaves it NULL until a later attribution
slice. So S9 cannot say which run
created a row. A replay would otherwise count an earlier intent's rows as `created_native`
(PLAN L248: "'Sent' is not 'stored'").

- Until a post-landing N3-FILL slice writes provenance intent attribution, the report carries
  **only** `native_present_verified` (buckets j of both outcomes).
- `created_native` and `already_present_verified` are `null`, meaning "not yet known". They are
  never 0 and never estimated (S7L-DOC L210-211).
- Adding the split later is additive. The union stays, and it must equal the sum of the split.

### D-S9-5: report v1 is recomputed on read; no table

**Report shape.** `reconcile` returns `{verdict, report}`. The report is deterministic (identical
facts give an identical report) and carries no clock:

```ts
interface ReconciliationReportV1 {
  report_version: 1;
  basis: 'recomputed';
  conditions: S9ReasonCode[]; // D-S9-2 order; [] iff verdict complete
  families: ReconciliationFamilyV1[]; // sorted by (mapped desc, family)
}
interface ReconciliationFamilyV1 {
  family: string; // canonical family; the staged token for an unmapped entry
  mapped: boolean;
  tokens: {
    token: string;
    staged_unique: number;
    native_present_verified: number;
    rejected: number;
    unresolved: number;
    failed: number;
  }[]; // sorted by token
  staged_unique: number;
  native_present_verified: number; // D-S9-4 union
  created_native: null; // D-S9-4
  already_present_verified: null; // D-S9-4
  rejected: number;
  unresolved: number;
  failed: number;
  ledger_without_staged: number;
  unresolved_children: number;
  relationship_closure: 'verified' | 'unverified' | 'not_applicable';
  relationship_unverified: number;
  reasons: { code: string; count: number }[]; // D-S9-7 keys, sorted by code
  child_reasons: { code: string; count: number }[]; // S8-DOC §3.7 child codes
  qualifiers: 'roster_bridge_pending'[]; // `clients` until S8-D (S8-DOC L372-374)
  // CQ-13 coverage-manifest fields
  completeness_basis: CompletenessBasisKind; // 'none' in v1 (D-S9-3)
  observed_unique: null; // S10
  pagination_terminal_evidence: null; // S10
  date_window: null; // S10
  media_policy: null; // not in v1 scope
}
```

The report is also the coverage manifest v1 (CQ-13): the per-family entry carries both the counts
and the coverage fields. Inside the report, a number is always a counted fact. `null` appears only
where the basis is absent (R12).

**Projection (S9-C).** The `families[]` entries of `GET /api/scout/import/status` stay one per
staged token, as S7-L defines them (S7L-DOC L207-210). No consumer-frozen semantics move.

- **When a report applies.** A report applies only to a `mode='server'` run with a non-null
  `terminal_status` whose `reason_code` is not `reconciliation_not_performed`. No report applies to
  legacy rows, open server runs, or pre-S9 terminals (the arbiter's step-4 default).
- **When no report applies:** the entry is exactly the S7-L shape. Every native bucket stays
  `null`, and **none of the additive fields is present** (R13, R15).
- **When a report applies:** the entry is filled from the report's token row and its family:
  - `rejected` and `unresolved` are filled;
  - `created_native` and `already_present_verified` stay `null`;
  - `observed_unique` stays `null`.
- **Fenced terminals** (`cancelled`, `timed_out`, `blocked`) and step-2 `failed` get the same
  report, as an account of what was kept. The terminal and its `reason_code` still come from the
  arbiter, and the report's own `conditions` never replace them.
- **Additive fields (option (i) of review R-B1):**
  - The fields are `canonical_family: string|null` (`null` when unmapped),
    `native_present_verified: int`, `completeness_basis`, `relationship_closure`,
    `reasons: {code, count}[]` and `qualifiers: string[]`.
  - They are **optional** DTO properties (`required: false`) on `ScoutImportFamilyDto`.
  - They are omitted entirely, never set to `null` or `[]`, whenever no report applies.
  - `projectFamilies` takes the report as an optional third parameter. Called with two arguments,
    it returns today's objects unchanged.
  - The accepted `toEqual` assertions therefore stay untouched and passing:
    - `src/scout/scout.service.spec.ts` L766-787 (legacy row);
    - `test/scout/lifecycle/lifecycle.service.spec.ts` L464-492 (two-argument
      `projectFamilies`).

    This keeps S7L-DOC L229-230.

  - The fields reach the OpenAPI artifact only through the generator owner, and they do not change
    the `families[]` key or any existing field.
- **E2 body bound.** The E2 consumer freeze accepts a status 200 only within 64 KiB
  (`execution/daceddc8/e2/CONSUMER_FREEZE.md` L78). The additive `reasons[]`, `qualifiers[]` and
  128-character token keys grow the body. A realistic run is a few KB, but a worst case of 32
  families with full histograms approaches the bound. The S9-C R15 fixture asserts that the body
  stays within 64 KiB for 32 families.

**Why no table (justification the parent required).** No v1 acceptance case needs persistence:

1. `complete` is unreachable in v1 (D-S9-3). A recomputed report therefore cannot contradict a
   stored `complete`. The settle-time verdict itself is persisted in
   `terminal_status`/`reason_code` and never moves (S7L-DOC L180).
2. A recomputed report can differ from the settle-time account only when the native domain changes
   later. Examples are a coach archiving a row (bucket i) and a later intent creating a row for an
   identity this run left unresolved. The report then shows the current verified state of this
   run's identities, labelled `basis: 'recomputed'`. The terminal is never `complete` in v1, so
   nothing is overstated.
3. R10 (determinism) and R15 (projection equality) hold for a recomputed report.
4. A table would add a migration, RLS, a refusing down, and run-record retention and erasure
   semantics. Retention and erasure are L8 and owner-reserved (S7L-DOC L257-263). None of that is
   justified by a v1 case.

**Re-decision trigger.** Persistence is re-decided when S10 makes `complete` reachable, because a
later coach deletion could then make a recomputed report contradict a stored `complete`. The table
would be an additive expand at that time. It is not granted here.

### D-S9-6: the ceiling case ends `partial`; `blocked` stays reserved for `revoked`

- The 10,000-row per-pass ceiling fails closed before any ledger row is written
  (`scout-reconstruct.dto.ts` L98-107). The staged rows it leaves are bucket b with
  `unresolved:pass_ceiling_exceeded`.
- The run ends `partial` / `unresolved_identities` (S8-DOC L472-473). No 409 reaches the terminal.
- `blocked` is emitted only by the `revoked` fence (S7L-DOC L68, L108-109; `arbiter.ts` L54-59).
  S9 never emits it.

### D-S9-7: reason codes (additive, low-cardinality, PII-free)

**Run level.** These are appended to `RUN_REASON_CODES` (`src/scout/lifecycle/reason-codes.ts`
L46-53) by S9-C, in this order. The existing six keep their order and meaning (S7L-DOC L107-109).

| Code                      | Condition | Meaning                                                                                                                                            |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unresolved_identities`   | C-ID      | A staged identity in a mapped family is not natively present and verified, or a child is unresolved                                                |
| `relationship_unverified` | C-REL     | A required parent link, soft link or child order failed closure                                                                                    |
| `coverage_basis_unknown`  | C-COV     | A family lacks a recorded completeness basis, or the stored claim is not `success`; as the run's `reason_code` it means no earlier condition holds |

- `unresolved_family` (C-FAM) is reused unchanged.
- `reconciliation_not_performed` stays the arbiter default when no verdict is passed (S7L-DOC
  L71-72).
- S9-A defines `S9_REASON_CODES = ['unresolved_family', 'unresolved_identities',
'relationship_unverified', 'coverage_basis_unknown']` in its own `types.ts`. S9-C proves
  `S9ReasonCode ⊆ RunReasonCode` at compile time when it appends the three codes, so S9-A never
  edits `lifecycle/**`.
- The column is opaque TEXT
  (`prisma/migrations/20270123000000_scout_run_lifecycle_expand/migration.sql` L126-128), so no
  schema change is needed.
- The projection narrows unknown codes to `null` (`lifecycle.service.ts` L574-575). The additions
  must therefore land in the same change as the wiring.

**Report level (histogram keys).** The catalogue is the S8-DOC §3.7 list (L286-305), adopted as-is
(S8-DOC L310), plus these S9 additions:

- `unresolved:not_reconstructed`
- `unresolved:pass_ceiling_exceeded`
- `unresolved:provenance_missing`
- `unresolved:evidence_only`
- `unresolved:reason_unrecognised`
- `failed`

**Key rules:**

- Qualifiers are limited to the tokens the catalogue already admits: family, field, model, staged
  token and the canonical `source_platform`.
- A ledger reason outside the grammar is counted as `unresolved:reason_unrecognised` and never
  echoed.
- `failed` rows never echo their ledger reason text.
- No key, qualifier or count carries a name, email, label, payload or free text (S8-DOC L309;
  CQ-17).
- The coach-facing copy for every code belongs to the copy owner (UX-05), not S9.

### D-S9-8: seam and exact writable paths (one writer each)

| Slice | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                       | Writable paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Not owned                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| S9-0  | This document                                                                                                                                                                                                                                                                                                                                                                                                                               | `docs/decisions/2026-09-25-s9-reconciliation.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Any code                                                                                                                      |
| S9-A  | The pure `reconcile(facts) → {verdict, report}`, its types, `CoverageFact`/`coverageKnown` and a table-driven spec. It imports only types from `lifecycle/{arbiter,reason-codes}` and `reconstruct/mapping-spec`                                                                                                                                                                                                                            | `src/scout/reconciliation/{types.ts,reconcile.ts,coverage.ts}`, `test/scout/reconciliation/reconcile.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `lifecycle/**`, `reconstruct/**`, readers, DTOs                                                                               |
| S9-B  | `ReconciliationFactsService.collect(db, coachId, intentId)`, run on the caller's transaction or client. It groups through `resolveStagedFamily`, sets the per-family ceiling fact from `RECONSTRUCT_MAX_ROWS`, supplies the per-platform spec-declared families (`null` for an unregistered platform) for `required_families`, and uses O(families + native kinds) aggregate queries with none per row. Real-PG proof harness. No migration | `src/scout/reconciliation/{facts.service.ts,reconciliation.module.ts}`, `test/scout/reconciliation/facts.service.spec.ts`, `test/scout/g2-s9-db-guard.spec.ts`, `test/utils/g2-s9-{bootstrap.sh,db.ts,harness.ts,pg-harness.ts,worker.cjs}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `prisma/**` (no table, D-S9-5), `families.ts`, `native/**`, `scout-reconstruct.*`, `scout-entities.*`, `scout-roster.*`       |
| S9-C  | Wiring after S8-C and S8-G land: pass the verdict in the settle hook, fill the projection, append the codes, register the provider and add the additive DTO fields                                                                                                                                                                                                                                                                          | `src/scout/lifecycle/lifecycle.service.ts` (the `reconciliation:` argument at the settle `arbitrate` call; `projectFamilies` optional third parameter and `FamilyProjection` optional fields; the reconciliation import; an `@Optional()` facts-service constructor parameter after `prisma, analytics` at L114-119, so `new ScoutLifecycleService(prisma, analytics)` at `scout.service.ts` L96, `scout-ingest.service.ts` L50, `lifecycle.service.spec.ts` L67 and `g2-s7l-worker.cjs` L112 keep working; one report-read method for the status path), `src/scout/lifecycle/reason-codes.ts` (three appended entries), `src/scout/scout.module.ts` (provider/import only), `src/scout/scout.service.ts` (status-read `families` composition only: the report read beside L455 and its argument at L497), `src/scout/scout.dto.ts` (`ScoutImportFamilyDto` optional additive properties only, L219-262), and added cases only in `test/scout/lifecycle/{arbiter,lifecycle.service}.spec.ts` and `src/scout/scout.service.spec.ts` | `run.controller.ts`, `reconstruct/orchestration/**`, `scout-reconstruct.service.ts`, every other hunk of the files it touches |
| Gen   | Regenerate for the three enum values and the additive `families[]` fields, after the S7-L, S8-C and S8-F regenerations                                                                                                                                                                                                                                                                                                                      | `scripts/importer-contract.ts`, `docs/contracts/importer-openapi.json`, `test/contracts/importer-contract.spec.ts` (**generator owner only**; S7L-DOC L246-249, S8-DOC L483-485)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | S9 builders                                                                                                                   |

**Paths added or dropped relative to the readiness plan.** The narrow `scout.service.ts` and
`scout.dto.ts` hunks are added because the status read and its DTO live there (`scout.service.ts`
L497; `scout.dto.ts` L219-262). Each is the minimum for the additive projection. The migration,
`schema.prisma` and new-table RLS paths are dropped (D-S9-5).

**Disjointness and sequencing.**

- S9-A and S9-B are disjoint from S8-F (`scout-entities.*`, `scout-roster.*`) and from S8-G
  (`reconstruct/orchestration/**`, `scout-reconstruct.service.ts`).
- S9-C touches the hook body's one argument only after S8-G has landed. The ownership is
  sequential, not concurrent.
- S9-A freezes to this text once it lands. S9-B and S9-C are granted separately.

## 3. Acceptance cases (fixed; real services; one new PG proof for S9-B/S9-C)

**Proof tiers.** "A" is the pure S9-A spec. "B" is the S9-B real-PG proof. "C" is the S9-C composed
hook plus projection, in one PG proof. No accepted suite is rerun.

- **R01 (A):** a native-clean run. Every staged identity is bucket j, there are no unresolved
  children and closure is verified.
  - (a) Coverage `known` with `covers_staged_identities` for every required family (staged and
    spec-declared) and claim `success` → `complete` with `reason_code` null.
  - (b) `coverage: null` → `partial/coverage_basis_unknown`, never `complete`.
  - (c) As (a) but claim `partial` → `partial/coverage_basis_unknown`.
  - (d) As (a), with every staged family covered, but a family the platform's spec declares is
    missing from the coverage map → `partial/coverage_basis_unknown`.
- **R02 (A, B):** an identity is staged but has no ledger row for this intent (C18(b) shape) →
  bucket b `unresolved:not_reconstructed`, `partial/unresolved_identities`.
- **R02b (A, B):** a ledger `skipped` row with `missing_source_id` → bucket d `rejected`,
  `partial/unresolved_identities`.
- **R03 (A, B):** staged `notes` (unmapped) → unmapped entry, `partial/unresolved_family`,
  `unresolved` = staged count, histogram `unresolved_family:notes`, projection
  `canonical_family: null` and `created_native: null`.
- **R03b (A, B):** a staged row on an unregistered platform → bucket a `rejected` with
  `unsupported_platform:<p>`, `partial/unresolved_family`.
- **R04 (A, B):** the ledger says `reconstructed`, but the native row is archived or deleted, or
  another coach owns it → bucket i or h, never counted native, `partial/unresolved_identities`.
- **R05 (A, B):** equal staged and ledger counts with different identity sets → a nonzero
  `ledger_without_staged` and bucket b, `partial/unresolved_identities`. Count equality never
  implies reconciliation.
- **R06 (A, B):**
  - an E-R1 program mismatch or `(week_index, day_index)` mismatch → `relationship_unverified`;
  - an E-R2 `#ord:` order mismatch → `relationship_unverified`;
  - a bucket-f client-linked workout stays `unresolved_identities`, the earlier condition.
- **R07 (A, B):** evidence rows (`target_kind` NULL or `scout_entity`) and
  `unresolved:no_native_client_principal` never count toward `native_present_verified`. A run that
  stages a client-owned family is at most `partial`, the D-S8-2 interim.
- **R08 (A, B):** the ceiling leaves rows staged → `unresolved:pass_ceiling_exceeded`,
  `partial/unresolved_identities`. No 409 reaches the terminal, and `blocked` is never emitted.
- **R09 (C):** precedence is preserved.
  - With a fence present, the S9 verdict is ignored.
  - Claim `failed` with zero staged rows → `failed/transfer_failed`.
  - S9 writes nothing, there is exactly one terminal write, and a CAS miss is a no-op.
- **R10 (A, C):** identical facts give an identical verdict and report. A replayed intent that
  converged `already_present` gives the same report, with `created_native` and
  `already_present_verified` `null` (D-S9-4).
- **R11 (B):** coach B's staging, ledger, provenance and native rows never enter coach A's facts.
  No new table exists, so there is no new RLS surface.
- **R12 (A):** unknown is never 0. `null` appears only for D-S9-3 and D-S9-4 fields. A `0` is always
  a counted fact, for example a family with coverage but zero staged rows. The partition invariant
  holds for every entry.
- **R13 (C):** legacy runs never invoke S9. The legacy `families[]` entries carry none of the
  additive fields. The accepted `toEqual` assertions stay untouched and passing, as does every
  other existing case in `scout.service.spec.ts` and `lifecycle.service.spec.ts`:
  - `scout.service.spec.ts` L766-787;
  - `lifecycle.service.spec.ts` L464-492.

  Legacy `/complete` stays byte-identical.

- **R14 (A):** every emitted `reason_code` is in the closed enum, and `conditions` follows the
  D-S9-2 order. Every histogram key is in the D-S9-7 catalogue. An unrecognised ledger reason gives
  `unresolved:reason_unrecognised`, and a `failed` row never echoes text. No name, email, label or
  payload appears.
- **R15 (C):** where no report applies (legacy rows, open runs, `reconciliation_not_performed`
  terminals), the native buckets stay `null` and the additive fields are absent. Where a report
  applies, they equal the recomputed report for the same facts. `observed_unique` stays `null`. A
  32-family fixture keeps the status body within 64 KiB (E2 bound).
- **R16 (B):** the reconciliation read set is O(families + native kinds) queries, with no per-row
  query (statement capture). On the proof lane, a synthetic 10k-row intent reconciles within
  10 000 ms of wall time. That is one thirtieth of `SCOUT_RUN_DEADLINE_MS_DEFAULT` = 300 000 ms
  (`lifecycle.service.ts` L29), leaving the rest of the window to the S8-G pass (PLAN L323).
- **R17 (A):** several conditions hold at once → `reason_code` is the first by D-S9-2 order, and
  `conditions` lists them all.
- **R18 (A):** an empty run (zero staged rows, claim `success`, `coverage: null`) →
  `partial/coverage_basis_unknown`, never `complete`.
- **R18b (A):** zero staged rows, `coverage = {}` (non-null, empty) and claim `success` →
  `partial/coverage_basis_unknown`. `required_families` cannot be determined, so the empty set
  never satisfies the predicate vacuously.
- **R19 (A, B):** children. An `already_present` plan with a persisted unresolved exercise → a
  nonzero `unresolved_children`, `child_reasons` of `unresolved:exercise_reference`, and
  `partial/unresolved_identities` (S8-DOC L194-197, L435-438).

## 4. Owner-reserved and deferred items (unchanged; S9 needs none of them)

**Owner-reserved:**

- the D-S8-2 end state, option (a) (S8-DOC L84-89). Until it is decided, client-owned families stay
  bucket f, and any run that stages them cannot reach `complete`. S9 reports this and does not
  resolve it.
- G3-AUTH workspace attribution. The E30 cross-workspace merge (S8-DOC L99-101) stays a recorded
  limitation that S9 cannot detect.
- L8 retention and erasure of run records, including any future persisted report (S7L-DOC L257-263).
- production deployment and enablement, flags, any `main` merge and external commitments (S7L-DOC
  L284-286).

**Deferred (not owner-reserved; later slices):**

- the S10 observation contract and basis kinds (D-S9-3);
- N3-FILL provenance intent attribution for the split (D-S9-4);
- the report-persistence re-decision at S10 (D-S9-5);
- source value-drift fingerprints, a later increment S9-D (S8-DOC L206-208);
- surfacing the `prescription:time` and `defaulted:<field>` provenance tags (S8-DOC L307-308, L338);
- late child resolution, which stays `unresolved` (S8-DOC L198-201);
- the `readDrainState` over-count, which is a CLI/runbook note, not S9 code.

## 5. Release boundary

This document binds S9-A/B/C as a local contract only. Passing R01-R19 (with R01d, R02b, R03b and
R18b) would prove local candidate behaviour only. S9-B and S9-C writers, the PG slot and review
grants are separate parent decisions.
Deployment, customer acceptance and any `main` merge or flag change remain owner-reserved (S7L-DOC
L284-286).

## Addendum A (S9-B, 2026-09-25): review closures and facts-collection rules

Recorded by the S9-B lane (EXEC-1910A060) against the landed text at `1c5fbb04`. Nothing above
this heading changes; each item names the line it amends. Sources: `S9_0_REVIEW.md` §8 RC-1..RC-3
and §6 C-5..C-10 (deferred to "the doc's next opening"); `S9_A_SOURCE_READY.md` deviations 2, 3
and 5; `S9_A_REVIEW_A.md` B-2.

### A.1 S9-0 review closures

- **RC-1 (D-S9-7 meaning of `coverage_basis_unknown`).** The meaning cell also covers the two
  D-S9-2 triggers where `required_families` is `null` (undeterminable: zero staged rows, or a
  staged platform without a registered spec) or empty. D-S9-2 stays the binding definition.
- **RC-2 (D-S9-5 "pre-S9 terminals").** "Pre-S9 terminals" excludes only
  `reason_code = reconciliation_not_performed`. A `mode='server'` run fenced before S9-C landed
  (`cancelled`, `timed_out`) therefore receives a recomputed report on read. That is a truthful
  account under an unchanged terminal; it is stated here so nobody reads it as a gap.
- **RC-3 (D-S9-2 declared families).** Own paragraph, moved out of the "cannot be determined"
  bullet: _A declared family with no staged row gets a report entry with `staged_unique: 0`
  (`mapped: true`, no tokens). It still needs a known basis before `complete`. Such report-only
  entries never create a `families[]` projection entry, because there is no staged token for
  them._
- **C-5 (E-R2 notation, L140).** Read `#ord:<ordinal>`: the child's `order` equals the ordinal
  (the 0-based source position, S8-DOC L178), not the length prefix `n` of S8-DOC L176-178. When
  source ordinals are not positions this yields a false `unverified` (safe direction). For the
  `#id:<identifier>` form only existence and `workout_plan_id` are compared.
- **C-6 (qualifier domains).** `unresolved_family:<token>` carries the staged token, which ingest
  accepts as any 1-128 character string; the token already projects as `families[].family`
  under the accepted S7-L contract, so no new exposure exists, but R14's PII guarantee does not
  extend to tokens. The accepted S9-A parser recognises reason codes by their catalogue prefix
  and does not validate qualifier domains; validating the qualifier against the spec's family,
  field and model names before anything reaches a DTO is an S9-C obligation, recorded here, not
  a property of the landed reconciler.
- **C-7, second half (`qualifiers` enum).** `qualifiers[]` is a closed OpenAPI enum
  (`roster_bridge_pending` only in v1; append-only), never `string[]`. The 32-family R15 fixture
  and the CONSUMER_FREEZE L78 note stand as recorded in §3.
- **C-9 (recompute-on-read).** The S9-B facts service opens no transaction and issues only
  reads; the caller supplies one `Prisma.TransactionClient` and is responsible for running it
  at `REPEATABLE READ` so classification sees one snapshot across staging, ledger, provenance
  and native tables. On the settle path that transaction is S8-G's (which also writes the
  terminal); on the status path S9-C opens one for the read. S9-C adds a spec that asserts
  S9-A's copy of the §3.7 catalogue equals S8-C's runtime `UNRESOLVED_CODE`.
- **C-10 (wording).** `relationship_closure: 'not_applicable'` means "no bucket-j identity of the
  family carries a declared edge" (see A.2 deviation 5), never "not checked". R12's "`null` only
  for D-S9-3/D-S9-4 fields" also lists `media_policy`, `pagination_terminal_evidence` and
  `date_window`. A token that resolves to different families across platforms in one intent
  projects one `families[]` entry whose counts are the sum over all of that token's rows;
  `canonical_family` is `null` unless every row resolves to the same family.

### A.2 S9-A deviations accepted into the text

- **Deviation 2 (D-S9-3).** `CoverageFact.known: true` carries `basis_kind: string` and
  `completeness_basis` is that string (`'none'` ⇔ `known: false`). `COMPLETENESS_BASIS_KINDS` is
  S10's append-only enum; v1 has only `none` because `coverage` is `null`.
- **Deviation 3 (D-S9-3).** `observed_unique: number | null` — a number whenever a `CoverageFact`
  carries one, `null` when there is no fact. v1 is always `null`.
- **Deviation 5 (D-S9-2 L145).** Edges from identities outside bucket j are ignored, never
  double-counted; `not_applicable` is emitted when no bucket-j identity of the family carries a
  declared edge.

### A.3 B-2: one edge per declared relationship (facts-collection rule)

For every staged identity whose canonical family declares E-R1, E-R2 or E-R3, S9-B emits exactly
one `RelationshipFacts` edge per declared relationship instance. When the parent cannot be
resolved through provenance or native rows, the edge is still emitted, with the parent's own
identity as `to_identity` (unresolvable to S9-A because it is not bucket j) and
`consistent: false`, so that it fails closure. Concretely:

- **E-R1** is declared iff the accepted S8-A/S8-C interpreter (read-only, `mode: 'native'`)
  derives a `programSourceId` for the staged `workouts` row; the edge targets the `programs`
  identity `(source_platform, programSourceId)` whether or not that identity was staged, and is
  `consistent` only when the run's own unarchived plan has `program_id` equal to the parent's
  verified native id and `(week_index, day_index)` equal to the interpreter's derivation.
- **E-R2** emits one edge per created or already-present child provenance row under a `workouts`
  parent (`from_identity = to_identity =` the parent), `consistent` iff the exercise row exists
  unarchived on the parent's plan and, for `#ord:<ordinal>`, `order` equals the ordinal.
- **E-R3** emits one edge per staged identity with an interpreted `clientSourceId` (families other
  than `clients`), `consistent: null`; S9-A closes it only against a bucket-j `clients` identity.

### A.4 S9-B facts rules the text left implicit

- **Grouping.** `resolveStagedFamily` first; a token equal to a canonical family the platform's
  spec declares maps to that family (S8-C `dispatch` precedent). Anything else is an unmapped
  entry keyed by the raw token. `resolution_reason` prefers `unresolved_family:<token>` over
  `unsupported_platform:<platform>` when both occur for the same token.
- **Ledger without staged (R05).** Counted run-wide over `(entity_type, source_platform,
source_id)`; attributed to the mapped entry the pair resolves to (creating a zero-identity mapped
  entry when necessary); never dropped when it resolves to nothing.
- **Native existence.** Looked up by id without a coach filter, then compared: missing or archived
  → `removed`; another coach → `foreign_owner`; provenance kind ≠ ledger kind → `kind_mismatch`;
  provenance id ≠ ledger target → `provenance_mismatch`. `Person` has no `archived_at`; a row
  that exists is present. No fabricated zero: an identity with no ledger row has `ledger: null`.
- **Coverage and split.** `coverage` is `null` in v1 (D-S9-3); the created/already-present split
  is unknown (D-S9-4); the report is never persisted (D-S9-5, no table).
- **Provenance read.** Coach-wide by `(coach_id, source_namespace ∈ staged platforms, entity_type
∈ mapped families ∪ {'workouts.exercise'})`; children attach to parents through the S8-DOC
  L174-181 length-prefixed `source_id`.
- **Claim.** `ScoutImportCompletion.terminal_status` filtered to `success | partial | failed`; any
  other value is `null`.
