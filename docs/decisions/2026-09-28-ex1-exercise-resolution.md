# EX1: exercise-reference resolution (source exercise → TGP exercise)

- **Status:** T3 design record, r2 (closes review EX1-SOL-A1, B1-B4 and notes, §9). Not merged or
  accepted; changes no code, and claims no route, proof or test below has run. Slices (§7) are T4.
- **Date:** 2026-09-28. **Owner:** Bradley Gleave. D-EX1-1..7 are stated defaults; §5 holds the
  three owner-reserved product forks. **Base:** backend `integration/importer` `d84cb7c`; mobile
  (`M:`) `growth-project-mobile` `3f91d58`.
- **Sources** (`docs/decisions/`): S8-DOC `2026-09-24-s8-native-contract.md`, S9-DOC
  `…-25-s9-reconciliation.md`, S8D-DOC `…-26-s8d-person-link.md`, L0-DOC
  `…-27-learn-and-remember.md` at `982bd286` (r2 in progress, so checks here are `CX-*`).

## 1. Why this exists

- Owner D1 (2026-09-28): `complete` means "All past client and coaching records in this site are
  now in TGP". A workout without its exercises, or a coach's exercise library, is not in TGP.
- S8-DOC L427-430 left references `unresolved:exercise_reference`; S8-C links a child when its
  reference equals an `ExerciseCatalogItem.id` **or** `.slug`, with no source declaration
  (`src/scout/reconstruct/native/native-writers.ts` L169-188, L263-314). Own-space ids stay
  unresolved and C-ID fires (S9-DOC L123-125); slug-equal ids link by coincidence (EX1-F1). No
  real-source run is evidenced either way.
- No coach-owned exercise model exists: only the global `ExerciseCatalogItem` (`prisma/schema.prisma`
  L4332-4336; `id` uuid, `slug @unique`), the client-owned `ExerciseSet` (L879-891) and the legacy
  `RoutineExercise` (L907-918). L0 forbids per-source hand work (NEW SOURCE → CORE CODE DIFF = 0);
  the AI proposes data only and deterministic validators decide (L0-DOC D-L0-4, D-L0-6).

## 2. Findings at this base

| ID     | Class | Finding                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EX1-F1 | B     | **Implicit identity-space assumption.** Any reference equal to a catalog id or slug links (`native-writers.ts` L175-188). A source with slug-like ids (`bench-press`) links to a different TGP exercise by string equality. A conditional risk, not an observed incident. `verifiedCatalogRefs` also returns a membership set, not a uniquely selected item.                     |
| EX1-F2 | B     | **`exercise_external_id` is polymorphic** (`schema.prisma` L2302 "NOT a FK"): catalog id or slug (`src/exercise-catalog/exercise-catalog.service.ts` L120-132), `seed:` ids (`src/exercise-library/seed-catalog.ts` L9-11, L25), any 1-128 char builder string (`src/ai/gateway/materialisers/__shared/workout-diff.types.ts` L58-63). A new token needs its own read/auth path. |
| EX1-F3 | B     | **Renderers show the raw reference as the name** (`M:src/utils/workout/buildActiveWorkout.ts` L30-52; `M:src/screens/coach/CoachWorkoutBuilderScreen.tsx` L255-267, L843-850; `M:src/screens/client/WorkoutAssignmentDetailScreen.tsx` L132). A `cx:` token would render as an opaque name without slice EX1-C.                                                                  |
| EX1-F4 | C     | The native rule grammar has `exerciseRef` but no exercise-name role (`src/scout/reconstruct/native/native-rules.ts` L62-73).                                                                                                                                                                                                                                                     |
| EX1-F5 | C     | Closed CHECKs: provenance `native_kind` (five kinds) and ledger `target_kind` (`prisma/migrations/20270122000000_scout_native_provenance_expand/migration.sql` L138-146, L184-195), plus the typed kind sets and read maps in `src/scout/reconciliation/facts.service.ts` L450-503. All need an additive expand.                                                                 |

## 3. Decisions (stated defaults)

### D-EX1-1: identity model

- A **source exercise identity** is `(platform, source_id)` on the D-S8-3 key
  `(coach_id, source_namespace, entity_type, source_id)`, `source_namespace` = `source_platform`
  until G3 (S8-DOC L93-98). `source_id` is always a value read from a spec-declared path on a
  staged row, never a name and never model output (L0-DOC D-L0-6).
- Identity is **per definition, not per use**; the per-use child identity stays S8-DOC §3.3
  (`workouts.exercise`, `<n>:<parent>#id:<child>` / `#ord:<n>`). The definition key's
  `entity_type` records which role produced it, so equal strings from different roles never meet:

| Role                                           | Definition key `entity_type` / `source_id`      | Target kind                    |
| ---------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| Library row (staged step → family `exercises`) | `exercises` / the step's `idField` value        | `coach_exercise`               |
| Reference with `refersTo: 'exercises'`         | `exercises` / the reference (same key as row)   | the library row's target       |
| Reference, no `refersTo` (source space)        | `workouts.exercise_ref` / the reference         | `coach_exercise`               |
| Reference with proven catalog space (D-EX1-3)  | `workouts.exercise_ref` / the catalog uuid      | `catalog_exercise_link`        |
| Id-less child, `exerciseIdentity: 'per_use'`   | `workouts.exercise_use` / the child's source id | `coach_exercise` (one per use) |

- **Cross-role relation (closes EX1-SOL-B1).** `sharedIdSpaces` is not used: it only declares
  fan-in of two or more steps into one family and rejects anything else
  (`src/scout/reconstruct/mapping-spec.ts` L378-432); a nested `exerciseRef` is not a step. EX1 adds a typed
  `refersTo: 'exercises'` field on the `exerciseRef` role of `NativeRuleSet` (data). Parse-time
  (V-L3): a step maps to family `exercises`, that family has an `idField` of id class (L0-DOC
  digest `int_id|uuid|short_id`) and native rules; `refersTo` and a catalog space declaration are
  mutually exclusive. Run-time check **CX-REF** (before any native write): library `source_id`s are
  unique per run, and every non-null reference of the run equals a staged library `source_id` in
  the same namespace. Any miss → the `workouts` and `exercises` native rules are dropped for the run
  (evidence path, L0 C3 precedent), gap `learn_exercise_ref_unlinked`. Nothing is guessed.
- **Id-less sources (default, not an owner fork).** A name is not identity (S8-DOC L217). With
  declared `exerciseIdentity: 'per_use'` (valid only if the child shape has no id-class key), each
  use gets its own definition keyed by the child identity, preserving plan text without claiming
  two uses are one exercise. Undeclared null references stay `unresolved:exercise_reference`.
- **Space pinning.** A key's target kind is fixed by its first write. A later run implying another
  kind for that key (catalog → coach) makes its children `unresolved:identity_conflict` (tag
  `space_changed`): no write, no downgrade, persisted children never re-pointed.

### D-EX1-2: resolution rule (deterministic; first match wins)

Per definition key, in one transaction with the first plan that uses it (S8-DOC §3.4):

1. **Provenance hit** → verify the target (D-EX1-4); present → reuse; removed →
   `unresolved:native_target_removed` for every child that uses it (never recreated).
2. **Proven catalog link** → only via D-EX1-3. Target = the single `ExerciseCatalogItem` selected
   by `id` (unique); the child writes that item's `slug` (the student gate accepts it,
   `exercise-catalog.service.ts` L131). Provenance kind `catalog_exercise_link`, `native_id` = id.
3. **Coach-owned custom exercise** (the default for every source) → create one `CoachExercise` owned
   by the importing coach, provenance kind `coach_exercise`; the child writes
   `exercise_external_id = 'cx:' + CoachExercise.id` (`seed:` precedent; ≤ 128 chars). `name` comes
   from the new `exerciseName` role (EX1-F4): on the library row when `refersTo`, else on the child.
4. Nothing else: no name, fuzzy, normalised, embedding or model match anywhere in the path. Two
   source identities never share one coach-owned target. **Scoped exception:** a global catalog row
   may be the target of the same uuid from several namespaces or coaches; that is what "catalog"
   means, and within one namespace the key is the uuid itself, so it is one-to-one there.

`CoachExercise` (new, slice EX1-A): `id`, `coach_id` (FK `User`), `name`, optional
`primary_muscle` / `equipment` / `instructions` only when spec-declared (`enum_unmapped` otherwise),
`archived_at`, `created_at`. RLS: owner coach and service_role; a client may read a row only
through an active assignment whose plan references its `cx:` token; deny-all to anon (S8D-DOC §3).
No source value column; provenance is the only link back (S8-DOC §3.3, TM-14).

### D-EX1-3: catalog identity needs positive proof (closes EX1-SOL-A1, B2, B3)

- **Default:** every source's references are in the source's own space (rule 3). An AI-proposed
  `exerciseRefSpace: 'tgp_catalog'` is a request to check, never evidence. Slug equality, name
  equality and `source_ref` equality never count as proof, however many rows match.
- **Proof CX-CAT** (deterministic, backend, before any native write) holds for a run only if the
  spec declares `tgp_catalog` **and every** non-null reference of the family:
  (a) is a canonical lowercase RFC 4122 version-4 uuid string; (b) equals exactly one
  `ExerciseCatalogItem.id`; (c) equals **no** `ExerciseCatalogItem.slug` (cross-column check).
  Catalog ids are server-generated v4 uuids (`schema.prisma` L4333; the seed sets only `slug`), so
  equality cannot be coincidence (≈2⁻¹²² per pair): only a source holding TGP's own ids passes.
- **Bounded read.** The only EX1 check that reads the database: `id IN (…)` and `slug IN (…)` over
  the run's distinct references, chunks ≤ 1,000, one snapshot in the settle transaction.
- **Failure refuses (closes B3).** Any miss, any slug hit, a non-uuid value or a read error → the
  `workouts` native rules are dropped for the run (evidence path), gap
  `learn_exercise_space_refused`, and C-FAM keeps the run `partial`. The run is **never**
  reinterpreted as source space; a later learned version that drops the declaration is a new
  version (L0-DOC D-L0-5) and space pinning (D-EX1-1) guards persisted keys.
- **CX-NAME:** every definition that takes rule 3 has a non-blank `exerciseName`; otherwise the
  family's native rules are dropped for the run, gap `learn_exercise_name_unmapped`.
- The AI proposes only paths, `refersTo`, `exerciseIdentity` and `exerciseRefSpace` as data; V-L3
  and V-L6 apply; it never emits an id or sees values (L0-DOC D-L0-2). Rules come from the learned
  registry (L0-DOC D-L0-5), not the repository `sources/*.json` loader
  (`native-rule-registry.ts` L5-19).

### D-EX1-4: provenance, replay and create-only

- Kinds `coach_exercise` and `catalog_exercise_link` join provenance `native_kind`, and
  `coach_exercise` joins ledger `target_kind` for library rows (EX1-F5); child kind unchanged.
- **Target verification.** `coach_exercise`: row present, `coach_id` = coach, `archived_at` null
  (`facts.service.ts` L745-755). `catalog_exercise_link`: row with `id = native_id` exists (the
  only ownership exception). A missing row → `native_target_removed`.
- **Order.** Within a run, the `exercises` family reconstructs before `workouts`, whatever the
  staging order; a definition is written before the first child that uses it. A unique-key race on
  a definition key re-reads and converges (S8-DOC L202-203).
- **Create-only.** An existing `CoachExercise` is never updated, so coach renames survive (S8-DOC
  D-S8-4); a later source rename is value drift for S9 fingerprints. **No late child inserts** stays
  (S8-DOC L198-201): plans persisted before EX1 keep their unresolved children (R-2).

### D-EX1-5: reconciler (bucket j and closure)

- **Bucket j, the partition invariant, condition order and `COMPLETENESS_BASIS_KINDS` are
  unchanged** (S9-DOC D-S9-2). Resolved children stop counting (`facts.service.ts` L721-727).
- `exercises` library identities classify a-k like any family: kind `coach_exercise` + verified →
  j; removed → i; another coach's row → h. The kind→model map gains `CoachExercise` and
  `ExerciseCatalogItem`. Staged without native rules → `no_native_destination:exercises`, C-FAM.
- **Edge E-R4** (added to the S9 v1 edges), one per created child of a bucket-j plan: re-derive the
  child's definition key from the accepted interpretation of its staged row (the same interpreter
  facts already use); the definition provenance must exist (`created`/`already_present`), its
  target must verify (D-EX1-4), and the child row's `exercise_external_id` must equal the token
  computed from **that row** (`cx:<id>` or the catalog row's current slug). A token-string match
  alone is not closure. Failure → `relationship_unverified` (C-REL); archiving an imported
  exercise after the run therefore turns the re-read `partial`, like bucket i for a top-level row.
- A workout-only definition reaches the verdict via E-R4 only; an unused library row must be j.

### D-EX1-6: side effects and module boundary

- Creating a `CoachExercise` notifies no one, calls no video or catalog write path, uploads no
  media (S8-DOC §3.6); the writer stays inside the S8-C `native/**` import boundary.
- `ExerciseSet` (client history, S8-E1a) keeps free-text `exercise_name`, copied from the resolved
  target when EX1 resolved the definition; `muscle_group` is mapped or unresolved, never inferred.

### D-EX1-7: completeness under D1 (closes EX1-SOL-B4)

A run is `complete` only if every in-scope item is natively present and verified, or its class is
excluded by a recorded owner decision; otherwise `partial` (existing reasons; the AI decides none).

| In scope (exercise records)              | Required for `complete`                                                                                   | If not met                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Library rows (used or unused)            | bucket j                                                                                                  | C-ID / C-FAM                                                  |
| Plan exercise children                   | created; E-R4 holds; name, sets, reps/duration, weight, rest, superset, notes, order equal the staged map | C-ID / C-REL                                                  |
| Program-day revision snapshot            | revision 0 `exercises_json` equals the written children                                                   | C-REL                                                         |
| Client exercise history (`ExerciseSet`)  | S8-E1a family natively present                                                                            | C-FAM until S8-E1a lands                                      |
| Unbound fields under an exercise         | every non-id leaf bound to a column, to `notes`/`instructions`, or owner-excluded                         | family coverage `known: false`, gap `exercise_fields_unbound` |
| **Exercise media** (demo videos, images) | see below                                                                                                 | C-FAM `no_native_destination:exercise_media`                  |

- **Media presence is deterministic and fails closed.** A server rule (not an AI judgment) marks
  media present when the digest (L0-DOC `ShapeNode`) has a class-`url` string in a library-row or
  exercise-child shape; the run then carries family `exercise_media` with no native destination,
  so C-FAM keeps it `partial`.
- It stays so until the owner answers EQ-3: either media joins the promise (a copy slice, EX1-M2)
  or media is explicitly excluded (then a coach-visible note replaces the block, EX1-M1). Wording
  alone never lets a site with media reach `complete`. Detection is a lower bound: media only on a
  step the replay never ran is L0's coverage-basis gap (§8).

## 4. Collisions (stated defaults)

| Situation                                                                  | Outcome                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Same source exercise in many plans or runs                                 | One definition, one target, reused                                             |
| Same name as another source exercise, a catalog item or a coach's exercise | Separate imported row; never merged by the importer (post-import merge = EQ-1) |
| Same id on two platforms / two workspaces of one platform                  | Two identities / merges (D-S8-3 limitation until G3, recorded risk)            |
| Reference equals a catalog slug (declared or not)                          | Rule 3, custom exercise; slugs are never proof                                 |
| Every reference is a slug matching the catalog, declared                   | CX-CAT refuses; `workouts` rules dropped; `partial`                            |
| Reference equals item A's id and item B's slug                             | CX-CAT refuses (cross-column ambiguity); never picks one                       |
| Declared `tgp_catalog`, one miss or catalog read error                     | CX-CAT refuses; no reinterpretation as source space                            |
| Library row and undeclared reference share a string                        | Two keys, two rows (D-EX1-1)                                                   |
| `refersTo` declared, a reference has no library row                        | CX-REF refuses; both families' rules dropped                                   |
| Persisted key would change target kind; or targets another coach's row     | `identity_conflict` (tag `space_changed` for the first); no write              |
| Coach archived an imported exercise, then a replay                         | New children `native_target_removed`; E-R4 `partial`; never recreated          |

## 5. Owner questions (genuine product forks only)

- **EQ-1 (collisions): after import, should TGP offer the coach a "merge" or "use the TGP version"
  action when an imported exercise duplicates one of theirs or a TGP library exercise by name?**
  The importer itself never merges (stated default). **Recommendation:** yes, as a later
  coach-confirmed action that re-points future plans only and leaves past client history as it was.
  **Customer consequence:** after import a coach may see "Bench Press" twice (theirs and the
  imported one) until they tap merge; nothing a client sees changes without the coach choosing it.
- **EQ-2 (visibility): where do imported custom exercises appear?** **Recommendation:** in the
  importing coach's own exercise picker under an "Imported" label, never shared with other coaches
  and never added to the TGP library; per-use exercises from name-only sites stay inside their plans.
  **Customer consequence:** the coach can reuse their old exercises in new plans right away; clients
  only ever see the exercise name on plans assigned to them. The picker stays off until answered.
- **EQ-3 (media in the promise): does "all past client and coaching records are now in TGP"
  include exercise demo videos and images?** **Recommendation:** not for the V1 pilot: exclude media
  explicitly and show the coach "Exercise videos and images from your old platform were not copied",
  then plan a copy slice once storage and rights are settled. **Customer consequence:** with the
  exclusion, the pilot can finish `complete` while the coach's own demo videos remain only on the
  old platform and are lost if they close it; without it, every site with videos ends `partial`
  until copying is built.

## 6. Acceptance cases (bind the build slices)

- **X01** Undeclared reference `4711` → one `CoachExercise` named from `exerciseName`, child
  `cx:<id>`, definition `coach_exercise`, child `created`; `unresolved_children = 0`.
- **X02** `4711` in three plans → one row, three children. **X03** Replay (same or new intent) →
  zero new rows, `already_present`, same counts.
- **X04** Declared `tgp_catalog`, every reference a v4 catalog id → children carry that item's
  slug, kind `catalog_exercise_link`, zero `CoachExercise` rows.
- **X05** Declared `tgp_catalog`, one miss → CX-CAT refuses; zero native plans; gap recorded; not
  reinterpreted; replay after a catalog read error → same refusal. **X06** Undeclared id equal to a
  catalog slug → custom exercise (EX1-F1 regression).
- **X07** **All references coincident but unrelated:** a source whose every id is a slug equal to a
  catalog slug, declared `tgp_catalog` → CX-CAT refuses; nothing links (EX1-SOL-A1 regression).
- **X08** Reference equals item A's id and item B's slug → refused; uuid-alias pair (A's id and A's
  slug as two source ids) → slug alias refused; no first-row selection.
- **X09** Same name as another source exercise, a hand-made coach exercise or a catalog item →
  separate rows. **X10** Blank `exerciseName` → CX-NAME drops the family; zero partial writes.
- **X11** Coach renames an imported exercise, then a replay → name unchanged (create-only).
- **X12** Coach archives an imported exercise → E-R4 fails, `partial/relationship_unverified`; a
  new plan using it → `native_target_removed`. Child token right but definition provenance missing
  → E-R4 fails (token alone is not closure).
- **X13** Provenance targets another coach's row → `identity_conflict`; RLS spec: coach B cannot read
  or write coach A's `CoachExercise`; a client reads a row only via an active assignment.
- **X14** Library step with `refersTo`: library staged before and after plans (both orders) → same
  targets; a library row used by no plan → bucket j; a reference with no library row → CX-REF
  refuses; library `4711` and undeclared ref `4711` → two rows, both orders, and on replay.
- **X15** Space change: a key first written `catalog_exercise_link`, later rules imply
  `coach_exercise` → `identity_conflict` tag `space_changed`; no downgrade.
- **X16** Name-only site with `per_use` → one row per use; undeclared → `exercise_reference`.
- **X17** Media: a `url`-class path in an exercise shape → C-FAM `partial`; none → no block;
  owner-excluded (EX1-M1) → note shown, no block.
- **X18** D1 fields: every child's prescription fields, order, revision-0 snapshot and client
  history name match the staged map; an unbound non-id leaf → coverage `known: false`.
- **X19** Mobile builder, active workout and assignment-detail screens show the resolved name for
  `cx:` and catalog tokens, for existing assignments and revision snapshots, never the raw token.
- **X20** Side-effect spies zero across X01-X18; module boundary holds; stub-provider proposal passes
  V-L3/V-L6, an unseen path is refused; no paid AI call; vendor-name guard passes (CORE DIFF = 0).

## 7. Build slices (graded by consequence; the first higher-tier trigger wins, no averaging)

LOC = expected hand-written production lines. Every slice is below ~1,000, so no structural
challenge is needed. Every T4 slice needs two independent exact-head audits and the PG proof lanes.

| Slice  | Scope                                                                                                                                                                               | T0  | T1  | T2  | T3  | T4  | Trigger                                   | Depends on   | LOC     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | ----------------------------------------- | ------------ | ------- |
| EX1-0  | This record                                                                                                                                                                         |     |     |     | ✔   |     | identity and ownership design             | —            | 0       |
| EX1-A  | `CoachExercise` + RLS (owner, client-via-assignment, service_role; deny anon), migration + down; CHECK expands (EX1-F5); X13 RLS spec                                               |     |     |     |     | ✔   | RLS, tenant boundary, persisted data      | —            | 150-250 |
| EX1-B  | Grammar (`exerciseName`, `refersTo`, `exerciseIdentity`, `exerciseRefSpace`); D-EX1-2 writer; CX-REF/CX-CAT/CX-NAME; space pinning; fixtures move to v4 ids (X01-X11, X14-X16, X20) |     |     |     |     | ✔   | create-only irreversible writes, identity | EX1-A, L0 L2 | 400-600 |
| EX1-R  | Kind→model maps, E-R4, `exercises` family, D-EX1-7 field/snapshot checks, `exercise_fields_unbound` (X12, X18)                                                                      |     |     |     |     | ✔   | terminal truth (reconciliation)           | EX1-B        | 200-300 |
| EX1-C  | Name resolver: backend plan and assignment reads return `display_name` for `cx:` / catalog tokens under coach and client authorization; mobile screens (X19)                        |     |     |     |     | ✔   | tenant-scoped reads, client access        | EX1-A        | 200-300 |
| EX1-M0 | Media presence rule over the digest → `exercise_media` family, C-FAM (X17)                                                                                                          |     |     |     |     | ✔   | terminal truth                            | EX1-B        | < 100   |
| EX1-M1 | Owner-excluded media: coach-visible note replaces the block (only if EQ-3 = exclude)                                                                                                |     |     |     |     | ✔   | terminal truth                            | EX1-M0, EQ-3 | < 80    |
| EX1-M2 | Media copy to TGP storage (only if EQ-3 = include); needs its own T3 design first                                                                                                   |     |     |     |     | ✔   | storage, rights, irreversible data        | EX1-M0, EQ-3 | TBD     |

- EX1-C is T4, not T2: clients read coach-owned rows through assignments (`schema.prisma`
  L2298-2321), an authorization boundary. EX1-B moves the S11/S10b PG pins (recorded in that PR).
  EQ-2 gates only the picker, not EX1-A.

## 8. Risks, evidence gaps and what this record does not decide

- **R-1** EX1-B changes today's behaviour: slug and undeclared matches stop linking (the EX1-F1 fix).
- **R-2** Plans persisted before EX1 keep unresolved children. That this touches only fixtures is
  **unproven**: before EX1-B lands, confirm from provenance that no real coach has settled native
  plans; if one has, lifting "no late inserts" needs its own amendment.
- **R-4** CX-CAT rarely holds for real sources, so nearly every import creates custom exercises
  (intended). **R-3** Until G3, workspaces of one platform share identities (D-S8-3).
- **Gaps:** re-read against L0 r2 (naming, completeness). Media detection assumes the digest emits
  class `url` for media fields (L0 X2), unverified. Mobile citations were read, not run.
- Not decided here: EQ-1 to EQ-3; client-owned `ExerciseSet` writing (S8-E1a); the upstream
  exercise-library id space (not provable inside the reconstruct transaction, so not declarable).

## 9. Review closure (EX1-SOL at `06ad1b6`)

| Finding | Closed by                                                                                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1      | D-EX1-3 default source space; CX-CAT v4-uuid proof, slugs never proof; X07                                                                                                                                                                         |
| B1      | D-EX1-1 role-keyed definitions, typed `refersTo` + CX-REF; `sharedIdSpaces` untouched; X14                                                                                                                                                         |
| B2      | CX-CAT selects by unique `id`, refuses any slug hit; scoped catalog exception; X08                                                                                                                                                                 |
| B3      | CX-CAT failure refuses, never reinterprets; space pinning; X05, X15                                                                                                                                                                                |
| B4      | D-EX1-7 in-scope table and fail-closed media rule; EQ-3; slices regraded (EX1-C, M0-M2 T4)                                                                                                                                                         |
| Notes   | r1 EQ-1/EQ-3 (name matches) → §4 defaults; r1 EQ-2 → `per_use` default; E-R4 by provenance key; `target_kind` CHECK; registry wiring; bounded read; assignment screen; order and unused-library cases; R-2 unproven; second T3 lens still required |
