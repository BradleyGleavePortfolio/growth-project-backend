# EX1: exercise-reference resolution (source exercise → TGP exercise)

- **Status:** T3 design decision record. Local candidate. Not merged, deployed or
  product-accepted. It changes no code, schema or API, and nothing here claims that a route,
  proof or test described below has run. The build slices (§7) are T4.
- **Date:** 2026-09-28. **Decision owner:** Bradley Gleave. The executing parent makes D-EX1-1
  to D-EX1-6. §5 lists the product forks that stay owner-reserved; none is assumed here.
- **Base:** backend `integration/importer` `d84cb7c`. Every `path Lx` citation is at this base
  unless stated otherwise. Mobile citations (`M:`) are at `growth-project-mobile` `3f91d58`.
- **Accepted sources:** "S8-DOC" = `docs/decisions/2026-09-24-s8-native-contract.md`; "S9-DOC" =
  `docs/decisions/2026-09-25-s9-reconciliation.md`; "S8D-DOC" =
  `docs/decisions/2026-09-26-s8d-person-link.md`; "L0-DOC" =
  `docs/decisions/2026-09-27-learn-and-remember.md` at `origin/cand/x42/learn-doc` `982bd286`
  (its r2 amendment is in progress; this record binds to the text as landed).

## 1. Why this exists

- Owner D1 (2026-09-28): `complete` means "All past client and coaching records in this site are
  now in TGP". A workout without its exercises is not in TGP.
- Today no imported exercise can resolve for a real source. S8-DOC L427-430 made every reference
  `unresolved:exercise_reference` "until that is confirmed". S8-C then shipped an exact check:
  a child links only when its source reference equals an `ExerciseCatalogItem.id` or `.slug`
  byte-for-byte (`src/scout/reconstruct/native/native-writers.ts` L169-188, L263-314).
- A source's exercise ids live in the source's own id space (for example numeric `4711`). They
  never equal a TGP catalog uuid or slug. So every exercise of every real source stays unresolved,
  S9 counts it in `unresolved_children` (S9-DOC L123-125), C-ID fires (S9-DOC L160-163), and no
  import with workouts can ever be `complete`.
- S8-DOC L423-426 left coach-defined exercises as `no_native_destination:exercises`, and no
  coach-owned exercise model exists: the only exercise tables are the global
  `ExerciseCatalogItem` (`prisma/schema.prisma` L4332-4336, `slug @unique`), the client-owned
  `ExerciseSet` (L879-891, free-text `exercise_name`) and the legacy `RoutineExercise` (L907-918).
- L0 forbids per-source hand work (NEW SOURCE → CORE CODE DIFF = 0). The AI may only propose
  data, gated by deterministic validators (L0-DOC D-L0-4, D-L0-6).

## 2. Findings at this base (facts the design depends on)

| ID     | Class | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EX1-F1 | B     | **Implicit identifier-space assumption.** The S8-C check links any source reference that happens to equal a catalog slug (`native-writers.ts` L175-188). A source whose own ids are slug-like (`bench-press`) would link to a different TGP exercise by coincidence. That is a silent merge by string equality. The rule must become declared, not implicit (D-EX1-2).                                                                                                                           |
| EX1-F2 | B     | **`exercise_external_id` is polymorphic.** It is "ExerciseDB catalog identifier — NOT a FK" (`schema.prisma` L2302), yet the catalog student gate matches it against catalog `id` or `slug` (`src/exercise-catalog/exercise-catalog.service.ts` L121-132), the library serves upstream ids and `seed:`-namespaced ids (`src/exercise-library/seed-catalog.ts` L9-11, L25), and the builder accepts any 1-128 char string (`src/ai/gateway/materialisers/__shared/workout-diff.types.ts` L59-63). |
| EX1-F3 | B     | **Renderers show the raw reference as the name.** Mobile builds the display name from the reference itself (`M:src/utils/workout/buildActiveWorkout.ts` L31-34; `M:src/screens/coach/CoachWorkoutBuilderScreen.tsx` L260, L848). A reference to a new coach-owned exercise would render as an opaque token unless a name resolver lands with it (slice EX1-C).                                                                                                                                   |
| EX1-F4 | C     | The native rule grammar has `exerciseRef` but no exercise **name** role (`src/scout/reconstruct/native/native-rules.ts` L62-73), so a custom exercise cannot be created from today's rules.                                                                                                                                                                                                                                                                                                      |
| EX1-F5 | C     | The provenance `native_kind` CHECK is closed at five kinds (`prisma/migrations/20270122000000_scout_native_provenance_expand/migration.sql` L141). A new kind is an additive CHECK expand, precedent S8D-DOC slice S8-E1a.                                                                                                                                                                                                                                                                       |

## 3. Decisions

### D-EX1-1: identity model

- A **source exercise identity** is `(platform, source_id)`: `source_namespace` (= `source_platform`
  until G3, S8-DOC L93-98) plus the source's own exercise-definition id. It is recorded on the
  D-S8-3 key as `(coach_id, source_namespace, 'exercises', source_id)`.
- The `source_id` is the value of the spec-declared `exerciseRef` role, never a name and never
  model output (L0-DOC D-L0-6: "the model names a key; it never emits an id").
- The identity is **per definition, not per use.** The same source exercise used in 40 workouts
  is one identity and one native target. The per-use child identity stays S8-DOC §3.3
  (`workouts.exercise`, `<n>:<parent>#id:<child>` / `#ord:<n>`), unchanged.
- A source may also stage an exercise library as its own step. That step maps to a new canonical
  family `exercises` (a TGP-side family, so a core change by design, S8-DOC D-S8-1). Its rows and
  the references inside workouts share **one** id space only when the spec declares it with the
  existing `sharedIdSpaces` rule (`src/scout/reconstruct/mapping-spec.ts` L383-433). Without that declaration a
  workout's reference and a library row with the same id are two identities.
- **Id-less sources.** A source whose exercises have no id (name only) has no definition identity.
  Until owner question EQ-2 is answered, each such child is `unresolved:exercise_reference`.

### D-EX1-2: resolution rule (deterministic, conservative, first match wins)

Per definition identity, in one transaction with the parent plan (S8-DOC §3.4):

1. **Provenance hit.** Provenance exists for the identity → verify the target (D-EX1-4 kinds).
   Present → reuse it. Removed → `unresolved:native_target_removed` for every child that uses it
   (never recreated; coach removal is an edit, S8-DOC §3.5).
2. **Declared catalog link.** Only if the source's native rules declare
   `exerciseRefSpace: 'tgp_catalog'` for the reference role **and** the reference equals an
   `ExerciseCatalogItem.id` or `.slug` byte-for-byte (today's check, now gated by the
   declaration). The child writes `exercise_external_id` = the catalog **slug** (canonical form;
   the student gate accepts it, `exercise-catalog.service.ts` L131). Provenance: kind
   `catalog_exercise_link`, `native_id` = the catalog item id.
3. **Coach-owned custom exercise.** Otherwise (`exerciseRefSpace` absent or `'source'`, which is
   the default): create one `CoachExercise` row owned by the importing coach, with provenance kind
   `coach_exercise`. The child writes `exercise_external_id = 'cx:' + <CoachExercise.id>` (the
   `seed:` namespacing precedent, `seed-catalog.ts` L9-11; ≤ 128 chars, `workout-diff.types.ts`
   L63). The row's `name` comes from a new required `exerciseName` rule (EX1-F4). A null or blank
   name → the child is `unresolved:missing_required_field:exercise_name`, and no row is created.
4. Nothing else. There is **no** name match, fuzzy match, normalisation, embedding match or model
   suggestion anywhere in the resolution path. A catalog item and a custom exercise are never
   merged, and two source identities never share one native target.

`CoachExercise` (new, coach-owned, slice EX1-A): `id`, `coach_id` (FK `User`), `name`, optional
`primary_muscle` / `equipment` / `instructions` only when spec-declared (enum or text rules,
`enum_unmapped` otherwise), `archived_at`, `created_at`. RLS: owner-coach and service_role only,
deny-all to anon (S8D-DOC §3 pattern). There is no source value column: provenance is the only
link back to the source (S8-DOC §3.3; no raw payload, TM-14). Source timestamps are not written
into audit columns (S8-DOC L185-187).

### D-EX1-3: the AI may propose the declaration; validators decide it

- The L0 learn step may propose, as data inside `NativeRuleSet` (L0-DOC D-L0-4 grammar): the
  `exerciseRef` path, the `exerciseName` path, the optional attribute paths and
  `exerciseRefSpace ∈ {'source', 'tgp_catalog'}`. V-L3 (`parseNativeRuleSet`) and V-L6 (every path
  resolves in the digest) apply unchanged.
- **New conformance check C5** (pure, before any native write, next to L0-DOC C1-C4):
  `exerciseRefSpace = 'tgp_catalog'` holds for a run only if **every** non-null staged reference
  of the family verifies in the catalog. One miss drops the declaration to `'source'` for that run
  and records gap `learn_exercise_space_refused`. There is no per-row partial credit (C3 rule).
- **C6:** when any child would take rule 3, `exerciseName` must resolve to a non-blank text for
  **every** such child; otherwise that family's native rules are dropped for the run (evidence
  path, C3 precedent) with gap `learn_exercise_name_unmapped`. An all-null name column means a
  wrong path.
- The AI never proposes a mapping from a source exercise to a catalog item, never emits an id and
  never sees values (digest only, L0-DOC D-L0-2). A coach-confirmed "link to catalog" suggestion
  is possible later, outside the importer (EQ-1); it never affects a verdict.

### D-EX1-4: provenance, replay and create-only

- Two new provenance kinds (EX1-F5 CHECK expand): `coach_exercise` (a coach-owned target) and
  `catalog_exercise_link` (a verified reference to a global row). Child provenance
  `workouts.exercise` / `workout_plan_exercise` is unchanged.
- **Target verification.** `coach_exercise`: row present, `coach_id` = coach, `archived_at` null
  (the `checkNative` rule, `src/scout/reconciliation/facts.service.ts` L745-755).
  `catalog_exercise_link`: the catalog row exists; ownership is not applicable to a global row,
  and this is the only kind with that exception. A deleted catalog row → `native_target_removed`.
- **Definition before use.** The definition provenance and any `CoachExercise` are written in the
  same transaction as the first plan that uses them, before that plan's children. A unique-key race
  on the definition key re-reads and converges (S8-DOC L202-203).
- **Create-only.** An existing `CoachExercise` is never updated by a later pass, so coach renames
  survive (S8-DOC D-S8-4). A later source rename is value drift and belongs to S9 fingerprints.
- **No late child inserts stays in force** (S8-DOC L198-201). A plan imported before EX1 keeps its
  persisted `unresolved:exercise_reference` children. No real-source import has settled natively
  at this base, so the practical effect is limited to test and proof fixtures (recorded risk R-2).

### D-EX1-5: effect on the reconciler (bucket j and the child count)

- **Bucket j is unchanged in meaning** (S9-DOC D-S9-2 row j): a top-level identity with native
  kind, provenance `created` or `already_present`, and a present, owned, not archived row.
- `workouts` identities: a bucket-j plan whose children now resolve contributes **zero**
  `unresolved_children`. Children count only if `native_kind = workout_plan_exercise` and outcome
  `unresolved` (`facts.service.ts` L722-727), so resolved children stop firing C-ID.
- `exercises` family (a staged library step): its identities classify through a-k like any
  family. Kind `coach_exercise` or `catalog_exercise_link` + verified target → **bucket j**.
  Removed → bucket i. Other coach's row → bucket h. The kind→model map in S9-B gains the two kinds
  (`CoachExercise`, `ExerciseCatalogItem`). When `exercises` is staged but has no native rules, it
  stays `unresolved:no_native_destination:exercises` and C-FAM fires, as today.
- A definition that is only referenced from workouts, and never staged as a row, is not a staged
  identity. It never enters the partition, and its effect reaches the verdict only through edge
  E-R4 below.
- **New closure edge E-R4** (added to S9-DOC D-S9-2 v1 edges): for each created child under a
  bucket-j plan, the child's `exercise_external_id` equals the token of its definition's verified
  target (`cx:<id>` or the catalog slug), and that target verifies (D-EX1-4). A coach archiving an
  imported custom exercise after the run therefore makes the re-read `relationship_unverified`
  (C-REL). This is the same truthfulness as bucket i for a top-level row.
- The partition invariant, the order of conditions and `COMPLETENESS_BASIS_KINDS` are unchanged.
  EX1 removes the structural reason exercises could never be complete; coverage (D-S9-3, L0-DOC
  D-L0-6) still decides whether a run can be.

### D-EX1-6: side effects and module boundary

- Creating a `CoachExercise` notifies no one, enrols no one, calls no video provider or catalog
  write path and uploads no media (S8-DOC §3.6). The writer stays inside
  `src/scout/reconstruct/native/**` with the S8-C import boundary; the notifications and drip spies
  still record zero calls.
- Client-owned history (`ExerciseSet`, S8-E1a) keeps its free-text `exercise_name`. When EX1 has
  resolved the same definition, S8-E1a copies the resolved target's name; its required
  `muscle_group` enum is still mapped or unresolved, never inferred from a name.

## 4. Collisions (resolved by the rules above; not product forks)

| Situation                                                        | Outcome                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Same source exercise in many workouts of one run or many runs    | One definition identity, one target, reused (D-EX1-1)                          |
| Two source exercises with the same name                          | Two identities, two `CoachExercise` rows. Names are not identity (S8-DOC L217) |
| Same exercise id on two platforms                                | Two identities (namespace differs)                                             |
| Same id in two workspaces of one platform                        | Merges; D-S8-3 recorded limitation until G3                                    |
| Source id is slug-like and equals a catalog slug, no declaration | Rule 3, custom exercise. No link by coincidence (closes EX1-F1)                |
| Declared `tgp_catalog`, but one reference misses                 | C5 drops the declaration for the run; every child takes rule 3                 |
| Provenance points at another coach's `CoachExercise`             | `unresolved:identity_conflict` for each child that uses it; no write           |
| Coach archived an imported custom exercise, then a replay runs   | Children of new plans: `unresolved:native_target_removed`; never recreated     |

## 5. Owner questions (product forks; recommendations only, nothing assumed)

- **EQ-1: exact-name catalog match.** A source exercise named exactly "Barbell Bench Press" when the
  catalog has that name. Link it to the catalog (TGP video and instructions) or keep it custom?
  **Recommendation: keep custom** (D-EX1-2 rule 3). Names are not identity, and a silent link can
  change what a client is shown. Offer a later, coach-confirmed "use TGP version" action that
  re-points future edits only and never counts toward the import verdict.
- **EQ-2: id-less sources.** The source lists exercises by name only. Treat the exact trimmed name
  as the identity inside one source namespace, declared as data (`exerciseIdentity: 'label'`) and
  checked for uniqueness per run? **Recommendation: yes**, only when declared, byte-exact after
  trim, never across namespaces. Otherwise such imports can never be `complete` under D1.
- **EQ-3: an existing coach exercise with the same name** (made by hand, or imported from another
  platform). Create a separate imported row or merge? **Recommendation: separate row** with an
  "Imported" marker and a later coach-driven merge tool. Never merge silently.
- **EQ-4: visibility.** Do imported custom exercises appear in the coach's exercise picker and
  library, or only inside imported plans? Clients see only the name on an assigned plan.
  **Recommendation:** visible to the owning coach in the picker under "Imported"; never shared
  with other coaches; never added to the global catalog.
- **EQ-5: exercise media** (source demo videos or images). Does "all records" (D1) include media?
  **Recommendation:** not in v1. Hot-linking a source CDN leaks and expires, and copying needs a
  storage and rights decision. Report the gap truthfully as a family qualifier
  `exercise_media_not_imported` (not a per-row failure), so `complete` is never read as "videos
  copied". If the owner says media is required, it becomes a blocking family and a new slice.

## 6. Acceptance cases (bind the build slices)

- **X01** Source reference `4711` with no declaration → one `CoachExercise` named from
  `exerciseName`, child `exercise_external_id = 'cx:<id>'`, definition provenance
  `coach_exercise` + child provenance `created`; S9 `unresolved_children = 0`.
- **X02** The same `4711` in three plans of one run → exactly one `CoachExercise`, three children
  pointing at it.
- **X03** Replay of X01 (same or new intent) → zero new rows, `already_present`, same outcomes and
  counts (S8-DOC §3.4).
- **X04** Declared `tgp_catalog`, every reference verifies → children carry catalog slugs, kind
  `catalog_exercise_link`, zero `CoachExercise` rows.
- **X05** Declared `tgp_catalog`, one reference misses → C5 refuses the declaration; every child
  takes rule 3; gap `learn_exercise_space_refused` recorded; no mixed linking.
- **X06** Undeclared slug-like source id equal to a catalog slug → custom exercise, **not** a
  catalog link (EX1-F1 regression).
- **X07** Two source exercises with the same name → two rows (no name merge). The same name as an
  existing hand-made coach exercise → a separate row (pending EQ-3).
- **X08** Blank `exerciseName` for a rule-3 child → C6 drops the family's native rules for the run
  (evidence path) with gap `learn_exercise_name_unmapped`; a mixed run never writes partial natives.
- **X09** Coach renames an imported `CoachExercise`, then a replay → the name is unchanged by the
  import (create-only).
- **X10** Coach archives an imported `CoachExercise`, then a reconcile read → E-R4 inconsistent,
  `partial/relationship_unverified`; a new plan using it → child `native_target_removed`.
- **X11** Provenance targets another coach's row → `identity_conflict`, no write; cross-tenant RLS
  spec denies coach B read or write of coach A's `CoachExercise`.
- **X12** Staged `exercises` library step with rules → bucket j per identity; without rules →
  `no_native_destination:exercises` and C-FAM.
- **X13** Side-effect spies record zero calls across X01-X12; the module-boundary check passes.
- **X14** Mobile builder and client workout screens render the `CoachExercise` name for a `cx:`
  reference and the catalog name for a slug; never the raw token (EX1-F3).
- **X15** Learned path: a stub-provider proposal with `exerciseRefSpace` and `exerciseName` passes
  V-L3/V-L6; a proposal whose name path the digest never saw is refused (V-L6). No paid AI call.
- **X16** Vendor-name guard passes; no core file names a source (NEW SOURCE → CORE DIFF = 0: a new
  source's exercises resolve through data only).

## 7. Build slices (graded; the max-tier rule applies)

LOC = expected hand-written production lines (tests, fixtures and generated contracts excluded).

| Slice | Scope                                                                                                                                                                                                                                                 | T0  | T1  | T2  | T3  | T4  | Depends on   | LOC     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | ------------ | ------- |
| EX1-0 | This record                                                                                                                                                                                                                                           |     |     |     | ✔   |     | —            | 0       |
| EX1-A | Schema: `CoachExercise` + RLS (owner coach, service_role; deny anon) + migration and down; provenance `native_kind` CHECK expand (`coach_exercise`, `catalog_exercise_link`); `RECONSTRUCT_FAMILY.exercises`; RLS spec (X11)                          |     |     |     |     | ✔   | owner EQ-4   | 150-250 |
| EX1-B | Grammar + writer: `exerciseName` / attribute / `exerciseRefSpace` rules; D-EX1-2 resolution in `native-writers.ts`; definition provenance; C5/C6 in the L0 conformance module; existing fixtures declare `tgp_catalog` explicitly (X01-X09, X13, X15) |     |     |     |     | ✔   | EX1-A, L0 L2 | 350-500 |
| EX1-R | S9-B kind→model map for the two kinds; E-R4 edge; `exercises` family entry; S9 fixtures R-EX (X10, X12)                                                                                                                                               |     |     |     |     | ✔   | EX1-B        | 150-250 |
| EX1-C | Name resolver: backend plan-exercise reads return `display_name` resolved from `cx:` / catalog; mobile builder and client screens use it (X14); contract regen via the single generator owner                                                         |     |     | ✔   |     |     | EX1-A        | 200-300 |
| EX1-M | Media qualifier `exercise_media_not_imported` (only if EQ-5 = not in v1)                                                                                                                                                                              |     | ✔   |     |     |     | EQ-5         | < 60    |

- Every slice stays below ~1,000 prod LOC, so no structural challenge is needed. EX1-A, EX1-B and
  EX1-R are T4 because they touch tenant-scoped schema and RLS, create-only native writes and the
  verdict. EX1-C is T2: a read-path change inside the established architecture.
- PG proofs run on the `proof/harness` lanes. The fixture change in EX1-B moves the S11 and S10b
  pins; the new totals are recorded in that PR, never assumed here.

## 8. Risks and what this record does not decide

- **R-1** EX1-B changes today's behaviour: an undeclared reference that equals a catalog slug no
  longer links. That is the intended fix for EX1-F1, and the fixtures must declare their space.
- **R-2** Pre-EX1 test imports keep their unresolved children (no late inserts). Lifting that rule
  needs its own amendment with an order-collision rule; it is not proposed here.
- **R-3** Until G3, two workspaces of one platform share exercise identities (D-S8-3).
- Not decided here: EQ-1 to EQ-5; the upstream exercise library id space (not verifiable inside the
  reconstruct transaction without an external call, so it is not a declarable space in v1);
  client-owned `ExerciseSet` writing (S8-E1a).
