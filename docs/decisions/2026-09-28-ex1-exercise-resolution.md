# EX1: exercise-reference resolution (source exercise → TGP exercise)

- **Status:** T3 design record r5 (closes re-review EX1-R4 at `7b15aa4`, §9); not accepted, no
  code, nothing run. 2026-09-28, owner Bradley Gleave; D-EX1-1..7 are defaults, §5 owner forks.
- **Base:** backend `integration/importer` `d84cb7c`; mobile (`M:`) `3f91d58`.
- **Sources** (`docs/decisions/`): S8-DOC `2026-09-24-s8-native-contract.md`, S9-DOC `…-25-s9-…`,
  S8D-DOC `…-26-s8d-person-link.md`, L0-DOC `…-27-learn-and-remember.md` (PR #581 r3 `c916144`,
  open, not landed; its gap channel is D-L0-6.1 (vi)). Checks defined here are `CX-*`.

## 1. Why this exists

- Owner D1 (2026-09-28): `complete` means "All past client and coaching records in this site are
  now in TGP". A workout without its exercises, or a coach's exercise library, is not in TGP.
- S8-DOC L427-430 left references `unresolved:exercise_reference`; S8-C links on catalog id or
  slug equality (`src/scout/reconstruct/native/native-writers.ts` L169-188), else writes the plan
  without them (EX1-F6). No coach-owned exercise model exists: only the global
  `ExerciseCatalogItem` (`prisma/schema.prisma` L4332-4336), client-owned `ExerciseSet` (L879-891,
  `video_url` L890), legacy `RoutineExercise` (L907-918). L0: NEW SOURCE → CORE CODE DIFF = 0.

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

### D-EX1-3: no catalog link; a reference links only on an observed fetch binding (C2)

- **No automatic catalog linking.** A source can never prove it shares TGP catalog identity (an
  equal uuid or slug may be copied or hostile). EX1-B deletes `verifiedCatalogRefs`; the importer
  never reads `ExerciseCatalogItem` or writes a catalog id/slug. Catalog linking is only EQ-1.
- **A declaration is a request to check, never evidence.** On `exerciseRef` the AI may propose
  (as data only, V-L3/V-L6, L0-DOC D-L0-2) `refersTo: { family: 'exercises', keyField }`; none →
  no link. V-L3: exactly one learned step maps to `exercises`; `keyField` is exactly its `idField`.
- **Equal values are never proof (r5).** r4's C1 (unique equal name) and C3 (high-entropy ids) are
  **deleted**: unrelated collections can share copied uuids and labels. Only **C2** proves.
- **CX-REF** (deterministic; this run's staged rows and ingest evidence only; no model, no
  catalog) holds only if **every** reference in the run satisfies both:
  - **M (membership):** the reference equals the `source_id` of exactly one library row staged in
    the same run and `source_namespace`, read from `keyField`.
  - **C2 (observed fetch binding):** that row carries an ingest `fetch_binding` (EX1-F)
    `{ step, templateRef, slot, bound_value, from: { step, source_id } }` where `step` is the
    `exercises` step; `from.step` is the plan step and `from.source_id` a plan staged in this run
    whose children carry this reference; `bound_value` byte-equals the reference; `slot` is the detail template's `:p1`
    path slot, or a query key whose response yielded exactly one item; and the row's `idField`
    byte-equals `bound_value`. So the extension fetched this exact row by this exact reference,
    in this run, from this source, under the declared relation.
- **Who records it.** The crawl executor, from the value it substituted into the request; never
  the response, a mapping or the model (which never sees values). Forgery risk: R-7.
- **All-or-nothing per run (new writes only).** Any reference failing M → cause `ref_unproven`; M
  everywhere but any reference without C2 → `ref_unbound`. Then **no reference in this settle
  links** and every reference-mode plan staged in this run is withheld (D-EX1-7). Plans written
  by earlier settles are never erased or edited (create-only); E-R4 re-checks them.
- **Until EX1-F lands, C2 never holds: every site whose plans reference exercises settles
  `partial` (`ref_unbound`).** Library rows and `per_use` plans still import; nothing guesses.
- **CX-NAME:** a blank `exerciseName` drops the `exercises` rules (no partial credit, L0-DOC); plans withheld.
- **Pre-pass.** CX-REF and CX-NAME run read-only before settle and return a result, never throw:
  a read error is cause `check_read_failed` for every staged plan, recorded in settle; an error
  inside settle rolls all back. Rules come from the learned registry (D-L0-5), not `sources/*.json`.

### D-EX1-4: provenance, replay, create-only and side effects

- Kind `coach_exercise` joins provenance `native_kind` and ledger `target_kind` (EX1-F5). Target
  verification: row present, `coach_id` = coach, `archived_at` null (`facts.service.ts` L745-755);
  else `native_target_removed`. `exercises` reconstructs before `workouts` whatever the staging
  order; a unique-key race re-reads and converges (S8-DOC L202-203).
- **Create-only.** A `CoachExercise` is never updated (coach renames survive, S8-DOC D-S8-4);
  pre-EX1 plans keep their children (R-2). Creation notifies no one, calls no video or catalog
  path, uploads no media (S8-DOC §3.6); `ExerciseSet` (S8-E1a) copies the resolved name.

### D-EX1-5: reconciler (bucket j and closure)

- **Bucket j, partition, condition order and `COMPLETENESS_BASIS_KINDS` unchanged** (D-S9-2);
  library identities classify a-k like any family; the kind→model map gains `CoachExercise`.
- **Edge E-R4**, per child of every bucket-j plan (earlier settles' included): the child's
  re-derived definition has provenance, a verified target, and `exercise_external_id` = `cx:<id>`
  of **that** row (a token match alone, or a catalog-linked child, fails) → else
  `relationship_unverified`. A withheld plan is not j (D-EX1-7).

### D-EX1-6: completeness under D1

`complete` only if every in-scope item is natively verified or owner-excluded; else `partial`.

| In scope (exercise records)              | Required for `complete`                                                                                   | If not met                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Library rows (used or unused)            | bucket j                                                                                                  | C-ID / C-FAM                                       |
| Plan exercise children                   | PG-PLAN passes; E-R4 holds; name, sets, reps/duration, weight, rest, superset, notes, order equal the map | withheld plan (D-EX1-7) / C-REL                    |
| Program-day revision snapshot            | revision 0 `exercises_json` equals the written children                                                   | C-REL                                              |
| Client exercise history (`ExerciseSet`)  | S8-E1a family natively present                                                                            | C-FAM until S8-E1a lands                           |
| Unbound fields under an exercise         | every non-id leaf bound to a column, to `notes`/`instructions`, or owner-excluded                         | coverage `known: false`, `exercise_fields_unbound` |
| **Exercise media** (demo videos, images) | never earned by the importer; only an owner exclusion (EQ-3) removes it from the promise                  | coverage `known: false`, media gap below           |

- **Media never contributes to `complete`.** Any run staging exercise records: a `url`-class
  field or key token in `video|image|photo|thumbnail|gif|media` (incl. `ExerciseSet.video_url`) →
  gap `exercise_media_not_imported`, else `exercise_media_unproven`. Only EQ-3 changes this.

### D-EX1-7: per-plan write gate and withheld-plan ledger (S9 grammar)

**Gate PG-PLAN**, per staged plan, before any write of it, over every child and required field;
first failing cause wins. The raw reference (#3) is inspected **before** the child interpreter
(#4), so `ref_missing` is reachable though `interpretExercise` fails it today (L501-526).

| #   | Cause               | Fails when                                                                                                                           | Ledger reason (bare)                    | Gap code (`RUN_GAP_CODES`)   |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ---------------------------- |
| 1   | `check_read_failed` | the pre-pass read failed                                                                                                             | `unresolved:withheld_check_read_failed` | `exercise_check_read_failed` |
| 2   | `children_absent`   | the declared exercise-children path is missing or not an array (a present empty array is an explicit empty plan, not a vacuous pass) | `unresolved:withheld_children_absent`   | `exercise_children_absent`   |
| 3   | `ref_missing`       | reference mode and any child's raw reference is null, blank, or not a string or integer in the S9 `TOKEN` shape                      | `unresolved:withheld_ref_missing`       | `exercise_ref_missing`       |
| 4   | `child_invalid`     | any child interprets not `ok`: missing required field, invalid value, enum, unit, non-integral prescription, order                   | `unresolved:withheld_child_invalid`     | `exercise_child_invalid`     |
| 5   | `ref_unproven`      | reference mode and `refersTo` is absent or refused, or M fails for any reference in the run                                          | `unresolved:withheld_ref_unproven`      | `exercise_ref_unproven`      |
| 6   | `ref_unbound`       | M holds for every reference and some reference has no C2 fetch binding (always, until EX1-F)                                         | `unresolved:withheld_ref_unbound`       | `exercise_ref_unbound`       |
| 7   | `name_unmapped`     | CX-NAME fails for a definition the plan uses (library rules dropped, or a blank `per_use` name)                                      | `unresolved:withheld_name_unmapped`     | `exercise_name_unmapped`     |

- **Ledger status is the existing `skipped` (S9 grammar).** S9's status set is closed at
  `reconstructed | skipped | failed` (`src/scout/reconciliation/types.ts` L74, L128-136); an
  unknown status is bucket k (`reconcile.ts` L122-124). A withheld plan takes today's plan-level
  refusal path: `map` returns `{ ok: false, reason }` (precedent `native-rules.ts` L462-463) and
  `scout-reconstruct.service.ts` L461-470 writes one ledger row per staged plan identity:
  `skipped`, that reason, no target or kind, **no provenance row**; `persist` never runs.
- **Classification.** `skipped` goes to the reason parser (`reconcile.ts` L118-119, L82-89): a
  catalogued reason is bucket e, key verbatim (S9-DOC L109). With no provenance row it is never
  `provenance_missing` (g); with a ledger row it is never `not_reconstructed` (b, L106-112).
- **The seven reasons are an append-only catalogue addition in the form S9 provides for.** They
  are **bare**: D-S9-7 limits qualifiers to family, field, model, staged token and platform
  (S9-DOC L393-394) and S9-C admits a qualifier only from that domain (S9-DOC B.3 L680-693;
  `lifecycle.service.ts` L1016-1021), so a cause qualifier would fold to `reason_unrecognised`.
  EX1-B appends them as `'bare'` to S8-C `UNRESOLVED_CODE` (`native-contract.ts` L48-61) and S9-A
  `UNRESOLVED_CATALOGUE` (`types.ts` L364-380) **in one change**, so the parity spec's pinned
  surplus stays exactly the three S9-DOC B.1 codes (L645-649; the spec anticipates widening, L19);
  its length pin moves 15 → 22; nothing is renamed or removed; S8-DOC §3.7 gets a forward pointer.
- **Replay.** `reconstructed` supersedes `skipped` (`scout-reconstruct.service.ts` L599-610): a
  passing replay writes the plan whole. **Every path writes a row:** pre-pass error → cause 1 for
  every staged plan; dropped `exercises` rules → cause 7; a `workouts` family with no rules = C-FAM.
- **Counts from S9 as is:** withheld = the seven keys' sum in the family's existing `reasons[]`.
- **Named gap per cause (L0 channel).** EX1 appends ten codes to L0-DOC D-L0-6.1 (vi)'s closed,
  append-only `RUN_GAP_CODES` (`gaps: { code, count }[]`, projected from closure ∪ coverage ∪ the
  D-S9-7 histogram): the seven above (each counts its key), `exercise_media_not_imported`,
  `exercise_media_unproven` (exercise-bearing families staged), `exercise_fields_unbound`.
- **Hold (existing D-S9-2; no arbiter change).** Withheld ⇒ `unresolved_identities`; dropped
  rules ⇒ `unresolved_family`; media/unbound gaps ⇒ `known: false` ⇒ `coverage_basis_unknown`;
  E-R4 ⇒ `relationship_unverified`. A non-empty EX1 gap never coexists with `complete`.

## 4. Collisions (stated defaults)

| Situation                                                                  | Outcome                                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Same name as another source exercise, a catalog item or a coach's exercise | Separate imported row; never merged or linked by the importer (later: EQ-1) |
| Reference equals a catalog id or slug (any number, any declaration)        | Never linked to the catalog; resolved only via CX-REF, else plan withheld   |
| Library ids and references share strings, no `refersTo`                    | No link; plans withheld `ref_unproven`; library rows still imported         |
| `refersTo` declared, ids coincide totally (integers, uuids or equal names) | No link without C2; plans withheld `ref_unbound`; `partial`                 |
| Coach archived an imported exercise, then a replay                         | New children `native_target_removed`; E-R4 `partial`; never recreated       |

## 5. Owner questions (genuine product forks only)

None of these gates the safe import: until answered, the importer creates coach-only custom
exercises, links nothing to the TGP library and reports media as not imported.

- **EQ-1 (duplicates and the TGP library): after import, should TGP offer a "merge" or "use the
  TGP version" action when an imported exercise looks like one of the coach's or a TGP library
  exercise?** **Recommendation:** yes, later, only on the coach's tap, re-pointing future plans. **Consequence:** until then the coach may see "Bench Press" twice, and imported exercises
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

- **X01** (after EX1-F) every reference C2-bound → one `CoachExercise` per row named from
  `exerciseName`, children `cx:<id>` (before EX1-F: the X21 outcome). **X02** Three plans → one
  row. **X03** Replay → none. **X04** Copied v4 catalog uuids → custom rows only, zero catalog
  reads (query spy) or ids; a catalog space field in a proposal → V-L3 refusal.
- **X05** Catalog-slug reference, no library → `ref_unproven`. **X06** Coincident roles, no
  `refersTo` → plans withheld, library rows imported. **X07** M failures, each alone (duplicate
  library id; no library row; library only in an earlier run; another namespace; `keyField` ≠
  `idField` refused at parse) → `ref_unproven`, zero plan/revision/child rows.
- **X08** Withheld plan, later version passes → written whole (`skipped` → `reconstructed`).
  **X09** Same name → separate rows. **X10** Blank `exerciseName` → `name_unmapped`. **X11**
  Coach rename, then replay → unchanged (create-only).
- **X12** Archived imported exercise → E-R4 fails (`relationship_unverified`); a new plan using
  it → `native_target_removed`; right token without definition provenance, or a prior
  catalog-linked child → E-R4 fails. **X13** Another coach's row → `identity_conflict`; RLS:
  coach B cannot touch coach A's rows; a client only via an active assignment. **X14** Both
  staging orders → same targets.
- **X15** **Mixed source:** clients, a prior plan and a failed CX-REF → clients reconstruct,
  prior plan untouched, new plans withheld with counts; pre-pass read error → every plan
  `check_read_failed`; error inside settle → full rollback. **X16** `per_use` → one row per use,
  no CX-REF; both or neither mode → refused.
- **X17** Media: `url`-class or media-key field (incl. `ExerciseSet.video_url`) → `_not_imported`;
  none → `_unproven`; both `partial`; owner-excluded (EX1-M1) → note shown, gap cleared.
- **X18** Prescriptions, order, revision-0 snapshot and history names match the map; an unbound
  non-id leaf → `exercise_fields_unbound`. **X19** Mobile builder, active-workout and assignment
  screens show the resolved name, never `cx:`. **X20** Side-effect spies zero; stub-provider
  proposal passes V-L3/V-L6, an unseen path refused; no paid AI call; vendor-name guard passes.
- **X21** **Coincidence adversaries** (`refersTo`, M everywhere, no binding) → `ref_unbound`, zero
  plan rows, `partial`: (a) unrelated integer collections `1..n`; (b) unrelated collections with
  distinct v4 uuids copied from one upstream table; (c) every child's name unique in the library
  and byte-equal to its row's; (d) all three. **C2 negatives** (after EX1-F), each alone →
  `ref_unbound`: `bound_value` ≠ reference; binding from another run, namespace, step or plan;
  `idField` ≠ `bound_value`; a query-slot response with 0 or ≥ 2 items; bindings on only some
  references (nothing links); a binding found in the response payload, not executor-recorded.
- **X22** **No plan disappears uncounted:** one fixture per cause 1-7 pins its ledger row
  (`skipped`, that bare reason, null target, no provenance), histogram key and gap code (count 1).
  A run mixing passing plans, a prior plan and all seven, plus a property test over random mixes →
  one ledger row per staged plan; staged = j + rejected + unresolved + failed; the seven keys sum
  to the withheld count and equal the seven `gaps[]` counts; no `reason_unrecognised`,
  `provenance_missing` or `not_reconstructed` and no plan, revision or child rows for withheld
  plans; `complete` never with a non-empty EX1 gap; the parity spec passes.

## 7. Build slices (graded by consequence; the first higher-tier trigger wins, no averaging)

LOC = hand-written prod lines; all < ~1,000 (no structural challenge). Every T4 slice needs two
independent exact-head audits and the PG proof lanes. EX1-B moves the S11/S10b PG pins.

| Slice  | Scope                                                                                                                                                                                                                                          | T0  | T1  | T2  | T3  | T4  | Trigger                                      | Depends on   | LOC     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | -------------------------------------------- | ------------ | ------- |
| EX1-0  | This record                                                                                                                                                                                                                                    |     |     |     | ✔   |     | identity and ownership design                | —            | 0       |
| EX1-A  | `CoachExercise` + RLS (owner, client-via-assignment, service_role; deny anon), migration + down; CHECK expands (EX1-F5); X13 RLS spec                                                                                                          |     |     |     |     | ✔   | RLS, tenant boundary, persisted data         | —            | 150-250 |
| EX1-B  | Grammar (`exerciseName`, `refersTo`, `exerciseIdentity`); writer; delete catalog path; CX-REF (M; C2 absent ⇒ `ref_unbound`), CX-NAME; PG-PLAN; seven bare codes in `UNRESOLVED_CODE` + `UNRESOLVED_CATALOGUE` (S9-A grant) (X01-X16, X20-X21) |     |     |     |     | ✔   | create-only irreversible writes, identity    | EX1-A, L0 L2 | 400-600 |
| EX1-R  | Kind→model map, E-R4, `exercises` family, withheld count from `reasons[]`, EX1 `RUN_GAP_CODES` + hold mapping, D-EX1-6 checks (X12, X18, X22)                                                                                                  |     |     |     |     | ✔   | terminal truth (reconciliation)              | EX1-B, L0 L3 | 200-300 |
| EX1-C  | Name resolver: backend plan and assignment reads return `display_name` for `cx:` tokens under coach and client authorization; mobile (X19)                                                                                                     |     |     |     |     | ✔   | tenant-scoped reads, client access           | EX1-A        | 200-300 |
| EX1-F  | C2: executor-recorded `fetch_binding` on ingest (additive), reference-collecting `forEach` binding in the extension, ingest validation, CX-REF C2 (X01 positive, X21 C2 negatives)                                                             |     |     |     |     | ✔   | identity evidence across the device boundary | EX1-B, L0 X2 | 200-300 |
| EX1-M0 | Media gap rule (`exercise_media_not_imported` / `_unproven`), coverage `known: false` (X17)                                                                                                                                                    |     |     |     |     | ✔   | terminal truth                               | EX1-R        | < 100   |
| EX1-M1 | Owner-excluded media: recorded exclusion + persistent coach-visible note (only if EQ-3 = exclude)                                                                                                                                              |     |     |     |     | ✔   | terminal truth                               | EX1-M0, EQ-3 | < 80    |
| EX1-M2 | Media copy to TGP storage (only if EQ-3 = include); needs its own T3 design first                                                                                                                                                              |     |     |     |     | ✔   | storage, rights, irreversible data           | EX1-M0, EQ-3 | TBD     |

- EX1-C is T4 (clients read coach rows via assignments, `schema.prisma` L2298-2321). EQ-2 gates
  only the picker; EQ-1 would need its own T3 design.

## 8. Risks, evidence gaps and what this record does not decide

- **R-1** Catalog matches stop linking; a plan with a failing child is withheld. **R-2** That
  only fixtures hold pre-EX1 plans is **unproven** (check before EX1-B; else its own amendment).
- **R-3** Until G3 one platform's workspaces share identities (D-S8-3). **R-4** References with
  no library step stay `partial` (`ref_unproven`); intended.
- **R-5 closed** by removal: no value-equality corroboration remains. **R-6** Until EX1-F lands,
  **every** site whose plans reference exercises settles `partial` (`ref_unbound`), the pilot
  included; after it, a library that is only listed, never fetched per reference, stays `partial`.
- **R-7** C2 trusts the paired executor as all staged data is trusted; a forgery harms only the
  forging coach's own import. **Gaps:** L0's gap channel is at PR #581 `c916144`, not landed;
  EX1-R binds to its final spelling. Mobile citations read, not run; no real-source data examined.
- Not decided here: EQ-1 to EQ-3; client-owned `ExerciseSet` writing (S8-E1a); any catalog link.

## 9. Review closure (EX1-R4 re-review at `7b15aa4`)

| Finding   | Closed by                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EX1-R4-A1 | C1 and C3 deleted; only C2 (executor-recorded fetch binding, byte-checked against reference and row id, same run/source/plan) links; X21 uuid, equal-name and C2 negatives      |
| EX1-R4-B1 | Withheld plan = ledger `skipped` + one of seven **bare** appended catalogue codes, no provenance, one row per staged plan on every path; counts from `reasons[]`; X22 per cause |
| EX1-R4-C1 | Raw reference inspected before the child interpreter (`ref_missing` #3); X22 pins reason, key and gap per cause                                                                 |
| EX1-R4-C2 | All-or-nothing covers new writes in this settle only; prior plans untouched; E-R4 re-checks every bucket-j plan and fails prior catalog-linked children (X12)                   |
| Earlier   | EX1-R3-B1 closed at design intent; R3-B2 closed by R4-B1 above; SOL-A1, B3, B4 remain closed as at r3                                                                           |
