# FAM-0: every reachable family lands in TGP (native map + preserve destination) — r3

- **Status:** T4 design record, draft, r3 (closes R590-A, R590-B, R590-A2, R590-B2; §11). It
  changes no code, schema or API. It binds the FAM-\* build slices in §7, each graded separately
  (T4). Not merged, not product-accepted.
- **Date:** 2026-09-29. **Decision owner:** Bradley Gleave (repo owner).
- **Base:** backend `integration/importer` at `d6cf9eb6`. Every `path Lx` citation is at this base
  unless it names another record.
- **Records this extends:** "S8-DOC" = `docs/decisions/2026-09-24-s8-native-contract.md`;
  "S8D-DOC" = `docs/decisions/2026-09-26-s8d-person-link.md`; "S9-DOC" =
  `docs/decisions/2026-09-25-s9-reconciliation.md`; "EX1-DOC" =
  `docs/decisions/2026-09-28-ex1-exercise-resolution.md`; "RESET" = the executive reset of
  2026-09-29 (orchestrator, binding; recorded in the L0 r5 record); "L0-DOC" = the
  learn-and-remember record **r5** (`docs/decisions/2026-09-27-learn-and-remember.md` on
  `cand/x43/learn-doc-r2`, written in parallel). L0 references name a RESET section or an r5
  decision id (D-L0-6.3 projection; slice L2d), never a line number.
- **Binding projection decisions (orchestrator, 2026-09-29; r5 adopts them verbatim):**
  `families[]` rows carry **no `destination` field** (a partly-native family is expressed by
  `moved_native` + `preserved`); `NotMovedReason` is the closed seven-code enum of §6.3; the
  catch-all preserved label is `unclassified`; a counted fact → `not_moved`, an unknown → `gaps`;
  unknown = `null`.
- **Open PRs this depends on:** #587 (S8-D3 person-owned schema and RLS), #588 (L2a one
  `SourceRegistryProvider`), #589 (L3 per-family evidence grammar), #577 (S8-D2 roster).

## 1. Owner directive, the reset, and what this record decides

Owner, 2026-09-29: there are **no unsupported families**. Anything reachable on a source site moves
into TGP, native or preserved. `complete` = every reachable client and coaching record is in TGP
with every list proven exhausted.

RESET §1 defers the completeness proof: until a separate completeness-closure record lands, no
package type has a run-level closure, and every run settles `partial` with gap
`completeness_not_proven` (test-only `source_signed_enumeration` excepted). **FAM-0 therefore
defines no `complete` mechanics beyond this one rule: native and preserved records both count as
"in TGP" once the coach can view them (§6.1).** Everything else about `complete` is an input to
the closure record (§6.4).

This record decides:

1. A closed, vendor-neutral **family catalogue** (§3). A record's destination is a deterministic
   function of its family, the gate state and its typed rules, never a model choice.
2. **One canonical record and one native write path** (§4.3, §4.6): every destination consumes
   the same sanitized record, and every native writer, existing or new, resolves a preserved row
   for the same identity in its own transaction. Native-first and graduated writes are
   value-identical by construction.
3. **PRESERVE** (§4): tenant-scoped, person-linked, idempotent, credential-safe, displayed to the
   coach, never read by AI.
4. **Media** (§5): clean-scan gate, immutable content-addressed blobs, reference-counted erasure,
   per-bucket copies so graduated media plays on existing screens.
5. **Reconciliation inputs** (§6) and the codes FAM-0 maps into the L0-owned
   `RunStatusProjectionV1`.
6. **Slices** (§7) in landable order; erasure hooks land before any client-data or media writer.

Today's facts that make this necessary:

- The canonical allow-list has four families (`src/scout/scout-reconstruct.dto.ts` L13-18); the
  spec grammar's `families` object is closed to them (`src/scout/reconstruct/mapping-spec.ts`
  L114-125). Native kinds are `person`, `workout_program`, `workout_plan`,
  `workout_plan_exercise` (`native-contract.ts` L16-21; CHECKs at
  `prisma/migrations/20270122000000_scout_native_provenance_expand/migration.sql` L141, L191).
- Every client-owned native table has a required `User` FK (S8-DOC D-S8-2). #587 adds `person_id`
  on five tables (S8D-DOC §2.1). Messages, food, water, targets, meal plans and sessions are not
  among them.
- A staged token with no family ends `unresolved_family:<token>`; a family with no native
  destination ends `unresolved:no_native_destination:<family>` (S8-DOC §3.7). Neither may remain
  the terminal answer for reachable coaching data.
- The ingest redactor (`src/scout/scout-ingest.service.ts` L82-95, L149-183) runs with no spec in
  scope and existing native writers read the staged payload (`native-rules.ts` L435 reads
  `program_id`; `reconciliation/facts.service.ts` L830-845 reads it too), so no value-shape rule
  may run at ingest (§4.3).

## 2. Inventory of TGP native destinations (`prisma/schema.prisma`)

Owner: C = coach-owned; P = client/person-owned (keyed on the client's `User` today); G = global.
RLS "in-tree" = a `prisma/migrations/<dir>/migration.sql`; "out-of-band" = only
`prisma/migrations/rls_fitness_backend.sql` (S8D-DOC §2.2). The application connects as
`service_role`; every import read and write asserts `coach_id = caller` in code.

| Model (schema lines)                                               | Owner  | RLS today                                                                                                    | Import identity                                                                     | Required fields                                                                                          | Surfaces / side effects                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Person` (L6959-6973)                                              | C      | In-tree service_role only, RESTRICTIVE deny-all (`20261223000200_scout_reconstruction/migration.sql` L73-86) | `@@unique([coach_id, source_platform, source_person_id])`; provenance kind `person` | `coach_id`, `source_platform`, `source_person_id`                                                        | Roster (#577, `src/scout/scout-roster.service.ts`). No `archived_at`; states are lifecycle only (S8D-DOC §2.3)                                                                                                                                                                                                |
| `UserProfile` (L755-806)                                           | P      | Out-of-band (`rls_fitness_backend.sql` L91-92)                                                               | `user_id @unique`; no person path                                                   | `user_id`                                                                                                | Profile; AI context                                                                                                                                                                                                                                                                                           |
| `WorkoutProgram` (L2183-2236)                                      | C      | In-tree (`20261215000000_mwb_1_data_model`)                                                                  | Provenance `workout_program` (`native-writers.ts` L92)                              | `coach_id`, `owner_user_id`, `name`, `weeks`, `days_per_week`                                            | Builder; has `archived_at`                                                                                                                                                                                                                                                                                    |
| `WorkoutPlan` (L2141-2174) + `WorkoutPlanExercise` (L2298-2321)    | C      | In-tree (`20260508000001_rls_workout_builder`)                                                               | Provenance `workout_plan`; child `workouts.exercise` (`native-contract.ts` L45)     | `coach_id`, `name`, `type`; child `exercise_external_id`, `order`, `sets`                                | Builder; has `archived_at`                                                                                                                                                                                                                                                                                    |
| `ExerciseCatalogItem` (L4332-4381)                                 | G      | In-tree                                                                                                      | Never an import target (EX1-DOC D-EX1-1, D-EX1-3)                                   | —                                                                                                        | —                                                                                                                                                                                                                                                                                                             |
| `CoachExercise` (EX1-A; not in schema yet)                         | C      | Planned (EX1-DOC D-EX1-2)                                                                                    | Provenance `coach_exercise`                                                         | `coach_id`, `name`                                                                                       | Planned EX1-C; demo media column defined there                                                                                                                                                                                                                                                                |
| `ClientWorkoutAssignment` (L2323-2358)                             | P      | In-tree on `auth.uid()`                                                                                      | Provenance planned (S8-E1d)                                                         | plan, client, coach, `scheduled_for`                                                                     | Schedules                                                                                                                                                                                                                                                                                                     |
| `WorkoutSession` (L862-877) + `ExerciseSet` (L879-891)             | P      | Session out-of-band (L142-146); sets in-tree                                                                 | Provenance planned (S8-E1a)                                                         | `user_id`, `date`, `workout_name`, `workout_type`; set `exercise_name`, `muscle_group`, `sets_completed` | Workout history; leaderboard; AI context                                                                                                                                                                                                                                                                      |
| `WeightLog` (L930-941)                                             | P      | Out-of-band (L135-139)                                                                                       | Provenance planned (S8-E1b)                                                         | `user_id`, `date`, `weight_lbs`                                                                          | Timeline; digest                                                                                                                                                                                                                                                                                              |
| `CheckIn` (L1102-1133)                                             | P      | In-tree (`20260607000000_rls_remaining_gaps` L352-391)                                                       | `@@unique([user_id, date])` L1129 (collides)                                        | `user_id`, `date`, `soreness`                                                                            | Coach queue on `reviewed_by_coach = false` (`src/coach/coach.service.ts` L728). No photo columns                                                                                                                                                                                                              |
| `Habit` (L1036-1045) + `HabitLog` (L1047-1058)                     | P      | Habit out-of-band; log in-tree                                                                               | Provenance planned (S8-E1c)                                                         | Habit `user_id`, `name`; log `habit_id`, `date`                                                          | Habits                                                                                                                                                                                                                                                                                                        |
| `CoachMessage` (L1189-1229)                                        | P      | In-tree participant policy (`20260607000000_rls_remaining_gaps` L312-313)                                    | Only `ai_draft_id @unique`; no import key                                           | `body` or `voice_url` (service rule)                                                                     | Thread ordered on `created_at` (index L1227); push and PTM (`src/messaging/messaging.service.ts` L461, L493-499, L548); `voice_url` bucket check L214-249; AI context (`src/ai/client-ai-context.service.ts` L192); `coach_id` = head coach, `sender_id` = author (`coach-effectiveness.service.ts` L466-469) |
| `Message` (L685-704)                                               | P      | In-tree                                                                                                      | none                                                                                | —                                                                                                        | Legacy; **not a destination**                                                                                                                                                                                                                                                                                 |
| `LoggedFoodEntry` (L838-860)                                       | P      | Out-of-band (L197-201)                                                                                       | `client_uuid @unique` (offline queue; not import identity)                          | `user_id`, `date`, `meal_type`, `food_item_id`                                                           | Log; AI context. No `coach_id` column                                                                                                                                                                                                                                                                         |
| `FoodItem` (L808-836)                                              | **G**  | In-tree                                                                                                      | `barcode @unique`                                                                   | name, serving, macros                                                                                    | Food search for every user (`src/food/food.service.ts` L162): an imported food here leaks across tenants                                                                                                                                                                                                      |
| `WaterLog` (L1170-1181)                                            | P      | In-tree                                                                                                      | none                                                                                | `user_id`, `amount_ml`                                                                                   | No `coach_id` column                                                                                                                                                                                                                                                                                          |
| `MacroTarget` (L2390-2408)                                         | P      | In-tree (L78-79)                                                                                             | none                                                                                | `client_id`, `coach_id`, four macros                                                                     | Has `archived_at`                                                                                                                                                                                                                                                                                             |
| `MealPlan` (L1142-1168)                                            | P or C | In-tree (`rls_tier3_nutrition` L36-47)                                                                       | none                                                                                | `title`, `items`                                                                                         | Has `archived_at`                                                                                                                                                                                                                                                                                             |
| `CoachingSession` (L3081-3134) + `SessionParticipant` (L3139-3150) | C + P  | In-tree                                                                                                      | `provider_idempotency_key` (live only)                                              | `coach_id`, `start_at`, `end_at`, `title`, `status`                                                      | `src/scheduling/jobs/reminder.job.ts` L46-47 sends reminders for `scheduled`; open-slot computation (`scheduling-open-slots.service.ts` L90-97)                                                                                                                                                               |
| `CoachMediaAsset` (L5212-5241)                                     | C      | none in-tree                                                                                                 | `mux_upload_id @unique`                                                             | —                                                                                                        | Sellable content (`ClientAssetGrant` L5261-5271). **Not a destination for client media**                                                                                                                                                                                                                      |
| `BloodworkAttachment` (L2898-2914)                                 | P      | In-tree tier-1                                                                                               | —                                                                                   | —                                                                                                        | Precedent: `scan_status` lifecycle for uploaded files                                                                                                                                                                                                                                                         |

Findings that shape §3-§7:

- **FI-1.** Six more client-owned destinations need the #587 person expansion: `CoachMessage`,
  `LoggedFoodEntry`, `WaterLog`, `MacroTarget`, `MealPlan`, `CoachingSession`. Shape: nullable
  `person_id`, exactly-one-owner CHECK, `person_id IS NULL` guard on every non-owner RLS branch,
  and the tenant FK: composite `(person_id, coach_id) → Person(id, coach_id)` where the table has a
  `coach_id` column; a plain `person_id → Person(id)` FK with `Person.coach_id = caller` asserted
  in the writer where it has none (`LoggedFoodEntry`, `WaterLog`; the #587 pattern for
  `WorkoutSession`, `WeightLog`, `Habit`) (R590-B-C1). Until a table has it, its family is
  preserved.
- **FI-2.** `FoodItem` is global. Food logs need a tenant-scoped food row first (FAM-N2a).
- **FI-3.** `CoachMessage.created_at` is the only event-time column that a screen orders on
  (D-FAM-4). `LoggedFoodEntry` and `HabitLog` carry a calendar `date` that the app shows.
- **FI-4.** Imported history must produce **no attention signal**: message push and PTM, unread
  badges, session reminders, the check-in review queue, and `created_at`-window platform metrics
  (`src/admin/metrics.service.ts` L54-55). D-FAM-4 gives one mechanism for all of them.
- **FI-5.** The media store is a provider interface (`src/coach-media/storage-provider.ts` L82
  signed upload, L96 signed download, L116 delete) over one bucket. Client media needs its own
  tables and bucket (§5).

## 3. Canonical family set

### D-FAM-1: the closed catalogue; destination is derived, never proposed

The catalogue extends `RECONSTRUCT_FAMILY` (`scout-reconstruct.dto.ts` L13-18) and
`CANONICAL_FAMILIES` (`mapping-spec.ts` L69). Adding a family is a deliberate core change with no
source names (S8-DOC D-S8-1). Child families (`<family>.<child>`) are provenance and preserve
namespaces only, never staged families.

**Destination determinism (R590-B-B9, R590-A2-06).** A learned or authored spec (and therefore
the model, via L0-DOC `LearnedProposalV1`) proposes **data only**: a `family` from this catalogue
(including `unclassified`) and a field mapping with value classes (§4.3). It never proposes a
destination or a group. The destination is decided **per record** by one pure function,
`destinationFor(family, gateState, typedResult) → 'native' | 'preserve'`: `native` iff the writer
registry (D-FAM-3) lists a native writer for the family **and** that writer's typed interpretation
of the canonical record is `ok`; otherwise `preserve`. A family can therefore be partly native
and partly preserved (collision losers, foreign authors, unresolved persons); the projection
expresses that with `moved_native` and `preserved` counts and has no family-level destination
field (§6.3). The catalogue is the single token set: `unclassified` is the catch-all; there is no
`PreserveGroup` and no `other`. `entity_type` in the identity key is always the family, so a
record is keyed identically whichever destination it first landed in.

| Family                | Owner | Native model (when the gate is open)                                 | Gate                                          |
| --------------------- | ----- | -------------------------------------------------------------------- | --------------------------------------------- |
| `clients`             | C     | `Person` (always native, including former clients; D-FAM-2)          | exists (S8-D1)                                |
| `client_profile`      | P     | none yet (OQ-6)                                                      | a person-capable profile design               |
| `programs`            | C     | `WorkoutProgram`                                                     | exists (S8-C)                                 |
| `workouts`            | C     | `WorkoutPlan`; child `workouts.exercise` → `WorkoutPlanExercise`     | exists (S8-C); withheld plan (EX1) ⇒ preserve |
| `exercises`           | C     | `CoachExercise`                                                      | EX1-A, EX1-B                                  |
| `workout_assignments` | P     | `ClientWorkoutAssignment`, inactive                                  | #587 + S8-E1d + S8D-DOC OQ-12                 |
| `workout_logs`        | P     | `WorkoutSession`; child `workout_logs.set` → `ExerciseSet`           | #587 + S8-E1a                                 |
| `client_history`      | P     | none (legacy generic token; new runs preserve only, §4.1)            | none: new specs must name a specific family   |
| `messages`            | P     | `CoachMessage`                                                       | FAM-N1                                        |
| `food_logs`           | P     | `LoggedFoodEntry` + tenant food row                                  | FAM-N2a + FAM-N2b                             |
| `water_logs`          | P     | `WaterLog`                                                           | FAM-N2b                                       |
| `nutrition_targets`   | P     | `MacroTarget`                                                        | FAM-N2c                                       |
| `meal_plans`          | C / P | `MealPlan` (`client_id`/`person_id` NULL ⇒ coach template)           | FAM-N2c                                       |
| `checkins`            | P     | `CheckIn`                                                            | #587 + S8-E1b                                 |
| `body_weights`        | P     | `WeightLog`                                                          | #587 + S8-E1b                                 |
| `body_measurements`   | P     | none                                                                 | a native design                               |
| `habits`              | P     | `Habit`; child `habits.log` → `HabitLog`                             | #587 + S8-E1c                                 |
| `coaching_sessions`   | C / P | `CoachingSession` (terminal statuses only; D-FAM-4)                  | FAM-N6                                        |
| `notes`, `goals`      | P     | none                                                                 | a native design                               |
| `forms`               | C     | none                                                                 | a native design                               |
| `form_responses`      | P     | none                                                                 | a native design                               |
| `media`               | C / P | preserved media (§5) attached to its parent                          | FAM-M1 (until then: not moved, with a reason) |
| `billing_history`     | P     | none; **default not moved** (`not_moved: excluded_by_policy`; OQ-1)  | owner answer to OQ-1                          |
| `unclassified`        | C / P | none (a reachable coaching collection the mapping cannot name; OQ-7) | —                                             |

Non-records (account settings, UI configuration, third-party service data) stay out of scope by
the structural exclusion rule and RESET §5, never by a model choice. Placement follows RESET §6:
an **owner-confirmed exclusion with a count** (billing under OQ-1) is `not_moved:
excluded_by_policy`; a collection left unmapped or undetermined is a **gap** (`collection_unmapped`,
`third_party_not_imported`; L0-DOC D-L0-6.3). Never both (R590-B2-B1).

### D-FAM-2: per-family contract

**Common rules** (extending S8-DOC §3; nothing relaxes it):

- **Identity.** Every top-level record is keyed on the D-S8-3 key
  `(coach_id, source_namespace, entity_type = family, source_id)`. Native records carry it in
  `ImportNativeProvenance` (unique L7027); preserved records in `ImportPreservedRecord_identity_key`
  (§4.1). **Exactly one destination holds a key**: a provenance row and a preserved row in state
  `preserved` never coexist (invariant test I-1, §7), because every native write path goes through
  the one function of §4.6, which resolves an existing preserved row first. `source_id` comes from
  the spec-declared id path, never a name or model output (EX1-DOC D-EX1-1). Children use
  `childSourceId` (`native-contract.ts` L110-120).
- **Spec grammar.** Per family, one minimum role set per source step: `idField` (required),
  `personSourceId` (P families), `occurredAt`/`occurredOn` with zone basis (S8-DOC §3.9), `title`,
  and for `messages` `authorSourceId` and `authorRole`; plus the declared field list with value
  classes (§4.3 rule 2). Native typed roles come from the native rule registry (`native-rules.ts`
  L794). The spec `families` object becomes a map over the catalogue (FAM-C1; L0-DOC validators
  apply unchanged).
- **Person edge (P families).** `personSourceId` resolves only through provenance of the `clients`
  identity (kind `person`), never by name or email (S8-DOC §3.8).
  - Resolved: native row person-owned (`person_id`, owner `User` NULL) or preserved row with
    `person_id`.
  - Unresolved: preserved with `person_id` NULL and `person_source_id` as a soft edge (S9 E-R3
    `relationship_unverified`). On a later run the row is handled by the **one rule** of §4.6: the
    native write path finds it, resolves the person edge from the row's own columns and attempts
    graduation; only when graduation is not-ok does it set `person_id`, clear `person_source_id`
    (the §4.1 CHECK requires exactly one) and leave the row `preserved`. There is no separate
    "attach" path (R590-B2-B2, R590-B-C2).
  - A `Deleted` Person (S8D-DOC §2.3) is a tombstone: no row resolving to it, by id or by soft
    edge, is written; the record is `not_moved: excluded_by_policy`.
- **Former and archived clients (R590-B-A2).** `clients` is **always** native `Person`. `Person`
  gains `source_archived_at DateTime?` (FAM-C1 pin; a data column written by the `clients` writer
  from the source's archived/inactive role; never a `PersonState`, which stays lifecycle-only).
  The roster shows such Persons under "Former clients"; their dependents resolve like any other
  Person's. Other archived source records move too, amending S8-DOC §3.7 `source_archived`:
  native with `archived_at := source value` where the model has the column (`WorkoutProgram`,
  `WorkoutPlan`, `MacroTarget`, `MealPlan`), else preserved with `source_archived = true`.
  Provenance records `imported_archived_at` (the exact value written) so reconciliation can tell
  an import-time archive from any later coach action (§6.2) (R590-A2-03, R590-B2-C4).
- **Timestamps.** Instants to UTC; calendar dates need the source's zone basis. Audit columns keep
  their defaults (S8-DOC §3.3) except `CoachMessage.created_at` (D-FAM-4).
- **Side effects.** S8-DOC §3.6 plus FI-4. Writers use `tx` row writes only; never
  `sendAsCoach`/`sendAsClient` (`messaging.service.ts` L406, L510), emitters, PTM, scheduling
  lifecycle or notification paths. The S8-C module-boundary spec extends to every FAM writer.
- **Create-only** (S8-DOC D-S8-4): replay verifies, never updates. Coach edits and deletions stand.
- **Collision winner** (R590-B-C7): where a native unique key can collide (`CheckIn(user_id, date)`),
  the winner is deterministic: earliest `occurredAt`, then lexicographically smallest `source_id`;
  the rest are preserved, never dropped.

**Per-family specifics** (native families only; preserved families need only the common rules):

| Family                | Native fields                                                                                                                        | Edges                                         | Time                                              | Not native when (⇒ preserved)                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `messages`            | `body`; `voice_url` via §5.4; `sender_id`/`sender_person_id` by D-FAM-4 authorship                                                   | thread `(coach_id = Person.coach_id, person)` | `created_at := occurredAt`; `read_at` per D-FAM-4 | group/multi-party thread; author not the bearer's own account and not the thread's Person; no `occurredAt` |
| `food_logs`           | `date`, `meal_type` (enum map), tenant food row, quantities, `notes`                                                                 | person                                        | `date`                                            | macros missing or enum unmapped                                                                            |
| `water_logs`          | `amount_ml` (declared unit, exact conversion)                                                                                        | person                                        | `logged_at := occurredAt` (data column)           | non-integral ml                                                                                            |
| `nutrition_targets`   | four macros, `fiber_g`, `notes`                                                                                                      | person; `coach_id = Person.coach_id`          | `effective_from := occurredAt`                    | non-integral                                                                                               |
| `meal_plans`          | `title`, `items` (spec-declared item roles only), `notes`                                                                            | optional person                               | default                                           | —                                                                                                          |
| `checkins`            | S8-DOC §4.5 + S8-E1b; `soreness` required                                                                                            | person; `coach_id = Person.coach_id`          | `date`                                            | `soreness` absent; collision loser                                                                         |
| `body_weights`        | `weight_lbs` (`toPounds`), `notes`                                                                                                   | person                                        | `date`                                            | —                                                                                                          |
| `habits`              | `name`, `category`, `target_value`, `unit`; log `date`, `value`, `completed`                                                         | person; log → habit by provenance             | log `date`                                        | log whose habit is unresolved (child preserved)                                                            |
| `workout_logs`        | S8-DOC §4.5; `muscle_group` enum map                                                                                                 | person; set → session                         | `date`                                            | unmapped muscle group (child preserved; session native)                                                    |
| `coaching_sessions`   | `title`, `start_at`, `end_at`, `status ∈ {completed, canceled, no_show, declined}`, notes; providers `stub`; no `SessionParticipant` | optional person                               | source instants                                   | future or non-terminal (never `scheduled`: reminders and open-slot computation, FI-4; note N-3)            |
| `workout_assignments` | S8D-DOC OQ-12                                                                                                                        | person; plan by provenance                    | `scheduled_for`                                   | until OQ-12 is answered                                                                                    |
| `exercises`           | EX1-DOC D-EX1-2                                                                                                                      | —                                             | —                                                 | EX1 withheld (§8 C-2)                                                                                      |

**Residual fields.** A native record whose canonical record carries paths the native rules do not
consume keeps them in a `graduated` row of `ImportPreservedRecord` (§4.1) under the same identity:
native pointer plus residual. The obligation is computed by **every** native write, native-first
or graduated, from the same canonical record (§4.6), and verified by S9 (§6.2).

### D-FAM-3: gates for client-owned families

- A native P-family writer runs only when its table has the #587/FI-1 shape **and** S8-D1's typed
  `person` handoff resolves the edge. The writer registry is the gate state (D-FAM-1): a family is
  native only for tables whose migration is present. Every writer — existing (S8-D1 `clients`,
  S8-C `programs`/`workouts` including the EX1 withheld path) or new — writes through the §4.6
  function; a registry flip from `preserve` to `native` ships in the same commit as the writer.
- The S8D-DOC §2.7 link transaction re-owns rows through the provenance join. Each FI-1 table
  joins that list in its FAM-N slice, including `CoachMessage.sender_person_id → sender_id`.
  Preserved rows never flip owner; after a link the client's read (if OQ-2 allows) goes through
  `Person.linked_user_id`. Client-visible **media** is not part of OQ-2 (§5.3).
- RLS never widens: person-owned native rows and PRESERVE are service-role only.

### D-FAM-4: event time, authorship and the imported-history rule (R590-A-B2, R590-B-B6, R590-B2-B5)

- **Event time.** `CoachMessage.created_at := occurredAt` for imported messages only (the thread
  orders on it, index L1227). This is the sole exception to S8-DOC §3.3.
- **Authorship.** The run carries the bearer's own source account id (the source account scope,
  RESET §2). A coach-authored message is native only when `authorSourceId` equals it; then
  `sender_id = bearer`. A client-authored message is native when `authorSourceId` equals the
  thread Person's `source_person_id`; then `sender_person_id = person`. Any other author (staff,
  sub-coach, another client) ⇒ preserved. Thread `coach_id = Person.coach_id` (the tenant head
  coach, as `coach-effectiveness.service.ts` L466-469 already models).
- **Imported-history rule (all consumers).** Every native table that gains any import writer
  (FAM-N\*, S8-E1a/b/c/d, EX1) gains `imported_at DateTime?` (indexed) in its expansion migration,
  set only inside the writer's transaction. No read state, review state or notification is
  invented: `read_at` stays NULL unless the spec declares a read-state role; `CheckIn.reviewed_by_coach`
  keeps its default. **Rule: every consumer of such a table excludes `imported_at IS NOT NULL`,
  except (a) the record's own history, thread and detail screens, (b) the disclosed per-client AI
  context (N-1), and (c) consumers the owner opts in (OQ-11; default none).** The consumer set is
  enumerated from code, never by hand: every `prisma.<delegate>.(findMany|findFirst|count|groupBy|aggregate)`
  call site outside `*.spec.ts`. At `d6cf9eb6`: `workoutSession` 15 files
  (`admin/admin.service.ts`, `admin/federation/federation.service.ts`,
  `admin/reports/transformation-scorecard.service.ts`, `ai/ai.service.ts`,
  `ai/client-ai-context.service.ts`, `coach/coach.service.ts`, `community/community.service.ts`,
  `insights/holistic-insights.service.ts`, `invite-codes/invite-codes.service.ts`,
  `notifications/digest.service.ts`, `sub-coach/sub-coach-analytics.service.ts`,
  `users/account.service.ts`, `users/users.service.ts`, `v1/v1-coach.service.ts`,
  `workout/workout.service.ts`); `coachMessage` 17; `checkIn` 16; `loggedFoodEntry` 12;
  `weightLog` 9; `coachingSession` 4; `mealPlan` 3; `habit` 3; `macroTarget` 2; `waterLog` 2;
  `habitLog` 1. Each writer slice ships (i) an `rg`-based spec that fails when a call site on its
  table is in neither its exclusion list nor the allow-list (a)-(c), and (ii) a post-link test per
  consumer class: zero badge, queue entry, push, digest line, leaderboard/streak/community entry,
  admin-metric delta, reminder. Thread and history screens render imported rows with no read
  receipt.
- **Disclosure.** The import itself is AI-free (§4.7). Once a row is native and the client linked,
  it follows live product behaviour, including the per-client AI context for that coach
  (`client-ai-context.service.ts` L192). Stated on the coach-facing result and in §9 note N-1.

## 4. PRESERVE: the universal destination

### 4.1 Schema (FAM-P1; additive migration with a refusing down)

```prisma
model ImportPreservedRecord {
  id                 String    @id @default(uuid())
  coach_id           String                       // tenant key
  person_id          String?                      // FK (person_id, coach_id) → Person(id, coach_id), ON DELETE RESTRICT
  person_source_id   String?                      // soft edge while unresolved (D-FAM-2)
  import_intent_id   String?   @db.Uuid           // FK (import_intent_id, coach_id) → ImportIntent(id, coach_id), RESTRICT
  source_namespace   String
  family             String                       // CHECK: catalogue + child families
  source_id          String
  parent_family      String?
  parent_source_id   String?
  occurred_at        DateTime? @db.Timestamptz
  occurred_on        DateTime? @db.Date
  title              String?                      // ≤ 200 chars, §4.3 text rules applied
  source_archived    Boolean   @default(false)
  fields             Json                         // the canonical record (§4.3); residual only when graduated
  fields_sha256      String
  byte_size          Int                          // CHECK 0 < byte_size ≤ SCOUT_PRESERVE_MAX_BYTES
  dropped            Json                         // { <DropCode>: count }, codes only (§4.3)
  projection_version Int
  state              String    @default("preserved") // CHECK IN ('preserved','graduated')
  native_kind        String?                      // set iff state = 'graduated'
  native_id          String?
  graduated_at       DateTime?
  created_at         DateTime  @default(now())

  @@unique([coach_id, source_namespace, family, source_id], map: "ImportPreservedRecord_identity_key")
  @@index([coach_id, person_id, family, occurred_at(sort: Desc)])
  @@index([coach_id, family, state])
  @@index([coach_id, native_kind, native_id])
}
```

Hand-written CHECKs (S8-B precedent, `20270122000000` L141-149): closed `family` and `state`;
`(native_id IS NULL) = (state = 'preserved')`; the size CHECK;
`(person_id IS NULL) <> (person_source_id IS NULL)` for P families.

**Two states, one shape (R590-B-C9).** `preserved` = the record's only destination. `graduated` =
a native pointer plus residual fields; it is **not** a destination and is never counted as
preserved. `ImportNativeProvenance` gains `residual_required Boolean` (NOT NULL, no default: every
native write states it), `residual_id String? @unique` with FK → `ImportPreservedRecord(id)` ON
DELETE RESTRICT, a CHECK `residual_required = (residual_id IS NOT NULL)`, and
`imported_archived_at DateTime?`. The obligation is computed by every native write (§4.6); a
graduated row cannot be deleted while its provenance exists; reconciliation refuses a native
identity whose required residual is missing (§6.2) (R590-A-A2, R590-A2-02).

**Ledger.** `ScoutReconstructionLedger.target_kind` gains `preserved_record` and every new native
kind (CHECK expand of L191; FAM-C1). A preserved top-level identity is ledger `reconstructed` with
that kind and `target_id = ImportPreservedRecord.id`. Children and residuals are not ledger rows.
The ledger fence trigger (`20270119000000_scout_ledger_obsolete_writer_fence` L87-92) is INSERT
only, so the §4.6 retarget UPDATE is not fenced; FAM-G1 adds its own fence: the UPDATE runs under
the run-row lock or, on demand, under the intent lock.

**No third destination (R590-B-B2).** From FAM-P2 on, no run writes `ScoutReconstructedEntity`
evidence rows (the upserting `persist` in `families.ts` L117-134 is retired for new runs);
`client_history` and rule-less `workouts` go to PRESERVE with ledger kind `preserved_record`.
Legacy `scout_entity` rows are converted once, idempotently per coach, by FAM-P2 **before** the
staged purge of §4.3 activates: read `ScoutIngestEntity.payload` for the identity (the evidence
row has no payload, schema L7112-7125), build the canonical record, insert the preserved row,
retarget the ledger rows to `preserved_record` and delete the evidence row in one transaction (so
`GET scout/reconstruct/entities` shows no second copy) (R590-B2-C2). An identity whose staged
payload is already gone stays bucket f, `not_moved: destination_gate_closed`.

### 4.2 RLS and tenancy

Exactly the `Person`/provenance posture: ENABLE + FORCE; permissive `service_role` policy;
RESTRICTIVE deny-all for `anon` and `authenticated`; explicit `REVOKE ALL ... FROM anon,
authenticated` (`20270122000000` L167-182). No principal reads the tables directly. Every read
route filters `coach_id = req.user.id` and re-asserts the parent's ownership (§5.3); any miss is an
opaque 404. The FAM-P1 RLS spec is the S8D-DOC §2.2 item 4 matrix plus role × tenant negatives.

### 4.3 The canonical record: one sanitized input for both destinations (R590-A-A1, R590-A2-01, R590-B-B3, R590-B2-B3)

**Where sanitization runs.** Two functions, one contract:

- **Ingest** (`redactPayload`, `scout-ingest.service.ts` L149-183) stays a **key-only** redactor.
  FAM-P2 extends `REDACTED_PAYLOAD_KEYS` with the credential words of rule 3 and nothing else: no
  value-shape rule runs at ingest, because no spec is in scope there and existing native writers
  read the staged payload (`native-rules.ts` L435; `facts.service.ts` L830-845). Ids are never
  dropped at ingest.
- **Reconstruct**: `canonicalRecord(payload, spec, family) → { fields, dropped }` is one pure,
  versioned core function run once per staged identity, with the validated spec in scope. Its
  output **C** is the only input to every destination: the preserve writer stores `C.fields`; every
  native writer interprets `C.fields` (never the raw staged payload); graduation re-interprets the
  stored `C.fields`. Native-first and graduated writes are therefore value-identical by
  construction, and native rules see the same ids and text either way.

**Rules of `canonicalRecord`.** It is an allow-list. A value is stored only if it passes every
rule; anything else is replaced by `{"$dropped": "<DropCode>"}` and counted in `dropped`. Codes:
`path_undeclared`, `credential_key`, `credential_shape`, `card_number`, `contact_pii`,
`url_unadmitted`, `class_mismatch`, `over_bound`.

1. **Scope.** Only objects from collections the run classified into a catalogue family enter.
   Settings, UI-config and third-party collections are excluded upstream (L0 exclusion rule;
   RESET §3, §5): the collections where credentials live never reach this function.
2. **Declared paths only (fail-closed retained-field contract).** `C.fields` keeps exactly the
   paths the validated spec declares for the family, each with a declared **value class** from the
   closed set `id | ref | datetime | date | number | bool | enum | text | url | media | map`.
   Declaration is data (authored, or model-proposed in `LearnedProposalV1.mappingSpec`) and is
   admitted by deterministic validators only: the path exists in ≥ 2 observed records of the
   collection (or 1 when the collection has 1), ≥ 90 % of observed non-null values conform to the
   declared class, `ref` paths resolve to another declared step's ids in ≥ 1 observed record, and
   no declared key fails rule 3. An undeclared path is `path_undeclared` (counted). Coach-defined
   labels (a custom question text as a key) are declared once as a `map` path (RESET §3): the
   object is stored as `{"$map": [{"k": <label>, "v": <value>}]}`.
3. **Credential keys (word-level, closed, versioned `CREDENTIAL_WORDS`).** Every key and every
   `$map` label is split into words on `_`, `-`, whitespace and camelCase and lower-cased. The
   value (any shape, any depth) is `credential_key` when any word is in `{password, passwd, pwd,
passphrase, secret, token, bearer, authorization, auth, cookie, csrf, otp, totp, mfa, pin, cvv,
cvc, iban, ssn, mnemonic, passport}` or any adjacent word pair is in `{(api, key), (auth, key),
(secret, key), (private, key), (access, key), (session, id), (session, key), (recovery, phrase),
(recovery, code), (backup, code), (seed, phrase), (security, answer), (card, number), (account,
number), (routing, number), (tax, id), (national, id)}`. **This runs on the raw key or label
   before any grammar or map conversion**, so `{"auth key": "…"}` and `{"Password hint": "…"}` are
   dropped whether or not the key is grammar-clean (R590-A2-01). Not in the list, and kept:
   `session`, `sessionDate`, `workout_session`, `signature`, `signed_at`, `account`, `key` alone
   (`exercise_key`, `week_key`), `author*`.
4. **Class admission per declared path.**
   - `id` / `ref`: one of `int_id` = `^[0-9]{1,20}$`; `uuid` = 8-4-4-4-12 hex; `short_id` =
     `^[A-Za-z0-9_-]{6,64}$` with no `.` (so nanoid, push ids, ULID, KSUID, ObjectId, Snowflake,
     prefixed ids like `usr_2N9f…` all pass; a JWT does not). No entropy test on id paths (ids are
     opaque by nature; the corroboration in rule 2 is the control). Ids ≤ 64 chars.
   - `datetime` / `date` / `number` / `bool` / `enum`: grammar of the class; `enum` values are
     ≤ 64 chars over `^[A-Za-z0-9 _./-]+$`.
   - `text`: any string ≤ 16 KiB, except: a JWT (three base64url segments, first decoding to JSON
     with `alg`), a `Bearer `/`Basic ` prefix or a PEM block anywhere ⇒ `credential_shape`; a
     whitespace-delimited word of ≥ 20 chars with ≥ 3 of the classes {lower, upper, digit, symbol}
     is replaced inline by `[hidden]` and counted once. Words < 20 chars, slugs, dates, numbers and
     plain-alphabet words are untouched (`upper-body-strength-day`, `MyFitnessPal2024!` kept).
   - `url`: rule 6. `media`: rule 6 media branch. `map`: labels pass rule 3; values are admitted as
     `bool`, `number`, `date`, `datetime`, or `text` (rule 4 text), else `class_mismatch`.
   - A value that fails its class is `class_mismatch` (never silently coerced).
5. **Card numbers.** A 13-19 digit string passes Luhn **only** when a card-like word (`card`,
   `creditcard`, `payment`, `bank`) is in its own key or any ancestor key; then `card_number`.
   Epoch-ms timestamps, 18-19 digit ids and EAN-13 barcodes under other keys are kept (the r1 rule
   dropped about 10 % of them; scratch `reviews/scratch/R590-B/luhn.py`).
6. **URLs.** Userinfo present ⇒ `url_unadmitted`. Scheme must be `http(s)`. Query parameters are
   kept **unless** the parameter name passes rule 3 (`token`, `sig…`, `auth`, `key`-pairs,
   `X-Amz-Signature`-style) or the value is a ≥ 20-char opaque word (rule 4 text test); only those
   parameters are removed (`watch?v=<11 chars>` survives; a signed-CDN query does not). Fragment
   removed. A URL under a declared `media` path becomes `{"$media": "<ImportPreservedMedia id>"}`
   once §5 holds the bytes, else `{"$media_pending": <ordinal>}`; the media URL string itself is
   never stored.
7. **Contact PII** (OQ-8 default): values under declared paths whose key words include `email`,
   `phone`, `mobile`, `address`, `dob`, `birth`, and email-like or phone-like values anywhere, are
   `contact_pii` until the owner answers.
8. **Spec roles** (`idField`, `personSourceId`, parent edge, `occurredAt`, `title`) are declared
   paths with classes `id`, `ref`, `datetime`/`date`, `text` (≤ 200) respectively; `source_id`,
   `person_source_id`, `parent_source_id`, `title` and `family` therefore pass this function, not a
   separate one.
9. **Bounds.** Depth ≤ 8, ≤ 500 keys, string ≤ 16 KiB, canonical JSON ≤ `SCOUT_PRESERVE_MAX_BYTES`
   (default 64 KiB, hard cap 256 KiB). Over-bound ⇒ the record is `not_moved: over_limit`, never
   truncated.
10. **Canonical form.** Sorted keys; `fields_sha256` over the canonical bytes; `projection_version`
    stored as evidence of which rule set produced the row. A rule change applies to new runs;
    stored rows are not re-projected (dropped material is gone) (R590-A2-C1).

**What "credentials never stored" means here, precisely.** Provable by rules: (i) no value is
stored unless its path is declared and its value conforms to the declared class (rule 2, 4);
(ii) every credential-named key or label drops its value at any depth, before any transform
(rule 3); (iii) credential-shaped strings (JWT, Bearer/Basic, PEM, opaque ≥ 20-char words) never
survive in text (rule 4); (iv) URL credentials never survive (rule 6); (v) credentials live in
settings-class collections that never enter (rule 1); (vi) device-side, captured request headers
are memory-only and never sent to TGP, and a key equal to any captured value is refused (RESET
§3-§4). **Bounded residual, stated and owner-visible (OQ-10):** a secret that is a short
plain-alphabet word under a declared `text` or `map` path in a coaching collection
(`{"hint": "mydog"}`) is indistinguishable from data by any rule; the controls are (i), (v), the
closed versioned word list and per-record `dropped` counts on the coach display.

**Staged payloads.** FAM-P2 clears `ScoutIngestEntity.payload` to `{}` once the intent settles,
after the legacy conversion of §4.1 (identity columns stay for S9 counts). Consequence
(R590-B2-C6): identities that settled `conformance_refused` or `write_failed` can only be retried
by a new run; the projection says so through their `not_moved` count.

**Test corpus** (`src/scout/preserve/__fixtures__/canonical-record-corpus.json`, synthetic values,
codes and counts asserted, values never logged).

- Must drop: JWT, `Bearer x`, `Basic x`, PEM, a 40-char `sk_`-style word inside a `text` note,
  `{"recoveryPhrase": "alpha beta gamma"}`, `{"auth key": "opaque-secret"}` (label, pre-map),
  `{"Password hint": "mydog"}` (label, pre-map), `{"auth": "opaque-secret"}`,
  `{"card": {"number": "<Luhn-valid 16>"}}`, a URL with userinfo, a signed-CDN query parameter,
  an undeclared path, a value failing its declared class, the same cases at ingest for rule 3
  keys.
- Must keep: `created: "1727600000000"`, a 19-digit id, an EAN-13 under `barcode`, `session`,
  `sessionDate`, `workout_session`, `signature: "signed on device"`, `signed_at`, `exercise_key`,
  a UUID, `upper-body-strength-day`, an ISO date, a 2 KiB note, `Monday`, `kg`,
  `https://…/watch?v=dQw4w9WgXcQ`, `MyFitnessPal2024!`.
- **Id false-positive corpus** (`id`/`ref` paths and `text` paths): 1 000 each of nanoid(21),
  push-style ids (20, leading `-`), ULID(26), KSUID(27), ObjectId(24 hex), Snowflake(19),
  UUID, `usr_`-prefixed ids: 100 % admitted on `id`/`ref` paths; on `text` paths the `[hidden]`
  rate is reported and must be 0 for ids < 20 chars. (r2's rule rejected 98.7 % of nanoids as
  text: scratch `reviews/scratch/R590-B2/rule4.py`.)
- **Path equality:** for every corpus record, `nativeWrite` from C on the first run equals
  `nativeWrite` from a stored `preserved` row's `fields` (R590-B2-B3); an S8-C plan with a nanoid
  `program_id` keeps its program edge after FAM-P2.

**Relation to TM-14** (`docs/decisions/2026-06-17-tm-14-no-raw-payload-storage.md`): TM-14
option (C), a sanitized bounded projection; the source stops being the system of record when the
coach leaves it.

### 4.4 Retention, erasure and export (FAM-E1a lands before FAM-P2; R590-A-A4, R590-B-B7, R590-A2-04, R590-B2-B4)

- **Retention:** as long as the coach account and the Person exist. A `graduated` row keeps only
  identity and residual, so no value is stored twice.
- **Person erasure** (S8D-DOC §2.3 explicit path) selects by tenant-scoped source identity,
  including soft edges: `coach_id = P.coach_id AND (person_id = P.id OR (person_id IS NULL AND
source_namespace = P.source_platform AND person_source_id = P.source_person_id))`. Order, so that
  the database never points at a missing object: (1) one transaction deletes those rows, their
  `ImportPreservedMedia` rows, and the ledger and provenance rows of those identities, and for
  each touched blob (`SELECT … FOR UPDATE`) counts remaining `ImportPreservedMedia` references
  across **all** Persons of the coach; a blob with zero remaining references is marked
  `state = 'deleting'` and an `ImportErasureJob` row is written in the same transaction; (2) the
  job deletes the blob's objects (import bucket and every `ImportMediaCopy`, `deleteObject` L116)
  idempotently with retries and then deletes the blob row; the Person transitions to `Deleted`
  only when its jobs are done. A blob with remaining references is untouched: another client's
  preserved record or graduated `voice_url` keeps playing (test: erase A, B's media still plays).
  `Deleted` is a tombstone (D-FAM-2): re-import refuses.
- **Coach account deletion** (`src/account-deletion/account-deletion.service.ts`, which has no
  Person or import handling today) deletes preserved rows, media rows, copies and blobs by
  `coach_id` with the same two-phase job (no reference counting needed: the tenant goes).
- **Export:** coach export of preserved records per Person (JSON + signed media links) in FAM-E1a;
  the client data export (`src/data-export/data-export.service.ts`) includes preserved records only
  for OQ-2-visible families.
- **Sequencing rule:** FAM-P2 does not write in any environment where FAM-E1a's deletion paths are
  not present and tested; FAM-M1 does not write blobs before FAM-E1b (media erasure) is present.

### 4.5 Display

- **Coach mobile, client detail:** "From your previous platform": per family a count and a
  date-ordered list; per record title, `occurred_at`, humanised fields, media thumbnails via
  short-lived signed URLs (§5.3), and a "hidden: n" marker from `dropped` (per code class:
  sensitive, contact details pending owner decision, altered link). Read-only. Former clients
  reach it from the roster's "Former clients" list.
- **Imported library:** coach-owned preserved records (`forms`, `meal_plans` templates,
  `unclassified` without a person).
- **Residuals** render under their native record as "More from your previous platform".
- **Client visibility:** coach-only by default (OQ-2); coach-private families never client-visible.
- **Viewability predicate** (R590-B-C6): server-side and deterministic — `PRESERVE_VIEWABLE =
true` is exported by the FAM-P3 route module when it registers; §6.1 reads it.

### 4.6 One native write path; graduation without loss (FAM-P2 guard, FAM-G1 engine; R590-A-A3, R590-B-B4, R590-A2-02, R590-B2-B2)

Every native write — S8-D1 `clients`, S8-C `programs`/`workouts` including the EX1 withheld path,
every W slice of §7, and on-demand graduation — goes through **one** function,
`nativeWrite(identity, C)`, in one transaction per identity tree (parent and children, or none):

1. `SELECT … FOR UPDATE` the provenance key and the preserved key. Provenance present ⇒ create-only
   replay: verify, write nothing (S8-DOC D-S8-4). Preserved row present ⇒ its stored `fields` **is**
   `C` from here on (the record TGP holds; the fresh payload is drift evidence only, never an
   update), and its `person_source_id`/`person_id` columns supply the person edge.
2. Interpret `C.fields` with the family's native rules. The interpreter returns not-ok for a
   `$dropped`, `$map` or `$media_pending` value **at a path it consumes** (R590-B2-C3); `$media` is
   accepted only by media-role rules (§5.4). Not-ok, or gate closed ⇒ the record is (or stays)
   preserved; if it was a soft-edge row and the person now resolves, set `person_id`, clear
   `person_source_id`. Nothing else changes.
3. Ok ⇒ write native rows and provenance `created` with `imported_at`, `imported_archived_at`;
   media copies per §5.4 (copy-then-commit).
4. **Residual** = paths of `C.fields` minus the paths the rules consumed (deterministic). Non-empty
   ⇒ write (native-first) or convert (graduation) the `ImportPreservedRecord` row to
   `state = 'graduated'` with the residual as `fields`, and set `residual_required = true`,
   `residual_id`. Empty ⇒ delete any preserved row, `residual_required = false`.
5. **Retarget the ledger** for every intent of this identity: `UPDATE ScoutReconstructionLedger
SET target_kind = <native kind>, target_id = <native id> WHERE coach_id, entity_type,
source_platform, source_id match AND target_kind = 'preserved_record'` (S9 bucket h then holds for
   all prior intents). Native-first writes insert the ledger row as today.

**Triggers for graduation** are just callers of `nativeWrite`: (a) the next run of the source
(the writer finds the preserved row in step 1); (b) on demand per coach, when the source is gone,
iterating `preserved` rows of families whose gate is open. A rule-outcome change without a
registry flip (an EX1 binding that now resolves, a native-rule version bump) is the same path:
step 1 finds the preserved row, step 2 now returns ok.

**Guard before engine.** FAM-P2 ships steps 1-2 and the "stays preserved" branch into every
existing writer (the guard); FAM-G1 ships steps 3-5 for preserved rows (the engine). Between them,
an existing writer that finds a preserved row for its key writes nothing native (the record is in
TGP already), so I-1 holds from FAM-P2 on.

**Accounting.** One identity, one count: native once graduated, else preserved. A race with an
import converges on the provenance unique (`families.ts` retry-once).

**Tests** (FAM-P2/G1 acceptance): I-1 over S8-D1, S8-C (withheld and bound), and each W writer;
native-first residual present and RESTRICT-protected; create → graduate → reconcile → replay;
deletion of a residual refused; children all-or-nothing; sentinel refusal at consumed paths only;
ledger retargeted for two intents; value equality native-first vs graduated (§4.3 corpus).

### 4.7 Preserved values never reach the AI or cross-coach memory

- **Module boundary spec** (FAM-P2 acceptance): outside `src/scout/preserve/**`,
  `src/scout/reconciliation/**`, `src/account-deletion/**`, `src/data-export/**`, no file references
  the Prisma delegates `importPreservedRecord`, `importPreservedMedia`, `importMediaBlob`,
  `importMediaCopy`, `importErasureJob`. `src/ai/**`, `src/roman/**`, `src/insights/**`,
  `src/coach/brief/**`, `src/coach/command-center/**`, `src/notifications/**`, `src/community/**`,
  `src/scout/learn/**` never import the preserve module. `rg`-based, fails on a new reference.
- **Learn memory** is structure-only and, in V1, per coach (RESET §2). Preserved values are never
  digest input.
- **Logs and telemetry** carry counts and closed codes only (S9-DOC D-S9-7).

## 5. Media, photos and files (FAM-M1; R590-A-B1, R590-A-B3, R590-B-B5, R590-A2-04, R590-A2-05, R590-B2-B4)

### 5.1 Tables

- `ImportMediaBlob`: `coach_id`, `content_sha256`, `byte_size`, `content_type`, `storage_key` =
  `imports/<coach_id>/<sha256>` (**immutable, content-addressed, never repointed**), `state ∈
{uploading, verified, ready, rejected, deleting}`, `scan_status ∈ {pending, clean, rejected,
error}`, `scanned_at`. Unique `(coach_id, content_sha256)`; dedup within one coach only.
- `ImportPreservedMedia`: identity `(coach_id, source_namespace, 'media', source_id)`; `blob_id`
  with FK `(blob_id, coach_id) → ImportMediaBlob(id, coach_id)`; parent is **either**
  `preserved_record_id` with FK `(preserved_record_id, coach_id) → ImportPreservedRecord(id,
coach_id)` **or** `(native_kind, native_id)` (CHECK exactly one). This row is the **reference**
  for every use of a blob, preserved or graduated; erasure counts these rows (§4.4).
- `ImportMediaCopy`: `blob_id` + `coach_id` (FK as above), `bucket`, `storage_key`, `state ∈
{pending, ready, failed}`, `attempts`, unique `(blob_id, bucket)`. One copy per native bucket that
  needs the object (§5.4).
- All tables use §4.2.

### 5.2 Path and scan gate

1. The extension fetches bytes in the authorized tab, from the run's confined origin set only
   (OQ-4), with `redirect: 'manual'`: **every** redirect hop is checked against the set; an
   unconfined hop is `not_moved: excluded_by_policy`.
2. It computes SHA-256 and calls the scout media route with
   `{family, source_id, parent key, sha256, byte_size, content_type}`.
3. Server: `already_present` if the blob is `ready`; else a signed PUT (`createSignedUploadUrl`,
   L82) for the immutable key in a **separate private bucket** (`IMPORT_MEDIA_BUCKET`; never the
   sellable-content bucket).
4. On confirm the server reads the object once, checks size, SHA-256 and magic bytes against
   `content_type` (`verified`; failure `not_moved: source_refused`), then submits it to
   `MediaScanProvider.scan(storage_key)` (a vendor-neutral provider interface, like the storage
   provider). `ready` **only** on `clean`. `rejected` ⇒ object deleted, `not_moved:
excluded_by_policy`. `error` or timeout (`MEDIA_SCAN_TIMEOUT_MS`) ⇒ stays `verified`, retried,
   reported `not_moved: destination_gate_closed`. No scanner configured ⇒ nothing becomes `ready`
   (fail closed; OQ-9).
5. Signed download URLs are minted only for `ready` blobs. A blob counts as "in TGP" only when
   `ready`.
6. Bounds (environment-tunable down only): image ≤ 25 MB; PDF ≤ 50 MB (`PDF_MAX_BYTES`,
   `coach-media.dto.ts` L12); audio ≤ 25 MB; video ≤ 500 MB, never transcoded; other ≤ 25 MB
   served as `application/octet-stream`; run budget 20 GB; coach total 100 GB. Excess is
   `not_moved: over_limit`. Storage and egress cost scales with these caps; the owner sets them
   (OQ-3).

### 5.3 Ownership contract for reads

Every media route (`sign`, `thumbnail`, attachment listing) is **coach-only in V1**: linked
clients have no media read route; client-visible media is not part of OQ-2 and would be its own
T4 slice with a person-link authorization path (R590-A2-05). The route verifies, in order:
`blob.coach_id = req.user.id`; the `ImportPreservedMedia` row's `coach_id = req.user.id`; the
parent belongs to the caller **and exists**: a preserved parent by the composite FK; a native
parent by (i) an `ImportNativeProvenance` row `(coach_id = caller, native_kind, native_id)` and
(ii) a per-kind parent resolver from the writer registry that loads the native row under the
caller's tenant (`CoachMessage.coach_id`, `WorkoutProgram.coach_id`, `CheckIn` via its Person's
`coach_id`, …) and confirms it is present and not deleted; the blob is `ready`. Any miss is an
opaque 404. Tests: role × tenant negatives (anon, authenticated, linked client, other coach, own
coach with a foreign parent id, own coach with a deleted parent, own coach with a foreign blob id,
non-ready blob) and positives per parent kind.

### 5.4 Graduated media stays playable (per-bucket copies; copy-then-commit)

Native surfaces resolve media by their own columns and buckets: `CoachMessage.voice_url` must be a
URL the live path could have produced (`messaging.service.ts` L214-249: storage host and
`/<voice-notes bucket>/<owner>/` prefix); `CoachExercise` demo media uses the column and bucket
EX1-C defines; check-in photos have no native column and stay preserved media attached to the
native `CheckIn` parent. The import blob is never moved. Instead `nativeWrite` (§4.6 step 3)
binds a **copy**:

1. **Copy first, outside the SQL transaction, idempotent.** Key =
   `<native bucket>/<tenant coach user id>/imported/<sha256>.<ext>` (owner = the tenant coach for
   coach- and client-authored messages alike: the client has no `User` before link and the prefix
   check applies to the send path only). If an `ImportMediaCopy(blob, bucket)` row is `ready`,
   reuse it; else copy within the storage provider, read back, verify SHA-256, upsert the row
   `ready`. A failure leaves `failed` + `attempts`; the native write is not-ok for that record
   (`not_moved: write_failed`, retried next run).
2. **Then commit** the native row with the column value derived from the copy key, plus the
   `ImportPreservedMedia` row re-parented to `(native_kind, native_id)`.
3. **Process loss** between 1 and 2 leaves a `ready` copy nobody references; a sweep deletes
   copies with no `ImportPreservedMedia` reference on a blob older than `MEDIA_COPY_ORPHAN_TTL`.
   A copy is deleted otherwise only by erasure (§4.4), when the blob's reference count is zero.

One immutable blob, N referencing rows, ≤ one copy per native bucket; graduation of one parent
never changes what another parent resolves (R590-A2-04, R590-B2-B4). Tests: shared blob with two
preserved parents, graduate one, both play; copy failure ⇒ record stays preserved; process loss
after copy ⇒ sweep; erase one Person ⇒ other Person's copy and blob survive. FAM-N1 acceptance
includes playback of an imported voice note in the thread screen for the coach and for a linked
client; EX1-C likewise for a demo clip in an assigned workout.

## 6. Reconciliation

### 6.1 What FAM-0 fixes about counting

Native and preserved records both count as "in TGP" once viewable (`PRESERVE_VIEWABLE`, §4.5).
Before that, preserved identities are reported `not_moved: destination_gate_closed` (a count) and
are **not** counted in `preserved` (R590-B2-C1). Nothing here makes `complete` reachable: RESET §1
leaves closure null for every package type, so runs settle `partial` with gap
`completeness_not_proven`. The arbiter stays the only terminal writer (S7-L).

### 6.2 S9 amendments (FAM-R1)

- **Bucket j-p `preserved_present_verified`**, after j, before k: ledger `reconstructed` with
  `target_kind = preserved_record`, and the preserved row present under the same key and
  `coach_id` in state `preserved`.
- **Bucket j residual check** (R590-A-A2, R590-A2-02): j additionally requires
  `provenance.residual_required = false OR residual row present with matching native_kind/native_id`;
  otherwise `unresolved:residual_missing`.
- **Archived amendment** (R590-B-A2, R590-A2-03, R590-B2-C4): buckets i and j, and S8 §3.4
  `already_present`, treat a native row as coach-archived iff
  `archived_at IS NOT NULL AND archived_at IS DISTINCT FROM provenance.imported_archived_at`. An
  import-time archive is verified present; a later coach archive, un-archive + re-archive
  (different timestamp) or removal is bucket i. Test: import-archived → coach change → reconcile.
- **Children.** A child that is neither native nor preserved counts `unresolved_children`.
- **Conditions.** C-FAM fires only for a staged token that resolves to no family (a spec defect).
  C-ID excludes j-p. C-REL includes unresolved person edges on preserved rows.
- **Invariant test I-1** (§7): for every key, never both a provenance row and a preserved row in
  state `preserved`; covers S8-D1, S8-C (bound and withheld) and every W writer.

### 6.3 Run-status projection: owned by L0, referenced verbatim (R590-B-A1, R590-B2-B1, R590-A2-06)

FAM-0 defines no projection fields. `GET scout/import/status` returns **`RunStatusProjectionV1`**
exactly as L0-DOC D-L0-6.3 defines it under the binding decisions: existing verdict fields;
`families[]` = `{ family, source_count: int|null, count_basis: 'proven'|'observed'|'unknown',
moved_native: int, preserved: int, not_moved: int|null }` — **no `destination` field**; one row
per family seen including preserved families, labels from the D-FAM-1 catalogue (`unclassified` is
the catch-all); `not_moved[]` = `{ family, count: int|null, reason: NotMovedReason }`; `gaps[]` =
`{ family: string|null, code: GapCode }`. A fact with a count goes to `not_moved`; an unknown goes
to `gaps`; never both; unknown = `null`, never 0. A partly-native family shows `moved_native > 0`
and `preserved > 0`; no rule chooses a family-level destination. Extension and mobile render only
this. Slice **L2d** (L0-DOC) creates the projection and the enums in `reason-codes.ts`; FAM-R1
depends on L2d and fills `moved_native` (bucket j), `preserved` (j-p) and the `not_moved[]` rows
below; L3b fills `source_count`/`count_basis`.

`NotMovedReason` is closed: `excluded_by_policy | source_refused | unresolved_parent |
identity_conflict | destination_gate_closed | over_limit | write_failed`. FAM-0 adds nothing to
it; every FAM and S9 fact maps into it:

| Fact (S9 histogram key or FAM state)                                                                                                               | `NotMovedReason`          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| billing under OQ-1; media from an unconfined origin (OQ-4); scan `rejected`; record resolving to an erased Person                                  | `excluded_by_policy`      |
| media fetch failed on the device; media verify failed (size/sha/magic)                                                                             | `source_refused`          |
| media whose parent record is not in TGP; child whose parent is neither native nor preserved                                                        | `unresolved_parent`       |
| `unresolved:identity_conflict` (h); `unresolved:native_target_removed` (i, coach removal/archive, OQ-5); `missing_source_id`                       | `identity_conflict`       |
| bucket f legacy row not yet converted; preserved before `PRESERVE_VIEWABLE`; media before FAM-M1; scan `error`/timeout; `unsupported_platform:<p>` | `destination_gate_closed` |
| `over_limit`: preserve over bound; media over bound; media quota; `unresolved:pass_ceiling_exceeded`                                               | `over_limit`              |
| ledger `failed`; `unresolved:residual_missing`; media copy failed                                                                                  | `write_failed`            |

The S9 histogram keys (D-S9-7) stay on the settled report for the coach's history detail (for
example "removed by you"); the run-status projection shows only the seven codes. No `GapCode` is
added by FAM-0. Per-record `dropped` counts (§4.3) are shown in the coach display, not in the
projection (N-2).

### 6.4 Deferred to the completeness-closure record (RESET §1)

Required inputs, not decided here: the release gate as a `complete` condition (R590-A-B1 "ready"
gating), C-COV, "every media ref ready", "zero not-moved", the `excluded[]` and staged > observed
arithmetic (R590-B-C5), and any run-level closure for preserved families.

## 7. Slice plan (landable order; R590-A-C1, R590-B-B1, R590-B-B7, R590-B2-B1, R590-B2-B5)

Tiers follow the T0-T4 doctrine. "Pin" = ships a migration and re-pins the S11 harness (S8D-DOC
§6). **W** = a native writer slice: it writes only through `nativeWrite` (§4.6), adds
`imported_at` to its tables, ships the consumer spec and post-link tests of D-FAM-4, and I-1
coverage. No W slice for a family that FAM-P2 preserves lands before FAM-G1.

| #   | Slice                                                                                                                                                                                                                                              | Tier  | Depends on                               | Pin |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------- | --- |
| 0   | **FAM-0** this record                                                                                                                                                                                                                              | T4    | —                                        | no  |
| 1   | **FAM-C1** catalogue tokens, spec grammar (role set, declared paths + classes), `destinationFor`, `preserved_record` + new native ledger kinds, `Person.source_archived_at`, provenance `residual_*`/`imported_archived_at`, contract regeneration | T4    | L2a #588, L0 r5                          | yes |
| 2   | **FAM-P1** `ImportPreservedRecord` schema, CHECKs, RLS, composite FKs, RLS matrix spec                                                                                                                                                             | T4    | #587, FAM-C1                             | yes |
| 3   | **FAM-E1a** erasure and export for preserved rows: Person erasure by source identity incl. soft edges, tombstone refusal, coach account deletion by `coach_id`, two-phase `ImportErasureJob`, coach export                                         | T4    | FAM-P1                                   | yes |
| 4   | **FAM-P2** `canonicalRecord` + corpus, ingest key-list extension, staged purge, preserve writer, legacy evidence conversion, **guard retrofit into S8-D1/S8-C** (§4.6 steps 1-2), module-boundary spec, I-1                                        | T4    | FAM-P1, FAM-E1a, S8-D1                   | no  |
| 5   | **FAM-P3** coach read route (per Person, former clients, library), `PRESERVE_VIEWABLE`, contract regeneration                                                                                                                                      | T4    | FAM-P2, S8-D2 #577                       | no  |
| 6   | **UX-P3** mobile "From your previous platform", "Imported library", "Former clients"                                                                                                                                                               | T2    | FAM-P3                                   | —   |
| 7   | **FAM-G1** graduation engine (§4.6 steps 3-5 for preserved rows), residual for native-first writes in S8-D1/S8-C, ledger retarget + fence, on-demand trigger, media copy hook                                                                      | T4    | FAM-P2                                   | no  |
| 8   | **FAM-R1** reconciliation: j-p, residual check, archived predicate, `not_moved[]` mapping, `moved_native`/`preserved` fill, extension/mobile decode                                                                                                | T4    | FAM-P3, FAM-G1, **L2d** (L0), L3b #589   | no  |
| 9   | **S8-E1a** (W) workout logs                                                                                                                                                                                                                        | T4    | #587, S8-D1, FAM-G1                      | yes |
| 10  | **S8-E1b** (W) check-ins + body weights (collision winner; unmapped required values preserved)                                                                                                                                                     | T4    | S8-E1a                                   | yes |
| 11  | **S8-E1c** (W) habits                                                                                                                                                                                                                              | T4    | S8-E1a                                   | yes |
| 12  | **FAM-E1b** media erasure: reference-counted blob deletion in Person erasure and account deletion, copy deletion, orphan sweep                                                                                                                     | T4    | FAM-E1a                                  | no  |
| 13  | **FAM-M1** media: tables, bucket, signed upload, verify, `MediaScanProvider`, quotas, ownership routes with parent resolvers, extension fetch with per-hop confinement                                                                             | T4    | FAM-P1, FAM-E1b, L3 origin set, OQ-3/4/9 | yes |
| 14  | **FAM-N1** (W) messages: person expansion, `sender_person_id`, authorship, consumer exclusions, voice copy, §2.7 re-own amendment                                                                                                                  | T4    | #587 pattern, FAM-G1, FAM-M1, S8-D4b/D5  | yes |
| 15  | **FAM-N2a** tenant-scoped food rows                                                                                                                                                                                                                | T4    | —                                        | yes |
| 16  | **FAM-N2b** (W) `food_logs` + `water_logs`                                                                                                                                                                                                         | T4    | FAM-N2a, FAM-G1                          | yes |
| 17  | **FAM-N2c** (W) `nutrition_targets` + `meal_plans`                                                                                                                                                                                                 | T4    | FAM-G1                                   | yes |
| 18  | **FAM-N6** (W) coaching sessions                                                                                                                                                                                                                   | T4    | FAM-G1                                   | yes |
| 19  | EX1-A/B/C, S8-E1d (W): withheld and blocked records preserved; demo media via §5.4                                                                                                                                                                 | T4    | EX1-DOC, FAM-G1, FAM-M1, OQ-12           | —   |
| 20  | Native designs for `notes`, `goals`, `forms`, `form_responses`, `body_measurements`, `client_profile` (own T3 records)                                                                                                                             | T3→T4 | owner decisions                          | —   |

Edges: FAM-C1 needs L2a (#588) and L0 r5 vocabulary; L1 needs FAM-C1's vocabulary (RESET §7);
FAM-R1 needs L2d (projection + enums) and L3b (`source_count`). L0-DOC should reference these
FAM-0 slice ids in place of `PRES`/`FAM-n` (R590-B2-C7). The FAM-C1 eval-harness re-run is L1's
CI job.

## 8. Contradictions with other records (this record proposes the amendment)

| #    | Record                                                                                                                                                                                               | Contradiction                                                                                        | Resolution                                                                                                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1  | L0-DOC (`unsupported_coaching_data` as a gap; messages/photos NO for V1)                                                                                                                             | All families YES                                                                                     | RESET §6 projection; `unsupported_coaching_data` deleted in L0 r4/r5                                                                                                                                                                                       |
| C-2  | EX1-DOC EQ-3, D-EX1-7                                                                                                                                                                                | Exercise media and withheld plans are reachable                                                      | Media via FAM-M1 (§5.4); withheld plan preserved whole with children, graduates through `nativeWrite` when CX-REF binds                                                                                                                                    |
| C-3  | S8-DOC §3.7 `source_archived`, §4.6 (messaging absent), `scout-reconstruct.dto.ts` L9-11                                                                                                             | Archived and messaging data are reachable                                                            | D-FAM-2 archived rule + §6.2 predicate; `messages` family                                                                                                                                                                                                  |
| C-4  | S8-DOC §3.3                                                                                                                                                                                          | `CoachMessage` orders on `created_at`                                                                | D-FAM-4 single-column exception                                                                                                                                                                                                                            |
| C-5  | S8-DOC §3.5 `native_uniqueness`, §3.7 `no_native_destination` as final                                                                                                                               | Reachable                                                                                            | Preserved; codes kept only for history                                                                                                                                                                                                                     |
| C-6  | S8D-DOC OQ-9                                                                                                                                                                                         | Answered by the directive                                                                            | Preserved now; native designs in slice 20                                                                                                                                                                                                                  |
| C-7  | TM-14                                                                                                                                                                                                | PRESERVE stores record content                                                                       | §4.3 sanitized projection                                                                                                                                                                                                                                  |
| C-8  | S9-DOC buckets i/j, S8-DOC §3.4 `already_present` ("not archived")                                                                                                                                   | Import-time archives would fail forever                                                              | §6.2 predicate on `imported_archived_at`                                                                                                                                                                                                                   |
| C-9  | L0-DOC r5 draft: model-proposed `{kind:'preserve', group: PreserveGroup}`, `family = … ∪ preserve groups ∪ 'other'`, exclusions as gaps, r4/r5 `NotMovedReason` names, `destination` in `families[]` | One token set; destination derived per record; one enum; one placement                               | Binding decisions (header): model proposes `family` only; `unclassified`; no `destination` field; seven-code `NotMovedReason`; owner-confirmed exclusions with a count → `not_moved: excluded_by_policy`, unmapped collections → gap `collection_unmapped` |
| C-10 | `Person` D2 comment (schema L6943-6950: "Email … deliberately NOT stored"), `families.ts` L105 ("Email/billing are never mapped or written")                                                         | Preserving `client_profile`, `forms`, `billing_history` would store contact and billing data as Json | **Reversal disclosed** (R590-B-B8): contact PII dropped by default (§4.3 rule 7), billing not moved by default; owner questions OQ-1, OQ-8. Email is still never an identity or linking key                                                                |
| C-11 | S8-DOC D-S8-4 writers read the staged payload; S8-C `native-rules.ts` L435                                                                                                                           | One canonical input for both destinations (§4.3)                                                     | S8-D1/S8-C read `C.fields` from FAM-P2 on; ids are never dropped (§4.3 rule 4); corpus proves edge retention                                                                                                                                               |

## 9. Open questions for the owner (each with a safe interim default)

| OQ    | Question                                                                                                                                                                                                                                                                                                                            | Interim default                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| OQ-1  | Is past billing and payment history a coaching record to move? (L0 P2)                                                                                                                                                                                                                                                              | **Not moved**, `not_moved: excluded_by_policy`. If yes: preserve read-only (amounts, dates, statuses), never a charge |
| OQ-2  | After a client joins, may they see preserved **records** about them? (Media reads stay coach-only in V1, §5.3)                                                                                                                                                                                                                      | Coach-only; coach-private families never client-visible                                                               |
| OQ-3  | Are the media caps of §5.2 (video 500 MB, 20 GB per run, 100 GB per coach) acceptable?                                                                                                                                                                                                                                              | Caps apply                                                                                                            |
| OQ-4  | May the extension fetch media from a separate media host proven by observation? If no, most photo-bearing runs keep media not moved                                                                                                                                                                                                 | Confined set only                                                                                                     |
| OQ-5  | Should a coach's deletion or archive of an imported record keep it reported as not moved?                                                                                                                                                                                                                                           | Yes (`identity_conflict` in the projection; "removed by you" in the history detail)                                   |
| OQ-6  | Should imported profile fields fill the joined client's profile on link?                                                                                                                                                                                                                                                            | No; preserved, coach-visible                                                                                          |
| OQ-7  | May an unnameable reachable coaching collection land as `unclassified`?                                                                                                                                                                                                                                                             | Yes                                                                                                                   |
| OQ-8  | Contact PII (email, phone, address, DOB) in `client_profile`, `forms`, `form_responses`: preserve coach-only, or never store?                                                                                                                                                                                                       | **Not stored** (`contact_pii`, counted and shown as "contact details hidden") until answered                          |
| OQ-9  | Which malware scanner backs `MediaScanProvider`?                                                                                                                                                                                                                                                                                    | None configured ⇒ no media becomes `ready` (fail closed)                                                              |
| OQ-10 | **Altered text.** Imported text (preserved and native) may differ from the source: credential-shaped words become `[hidden]`, signed-link query parameters are removed, undeclared fields are not kept, a short plain-word secret under a data label cannot be detected (§4.3). Acceptable, with per-record "hidden: n" disclosure? | Yes, disclosed per record; no rule is relaxed                                                                         |
| OQ-11 | **Joined client's imported history in live surfaces.** May imported workouts/weights/check-ins enter leaderboards, community, streaks, digests, coach analytics after link?                                                                                                                                                         | **Excluded** everywhere except the record's own screens and the disclosed AI context (D-FAM-4)                        |

Notes (not questions): **N-1** graduated native rows follow live per-client AI behaviour after
link (existing behaviour; disclosed on the result). **N-2** a per-family redaction count in
`families[]` is proposed to L0 as an owner question; FAM-0 adds no fields. **N-3** future and
non-terminal source sessions are preserved, so they are absent from the TGP calendar and open-slot
computation (`scheduling-open-slots.service.ts` L90-97) would offer those times.

## 10. Invariant cross-check

| Invariant                                      | How this record holds it                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New source → core diff = 0                     | Catalogue is TGP-side; no source names; scanner and storage are provider interfaces                                                                          |
| AI returns data only, never decides completion | Model proposes family + declared paths/classes; `destinationFor` and validators are pure; closure is null (RESET §1)                                         |
| Deterministic identity, writes, reconciliation | D-S8-3 key everywhere; one canonical record; one `nativeWrite`; ledger retarget; collision winner rule                                                       |
| Credentials never stored/learned/logged/sent   | §4.3 declared-path allow-list, pre-transform key screening, shape rules, corpus; key-only ingest redaction + purge; device headers memory-only               |
| Customer data never in cross-coach memory      | §4.7 boundary; V1 per-coach memory; dedup per coach                                                                                                          |
| Unknown ≠ 0; no false `complete`               | L0-owned projection referenced verbatim (no `destination`, seven codes); `complete` unreachable until the closure record; residual check; archived predicate |
| RLS never weakened                             | Service-role-only tables with REVOKE; expansions add `person_id IS NULL` guards only; §5.3 parent-existence ownership on every read                          |
| Erasure                                        | FAM-E1a before FAM-P2, FAM-E1b before FAM-M1; soft-edge selection; tombstone; reference-counted two-phase blob deletion                                      |
| Replay/cancel/timeout/process-loss safe        | Create-only, unique keys, one transaction per identity tree, copy-then-commit with orphan sweep, retryable erasure job                                       |

## 11. Closure maps

### r3 (R590-A2, R590-B2)

| Finding        | Section                              | How                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R590-A2-01     | §4.3 rules 2-4                       | Word-level credential screening on raw keys and `$map` labels before any transform; declared-path + class contract (fail closed); residual restated precisely and made an owner question (OQ-10); corpus adds the exact `$map` cases and ingest cases |
| R590-A2-02     | §4.6, §4.1, §6.2                     | Residual computed by every `nativeWrite` (native-first included); `residual_required` NOT NULL with CHECK; deletion/replay tests for both paths                                                                                                       |
| R590-A2-03     | D-FAM-2, §6.2                        | Provenance `imported_archived_at`; predicate `archived_at IS DISTINCT FROM imported_archived_at`; import-archived → coach change test                                                                                                                 |
| R590-A2-04     | §5.1, §5.4, §4.4                     | Immutable content-addressed blob; per-bucket `ImportMediaCopy`; copy-then-commit; orphan sweep; reference-counted two-phase erasure; shared-blob/rollback/process-loss tests                                                                          |
| R590-A2-05     | §5.3, D-FAM-3                        | Native parent existence + tenant via per-kind resolver; media reads coach-only in V1, client media explicitly out of OQ-2; role × tenant negatives incl. linked client and deleted parent                                                             |
| R590-A2-06     | D-FAM-1, §6.3                        | Per-record `destinationFor`; `families[]` has no `destination` field (binding decision); mixed families expressed by counts                                                                                                                           |
| R590-A2-C1     | §4.3 rule 10                         | Re-projection claim removed                                                                                                                                                                                                                           |
| R590-B2-B1     | §6.3, D-FAM-1, §7, §8 C-9            | Seven-code `NotMovedReason` with full mapping; exclusions → `not_moved: excluded_by_policy`, unmapped → gap; `unclassified` only; FAM-R1 → L2d edge                                                                                                   |
| R590-B2-B2     | §4.6, D-FAM-2, D-FAM-3               | One `nativeWrite` for every writer incl. S8-D1/S8-C withheld path; guard in FAM-P2, engine in FAM-G1; attach wording deleted (graduate first, attach only when not-ok); I-1 covers existing writers                                                   |
| R590-B2-B3     | §4.3, §4.6, §8 C-11                  | Ingest redactor key-only (no shape rules, no id drops); one canonical record consumed by both destinations; id classes defined; id false-positive corpus; URL query rule narrowed; equality test; OQ-10                                               |
| R590-B2-B4     | §4.4, §5.4                           | Reference count under `FOR UPDATE` across all Persons; blob and copies deleted only at zero refs; erase-A-B-plays test                                                                                                                                |
| R590-B2-B5     | D-FAM-4, §7                          | Rule over all consumers with code-enumerated lists (15 `workoutSession` files named); allow-list (a)-(c); `rg` spec + post-link tests bound to every W slice incl. S8-E1a/b/c; OQ-11                                                                  |
| R590-B2-C1..C7 | §6.1, §4.1, §4.6, §6.2, §9, §4.3, §7 | display-pending not in `preserved`; conversion reads staged payload and deletes evidence row; sentinel at consumed path; archived predicate; OQ-3 split, OQ-5 reworded; purge consequence stated; L0 to reference FAM-0 slice ids                     |

### r2 (R590-A, R590-B)

| Finding       | Section                             | How                                                                                                                                                       |
| ------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R590-A-A1     | §4.3                                | Allow-list projection, credential keys, value classes, URL rules, metadata covered, ingest + purge, corpus, stated residual (tightened in r3)             |
| R590-A-A2     | §4.1, §4.6, §6.2                    | One `graduated` state; `residual_id` RESTRICT FK + `residual_required`; bucket j residual check                                                           |
| R590-A-A3     | §4.6 step 5                         | Ledger retarget for all intents inside the transaction                                                                                                    |
| R590-A-A4     | §4.4, §7                            | Erasure by source identity incl. soft edges, tombstone, retryable job, export; FAM-E1a before P2, FAM-E1b before M1                                       |
| R590-A-B1     | §5.2                                | Scan provider; `ready` only on `clean`; download only when `ready`; per-hop redirect confinement                                                          |
| R590-A-B2     | D-FAM-4                             | `imported_at`; no invented read/review state; consumer exclusions; AI disclosure N-1                                                                      |
| R590-A-B3     | §5.1, §5.3, §4.2                    | Composite FKs; native parent verified; opaque 404; REVOKE; role × tenant negatives                                                                        |
| R590-A-C1..C3 | §7, §2, header                      | Topological order; `src/scheduling/jobs/reminder.job.ts`; anchored to L0 r5 / RESET                                                                       |
| R590-B-A1     | §6.3                                | FAM-0 projection deleted; `RunStatusProjectionV1` verbatim                                                                                                |
| R590-B-A2     | D-FAM-2, §6.2, §4.5                 | `clients` always native; `Person.source_archived_at`; buckets i/j and `already_present` amended; former-client display                                    |
| R590-B-B1     | §7, D-FAM-3                         | G1 depends only on P2; every writer depends on G1; I-1                                                                                                    |
| R590-B-B2     | §4.1                                | No evidence rows for new runs; `preserved_record` ledger kind; legacy conversion                                                                          |
| R590-B-B3     | §4.3                                | No token matching on coaching words; Luhn only under card-like keys; negatives kept                                                                       |
| R590-B-B4     | §4.6                                | One canonical input; sentinel refusal; atomic children                                                                                                    |
| R590-B-B5     | §5.4                                | Native-bucket copies per column; playback acceptance                                                                                                      |
| R590-B-B6     | D-FAM-4                             | Author = bearer's own source account or thread Person; `coach_id = Person.coach_id`                                                                       |
| R590-B-B7     | §4.4, §7                            | E1a before P2; E1b before M1                                                                                                                              |
| R590-B-B8     | §8 C-10, OQ-1/OQ-8                  | Reversal recorded; fail-closed defaults                                                                                                                   |
| R590-B-B9     | D-FAM-1, §8 C-9                     | Model proposes family + mapping only; destination derived; single token set                                                                               |
| R590-B-C1..C9 | FI-1, D-FAM-2, §9, §4.5, §4.1, §6.4 | FK shape per table; soft-edge clear; OQ-4/session notes; deterministic predicate; collision winner; metrics exclusion; states merged; arithmetic deferred |
