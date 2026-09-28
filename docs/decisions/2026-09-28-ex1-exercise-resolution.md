# EX1: exercise-reference resolution (source exercise → TGP exercise)

- **Status:** T3 design record, r4 (closes re-review EX1-R3 findings at `a45d655`, §9). Not
  merged or accepted; changes no code; nothing below has run. Slices (§7) are T4.
- **Date:** 2026-09-28. **Owner:** Bradley Gleave. D-EX1-1..7 are stated defaults; §5 holds the
  owner forks. **Base:** backend `integration/importer` `d84cb7c`; mobile (`M:`) `3f91d58`.
- **Sources** (`docs/decisions/`): S8-DOC `2026-09-24-s8-native-contract.md`, S9-DOC `…-25-s9-…`,
  S8D-DOC `…-26-s8d-person-link.md`, L0-DOC `…-27-learn-and-remember.md` (PR #581 `a13ec1f`; its
  r3 gap channel D-L0-6.1 (vi) is in revision; checks here are `CX-*`).

## 1. Why this exists

- Owner D1 (2026-09-28): `complete` means "All past client and coaching records in this site are
  now in TGP". A workout without its exercises, or a coach's exercise library, is not in TGP.
- S8-DOC L427-430 left references `unresolved:exercise_reference`; S8-C links a child on catalog
  id **or** slug equality (`src/scout/reconstruct/native/native-writers.ts` L169-188); other ids
  stay unresolved and the plan is written without them (EX1-F6). No real-source run is evidenced.
- No coach-owned exercise model exists: only the global `ExerciseCatalogItem` (`prisma/schema.prisma`
  L4332-4336), the client-owned `ExerciseSet` (L879-891, `video_url` L890) and legacy
  `RoutineExercise` (L907-918). L0: NEW SOURCE → CORE CODE DIFF = 0; the AI proposes data only.

## 2. Findings at this base

| ID     | Class | Finding                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EX1-F1 | B     | **Implicit identity-space assumption.** Any reference equal to a catalog id or slug links (`native-writers.ts` L175-188). A source with slug-like ids (`bench-press`), or holding copied catalog uuids, links to a TGP exercise by string equality. Equality never proves shared identity. Conditional risk, not an observed incident.                                           |
| EX1-F2 | B     | **`exercise_external_id` is polymorphic** (`schema.prisma` L2302 "NOT a FK"): catalog id or slug (`src/exercise-catalog/exercise-catalog.service.ts` L120-132), `seed:` ids (`src/exercise-library/seed-catalog.ts` L9-11, L25), any 1-128 char builder string (`src/ai/gateway/materialisers/__shared/workout-diff.types.ts` L58-63). A new token needs its own read/auth path. |
| EX1-F3 | B     | **Renderers show the raw reference as the name** (`M:src/utils/workout/buildActiveWorkout.ts` L30-52; `M:src/screens/coach/CoachWorkoutBuilderScreen.tsx` L255-267, L843-850; `M:src/screens/client/WorkoutAssignmentDetailScreen.tsx` L132). A `cx:` token would render as an opaque name without slice EX1-C.                                                                  |
| EX1-F4 | C     | The native rule grammar has `exerciseRef` but no exercise-name role (`src/scout/reconstruct/native/native-rules.ts` L62-73).                                                                                                                                                                                                                                                     |
| EX1-F5 | C     | Closed CHECKs: provenance `native_kind` (five kinds) and ledger `target_kind` (`prisma/migrations/20270122000000_scout_native_provenance_expand/migration.sql` L138-146, L184-195), plus the typed kind sets and read maps in `src/scout/reconciliation/facts.service.ts` L450-503. All need an additive expand.                                                                 |
| EX1-F6 | B     | **Child failures do not withhold the plan.** The interpreter yields an unresolved child on a null reference or invalid field (`native-rules.ts` L458-576); the writer then creates the plan and a snapshot of only the written children (`native-writers.ts` L263-353).                                                                                                          |

## 3. Decisions (stated defaults)

### D-EX1-1: identity model

- A **source exercise identity** is `(platform, source_id)` on the D-S8-3 key `(coach_id,
source_namespace, entity_type, source_id)` (S8-DOC L93-98); `source_id` is a value read from a
  spec-declared path on a staged row, never a name or model output (L0-DOC D-L0-6).
- Identity is **per definition**; the per-use child identity stays S8-DOC §3.3. Only two things
  create a definition, and `entity_type` names the role, so equal strings of two roles never meet:

| Where the definition comes from                        | Definition key `entity_type` / `source_id`        | Target kind                    |
| ------------------------------------------------------ | ------------------------------------------------- | ------------------------------ |
| Library row (the one staged step → family `exercises`) | `exercises` / exactly that step's `idField` value | `coach_exercise`               |
| Id-less child, declared `exerciseIdentity: 'per_use'`  | `workouts.exercise_use` / the child's source id   | `coach_exercise` (one per use) |

- A workout-exercise **reference** never creates a definition: it links only through CX-REF
  (D-EX1-3), else its plan is withheld (D-EX1-7). **Every definition is a coach-owned custom
  exercise with provenance**; no catalog kind exists. A name is not identity (S8-DOC L217).
- **One mode per plan step (V-L3).** A plan step with an exercise-children path declares exactly
  one of `exerciseRef` + `refersTo`, or `exerciseIdentity: 'per_use'` (valid only if the child
  shape has no id-class key); both or neither refuses the rules. `per_use` gives each use its own
  definition and has no reference, so it never reaches CX-REF; it still passes D-EX1-7.

### D-EX1-2: resolution rule (deterministic; first match wins)

Per definition key, in the settle transaction of the run that first stages it (S8-DOC §3.4):

1. **Provenance hit** → verify the target (D-EX1-4); present → reuse; removed →
   `unresolved:native_target_removed` for every child that uses it (never recreated).
2. **Otherwise** → create one coach-owned `CoachExercise`, provenance kind `coach_exercise`;
   children write `exercise_external_id = 'cx:' + id` (`seed:` precedent; ≤ 128 chars); `name`
   from the new `exerciseName` role (EX1-F4) on the library row, or the child for `per_use`.
3. Nothing else: no catalog, name, fuzzy, embedding or model match. No two identities share a target.

`CoachExercise` (EX1-A): `id`, `coach_id` (FK `User`), `name`, optional `primary_muscle` /
`equipment` / `instructions` only when spec-declared, `archived_at`, `created_at`. RLS: owner coach
and service_role; a client reads a row only via an active assignment whose plan references its
`cx:` token; deny anon (S8D-DOC §3). No source value column; provenance is the only link back.

### D-EX1-3: no catalog link; a relation links only on membership AND corroboration (R-5)

- **No automatic catalog linking.** A source can never prove it shares TGP catalog identity (an
  equal uuid or slug may be copied or hostile). EX1-B deletes `verifiedCatalogRefs`; the importer
  never reads `ExerciseCatalogItem` or writes a catalog id/slug. Catalog linking is only EQ-1.
- **A declaration is a request to check, never evidence.** On `exerciseRef` the AI may propose
  `refersTo: { family: 'exercises', keyField, corroborateBy? }`; none → no link. V-L3: exactly one
  learned step maps to `exercises`; `keyField` is exactly its id-class `idField`; the two
  `corroborateBy` paths (`childField`, `libraryField`) are mapped non-id string paths, `childField`
  ≠ the reference path, `libraryField` ≠ `idField`. A mismatch refuses the rules.
- **CX-REF** (deterministic, this run's own staged rows only; no model, no catalog) holds only if
  **every** link satisfies **M and at least one of C1-C3**:
  - **M (membership):** the reference equals the `source_id` of exactly one library row staged in
    the same run, same `source_namespace`, from `keyField`. Membership alone never links.
  - **C1 (denormalized field):** the child's `childField` value is non-blank, byte-equals the
    matched row's `libraryField` value, and that value is unique among the run's staged library
    rows, so it singles out the same row without the key.
  - **C2 (fetched by reference):** the matched row was staged from a detail request whose id the
    crawl bound from this child's reference: the library step is a `forEach` over the plan step's
    reference path (L0-DOC link inventory, D-L0-2) and the ingest row carries additive
    `fetched_by: { step, parentSourceId }` (EX1-F; staged ids only). C2 never holds before EX1-F.
  - **C3 (high-entropy id space):** every library id and reference has ≥ 12 characters and, after
    removing the longest prefix and suffix common to all staged library ids, each library id's
    remainder has ≥ 8 characters and a non-digit. All-digit, small-integer, zero-padded or
    prefixed-sequential spaces (`1..n`, `ex_000001..`) never qualify; neither does one library row.
- **All-or-nothing per run.** One link failing M → cause `ref_unproven`; M holding everywhere but
  one link lacking C → `ref_uncorroborated`. Either way no reference in the run links, because
  the relation itself is in doubt; every plan that uses a reference is withheld (D-EX1-7).
- **Why this closes R-5.** Unrelated integer collections `1..n` pass M but fail C3 and C2, and
  fail C1 unless each child carries that row's unique name (then the child names that exercise).
- **CX-NAME:** every definition has a non-blank `exerciseName`, else the `exercises` rules are
  dropped for the run (L0-DOC C3, no partial-credit writes) and its plans are withheld.
- **Pre-pass.** CX-REF and CX-NAME run read-only before settle and return a result, never throw
  into it: a read error is cause `check_read_failed` for every staged plan, recorded in settle. An
  error inside settle rolls all back (existing failure path); nothing counts written; replay.
- The AI proposes these roles as data only (V-L3, V-L6), never an id or a value (L0-DOC D-L0-2);
  rules come from the learned registry (D-L0-5), not the `sources/*.json` loader.

### D-EX1-4: provenance, replay, create-only and side effects

- Kind `coach_exercise` joins provenance `native_kind` and ledger `target_kind` (EX1-F5). Target
  verification: row present, `coach_id` = coach, `archived_at` null (`facts.service.ts` L745-755);
  else `native_target_removed`. `exercises` reconstructs before `workouts` whatever the staging
  order; a unique-key race re-reads and converges (S8-DOC L202-203).
- **Create-only.** An existing `CoachExercise` is never updated, so coach renames survive (S8-DOC
  D-S8-4). Plans persisted before EX1 keep their children as written, including catalog-linked
  ones (R-2). Creating a `CoachExercise` notifies no one, calls no video or catalog path and uploads
  no media (S8-DOC §3.6); `ExerciseSet` (S8-E1a) copies `exercise_name` from the resolved target.

### D-EX1-5: reconciler (bucket j and closure)

- **Bucket j, the partition, condition order and `COMPLETENESS_BASIS_KINDS` are unchanged**
  (D-S9-2). Library identities classify a-k like any family (`coach_exercise` verified → j; removed
  → i; another coach's → h); the kind→model map gains `CoachExercise`; no rules → C-FAM.
- **Edge E-R4**, per created child of a bucket-j plan: re-derive the child's definition key from
  its staged row; that definition's provenance must exist, its target verify (D-EX1-4), and the
  child's `exercise_external_id` equal `cx:<id>` of **that** row (a token match alone is not
  closure). Failure → `relationship_unverified`. A withheld plan is not j; D-EX1-7 counts it.

### D-EX1-6: completeness under D1

A run is `complete` only if every in-scope item is natively present and verified, or its class is
excluded by a recorded owner decision; otherwise `partial` with the gap named (D-EX1-7).

| In scope (exercise records)              | Required for `complete`                                                                                   | If not met                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Library rows (used or unused)            | bucket j                                                                                                  | C-ID / C-FAM                                       |
| Plan exercise children                   | PG-PLAN passes; E-R4 holds; name, sets, reps/duration, weight, rest, superset, notes, order equal the map | withheld plan (D-EX1-7) / C-REL                    |
| Program-day revision snapshot            | revision 0 `exercises_json` equals the written children                                                   | C-REL                                              |
| Client exercise history (`ExerciseSet`)  | S8-E1a family natively present                                                                            | C-FAM until S8-E1a lands                           |
| Unbound fields under an exercise         | every non-id leaf bound to a column, to `notes`/`instructions`, or owner-excluded                         | coverage `known: false`, `exercise_fields_unbound` |
| **Exercise media** (demo videos, images) | never earned by the importer; only an owner exclusion (EQ-3) removes it from the promise                  | coverage `known: false`, media gap below           |

- **Media never contributes to `complete`** (a generic `url` class is not a media kind; a bounded
  digest cannot prove absence). Any run staging exercise records (incl. `ExerciseSet.video_url`):
  a `url`-class field or key token in `video|image|photo|thumbnail|gif|media` → gap
  `exercise_media_not_imported`; otherwise `exercise_media_unproven`. Only EQ-3 changes this
  (exclusion → recorded owner exclusion + coach note, EX1-M1; inclusion → EX1-M2 must earn it).

### D-EX1-7: per-plan write gate and withheld-plan accounting (closes EX1-R3-B1, B2)

**Gate PG-PLAN**, per staged plan identity, after the pre-pass and before any write of that plan;
every staged child and every required mapped field is checked; the first failing cause is recorded:

| #   | Cause token          | Fails when                                                                                                                                  | Gap code (`RUN_GAP_CODES`)    |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | `check_read_failed`  | the pre-pass read failed                                                                                                                    | `exercise_check_read_failed`  |
| 2   | `children_absent`    | the declared exercise-children path is missing or not an array (a present empty array is an explicit empty plan, not a vacuous pass)        | `exercise_children_absent`    |
| 3   | `child_invalid`      | any child interprets not `ok`: missing required field, invalid value, enum, unit, non-integral prescription, order (every child code today) | `exercise_child_invalid`      |
| 4   | `ref_missing`        | reference mode and any child's reference is null, blank, or not a string or integer in the S9 `TOKEN` shape                                 | `exercise_ref_missing`        |
| 5   | `ref_unproven`       | reference mode and `refersTo` is absent or refused, or M fails for any link in the run                                                      | `exercise_ref_unproven`       |
| 6   | `ref_uncorroborated` | M holds for every link and some link has no C1-C3                                                                                           | `exercise_ref_uncorroborated` |
| 7   | `name_unmapped`      | CX-NAME fails for a definition the plan uses (library rules dropped, or a blank `per_use` name)                                             | `exercise_name_unmapped`      |

- **Withheld means nothing partial.** No plan, program, revision or child row is written; the
  plan's ledger row is `unresolved` with reason `unresolved:plan_withheld:<cause>` (one additive
  `plan_withheld: 'qualified'` entry in `UNRESOLVED_CATALOGUE`, `types.ts` L359-380; any other
  qualifier parses `reason_unrecognised`). Provenance outcome `unresolved` → replay retries
  (`native-writers.ts` L246) and writes the plan whole once it passes. A passing plan writes every
  child, so `unresolved_children` stays 0.
- **Counts in the reconciliation facts.** Each `families[]` entry has `staged_unique` (staged),
  `native_present_verified` (written) and additive `withheld` (reason `unresolved:plan_withheld:*`),
  with one `reasons` key per cause. The S9 partition is unchanged and `withheld ≤ unresolved`; a
  withheld plan never falls to the no-ledger-row `not_reconstructed` key (`reconcile.ts` L106-112).
- **Named gap per cause, through L0's channel.** EX1 appends to L0-DOC D-L0-6.1 (vi)'s closed,
  append-only `RUN_GAP_CODES` (additive `gaps: { code, count }[]` on the run status; PR #581, in
  revision) the seven codes above plus `exercise_media_not_imported`, `exercise_media_unproven`,
  `exercise_fields_unbound`; counts only. A plan cause counts its withheld plans (the seven sum
  to `withheld`); a media code, exercise-bearing families staged; fields, unbound leaf templates.
- **Terminal hold (existing D-S9-2 conditions; no arbiter change).** Plan causes hold
  `unresolved_identities`; dropped `exercises` rules hold `unresolved_family`
  (`no_native_destination:exercises`); media and unbound-field gaps set those families' coverage
  `known: false`, holding `coverage_basis_unknown`; E-R4 holds `relationship_unverified`. A
  non-empty EX1 gap never coexists with `complete`.

## 4. Collisions (stated defaults)

| Situation                                                                  | Outcome                                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Same source exercise in many plans or runs                                 | One definition, one target, reused                                          |
| Same name as another source exercise, a catalog item or a coach's exercise | Separate imported row; never merged or linked by the importer (later: EQ-1) |
| Reference equals a catalog id or slug (any number, any declaration)        | Never linked to the catalog; resolved only via CX-REF, else plan withheld   |
| Library ids and references share strings, no `refersTo`                    | No link; plans withheld `ref_unproven`; library rows still imported         |
| `refersTo` declared, ids `1..n` coincide totally, no C1/C2                 | No link; plans withheld `ref_uncorroborated`; `partial`                     |
| Persisted key targets another coach's row                                  | `identity_conflict`; no write                                               |
| Coach archived an imported exercise, then a replay                         | New children `native_target_removed`; E-R4 `partial`; never recreated       |

## 5. Owner questions (genuine product forks only)

None of these gates the safe import: until answered, the importer creates coach-only custom
exercises, links nothing to the TGP library and reports media as not imported.

- **EQ-1 (duplicates and the TGP library): after import, should TGP offer a "merge" or "use the
  TGP version" action when an imported exercise looks like one of the coach's or a TGP library
  exercise?** **Recommendation:** yes, later, only on the coach's tap; it re-points future plans
  only. **Consequence:** until then the coach may see "Bench Press" twice, and imported exercises
  never pick up TGP videos or cues; nothing a client sees changes unless the coach chooses it.
- **EQ-2 (visibility): should imported exercises appear in the coach's picker for new plans?**
  **Recommendation:** yes, in that coach's own picker under "Imported", never shared or added to
  the TGP library. **Consequence:** until answered, they exist only inside the imported plans.
- **EQ-3 (media in the promise): does "all past client and coaching records in this site are now
  in TGP" include exercise demo videos and images?** **Recommendation:** for the V1 pilot, exclude
  media by an explicit owner decision amending D1's scope, then plan a copy slice once storage
  and rights are settled. **Consequence:** with the exclusion, `complete` then means "all records
  except exercise media", and the coach permanently sees "Exercise videos and images from your old
  platform were not copied"; their demos stay only on the old platform and are lost if it closes.
  Without it, every site with exercises ends `partial` until copying is built.

## 6. Acceptance cases (bind the build slices)

- **X01** High-entropy library ids + `refersTo` (C3) → one `CoachExercise` per row named from
  `exerciseName`, children `cx:<id>`. **X02** Used in three plans → one row. **X03** Replay → none.
- **X04** Every id a copied v4 catalog uuid → custom rows only; zero catalog reads (query spy) and
  zero catalog ids in children; a catalog space field in a proposal → refused by V-L3.
- **X05** Catalog-slug reference, no library → withheld `ref_unproven`. **X06** Coincident roles,
  no `refersTo` → no link, plans withheld, library rows imported.
- **X07** M failures, each alone: duplicate library id; reference with no library row; library
  only in an earlier run; another namespace; `keyField` ≠ `idField` (parse-time refusal) → no
  link, `ref_unproven`, zero plan/revision/child rows.
- **X08** Withheld plan, later version passes → written whole on replay. **X09** Same name as
  another exercise → separate rows. **X10** Blank `exerciseName` → rules dropped, `name_unmapped`.
  **X11** Coach renames an imported exercise, then a replay → name unchanged (create-only).
- **X12** Coach archives an imported exercise → E-R4 fails, `partial/relationship_unverified`; a
  new plan using it → `native_target_removed`. Right token, missing definition provenance → fails.
- **X13** Another coach's row → `identity_conflict`; RLS: coach B cannot read or write coach A's
  rows; a client only via an active assignment. **X14** Both staging orders → same targets.
- **X15** **Mixed source:** clients, a prior written plan and a failed CX-REF → clients
  reconstruct, the prior plan is untouched, new plans withheld with counts; a pre-pass read error
  → every plan `check_read_failed` inside settle; an error inside settle → full rollback.
- **X16** `per_use` site → one row per use, no CX-REF; both or neither mode declared → refused.
- **X17** Media: `url`-class or media-key field (incl. `ExerciseSet.video_url`) → `_not_imported`;
  none → `_unproven`; both `partial`; owner-excluded (EX1-M1) → note shown, gap cleared.
- **X18** Prescription fields, order, revision-0 snapshot and history names match the staged map;
  an unbound non-id leaf → `known: false`, `exercise_fields_unbound`. **X19** Mobile builder,
  active-workout and assignment screens (incl. snapshots) show the resolved name, never `cx:`.
- **X20** Side-effect spies zero across X01-X18; module boundary holds; stub-provider proposal passes
  V-L3/V-L6, an unseen path is refused; no paid AI call; vendor-name guard passes (CORE DIFF = 0).
- **X21** **R-5 adversary:** unrelated integer collections `1..n`, references a subset, `refersTo`
  declared → M holds, C fails → no link, `ref_uncorroborated`. `ex_000001..` or one library row
  fail C3; a C1 value repeated across library rows or mismatched on one link fails; C1 unique and
  equal on every link, or uuids (C3) → links; C2 bound/unbound `fetched_by` after EX1-F.
- **X22** **No plan disappears uncounted:** one run staging passing plans, a prior plan and one
  plan per cause 1-7 (and a generated property test over random mixes) → for the plan family,
  `staged_unique` = written + withheld + other buckets; `withheld` = sum of the seven cause keys
  = sum of the seven `gaps[]` counts; zero `not_reconstructed` among them; zero plan, revision or
  child rows for withheld identities; `complete` never coexists with a non-empty EX1 gap.

## 7. Build slices (graded by consequence; the first higher-tier trigger wins, no averaging)

LOC = expected hand-written production lines. Every slice is below ~1,000, so no structural
challenge is needed. Every T4 slice needs two independent exact-head audits and the PG proof lanes.

| Slice  | Scope                                                                                                                                                                                      | T0  | T1  | T2  | T3  | T4  | Trigger                                      | Depends on   | LOC     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | --- | --- | --- | --- | -------------------------------------------- | ------------ | ------- |
| EX1-0  | This record                                                                                                                                                                                |     |     |     | ✔   |     | identity and ownership design                | —            | 0       |
| EX1-A  | `CoachExercise` + RLS (owner, client-via-assignment, service_role; deny anon), migration + down; CHECK expands (EX1-F5); X13 RLS spec                                                      |     |     |     |     | ✔   | RLS, tenant boundary, persisted data         | —            | 150-250 |
| EX1-B  | Grammar (`exerciseName`, `refersTo`, `corroborateBy`, `exerciseIdentity`); writer; delete catalog path; CX-REF (M, C1, C3), CX-NAME; PG-PLAN, `plan_withheld` (X01-X11, X14-X16, X20, X21) |     |     |     |     | ✔   | create-only irreversible writes, identity    | EX1-A, L0 L2 | 450-650 |
| EX1-R  | Kind→model map, E-R4, `exercises` family, `withheld` count, EX1 `RUN_GAP_CODES` + hold mapping, D-EX1-6 checks (X12, X18, X22)                                                             |     |     |     |     | ✔   | terminal truth (reconciliation)              | EX1-B, L0 L3 | 250-350 |
| EX1-C  | Name resolver: backend plan and assignment reads return `display_name` for `cx:` tokens under coach and client authorization; mobile (X19)                                                 |     |     |     |     | ✔   | tenant-scoped reads, client access           | EX1-A        | 200-300 |
| EX1-F  | C2: ingest `fetched_by` (additive) + extension fan-out binding + CX-REF C2 (X21 C2 variants)                                                                                               |     |     |     |     | ✔   | identity evidence across the device boundary | EX1-B, L0 X2 | 150-250 |
| EX1-M0 | Media gap rule (`exercise_media_not_imported` / `_unproven`), coverage `known: false` (X17)                                                                                                |     |     |     |     | ✔   | terminal truth                               | EX1-R        | < 100   |
| EX1-M1 | Owner-excluded media: recorded exclusion + persistent coach-visible note (only if EQ-3 = exclude)                                                                                          |     |     |     |     | ✔   | terminal truth                               | EX1-M0, EQ-3 | < 80    |
| EX1-M2 | Media copy to TGP storage (only if EQ-3 = include); needs its own T3 design first                                                                                                          |     |     |     |     | ✔   | storage, rights, irreversible data           | EX1-M0, EQ-3 | TBD     |

- EX1-C is T4: clients read coach-owned rows through assignments (`schema.prisma` L2298-2321).
  EX1-B moves the S11/S10b PG pins. EQ-2 gates only the picker; EQ-1 would need its own T3 design.

## 8. Risks, evidence gaps and what this record does not decide

- **R-1** Behaviour change: catalog matches stop linking; a plan with a failing child is withheld.
- **R-2** Plans persisted before EX1 keep their children; that only fixtures have them is
  **unproven** (check provenance before EX1-B; if a real coach has, it needs its own amendment).
- **R-3** Until G3, workspaces of one platform share identities (D-S8-3). **R-4** Plans that
  reference exercises with no library step stay `partial` (`ref_unproven`); intended.
- **R-5 closed** (membership never links alone). **R-6** Integer-keyed sites without a unique
  denormalized name stay `partial/ref_uncorroborated` until EX1-F (honest, intended). C3 would
  accept a source reusing one high-entropy id for two unrelated objects; recorded, not observed.
- **Gaps:** L0 r3's gap channel is in revision (PR #581); EX1-R binds to its final spelling.
  Mobile citations were read, not run. No real-source staging data was examined.
- Not decided here: EQ-1 to EQ-3; client-owned `ExerciseSet` writing (S8-E1a); any catalog link.

## 9. Review closure (EX1-R3 re-review at `a45d655`)

| Finding   | Closed by                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EX1-R3-A1 | CX-REF = membership AND per-link corroboration C1/C2/C3 (D-EX1-3); membership alone never links; uncorroborated → withheld `ref_uncorroborated`; X21 declared total-coincidence negative           |
| EX1-R3-B1 | PG-PLAN over every child and required field, causes 1-7 incl. null refs, invalid children, absent array; one mode per step (`per_use` defined); per-identity `plan_withheld` ledger; X15, X16, X22 |
| EX1-R3-B2 | Ten codes appended to L0 `RUN_GAP_CODES` with counting scope; `plan_withheld` catalogue entry; hold per code on existing D-S9-2 conditions; read errors recorded inside settle; X22                |
| Earlier   | SOL-A1 (catalog removed), B2 (superseded), B3, B4 (media never `complete`) remain closed as at r3                                                                                                  |
