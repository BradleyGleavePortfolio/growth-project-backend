# FAM-0: every reachable family lands in TGP (native map + preserve destination) — r2

- **Status:** T4 design record, draft, r2 (closes R590-A and R590-B; §11). It changes no code,
  schema or API. It binds the FAM-\* build slices in §7, each graded separately (T4). Not merged,
  not product-accepted.
- **Date:** 2026-09-29. **Decision owner:** Bradley Gleave (repo owner).
- **Base:** backend `integration/importer` at `d6cf9eb6`. Every `path Lx` citation is at this base
  unless it names another record.
- **Records this extends:** "S8-DOC" = `docs/decisions/2026-09-24-s8-native-contract.md`;
  "S8D-DOC" = `docs/decisions/2026-09-26-s8d-person-link.md`; "S9-DOC" =
  `docs/decisions/2026-09-25-s9-reconciliation.md`; "EX1-DOC" =
  `docs/decisions/2026-09-28-ex1-exercise-resolution.md`; "RESET" = the executive reset of
  2026-09-29 (orchestrator, binding; recorded in the L0 r5 record); "L0-DOC" = the
  learn-and-remember record **r5** (`docs/decisions/2026-09-27-learn-and-remember.md` on
  `cand/x43/learn-doc-r2`, written in parallel). Until r5 lands, every L0 reference below names a
  RESET section, never an r3/r4 line number (R590-A-C3, R590-B-A1).
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
the closure record (§6.3).

This record decides:

1. A closed, vendor-neutral **family catalogue** (§3). The destination of a record is a
   deterministic function of its family and the gate state, never a model choice.
2. **PRESERVE** (§4): a tenant-scoped, person-linked, idempotent, credential-safe store for any
   reachable record. Displayed to the coach, graduated to native without loss, never read by AI.
3. A **media path** (§5) with a clean-scan gate and a copy strategy that keeps graduated media
   playable on existing screens.
4. **Reconciliation inputs** (§6): the preserved bucket, the residual obligation, the archived
   amendment, and the codes FAM-0 contributes to `RunStatusProjectionV1` (owned by L0, RESET §6).
5. **Slices** (§7) in landable order; erasure hooks land before any client-data or media writer.

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

**Destination determinism (R590-B-B9).** A learned or authored spec (and therefore the model, via
L0-DOC `LearnedProposalV1`) proposes **data only**: a `family` from this catalogue (including
`unclassified`) and a field mapping. It never proposes a destination or a group. The destination
is computed by one pure function, `destinationFor(family, gateState) → 'native' | 'preserve'`,
where `gateState` is the native writer registry (D-FAM-3): `native` iff the registry lists a
native writer for the family **and** the record passes that writer's typed rules; otherwise
`preserve`. The catalogue is the single token set; L0-DOC's `PreserveGroup`/`other` is replaced by
`family`/`unclassified` (§8 C-9). The identity key's `entity_type` is always the family, so
graduation is keyed identically whichever destination a record first landed in.

| Family                | Owner | Native model (when the gate is open)                                  | Gate                                          |
| --------------------- | ----- | --------------------------------------------------------------------- | --------------------------------------------- |
| `clients`             | C     | `Person` (always native, including former clients; D-FAM-2)           | exists (S8-D1)                                |
| `client_profile`      | P     | none yet (OQ-6)                                                       | a person-capable profile design               |
| `programs`            | C     | `WorkoutProgram`                                                      | exists (S8-C)                                 |
| `workouts`            | C     | `WorkoutPlan`; child `workouts.exercise` → `WorkoutPlanExercise`      | exists (S8-C); withheld plan (EX1) ⇒ preserve |
| `exercises`           | C     | `CoachExercise`                                                       | EX1-A, EX1-B                                  |
| `workout_assignments` | P     | `ClientWorkoutAssignment`, inactive                                   | #587 + S8-E1d + S8D-DOC OQ-12                 |
| `workout_logs`        | P     | `WorkoutSession`; child `workout_logs.set` → `ExerciseSet`            | #587 + S8-E1a                                 |
| `client_history`      | P     | none (legacy generic token; new runs preserve only, §4.1)             | none: new specs must name a specific family   |
| `messages`            | P     | `CoachMessage`                                                        | FAM-N1                                        |
| `food_logs`           | P     | `LoggedFoodEntry` + tenant food row                                   | FAM-N2a + FAM-N2b                             |
| `water_logs`          | P     | `WaterLog`                                                            | FAM-N2b                                       |
| `nutrition_targets`   | P     | `MacroTarget`                                                         | FAM-N2c                                       |
| `meal_plans`          | C / P | `MealPlan` (`client_id`/`person_id` NULL ⇒ coach template)            | FAM-N2c                                       |
| `checkins`            | P     | `CheckIn`                                                             | #587 + S8-E1b                                 |
| `body_weights`        | P     | `WeightLog`                                                           | #587 + S8-E1b                                 |
| `body_measurements`   | P     | none                                                                  | a native design                               |
| `habits`              | P     | `Habit`; child `habits.log` → `HabitLog`                              | #587 + S8-E1c                                 |
| `coaching_sessions`   | C / P | `CoachingSession` (terminal statuses only; D-FAM-4)                   | FAM-N6                                        |
| `notes`, `goals`      | P     | none                                                                  | a native design                               |
| `forms`               | C     | none                                                                  | a native design                               |
| `form_responses`      | P     | none                                                                  | a native design                               |
| `media`               | C / P | preserved media (§5) attached to its parent                           | FAM-M1 (until then: not moved, with a reason) |
| `billing_history`     | P     | none; **default not moved** (`out_of_scope_billing`, disclosed; OQ-1) | owner answer to OQ-1                          |
| `unclassified`        | C / P | none (a reachable coaching collection the mapping cannot name; OQ-7)  | —                                             |

Non-records (account settings, UI configuration, third-party service data) stay out of scope by
the structural exclusion rule and RESET §5, never by a model choice. A confirmed exclusion is
disclosed in `not_moved[]`, never counted as moved.

### D-FAM-2: per-family contract

**Common rules** (extending S8-DOC §3; nothing relaxes it):

- **Identity.** Every top-level record is keyed on the D-S8-3 key
  `(coach_id, source_namespace, entity_type = family, source_id)`. Native records carry it in
  `ImportNativeProvenance` (unique L7027); preserved records in `ImportPreservedRecord_identity_key`
  (§4.1). **Exactly one destination holds a key**: a provenance row and a preserved row in state
  `preserved` never coexist for one key (invariant test I-1, §7). `source_id` comes from the
  spec-declared id path, never a name or model output (EX1-DOC D-EX1-1). Children use
  `childSourceId` (`native-contract.ts` L110-120).
- **Spec grammar.** Per family, one minimum role set per source step: `idField` (required),
  `personSourceId` (P families), `occurredAt`/`occurredOn` with zone basis (S8-DOC §3.9), `title`,
  and for `messages` `authorSourceId` and `authorRole`. Native typed roles come from the native
  rule registry (`native-rules.ts` L794). The spec `families` object becomes a map over the
  catalogue (FAM-C1; L0-DOC validators apply unchanged).
- **Person edge (P families).** `personSourceId` resolves only through provenance of the `clients`
  identity (kind `person`), never by name or email (S8-DOC §3.8).
  - Resolved: native row person-owned (`person_id`, owner `User` NULL) or preserved row with
    `person_id`.
  - Unresolved: preserved with `person_id` NULL and `person_source_id` as a soft edge (S9 E-R3
    `relationship_unverified`). A later run attaches it under `FOR UPDATE`: `person_id` set,
    `person_source_id` cleared (the CHECK in §4.1 requires exactly one) (R590-B-C2).
  - A `Deleted` Person (S8D-DOC §2.3) is a tombstone: no row resolving to it, by id or by soft
    edge, is written; the record is `not_moved: person_erased`.
- **Former and archived clients (R590-B-A2).** `clients` is **always** native `Person`. `Person`
  gains `source_archived_at DateTime?` (FAM-C1 pin; a data column written by the `clients` writer
  from the source's archived/inactive role; never a `PersonState`, which stays lifecycle-only).
  The roster shows such Persons under "Former clients"; their dependents resolve like any other
  Person's. Other archived source records move too, amending S8-DOC §3.7 `source_archived`:
  native with `archived_at := source value` where the model has the column (`WorkoutProgram`,
  `WorkoutPlan`, `MacroTarget`, `MealPlan`), else preserved with `source_archived = true`.
  Provenance gains `source_archived Boolean @default(false)` so reconciliation can tell an
  import-time archive from a coach action (§6.2).
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
| `coaching_sessions`   | `title`, `start_at`, `end_at`, `status ∈ {completed, canceled, no_show, declined}`, notes; providers `stub`; no `SessionParticipant` | optional person                               | source instants                                   | future or non-terminal (never `scheduled`: reminders and open-slot computation, FI-4; owner note in OQ-3)  |
| `workout_assignments` | S8D-DOC OQ-12                                                                                                                        | person; plan by provenance                    | `scheduled_for`                                   | until OQ-12 is answered                                                                                    |
| `exercises`           | EX1-DOC D-EX1-2                                                                                                                      | —                                             | —                                                 | EX1 withheld (§8 C-2)                                                                                      |

**Residual fields.** A native record whose source row carries fields the native model cannot hold
keeps them in a `graduated` row of `ImportPreservedRecord` (§4.1) under the same identity: native
pointer plus residual. The residual obligation is deterministic and verified (§4.6, §6.2).

### D-FAM-3: gates for client-owned families

- A native P-family writer runs only when its table has the #587/FI-1 shape **and** S8-D1's typed
  `person` handoff resolves the edge. The writer registry is the gate state (D-FAM-1): a family is
  native only for tables whose migration is present. A registry flip from `preserve` to `native`
  ships in the same commit as the writer and the FAM-G1 preserved-key guard call (§4.6).
- The S8D-DOC §2.7 link transaction re-owns rows through the provenance join. Each FI-1 table
  joins that list in its FAM-N slice, including `CoachMessage.sender_person_id → sender_id`.
  Preserved rows never flip owner; after a link the client's read (if OQ-2 allows) goes through
  `Person.linked_user_id`.
- RLS never widens: person-owned native rows and PRESERVE are service-role only.

### D-FAM-4: event time, authorship and the imported-history rule (R590-A-B2, R590-B-B6, R590-B-C8)

- **Event time.** `CoachMessage.created_at := occurredAt` for imported messages only (the thread
  orders on it, index L1227). This is the sole exception to S8-DOC §3.3.
- **Authorship.** The run carries the bearer's own source account id (the source account scope,
  RESET §2). A coach-authored message is native only when `authorSourceId` equals it; then
  `sender_id = bearer`. A client-authored message is native when `authorSourceId` equals the
  thread Person's `source_person_id`; then `sender_person_id = person`. Any other author (staff,
  sub-coach, another client) ⇒ preserved. Thread `coach_id = Person.coach_id` (the tenant head
  coach, as `coach-effectiveness.service.ts` L466-469 already models).
- **Imported-history rule.** Every native table that gains a FAM writer gains `imported_at
DateTime?` (indexed) in its expansion migration, set only inside the writer's transaction. No
  read state, review state or notification is invented: `read_at` stays NULL unless the spec
  declares a read-state role (then it is a source fact); `CheckIn.reviewed_by_coach` keeps its
  default. Instead every attention, notification and metrics consumer excludes
  `imported_at IS NOT NULL`: unread counts and badges, push and PTM (`messaging.service.ts` L461,
  L493-499, L548), the check-in queue (`coach.service.ts` L728), reminders (`reminder.job.ts`
  L46-47), platform `created_at`-window metrics (`src/admin/metrics.service.ts` L54-55). Each FAM-N slice
  lists its consumers and ships a post-link test per consumer (zero badge, zero queue entry, zero
  push). Thread and history screens render imported rows with no read receipt.
- **Disclosure.** The import itself is AI-free (§4.7). Once a row is native and the client linked,
  it follows live product behaviour, including the per-client AI context for that coach
  (`client-ai-context.service.ts` L192). This is stated on the coach-facing result and in §9 note N-1.

## 4. PRESERVE: the universal destination

### 4.1 Schema (FAM-P1; additive migration with a refusing down)

```prisma
model ImportPreservedRecord {
  id                String    @id @default(uuid())
  coach_id          String                       // tenant key
  person_id         String?                      // FK (person_id, coach_id) → Person(id, coach_id), ON DELETE RESTRICT
  person_source_id  String?                      // soft edge while unresolved (D-FAM-2)
  import_intent_id  String?   @db.Uuid           // FK (import_intent_id, coach_id) → ImportIntent(id, coach_id), RESTRICT
  source_namespace  String
  family            String                       // CHECK: catalogue + child families
  source_id         String
  parent_family     String?
  parent_source_id  String?
  occurred_at       DateTime? @db.Timestamptz
  occurred_on       DateTime? @db.Date
  title             String?                      // ≤ 200 chars, §4.3 text rules applied
  source_archived   Boolean   @default(false)
  fields            Json                         // §4.3 projection; residual only when graduated
  fields_sha256     String
  byte_size         Int                          // CHECK 0 < byte_size ≤ SCOUT_PRESERVE_MAX_BYTES
  dropped           Json                         // { <DropCode>: count }, codes only (§4.3)
  projection_version Int
  state             String    @default("preserved") // CHECK IN ('preserved','graduated')
  native_kind       String?                      // set iff state = 'graduated'
  native_id         String?
  graduated_at      DateTime?
  created_at        DateTime  @default(now())

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
preserved. `ImportNativeProvenance` gains `residual_id String? @unique` with FK →
`ImportPreservedRecord(id)` ON DELETE RESTRICT and `residual_required Boolean`. A graduated row
cannot be deleted while its provenance exists, and reconciliation refuses a native identity whose
`residual_required` row is missing (§6.2) (R590-A-A2).

**Ledger.** `ScoutReconstructionLedger.target_kind` gains `preserved_record` (CHECK expand of
L191). A preserved top-level identity is ledger `reconstructed` with that kind and
`target_id = ImportPreservedRecord.id`. Children and residuals are not ledger rows.

**No third destination (R590-B-B2).** From FAM-P2 on, no run writes `ScoutReconstructedEntity`
evidence rows (the upserting `persist` in `families.ts` L117-134 is retired for new runs);
`client_history` and rule-less `workouts` go to PRESERVE with ledger kind `preserved_record`.
Legacy `scout_entity` rows are converted once, idempotently per coach, by FAM-P2: project the
payload with §4.3, insert the preserved row under the same identity, retarget the ledger rows to
`preserved_record`. Until converted they stay S9 bucket f (`not_moved: no_destination_yet`).

### 4.2 RLS and tenancy

Exactly the `Person`/provenance posture: ENABLE + FORCE; permissive `service_role` policy;
RESTRICTIVE deny-all for `anon` and `authenticated`; explicit `REVOKE ALL ... FROM anon,
authenticated` (`20270122000000` L167-182). No principal reads the tables directly. Every read
route filters `coach_id = req.user.id` and re-asserts the parent's ownership (§5.3); any miss is an
opaque 404. The FAM-P1 RLS spec is the S8D-DOC §2.2 item 4 matrix plus role × tenant negatives.

### 4.3 The preserved projection: credential-safe by construction (R590-A-A1, R590-B-B3)

`fields` is computed by one pure, versioned core function
`preserveProjection(object, spec) → { fields, dropped }`. It is an **allow-list**: a value is stored
only if it passes every rule below; anything else is replaced by `{"$dropped": "<DropCode>"}` and
counted in `dropped`. Codes: `credential_key`, `credential_shape`, `card_number`, `contact_pii`,
`url_unadmitted`, `key_unadmitted`, `over_bound`.

1. **Scope.** Only objects from collections the run classified into a catalogue family enter.
   Settings, UI-config and third-party collections are excluded upstream (L0 exclusion rule;
   RESET §3, §5): the collections where credentials live never reach this function.
2. **Key admission.** Keys are matched on `norm(key)` = lower-case with `_`, `-` and spaces
   removed. A key that fails the grammar `^[A-Za-z_][A-Za-z0-9_\-]{0,63}$` (coach-defined labels,
   RESET §3) does not become a key: the object collapses to `{"$map": [{"k": <text>, "v": …}]}` and
   `k` is treated as a text value under rule 4.
3. **Credential keys (exact, closed, versioned `CREDENTIAL_KEYS`).** The value, whatever its shape
   or depth, is dropped as `credential_key` when `norm(key)` is in the set — `password`, `passwd`,
   `pwd`, `passphrase`, `secret`, `clientsecret`, `apikey`, `apisecret`, `accesstoken`,
   `refreshtoken`, `idtoken`, `authtoken`, `sessiontoken`, `sessionid`, `csrftoken`, `bearer`,
   `authorization`, `auth`, `cookie`, `setcookie`, `privatekey`, `sshkey`, `otp`, `totp`,
   `mfacode`, `backupcode`, `backupcodes`, `recoverycode`, `recoveryphrase`, `mnemonic`,
   `seedphrase`, `securityanswer`, `pin`, `cardnumber`, `pan`, `ccnumber`, `cvv`, `cvc`, `iban`,
   `accountnumber`, `routingnumber`, `ssn`, `taxid`, `nationalid`, `passportnumber` — or ends
   with `token`, `secret`, `password`, `apikey`, `privatekey`, `credential`, `credentials`.
   **Token matching is gone**: `session`, `sessionDate`, `workout_session`, `signature`,
   `signed_at`, `account`, `token_count` are kept (they are coaching data and in L0-DOC's
   `COACHING_VOCABULARY`).
4. **Value-shape admission (strings).** A string is stored only if it is one of: an ISO
   date/time; a number-shaped string; an id-class string (`int_id | uuid | short_id`, ≤ 64); a URL
   admitted by rule 6; or **text**. Text is admitted when it contains whitespace, or has no
   whitespace and is < 20 characters, or has no whitespace and uses ≤ 2 of the four character
   classes {lower, upper, digit, symbol} and is not base64/hex-shaped ≥ 32 chars. Everything
   else is `credential_shape`. Dropped regardless of length: a JWT (three base64url segments,
   first decoding to JSON with `alg`), `Bearer `/`Basic ` prefixes, PEM blocks. Inside text, a
   whitespace-delimited word that would itself fail this rule is replaced by `[hidden]` and
   counted once.
5. **Card numbers.** A 13-19 digit string passes Luhn **only** when a card-like token (`card`,
   `creditcard`, `paymentmethod`, `bank`) is in its own key or any ancestor key; then it is
   `card_number`. Epoch-ms timestamps, 18-19 digit ids and EAN-13 barcodes under other keys are
   kept (the r1 rule dropped about 10 % of them; scratch `reviews/scratch/R590-B/luhn.py`).
6. **URLs.** Userinfo present ⇒ dropped. Otherwise query and fragment are removed and each path
   segment must pass rule 4; a failing segment drops the whole URL as `url_unadmitted`. A URL under
   a spec-declared media role becomes `{"$media": "<ImportPreservedMedia id>"}` once §5 holds the
   bytes, else `{"$media_pending": <ordinal>}`; the URL string itself is never stored.
7. **Contact PII** (OQ-8 default): values under `email`/`phone`/`address`/`dob`-class keys and
   email-like or phone-like values are `contact_pii` until the owner answers.
8. **Spec-declared roles** (`idField`, `personSourceId`, parent edge, `occurredAt`, `title`) are
   exempt from rule 4 and instead must satisfy their own class: ids are id-class ≤ 64 chars,
   `title` is text ≤ 200 after rule 4. `source_id`, `person_source_id`, `parent_source_id`,
   `title` and `family` are therefore covered by the same function, not left outside it.
9. **Bounds.** Depth ≤ 8, ≤ 500 keys, string ≤ 16 KiB, canonical JSON ≤ `SCOUT_PRESERVE_MAX_BYTES`
   (default 64 KiB, hard cap 256 KiB). Over-bound ⇒ the record is `not_moved: preserve_over_bound`
   (a count), never truncated.
10. **Canonical form.** Sorted keys; `fields_sha256` over the canonical bytes; `projection_version`
    stored so a rule change can re-project stored rows deterministically.

**Why credentials are provably excluded.** (i) Positive controls: credentials live in
settings-class collections that never enter (rule 1); no value is stored unless it matches an
admitted class (rule 4); every named credential key drops its value at any depth (rule 3); URL
tokens cannot survive (rule 6); metadata columns pass the same function (rule 8). (ii) Device
side (RESET §3-§4): captured request headers are memory-only and never sent to TGP; a key equal to
any captured value is refused. (iii) **Stated residual:** a short (< 20 chars), low-entropy secret
under an unlisted key in a coaching collection (`{"hint": "mydog"}`) is indistinguishable from
data; the mitigations are rule 1, the closed versioned key set, and re-projection on version bump.
(iv) **Staged payloads:** FAM-P2 replaces `redactPayload` (`scout-ingest.service.ts` L149-183,
key denylist only) with rules 3-6 of this function, so no staged row holds a credential shape, and
clears `ScoutIngestEntity.payload` to `{}` once the intent settles (identity columns stay for S9
counts; PRESERVE never depends on staged retention).

**Test corpus** (`src/scout/preserve/__fixtures__/credential-corpus.json`, synthetic values, codes
and counts asserted, values never logged). Must drop: JWT, `Bearer x`, `Basic x`, PEM, a 40-char
`sk_`-style token under `note`, `{"recoveryPhrase": "alpha beta gamma"}`,
`{"auth": "opaque-secret"}`, `{"card": {"number": "<Luhn-valid 16>"}}`, a URL with userinfo, a URL
whose path segment is a 48-char base64url token, a password as a `$map` key label. Must keep:
`"created": "1727600000000"`, a 19-digit id string, an EAN-13 under `barcode`, `session`,
`sessionDate`, `workout_session`, `signature: "signed on device"`, `signed_at`, a UUID, a slug
`upper-body-strength-day`, an ISO date, a 2 KiB coaching note, single words (`Monday`, `kg`).

**Relation to TM-14** (`docs/decisions/2026-06-17-tm-14-no-raw-payload-storage.md`): this is TM-14
option (C), a sanitized bounded projection; the source stops being the system of record when the
coach leaves it.

### 4.4 Retention, erasure and export (FAM-E1a lands before FAM-P2; R590-A-A4, R590-B-B7)

- **Retention:** as long as the coach account and the Person exist. A `graduated` row keeps only
  identity and residual, so no value is stored twice.
- **Person erasure** (S8D-DOC §2.3 explicit path) selects by tenant-scoped source identity,
  including soft edges: `coach_id = P.coach_id AND (person_id = P.id OR (person_id IS NULL AND
source_namespace = P.source_platform AND person_source_id = P.source_person_id))`, deletes those
  rows, their `ImportPreservedMedia` rows and blobs (`deleteObject`, L116), and the ledger and
  provenance rows of those identities, in one audited operation. Blob deletion failures are
  recorded in a retryable `ImportErasureJob` row; the Person transitions to `Deleted` only when
  the job is done. `Deleted` is a tombstone (D-FAM-2): re-import refuses.
- **Coach account deletion** (`src/account-deletion/account-deletion.service.ts`, which has no
  Person or import handling today) deletes preserved rows, media rows and blobs by `coach_id`, with
  the same retryable job.
- **Export:** coach export of preserved records per Person (JSON + signed media links) in FAM-E1a;
  the client data export (`src/data-export/data-export.service.ts`) includes preserved records only
  for OQ-2-visible families.
- **Sequencing rule:** FAM-P2 does not write in any environment where FAM-E1a's deletion paths are
  not present and tested; FAM-M1 does not write blobs before FAM-E1b (media erasure) is present.

### 4.5 Display

- **Coach mobile, client detail:** "From your previous platform": per family a count and a
  date-ordered list; per record title, `occurred_at`, humanised fields, media thumbnails via
  short-lived signed URLs (§5.3), and a "hidden: n" marker from `dropped` (per code class:
  sensitive, contact details pending owner decision). Read-only. Former clients reach it from the
  roster's "Former clients" list.
- **Imported library:** coach-owned preserved records (`forms`, `meal_plans` templates,
  `unclassified` without a person).
- **Residuals** render under their native record as "More from your previous platform".
- **Client visibility:** coach-only by default (OQ-2); coach-private families never client-visible.
- **Viewability predicate** (R590-B-C6): server-side and deterministic — `PRESERVE_VIEWABLE =
true` is exported by the FAM-P3 route module when it registers; §6.1 reads it. No mobile
  release assumption.

### 4.6 Graduation to native without loss (FAM-G1; R590-A-A3, R590-B-B4)

Graduation runs when a family's gate opens. It has **one canonical input**: the stored `fields`
(the record TGP holds). No re-import is needed and the fresh payload is never used as native
input for a preserved identity (create-only: L0-DOC "deterministic backfill without re-import").

1. **Triggers.** (a) The next run of that source: the native writer looks up provenance (none),
   then the preserved key, finds a `preserved` row, and graduates it in the same transaction from
   `fields`; the fresh payload is used only as create-only replay verification (drift is evidence,
   never an update). (b) On demand per coach, when the source is gone. Both call the same function
   with `{source_id, source_platform: source_namespace, payload: fields}` (the `map()` input shape,
   `native-families.ts` L31-36).
2. **Sentinels.** Native interpreters return not-ok for any `$dropped`, `$map`, `$media_pending`
   value; `$media` is accepted only by media-role rules (§5.4). Not-ok ⇒ nothing changes and the
   row stays `preserved`.
3. **Transaction** (parent and all its children, or none):
   1. `SELECT … FOR UPDATE` the preserved row and its children; assert provenance absent.
   2. Write native rows and provenance `created`; set `imported_at`; copy media (§5.4).
   3. Compute the **residual** = paths of `fields` minus the paths the native rules consumed
      (deterministic: the consumed set is the rule paths). If non-empty: set `state =
'graduated'`, `native_kind`, `native_id`, replace `fields` with the residual, and set
      `provenance.residual_id`/`residual_required = true`. If empty: delete the preserved row and
      set `residual_required = false`.
   4. **Retarget the ledger** for every intent of this identity: `UPDATE ScoutReconstructionLedger
SET target_kind = <native kind>, target_id = <native id> WHERE coach_id, entity_type,
source_platform, source_id match AND target_kind = 'preserved_record'`. S9 bucket h then holds
      for all prior intents.
4. **Accounting.** One identity, one count: native once graduated, else preserved. A race with an
   import converges on the provenance unique (`families.ts` retry-once).
5. **Tests** (FAM-G1 acceptance): create → graduate → reconcile → replay; residual present and
   RESTRICT-protected; children all-or-nothing; sentinel refusal; ledger retargeted for two
   intents.

### 4.7 Preserved values never reach the AI or cross-coach memory

- **Module boundary spec** (FAM-P2 acceptance): outside `src/scout/preserve/**`,
  `src/scout/reconciliation/**`, `src/account-deletion/**`, `src/data-export/**`, no file references
  the Prisma delegates `importPreservedRecord`, `importPreservedMedia`, `importMediaBlob`. `src/ai/**`,
  `src/roman/**`, `src/insights/**`, `src/coach/brief/**`, `src/coach/command-center/**`,
  `src/notifications/**`, `src/community/**`, `src/scout/learn/**` never import the preserve module.
  `rg`-based, fails on a new reference.
- **Learn memory** is structure-only and, in V1, per coach (RESET §2). Preserved values are never
  digest input.
- **Logs and telemetry** carry counts and closed codes only (S9-DOC D-S9-7).

## 5. Media, photos and files (FAM-M1; R590-A-B1, R590-A-B3, R590-B-B5)

### 5.1 Tables

- `ImportMediaBlob`: `coach_id`, `content_sha256`, `byte_size`, `content_type`, `storage_key`,
  `state ∈ {uploading, verified, ready, rejected}`, `scan_status ∈ {pending, clean, rejected,
error}`, `scanned_at`. Unique `(coach_id, content_sha256)`; dedup within one coach only.
- `ImportPreservedMedia`: identity `(coach_id, source_namespace, 'media', source_id)`; `blob_id`
  with FK `(blob_id, coach_id) → ImportMediaBlob(id, coach_id)`; parent is **either**
  `preserved_record_id` with FK `(preserved_record_id, coach_id) → ImportPreservedRecord(id,
coach_id)` **or** `(native_kind, native_id)` (CHECK exactly one). Both tables use §4.2.

### 5.2 Path and scan gate

1. The extension fetches bytes in the authorized tab, from the run's confined origin set only
   (OQ-4), with `redirect: 'manual'`: **every** redirect hop is checked against the set; an
   unconfined hop is `media_origin_unconfined`.
2. It computes SHA-256 and calls the scout media route with
   `{family, source_id, parent key, sha256, byte_size, content_type}`.
3. Server: `already_present` if the blob is `ready`; else a signed PUT (`createSignedUploadUrl`,
   L82) for `imports/<coach_id>/<sha256>` in a **separate private bucket** (`IMPORT_MEDIA_BUCKET`;
   never the sellable-content bucket).
4. On confirm the server reads the object once, checks size, SHA-256 and magic bytes against
   `content_type` (`verified`; failure `media_verify_failed`), then submits it to
   `MediaScanProvider.scan(storage_key)` (a vendor-neutral provider interface, like the storage
   provider). `ready` **only** on `clean`. `rejected` ⇒ blob deleted, `not_moved:
media_scan_rejected`. `error` or timeout (`MEDIA_SCAN_TIMEOUT_MS`) ⇒ stays `verified`, retried,
   reported `not_moved: media_scan_unavailable`. No scanner configured ⇒ nothing becomes `ready`
   (fail closed; OQ-9).
5. Signed download URLs are minted only for `ready` blobs. A blob counts as "in TGP" only when
   `ready`.
6. Bounds (environment-tunable down only): image ≤ 25 MB; PDF ≤ 50 MB (`PDF_MAX_BYTES`,
   `coach-media.dto.ts` L12); audio ≤ 25 MB; video ≤ 500 MB, never transcoded; other ≤ 25 MB
   served as `application/octet-stream`; run budget 20 GB; coach total 100 GB. Excess is
   `not_moved: media_over_bound | media_quota_exceeded`. Storage and egress cost scales with these
   caps; the owner sets them (OQ-3).

### 5.3 Ownership contract for reads

Every media route (`sign`, `thumbnail`, attachment listing) verifies, in order: `blob.coach_id =
req.user.id`; the `ImportPreservedMedia` row's `coach_id = req.user.id`; the parent belongs to the
caller — a preserved parent by the composite FK, a native parent by an `ImportNativeProvenance`
row `(coach_id = caller, native_kind, native_id)`; the blob is `ready`. Any miss is an opaque 404.
Tests: role × tenant negatives (anon, authenticated, other coach, own coach with a foreign parent
id, own coach with a foreign blob id, non-ready blob).

### 5.4 Graduated media stays playable (copy strategy)

Native surfaces resolve media by their own columns and buckets: `CoachMessage.voice_url` must be a
URL the live path could have produced (`messaging.service.ts` L214-249: storage host and
`/<voice-notes bucket>/<owner>/` prefix); `CoachExercise` demo media uses the column and bucket
EX1-C defines; check-in photos have no native column and stay preserved media attached to the
native `CheckIn` parent. On graduation, FAM-G1 **moves** the object: copy the blob within the
storage provider into the native bucket under that column's key scheme
(`<native bucket>/<owner id>/imported/<sha256>.<ext>`, owner = the tenant coach's user id for both
coach- and client-authored messages, since the client has no `User` before link and the prefix
check applies to the send path only), verify SHA-256 of the copy, write the native column, repoint
`ImportMediaBlob.storage_key`, delete the import-bucket object. One object, two readers: the
native screen through its existing path, the preserve route through §5.3. FAM-N1 acceptance
includes playback of an imported voice note in the thread screen for the coach and for a linked
client; EX1-C acceptance likewise for a demo clip in an assigned workout.

## 6. Reconciliation

### 6.1 What FAM-0 fixes about counting

Native and preserved records both count as "in TGP" once viewable (`PRESERVE_VIEWABLE`, §4.5).
Before that, preserved identities are reported `not_moved: preserve_display_pending` (a count).
Nothing here makes `complete` reachable: RESET §1 leaves closure null for every package type, so
runs settle `partial` with gap `completeness_not_proven`. The arbiter stays the only terminal
writer (S7-L).

### 6.2 S9 amendments (FAM-R1)

- **Bucket j-p `preserved_present_verified`**, after j, before k: ledger `reconstructed` with
  `target_kind = preserved_record`, and the preserved row present under the same key and
  `coach_id` in state `preserved`.
- **Bucket j residual check** (R590-A-A2): j additionally requires
  `provenance.residual_required = false OR residual row present with matching native_kind/native_id`;
  otherwise `unresolved:residual_missing` (`not_moved: residual_missing`).
- **Archived amendment** (R590-B-A2): buckets i and j, and S8 §3.4 `already_present`, treat a
  native row as "archived" only when `archived_at IS NOT NULL AND NOT provenance.source_archived`.
  An import-time archive is verified present; a coach archive or removal stays bucket i (no false
  count).
- **Children.** A child that is neither native nor preserved counts `unresolved_children`.
- **Conditions.** C-FAM fires only for a staged token that resolves to no family (a spec defect).
  C-ID excludes j-p. C-REL includes unresolved person edges on preserved rows.
- **Invariant test I-1** (§7): for every key, never both a provenance row and a preserved row in
  state `preserved`.

### 6.3 Run-status projection: owned by L0, referenced verbatim (R590-B-A1)

FAM-0 defines no projection fields. `GET scout/import/status` returns **`RunStatusProjectionV1`**
exactly as RESET §6 defines it: existing verdict fields; `families[]` = `{ family, destination:
'native'|'preserve', source_count: int|null, count_basis: 'proven'|'observed'|'unknown',
moved_native: int, preserved: int, not_moved: int|null }`, one row per family seen including
preserved families; `not_moved[]` = `{ family, count: int|null, reason: NotMovedReason }`;
`gaps[]` = `{ family: string|null, code: GapCode }`. A fact with a count goes to `not_moved`; an
unknown goes to `gaps`; never both; unknown = `null`, never 0. Extension and mobile render only
this. FAM-R1 fills `moved_native` (bucket j), `preserved` (j-p) and `destination`
(`destinationFor`, D-FAM-1); L3 fills `source_count`/`count_basis`.

FAM-0 contributes these closed codes to L0's enums (FAM-C1 lands the vocabulary; L0 owns the enum):

| S9 / FAM fact                                                                                                                                                       | `NotMovedReason`                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `preserve_over_bound`, `preserve_display_pending`, `residual_missing`                                                                                               | same names                                                                |
| `media_over_bound`, `media_quota_exceeded`, `media_fetch_failed`, `media_origin_unconfined`, `media_verify_failed`, `media_scan_rejected`, `media_scan_unavailable` | same names                                                                |
| `person_erased`                                                                                                                                                     | same                                                                      |
| `unresolved:native_target_removed`                                                                                                                                  | `removed_by_coach`                                                        |
| `unresolved:identity_conflict`                                                                                                                                      | `identity_unresolved`                                                     |
| bucket f legacy evidence rows                                                                                                                                       | `no_destination_yet`                                                      |
| `failed`, `missing_source_id`, `unsupported_platform:<p>`                                                                                                           | `write_failed`, `identity_unresolved`, `structure_unrecognized`           |
| confirmed exclusions                                                                                                                                                | `out_of_scope_billing` / `out_of_scope_settings` / `out_of_scope_ui` (L0) |

No `GapCode` is added by FAM-0. The per-record `dropped` counts (§4.3) are shown in the coach
display, not in the projection; adding a redaction count to `families[]` is an L0 owner question
(§9 N-2).

### 6.4 Deferred to the completeness-closure record (RESET §1)

Required inputs, not decided here: the release gate as a `complete` condition (R590-A-B1 "ready"
gating), C-COV, "every media ref ready", "zero not-moved", the `excluded[]` and staged > observed
arithmetic (R590-B-C5), and any run-level closure for preserved families.

## 7. Slice plan (landable order; R590-A-C1, R590-B-B1, R590-B-B7)

Tiers follow the T0-T4 doctrine. "Pin" = ships a migration and re-pins the S11 harness (S8D-DOC
§6). Every writer slice below (marked W) depends on FAM-G1 and calls its preserved-key guard; no
writer for a family that FAM-P2 preserves may land before FAM-G1.

| #   | Slice                                                                                                                                                                                                                             | Tier  | Depends on                               | Pin |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------- | --- |
| 0   | **FAM-0** this record                                                                                                                                                                                                             | T4    | —                                        | no  |
| 1   | **FAM-C1** catalogue tokens, spec grammar role set, `destinationFor`, `preserved_record` ledger kind, `Person.source_archived_at`, provenance `source_archived`/`residual_*`, projection codes to L0 enums, contract regeneration | T4    | L2a #588, L0 r5                          | yes |
| 2   | **FAM-P1** `ImportPreservedRecord` schema, CHECKs, RLS, composite FKs, RLS matrix spec                                                                                                                                            | T4    | #587, FAM-C1                             | yes |
| 3   | **FAM-E1a** erasure and export for preserved rows: Person erasure by source identity incl. soft edges, tombstone refusal, coach account deletion by `coach_id`, `ImportErasureJob`, coach export                                  | T4    | FAM-P1                                   | yes |
| 4   | **FAM-P2** preserve writer: §4.3 projection + corpus, ingest redactor replacement and staged purge, bounds, person edge, legacy evidence conversion, module-boundary spec                                                         | T4    | FAM-P1, FAM-E1a, S8-D1                   | no  |
| 5   | **FAM-P3** coach read route (per Person, former clients, library), `PRESERVE_VIEWABLE`, contract regeneration                                                                                                                     | T4    | FAM-P2, S8-D2 #577                       | no  |
| 6   | **UX-P3** mobile "From your previous platform", "Imported library", "Former clients"                                                                                                                                              | T2    | FAM-P3                                   | —   |
| 7   | **FAM-G1** graduation engine: preserved-key guard, canonical input, residual, ledger retarget, media move hook, invariant test I-1                                                                                                | T4    | FAM-P2                                   | no  |
| 8   | **FAM-R1** reconciliation: j-p, residual check, archived amendment, projection fill, extension/mobile decode                                                                                                                      | T4    | FAM-P3, FAM-G1, L3 #589                  | no  |
| 9   | **S8-E1a** (W) workout logs                                                                                                                                                                                                       | T4    | #587, S8-D1, FAM-G1                      | yes |
| 10  | **S8-E1b** (W) check-ins + body weights (collision winner; unmapped required values preserved)                                                                                                                                    | T4    | S8-E1a                                   | no  |
| 11  | **S8-E1c** (W) habits                                                                                                                                                                                                             | T4    | S8-E1a                                   | no  |
| 12  | **FAM-E1b** media erasure (blob deletion in Person erasure and account deletion, retryable job)                                                                                                                                   | T4    | FAM-E1a                                  | no  |
| 13  | **FAM-M1** media: tables, bucket, signed upload, verify, `MediaScanProvider`, quotas, ownership routes, extension fetch with per-hop confinement                                                                                  | T4    | FAM-P1, FAM-E1b, L3 origin set, OQ-3/4/9 | yes |
| 14  | **FAM-N1** (W) messages: person expansion, `sender_person_id`, `imported_at`, authorship, consumer exclusions, voice copy, §2.7 re-own amendment                                                                                  | T4    | #587 pattern, FAM-G1, FAM-M1, S8-D4b/D5  | yes |
| 15  | **FAM-N2a** tenant-scoped food rows                                                                                                                                                                                               | T4    | —                                        | yes |
| 16  | **FAM-N2b** (W) `food_logs` + `water_logs`                                                                                                                                                                                        | T4    | FAM-N2a, FAM-G1                          | yes |
| 17  | **FAM-N2c** (W) `nutrition_targets` + `meal_plans`                                                                                                                                                                                | T4    | FAM-G1                                   | yes |
| 18  | **FAM-N6** (W) coaching sessions                                                                                                                                                                                                  | T4    | FAM-G1                                   | yes |
| 19  | EX1-A/B/C, S8-E1d (W): withheld and blocked records preserved; demo media via §5.4                                                                                                                                                | T4    | EX1-DOC, FAM-G1, FAM-M1, OQ-12           | —   |
| 20  | Native designs for `notes`, `goals`, `forms`, `form_responses`, `body_measurements`, `client_profile` (own T3 records)                                                                                                            | T3→T4 | owner decisions                          | —   |

Edges: FAM-C1 needs L2a (#588) and L0 r5 vocabulary; L1 needs FAM-C1's vocabulary (RESET §7);
FAM-R1 needs L3 (#589) for `source_count`. The FAM-C1 eval-harness re-run is L1's CI job.

## 8. Contradictions with other records (this record proposes the amendment)

| #    | Record                                                                                                                                           | Contradiction                                                                                        | Resolution                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1  | L0-DOC (`unsupported_coaching_data` as a gap; messages/photos NO for V1)                                                                         | All families YES                                                                                     | RESET §6 projection; `unsupported_coaching_data` deleted in L0 r4/r5                                                                                                                                                         |
| C-2  | EX1-DOC EQ-3, D-EX1-7                                                                                                                            | Exercise media and withheld plans are reachable                                                      | Media via FAM-M1 (§5.4); withheld plan preserved whole with children, graduates when CX-REF binds                                                                                                                            |
| C-3  | S8-DOC §3.7 `source_archived`, §4.6 (messaging absent), `scout-reconstruct.dto.ts` L9-11                                                         | Archived and messaging data are reachable                                                            | D-FAM-2 archived rule + §6.2 amendment; `messages` family                                                                                                                                                                    |
| C-4  | S8-DOC §3.3                                                                                                                                      | `CoachMessage` orders on `created_at`                                                                | D-FAM-4 single-column exception                                                                                                                                                                                              |
| C-5  | S8-DOC §3.5 `native_uniqueness`, §3.7 `no_native_destination` as final                                                                           | Reachable                                                                                            | Preserved; codes kept only for history                                                                                                                                                                                       |
| C-6  | S8D-DOC OQ-9                                                                                                                                     | Answered by the directive                                                                            | Preserved now; native designs in slice 20                                                                                                                                                                                    |
| C-7  | TM-14                                                                                                                                            | PRESERVE stores record content                                                                       | §4.3 sanitized projection                                                                                                                                                                                                    |
| C-8  | S9-DOC buckets i/j, S8-DOC §3.4 `already_present` ("not archived")                                                                               | Import-time archives would fail forever                                                              | §6.2 archived amendment with provenance `source_archived`                                                                                                                                                                    |
| C-9  | L0-DOC `PreserveGroup`/`other`, model-proposed `destination`, billing default, "existing media path", graduation "backfill"                      | One token set; destination derived; align defaults                                                   | D-FAM-1 `destinationFor`; `unclassified` only; billing default `out_of_scope_billing` (L0 P2); media via existing provider interface, separate bucket; graduation without re-import (§4.6)                                   |
| C-10 | **`Person` D2 comment (schema L6943-6950: "Email … deliberately NOT stored"), `families.ts` L105 ("Email/billing are never mapped or written")** | Preserving `client_profile`, `forms`, `billing_history` would store contact and billing data as Json | **Reversal disclosed** (R590-B-B8): contact PII dropped by default (§4.3 rule 7), billing not moved by default; both are owner questions OQ-1, OQ-8. The D2 rule that email is never an identity or linking key is unchanged |

## 9. Open questions for the owner (each with a safe interim default)

| OQ   | Question                                                                                                                                                            | Interim default                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Is past billing and payment history a coaching record to move? (L0 P2)                                                                                              | **Not moved**, disclosed as `out_of_scope_billing`. If yes: preserve read-only (amounts, dates, statuses), never a charge or subscription |
| OQ-2 | After a client joins, may they see preserved records about them?                                                                                                    | Coach-only; coach-private families never client-visible                                                                                   |
| OQ-3 | Media caps (§5.2) acceptable? Note: future/non-terminal sessions are preserved, so they are absent from the calendar and open-slot computation                      | Caps apply                                                                                                                                |
| OQ-4 | May the extension fetch media from a separate media host proven by observation? Consequence of "no": most sources serve photos from a CDN, so media stays not moved | Confined set only (`media_origin_unconfined`)                                                                                             |
| OQ-5 | Should a coach's deletion of an imported record keep it reported as not moved?                                                                                      | Yes (`removed_by_coach`, "removed by you")                                                                                                |
| OQ-6 | Should imported profile fields fill the joined client's profile on link?                                                                                            | No; preserved, coach-visible                                                                                                              |
| OQ-7 | May an unnameable reachable coaching collection land as `unclassified`?                                                                                             | Yes                                                                                                                                       |
| OQ-8 | **Contact PII** (email, phone, address, DOB) in `client_profile`, `forms`, `form_responses`: preserve coach-only, or never store?                                   | **Not stored** (`contact_pii`, counted and shown as "contact details hidden") until answered                                              |
| OQ-9 | Which malware scanner backs `MediaScanProvider`?                                                                                                                    | None configured ⇒ no media becomes `ready` (fail closed)                                                                                  |

Notes (not questions): **N-1** graduated native rows follow live per-client AI behaviour after
link (existing behaviour; disclosed on the result). **N-2** a per-family redaction count in
`families[]` is proposed to L0 as an owner question; FAM-0 does not add fields.

## 10. Invariant cross-check

| Invariant                                      | How this record holds it                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| New source → core diff = 0                     | Catalogue is TGP-side; no source names; scanner and storage are provider interfaces                                     |
| AI returns data only, never decides completion | Model proposes family + mapping; `destinationFor` is pure; closure is null (RESET §1)                                   |
| Deterministic identity, writes, reconciliation | D-S8-3 key everywhere; one canonical graduation input; ledger retarget; collision winner rule                           |
| Credentials never stored/learned/logged/sent   | §4.3 allow-list projection with corpus; staged redactor replaced and purged; device-side headers memory-only (RESET §4) |
| Customer data never in cross-coach memory      | §4.7 boundary; V1 per-coach memory; dedup per coach                                                                     |
| Unknown ≠ 0; no false `complete`               | RESET §6 projection referenced verbatim; `complete` unreachable until the closure record; residual check; archived rule |
| RLS never weakened                             | Service-role-only tables with REVOKE; expansions add `person_id IS NULL` guards only; §5.3 ownership on every read      |
| Erasure                                        | FAM-E1a before FAM-P2, FAM-E1b before FAM-M1; soft-edge selection; tombstone                                            |
| Replay/cancel/timeout/process-loss safe        | Create-only, unique keys, one transaction per identity tree, retryable erasure job                                      |

## 11. r2 closure map

| Finding       | Section                             | How                                                                                                                                                                       |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R590-A-A1     | §4.3                                | Allow-list projection: scope, exact credential keys, value-shape classes, URL rules, metadata covered, staged redactor + purge, corpus, stated residual                   |
| R590-A-A2     | §4.1, §4.6, §6.2                    | One `graduated` state; `provenance.residual_id` RESTRICT FK + `residual_required`; bucket j residual check; atomic write                                                  |
| R590-A-A3     | §4.6 step 3.4                       | Ledger retarget for all intents inside the graduation transaction; create→graduate→reconcile→replay test                                                                  |
| R590-A-A4     | §4.4, §7 rows 3, 12                 | Erasure by source identity incl. soft edges, tombstone, retryable media job, export; FAM-E1a before P2, FAM-E1b before M1                                                 |
| R590-A-B1     | §5.2                                | `MediaScanProvider`, `ready` only on `clean`, download only when `ready`, timeout/error codes, per-hop redirect confinement                                               |
| R590-A-B2     | D-FAM-4                             | `imported_at` on every FAM table; no invented read/review state; consumer exclusion list with post-link tests; AI disclosure N-1                                          |
| R590-A-B3     | §5.1, §5.3, §4.2                    | Composite FKs to parent and blob; native parent verified via provenance; opaque 404; REVOKE; role × tenant negatives                                                      |
| R590-A-C1     | §7                                  | Landable topological order                                                                                                                                                |
| R590-A-C2     | §2                                  | `src/scheduling/jobs/reminder.job.ts`                                                                                                                                     |
| R590-A-C3     | header                              | Anchored to L0 r5 / RESET section names                                                                                                                                   |
| R590-B-A1     | §6.3                                | FAM-0 projection deleted; `RunStatusProjectionV1` referenced verbatim; code mapping into L0's enums; fields land in FAM-R1/L3                                             |
| R590-B-A2     | D-FAM-2, §6.2, §4.5                 | `clients` always native; `Person.source_archived_at`; provenance `source_archived`; buckets i/j and `already_present` amended; "Former clients" display                   |
| R590-B-B1     | §7, D-FAM-3, §6.2                   | FAM-G1 depends only on P2; every writer (incl. S8-E1a/c) depends on G1 and calls the guard; invariant test I-1; renumbered                                                |
| R590-B-B2     | §4.1                                | No evidence rows for new runs; `preserved_record` ledger kind; idempotent legacy conversion                                                                               |
| R590-B-B3     | §4.3 rules 3-5                      | Exact key set + suffix rule, no tokens; Luhn only under card-like keys; role paths exempt; corpus with the named negatives                                                |
| R590-B-B4     | §4.6                                | One canonical input (`fields`); sentinel refusal; parent + children atomic; residual from `fields`                                                                        |
| R590-B-B5     | §5.4                                | Move-into-native-bucket strategy per column; voice, exercise demo, check-in photos; playback acceptance                                                                   |
| R590-B-B6     | D-FAM-4                             | Native only when author = bearer's own source account or the thread Person; `coach_id = Person.coach_id`                                                                  |
| R590-B-B7     | §4.4, §7                            | FAM-E1a precedes FAM-P2; FAM-E1b precedes FAM-M1; P2 does not write without E1a                                                                                           |
| R590-B-B8     | §8 C-10, §9 OQ-1/8                  | Reversal recorded; contact PII and billing defaults fail closed; owner questions                                                                                          |
| R590-B-B9     | D-FAM-1, §8 C-9                     | Model proposes family + mapping only; `destinationFor`; single token set; billing/media/graduation aligned                                                                |
| R590-B-C1..C9 | FI-1, D-FAM-2, §9, §4.5, §4.1, §6.4 | FK shape per table; soft-edge clear; OQ-4 and session notes; deterministic predicate; collision winner; metrics exclusion; states merged; OQ-3 split; arithmetic deferred |
