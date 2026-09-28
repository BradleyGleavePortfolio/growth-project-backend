# EX1: exercise-reference resolution (source exercise → TGP exercise)

- **Status:** T3 design record, r3 (closes re-review EX1-SOL findings at `ce825b8`, §9). Not
  merged or accepted; changes no code; nothing below has run. Slices (§7) are T4.
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
  unresolved (the child is not written, S9-DOC L123-125); slug-equal ids link by coincidence
  (EX1-F1). No real-source run is evidenced either way.
- No coach-owned exercise model exists: only the global `ExerciseCatalogItem` (`prisma/schema.prisma`
  L4332-4336), the client-owned `ExerciseSet` (L879-891, with `video_url` L890) and the legacy
  `RoutineExercise` (L907-918). L0 forbids per-source hand work (NEW SOURCE → CORE CODE DIFF = 0);
  the AI proposes data only and deterministic validators decide (L0-DOC D-L0-4, D-L0-6).

## 2. Findings at this base

| ID     | Class | Finding                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EX1-F1 | B     | **Implicit identity-space assumption.** Any reference equal to a catalog id or slug links (`native-writers.ts` L175-188). A source with slug-like ids (`bench-press`), or holding copied catalog uuids, links to a TGP exercise by string equality. Equality never proves shared identity. Conditional risk, not an observed incident.                                           |
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
  (`workouts.exercise`, `<n>:<parent>#id:<child>` / `#ord:<n>`). Only two things create a
  definition, and the key's `entity_type` names the role, so equal strings from different roles
  never meet:

| Where the definition comes from                        | Definition key `entity_type` / `source_id`        | Target kind                    |
| ------------------------------------------------------ | ------------------------------------------------- | ------------------------------ |
| Library row (the one staged step → family `exercises`) | `exercises` / exactly that step's `idField` value | `coach_exercise`               |
| Id-less child, declared `exerciseIdentity: 'per_use'`  | `workouts.exercise_use` / the child's source id   | `coach_exercise` (one per use) |

- A workout-exercise **reference** never creates a definition: it links to a library definition
  only through CX-REF (D-EX1-3), else stays `unresolved:exercise_reference` (partial). **Every
  definition is a coach-owned custom exercise with provenance**; no catalog kind exists.
- **Id-less sources.** A name is not identity (S8-DOC L217). `per_use` is valid only if the child
  shape has no id-class key; each use gets its own definition, never merging two uses.

### D-EX1-2: resolution rule (deterministic; first match wins)

Per definition key, in the settle transaction of the run that first stages it (S8-DOC §3.4):

1. **Provenance hit** → verify the target (D-EX1-4); present → reuse; removed →
   `unresolved:native_target_removed` for every child that uses it (never recreated).
2. **Otherwise** → create one `CoachExercise` owned by the importing coach, provenance kind
   `coach_exercise`; children write `exercise_external_id = 'cx:' + CoachExercise.id` (`seed:`
   precedent; ≤ 128 chars). `name` comes from the new `exerciseName` role (EX1-F4): on the library
   row, or on the child for `per_use`.
3. Nothing else: no catalog, name, fuzzy, normalised, embedding or model match anywhere in the
   path. Two source identities never share one target.

`CoachExercise` (new, slice EX1-A): `id`, `coach_id` (FK `User`), `name`, optional
`primary_muscle` / `equipment` / `instructions` only when spec-declared (`enum_unmapped` otherwise),
`archived_at`, `created_at`. RLS: owner coach and service_role; a client may read a row only
through an active assignment whose plan references its `cx:` token; deny-all to anon (S8D-DOC §3).
No source value column; provenance is the only link back (S8-DOC §3.3, TM-14).

### D-EX1-3: no automatic catalog link; the library relation must be proven (closes A1, B1)

- **No automatic catalog linking (closes EX1-SOL-A1).** A third-party source can never prove it
  shares TGP catalog identity: an equal uuid or slug may be copied, from another environment or
  hostile. EX1-B deletes the S8-C catalog path (`verifiedCatalogRefs`); the importer never reads
  `ExerciseCatalogItem` and never writes a catalog id or slug into a child. Linking an imported
  exercise to the TGP library is only the later coach-confirmed action in EQ-1.
- **The relation is declared, then proven (closes EX1-SOL-B1).** The AI may propose, as data, a
  typed `refersTo: { family: 'exercises', keyField }` on the `exerciseRef` role. A declaration is a
  request to check, never evidence; no declaration → no link. Parse time (V-L3): exactly one learned
  step maps to family `exercises`, it has native rules, and `keyField` is exactly that step's
  `idField` (the value staged as `source_id`, not another payload field) of id class (L0-DOC digest
  `int_id|uuid|short_id`). A mismatch refuses the rules.
- **Proof CX-REF** (deterministic, over this run's own staged rows only; no model, no catalog)
  holds only if **every** non-null reference of the run equals the `source_id` of **exactly one**
  library row staged in the **same run**, same `source_namespace`, from the declared `keyField`.
  A duplicate library id, a reference with no library row, a library row from an earlier run only,
  or a different namespace each fails it. All-or-nothing: one failure means no reference links.
- **When not proven** (undeclared, refused or failed): every plan in the run that carries an
  exercise reference is not written; its identity records `unresolved:exercise_reference` with
  gap `exercise_ref_unproven`, and C-FAM keeps the run `partial`. Unresolved provenance is retried
  (`native-writers.ts` L246), so a later learned version that proves the relation writes the plan
  whole; no plan is written missing exercises (S8-DOC "no late inserts", L198-201). Library rows
  still reconstruct. Nothing is guessed or reinterpreted.
- **Residual (R-5).** A declared relation over two unrelated collections that coincide on every id
  passes CX-REF; the harm stays within one coach's own imported rows from one source, the accepted
  evidence standard. Coincident ids without a declaration never link (X06).
- **CX-NAME:** every definition has a non-blank `exerciseName`, else its family's rules are
  dropped for the run, gap `learn_exercise_name_unmapped`.
- **Transactions (B3 note).** CX-REF and CX-NAME are a read-only pre-pass before settle opens. A
  read error stops the run before any write (`exercise_check_read_failed`, retryable); an error
  inside settle rolls it all back. Either gap is recorded in a fresh transaction, never the aborted one.
- The AI proposes only paths, `refersTo`, `exerciseIdentity` and `exerciseName` as data (V-L3,
  V-L6); it never emits an id or sees values (L0-DOC D-L0-2). Rules come from the learned registry
  (L0-DOC D-L0-5), not the `sources/*.json` loader (`native-rule-registry.ts` L5-19).

### D-EX1-4: provenance, replay and create-only

- Kind `coach_exercise` joins provenance `native_kind` and ledger `target_kind` (EX1-F5).
  **Target verification:** row present, `coach_id` = coach, `archived_at` null (`facts.service.ts`
  L745-755); a missing or archived row → `native_target_removed`.
- **Order.** Within a run, the `exercises` family reconstructs before `workouts`, whatever the
  staging order; a definition is written before the first child that uses it. A unique-key race on
  a definition key re-reads and converges (S8-DOC L202-203).
- **Create-only.** An existing `CoachExercise` is never updated, so coach renames survive (S8-DOC
  D-S8-4); a later source rename is value drift for S9 fingerprints. Plans persisted before EX1
  keep their children as written, including old catalog-linked ones (R-2).

### D-EX1-5: reconciler (bucket j and closure)

- **Bucket j, the partition invariant, condition order and `COMPLETENESS_BASIS_KINDS` are
  unchanged** (S9-DOC D-S9-2). Resolved children stop counting (`facts.service.ts` L721-727).
- `exercises` library identities classify a-k like any family: kind `coach_exercise` + verified →
  j; removed → i; another coach's row → h. The kind→model map gains `CoachExercise`. Staged
  without native rules → `no_native_destination:exercises`, C-FAM.
- **Edge E-R4** (added to the S9 v1 edges), one per created child of a bucket-j plan: re-derive the
  child's definition key from the accepted interpretation of its staged row (the same interpreter
  facts already use); the definition provenance must exist (`created`/`already_present`), its
  target must verify (D-EX1-4), and the child's `exercise_external_id` must equal `cx:<id>` of
  **that** row. A token-string match alone is not closure. Failure → `relationship_unverified`
  (C-REL); archiving an imported exercise later turns the re-read `partial`. A plan withheld by
  D-EX1-3 is not bucket j; it reaches the verdict as `exercise_reference`.

### D-EX1-6: side effects and module boundary

- Creating a `CoachExercise` notifies no one, calls no video or catalog path, uploads no media
  (S8-DOC §3.6); the writer stays inside the S8-C `native/**` boundary. `ExerciseSet` (S8-E1a)
  keeps free-text `exercise_name`, copied from the resolved target; `muscle_group` is never inferred.

### D-EX1-7: completeness under D1 (closes EX1-SOL-B4)

A run is `complete` only if every in-scope item is natively present and verified, or its class is
excluded by a recorded owner decision; otherwise `partial` (existing reasons; the AI decides none).

| In scope (exercise records)              | Required for `complete`                                                                                   | If not met                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Library rows (used or unused)            | bucket j                                                                                                  | C-ID / C-FAM                                                  |
| Plan exercise children                   | created; E-R4 holds; name, sets, reps/duration, weight, rest, superset, notes, order equal the staged map | C-ID / C-REL / `exercise_ref_unproven`                        |
| Program-day revision snapshot            | revision 0 `exercises_json` equals the written children                                                   | C-REL                                                         |
| Client exercise history (`ExerciseSet`)  | S8-E1a family natively present                                                                            | C-FAM until S8-E1a lands                                      |
| Unbound fields under an exercise         | every non-id leaf bound to a column, to `notes`/`instructions`, or owner-excluded                         | family coverage `known: false`, gap `exercise_fields_unbound` |
| **Exercise media** (demo videos, images) | never earned by the importer; only an owner exclusion (EQ-3) removes it from the promise                  | `partial`, gap below                                          |

- **Media never contributes to `complete`, and the importer never claims media coverage.** The
  digest's `url` class is a generic string class, not a media kind, and a bounded digest cannot
  prove absence (media ids, paths, deep or unsampled fields escape it). So no detector can say
  "this site has no exercise media", and EX1 copies none.
- **Rule (server, deterministic, not AI).** On any run that stages exercise records (library rows,
  plan children or client history, including `ExerciseSet.video_url`):
  - digest shows a media-like field there (class `url`, or a key token in a fixed generic list:
    `video`, `image`, `photo`, `thumbnail`, `gif`, `media`) → `partial`, gap
    `exercise_media_not_imported`;
  - otherwise → `partial`, gap `exercise_media_unproven` (absence not provable).
- The only way out is EQ-3. Wording, a clean digest or an AI judgment never lets exercise media
  pass. If the owner excludes media, the gap becomes a recorded owner exclusion and a persistent
  coach-visible note (EX1-M1); if included, a copy slice (EX1-M2) must earn it with its own proof.

## 4. Collisions (stated defaults)

| Situation                                                                  | Outcome                                                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Same source exercise in many plans or runs                                 | One definition, one target, reused                                           |
| Same name as another source exercise, a catalog item or a coach's exercise | Separate imported row; never merged or linked by the importer (later: EQ-1)  |
| Same id on two platforms / two workspaces of one platform                  | Two identities / merges (D-S8-3 limitation until G3, recorded risk)          |
| Reference equals a catalog id or slug (any number, any declaration)        | Never linked to the catalog; resolved only via CX-REF, else unresolved       |
| Library row and reference share a string, no `refersTo`                    | No link; plans withheld, `exercise_ref_unproven`; library row still imported |
| `refersTo` declared, one reference misses or a library id repeats          | CX-REF fails; no reference links; plans withheld; `partial`                  |
| Persisted key targets another coach's row                                  | `identity_conflict`; no write                                                |
| Coach archived an imported exercise, then a replay                         | New children `native_target_removed`; E-R4 `partial`; never recreated        |

## 5. Owner questions (genuine product forks only)

None of these gates the safe import: until answered, the importer creates coach-only custom
exercises, links nothing to the TGP library and reports media as not imported.

- **EQ-1 (duplicates and the TGP library): after import, should TGP offer the coach a "merge" or
  "use the TGP version" action when an imported exercise looks like one of theirs or a TGP
  library exercise?** **Recommendation:** yes, later, only on the coach's tap; it re-points future
  plans only and leaves past client history as it was. **Consequence:** until then the coach may
  see "Bench Press" twice (theirs and the imported one), and imported exercises never pick up TGP
  library videos or cues; nothing a client sees changes unless the coach chooses it.
- **EQ-2 (visibility): should imported exercises appear in the coach's exercise picker for new
  plans?** **Recommendation:** yes, in that coach's own picker under an "Imported" label, never
  shared with other coaches and never added to the TGP library. **Consequence:** until answered,
  imported exercises exist only inside the imported plans and the coach cannot reuse them in new
  plans; clients only ever see exercise names on plans assigned to them.
- **EQ-3 (media in the promise): does "all past client and coaching records in this site are now
  in TGP" include exercise demo videos and images?** **Recommendation:** for the V1 pilot, exclude
  media by an explicit owner decision, then plan a copy slice once storage and rights are settled.
  **Consequence:** with the exclusion, a site can finish `complete`, but that word then means "all
  records except exercise media", and the coach permanently sees "Exercise videos and images from
  your old platform were not copied" on the import result; their demos stay only on the old
  platform and are lost if they close it. Without it, every site with exercises ends `partial`
  until copying is built.

## 6. Acceptance cases (bind the build slices)

- **X01** Library row `4711` + `refersTo` proven → one `CoachExercise` named from `exerciseName`,
  children `cx:<id>`, definition `coach_exercise`, children `created`; `unresolved_children = 0`.
- **X02** `4711` in three plans → one row, three children. **X03** Replay → zero new rows.
- **X04** **Catalog uuids, hostile or copied:** every reference and every library id is a v4 uuid
  equal to an `ExerciseCatalogItem.id` → custom exercises only; zero catalog reads (query spy),
  zero catalog ids or slugs in any child (EX1-SOL-A1 regression). A proposal carrying a catalog
  space field → V-L3 refuses the unknown field before any write.
- **X05** Reference equal to a catalog slug, no library → never linked; plan withheld,
  `exercise_ref_unproven` (EX1-F1 regression).
- **X06** **Coincident but unrelated roles:** library ids and references are equal strings from
  independently keyed collections, no `refersTo` → no link, plans withheld, library rows imported
  (EX1-SOL-B1 regression). Same with `refersTo` and one extra reference → CX-REF fails, no link.
- **X07** CX-REF failures, each alone: duplicate library id; reference with no library row;
  library row staged only in an earlier run; library in another namespace; `keyField` ≠ the
  step's `idField` (parse-time refusal) → no link, plans withheld, gap named, zero partial plans.
- **X08** Unproven relation, then a later version proves it → the withheld plan is written whole
  on replay; nothing written earlier changes.
- **X09** Same name as another source exercise, a hand-made coach exercise or a catalog item →
  separate rows. **X10** Blank `exerciseName` → CX-NAME drops the family; zero partial writes.
- **X11** Coach renames an imported exercise, then a replay → name unchanged (create-only).
- **X12** Coach archives an imported exercise → E-R4 fails, `partial/relationship_unverified`; a
  new plan using it → `native_target_removed`. Child token right but definition provenance missing
  → E-R4 fails (token alone is not closure).
- **X13** Provenance targets another coach's row → `identity_conflict`; RLS spec: coach B cannot read
  or write coach A's `CoachExercise`; a client reads a row only via an active assignment.
- **X14** Library staged before and after plans (both orders) → same targets; a library row used by
  no plan → bucket j; replay keeps role separation.
- **X15** **Transactions and mixed sources:** a source with clients, a prior written plan and a
  failed CX-REF → clients reconstruct, the prior plan is untouched, new plans withheld, verdict
  `partial` with the gap; a read error in the pre-pass → no writes, `exercise_check_read_failed`
  in a fresh transaction; an error inside settle → full rollback, gap recorded afterwards.
- **X16** Name-only site with `per_use` → one row per use; undeclared → `exercise_reference`.
- **X17** Media: a `url`-class or media-key field in library, child or `ExerciseSet.video_url`
  shape → `partial`, `exercise_media_not_imported`; a non-media url → same verdict; no media-like
  field → `partial`, `exercise_media_unproven`; owner-excluded (EX1-M1) → note shown, gap cleared.
- **X18** D1 fields: every child's prescription fields, order, revision-0 snapshot and client
  history name match the staged map; an unbound non-id leaf → coverage `known: false`.
- **X19** Mobile builder, active workout and assignment-detail screens show the resolved name for
  `cx:` tokens, for existing assignments and revision snapshots, never the raw token.
- **X20** Side-effect spies zero across X01-X18; module boundary holds; stub-provider proposal passes
  V-L3/V-L6, an unseen path is refused; no paid AI call; vendor-name guard passes (CORE DIFF = 0).

## 7. Build slices (graded by consequence; the first higher-tier trigger wins, no averaging)

LOC = expected hand-written production lines. Every slice is below ~1,000, so no structural
challenge is needed. Every T4 slice needs two independent exact-head audits and the PG proof lanes.

| Slice  | Scope                                                                                                                                                            | T0  | T1  | T2  | T3  | T4  | Trigger                                   | Depends on   | LOC     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | ----------------------------------------- | ------------ | ------- |
| EX1-0  | This record                                                                                                                                                      |     |     |     | ✔   |     | identity and ownership design             | —            | 0       |
| EX1-A  | `CoachExercise` + RLS (owner, client-via-assignment, service_role; deny anon), migration + down; CHECK expands (EX1-F5); X13 RLS spec                            |     |     |     |     | ✔   | RLS, tenant boundary, persisted data      | —            | 150-250 |
| EX1-B  | Grammar (`exerciseName`, `refersTo`, `exerciseIdentity`); D-EX1-2 writer; delete catalog path; CX-REF/CX-NAME pre-pass; plan withholding (X01-X11, X14-X16, X20) |     |     |     |     | ✔   | create-only irreversible writes, identity | EX1-A, L0 L2 | 350-550 |
| EX1-R  | Kind→model map, E-R4, `exercises` family, D-EX1-7 field/snapshot checks, `exercise_fields_unbound` (X12, X18)                                                    |     |     |     |     | ✔   | terminal truth (reconciliation)           | EX1-B        | 200-300 |
| EX1-C  | Name resolver: backend plan and assignment reads return `display_name` for `cx:` tokens under coach and client authorization; mobile screens (X19)               |     |     |     |     | ✔   | tenant-scoped reads, client access        | EX1-A        | 200-300 |
| EX1-M0 | Media gap rule (`exercise_media_not_imported` / `_unproven`), C-FAM (X17)                                                                                        |     |     |     |     | ✔   | terminal truth                            | EX1-B        | < 100   |
| EX1-M1 | Owner-excluded media: recorded exclusion + persistent coach-visible note (only if EQ-3 = exclude)                                                                |     |     |     |     | ✔   | terminal truth                            | EX1-M0, EQ-3 | < 80    |
| EX1-M2 | Media copy to TGP storage (only if EQ-3 = include); needs its own T3 design first                                                                                |     |     |     |     | ✔   | storage, rights, irreversible data        | EX1-M0, EQ-3 | TBD     |

- EX1-C is T4: clients read coach-owned rows through assignments (`schema.prisma` L2298-2321).
  EX1-B moves the S11/S10b PG pins. EQ-2 gates only the picker; EQ-1 would need its own T3 design.

## 8. Risks, evidence gaps and what this record does not decide

- **R-1** EX1-B changes today's behaviour: catalog id/slug matches stop linking (EX1-F1), and a
  plan with an unproven reference is withheld instead of written without its exercises.
- **R-2** Plans persisted before EX1 keep their children. That this touches only fixtures is
  **unproven**: before EX1-B lands, confirm from provenance that no real coach has settled native
  plans; if one has, lifting "no late inserts" needs its own amendment.
- **R-3** Until G3, workspaces of one platform share identities (D-S8-3). **R-4** Plans that
  reference exercises with no library step stay `partial` (`exercise_ref_unproven`); intended.
  **R-5** Declared relation + total coincidence in one source links (D-EX1-3); one coach only.
- **Gaps:** re-read against L0 r2 (naming, completeness, digest classes). Mobile citations were
  read, not run. No real-source staging data was examined.
- Not decided here: EQ-1 to EQ-3; client-owned `ExerciseSet` writing (S8-E1a); any catalog link.

## 9. Review closure (EX1-SOL re-review at `ce825b8`)

| Finding     | Closed by                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1          | Automatic catalog linking removed (D-EX1-3); catalog path deleted in EX1-B; no catalog kind; X04 hostile/copied uuid case; catalog link only EQ-1                                                    |
| B1          | References never create definitions; `refersTo` declared + CX-REF proven on this run's staged rows (same run, namespace, `keyField` = `idField`), all-or-nothing, else withheld + gap; X06, X07; R-5 |
| B2          | Superseded: no catalog lookup remains                                                                                                                                                                |
| B3 (C note) | Read-only pre-pass; read error and settle rollback record gaps in a fresh transaction; mixed-source test X15                                                                                         |
| B4          | Media never earns `complete`; generic url class not treated as proof; `exercise_media_not_imported` / `_unproven`; `ExerciseSet.video_url`; X17                                                      |
| Notes       | EQ-2 contradiction removed (picker off until answered); EQ-3 names the override and persistent note; EQs do not gate the safe import                                                                 |
