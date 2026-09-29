# FAM-0: every reachable family lands in TGP (native map + preserve destination)

- **Status:** T3 design record, draft. It changes no code, schema or API. It binds the FAM-\*
  build slices in §7, which are graded separately (most are T4). Not merged, not
  product-accepted.
- **Date:** 2026-09-29. **Decision owner:** Bradley Gleave (repo owner).
- **Base:** backend `integration/importer` at `d6cf9eb6`. Every `path Lx` citation is at this
  base unless it names another record.
- **Records this extends:** "S8-DOC" = `docs/decisions/2026-09-24-s8-native-contract.md`;
  "S8D-DOC" = `docs/decisions/2026-09-26-s8d-person-link.md`; "S9-DOC" =
  `docs/decisions/2026-09-25-s9-reconciliation.md`; "EX1-DOC" =
  `docs/decisions/2026-09-28-ex1-exercise-resolution.md`; "L0-DOC" = the learn-and-remember record
  on the branch of PR #581 (r3 head `c9161447`, `docs/decisions/2026-09-27-learn-and-remember.md`),
  being revised to r4 in parallel.
- **Open PRs this depends on:** #587 (S8-D3 person-owned schema and RLS), #588 (L2a one
  `SourceRegistryProvider`), #589 (L3 `replay_terminal_enumeration` basis), #577 (S8-D2 roster).

## 1. Owner directive and what it changes

Owner, 2026-09-29: there are **no unsupported families**. Anything reachable on a source site
moves into TGP: clients, programs, workouts, workout history, exercises, messages and message
history, food and nutrition logs, water, check-ins, habits, body metrics and weight, notes, forms
and questionnaires, photos and files, coaching sessions, and anything else reachable.
**`complete` = every reachable client and coaching record is in TGP, native OR preserved**, with
every list proven exhausted.

What this record decides:

1. A closed, vendor-neutral **canonical family set** (§3). Each family has exactly one
   destination: a native TGP model, or the universal **PRESERVE** destination when no native model
   exists yet or the native writer is still gated.
2. **PRESERVE** (§4): a tenant-scoped, person-linked, idempotent store for any reachable record
   group. It is displayed to the coach, graduates to native without loss, and never reaches the
   AI or cross-coach memory.
3. A **media path** (§5) into TGP storage.
4. **Reconciliation** (§6): `complete` counts native and preserved records. The per-family
   projection reports source-visible, moved natively, preserved, and not moved with closed reasons.
   Unknown is never 0.
5. **Slices** (§7) in value order.

Today's facts that make this necessary:

- The canonical allow-list has four families: `clients`, `workouts`, `client_history`, `programs`
  (`src/scout/scout-reconstruct.dto.ts` L13-18). The comment calls billing and messaging "deliberately
  absent" (L9-11). The spec grammar's `families` object is closed to those four
  (`src/scout/reconstruct/mapping-spec.ts` L114-125).
- The native kinds are `person`, `workout_program`, `workout_plan` and `workout_plan_exercise`
  (`src/scout/reconstruct/native/native-contract.ts` L16-21). They are pinned by the provenance
  CHECK (`prisma/migrations/20270122000000_scout_native_provenance_expand/migration.sql` L141) and
  the ledger `target_kind` CHECK (L191).
- Every client-owned native table has a required `User` foreign key (S8-DOC D-S8-2). S8D-DOC §2.1
  adds `person_id` on five of them in S8-D3 (#587). Messages, food logs, water, targets, meal plans
  and coaching sessions are not in that list.
- A staged token with no family ends as `unresolved_family:<token>`. A family with no native
  destination ends as `unresolved:no_native_destination:<family>` (S8-DOC §3.7). Either code makes
  the run `partial` for good (S9-DOC D-S9-2 C-FAM). Under the directive, neither may remain the
  terminal answer for reachable coaching data.

## 2. Inventory of TGP native destinations (`prisma/schema.prisma`)

**Legend.**

- **Owner:** C = coach-owned (the coach's own business object); P = client/person-owned (about one
  client, keyed on the client's `User` today); G = global (not tenant-scoped).
- **RLS:** "in-tree" = created by a `prisma/migrations/<dir>/migration.sql`. "Out-of-band" = only in
  `prisma/migrations/rls_fitness_backend.sql`, which is applied with `psql`, not by
  `prisma migrate` (S8D-DOC §2.2). The application connects as `service_role`, so RLS guards
  direct database access. Every import read and write goes through service-role code that asserts
  `coach_id = caller`.

| Model (schema lines)                                               | Owner                         | Tenancy / RLS today                                                                                                                              | Identity usable for idempotent import                                                         | Required fields (non-default)                                                                                                         | Relationships                                                              | App surfaces that display it                                                                                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Person` (L6959-6973)                                              | C (roster record)             | In-tree: service_role only, RESTRICTIVE deny-all for anon and authenticated (`20261223000200_scout_reconstruction/migration.sql` L73-86)         | `@@unique([coach_id, source_platform, source_person_id])` L6971; provenance kind `person`     | `coach_id`, `source_platform`, `source_person_id`                                                                                     | none in tree; #587 adds `linked_user_id` and `Person(id, coach_id)` unique | Roster via S8-D2 (#577); `src/scout/scout-roster.service.ts`                                                                                                                                              |
| `UserProfile` (L755-806)                                           | P                             | Out-of-band `user_profile_owner_access` (`rls_fitness_backend.sql` L91-92)                                                                       | `user_id @unique` L757 (1:1 with `User`); no person path                                      | `user_id`                                                                                                                             | `User`                                                                     | `src/profile/profile.service.ts`; AI context                                                                                                                                                              |
| `WorkoutProgram` (L2183-2236)                                      | C                             | In-tree (`20261215000000_mwb_1_data_model`)                                                                                                      | Provenance kind `workout_program` (S8-C writer `native-writers.ts` L92)                       | `coach_id`, `owner_user_id`, `name`, `weeks`, `days_per_week`                                                                         | plans                                                                      | Workout builder                                                                                                                                                                                           |
| `WorkoutPlan` (L2141-2174)                                         | C                             | In-tree (`20260508000001_rls_workout_builder`)                                                                                                   | Provenance kind `workout_plan` (`native-writers.ts` L238)                                     | `coach_id`, `name`, `type` (enum)                                                                                                     | program, exercises, assignments                                            | Workout builder                                                                                                                                                                                           |
| `WorkoutPlanExercise` (L2298-2321)                                 | C (child)                     | In-tree (same)                                                                                                                                   | Child provenance `workouts.exercise` (`native-contract.ts` L45, L110-120)                     | `exercise_external_id` (not an FK, L2302), `order`, `sets`, `reps_or_duration_seconds`                                                | plan                                                                       | Builder, assignment detail                                                                                                                                                                                |
| `ExerciseCatalogItem` (L4332-4381)                                 | G                             | In-tree (`20261213000000_rls_tier3_workouts`)                                                                                                    | `slug @unique` L4336. Never an import target (EX1-DOC D-EX1-1, D-EX1-3)                       | `slug`, `name`, `category`, `primary_muscle`                                                                                          | —                                                                          | `src/exercise-catalog/exercise-catalog.service.ts`                                                                                                                                                        |
| `CoachExercise` (EX1-A; **not in schema yet**)                     | C                             | Planned: owner coach + service_role; client via assignment (EX1-DOC D-EX1-2)                                                                     | Provenance kind `coach_exercise` (EX1-DOC)                                                    | `coach_id`, `name`                                                                                                                    | referenced as `cx:` tokens                                                 | Planned EX1-C                                                                                                                                                                                             |
| `ClientWorkoutAssignment` (L2323-2358)                             | P                             | In-tree, keyed on `auth.uid()` (S8D-DOC §2.2)                                                                                                    | `idempotency_key @unique` L2336 (live path; not import identity); provenance planned (S8-E1d) | `workout_plan_id`, `client_id`, `assigned_by_coach_id`, `scheduled_for`                                                               | plan, snapshot                                                             | Client schedule, coach assignment views                                                                                                                                                                   |
| `WorkoutSession` (L862-877) + `ExerciseSet` (L879-891)             | P + child                     | Session: out-of-band only (`rls_fitness_backend.sql` L142-146); sets in-tree (`rls_tier3_workouts` L85-101)                                      | Provenance planned (S8-E1a); no native unique key                                             | Session: `user_id`, `date` (Date), `workout_name`, `workout_type`. Set: `exercise_name`, `muscle_group` (enum L884), `sets_completed` | sets → session                                                             | `src/workout/workout.service.ts` L73; coach summary; community leaderboard; AI context                                                                                                                    |
| `WeightLog` (L930-941)                                             | P                             | Out-of-band only (`rls_fitness_backend.sql` L135-139)                                                                                            | none native; provenance planned (S8-E1b)                                                      | `user_id`, `date`, `weight_lbs`                                                                                                       | —                                                                          | `src/weight/weight.service.ts` L41; timeline; digest                                                                                                                                                      |
| `CheckIn` (L1102-1133)                                             | P (+ optional `coach_id`)     | In-tree (`20260607000000_rls_remaining_gaps` L352-391, S8D-DOC §2.2)                                                                             | `@@unique([user_id, date])` L1129: one per day, so it can collide (S8-DOC §3.5)               | `user_id`, `date`, `soreness` (1-5, L1110)                                                                                            | —                                                                          | `src/check-ins/check-ins.service.ts` L273, L312; coach dashboard queue on `reviewed_by_coach` (L1119; `coach.service.ts` L728)                                                                            |
| `Habit` (L1036-1045) + `HabitLog` (L1047-1058)                     | P + child                     | Habit: out-of-band only (L206-210); log in-tree (`rls_tier5_notifications_community` L194-214)                                                   | Provenance planned (S8-E1c)                                                                   | Habit: `user_id`, `name`. Log: `habit_id`, `date`                                                                                     | logs → habit                                                               | `src/habits/habits.service.ts` L9                                                                                                                                                                         |
| `CoachMessage` (L1189-1229)                                        | P (thread of coach ↔ client)  | In-tree `coach_message_participant_access` (`20260607000000_rls_remaining_gaps` L312-313): `coach_id` / `client_id` / `sender_id` = current user | Only `ai_draft_id @unique` L1223 (AI path). No import key                                     | none at column level; the service requires `body` or `voice_url` (schema comment L1202-1208)                                          | `coach_id`, `client_id`, `sender_id` → `User`, all nullable with SET NULL  | `src/messaging/messaging.service.ts` L348-371 (thread, ordered by `created_at`, index L1227); timeline; coach home; AI context (`src/ai/client-ai-context.service.ts` L192)                               |
| `Message` (L685-704)                                               | P (legacy two-party)          | In-tree `20260612000001_message_rls`                                                                                                             | none                                                                                          | `sender_id`, `recipient_id`, `body`                                                                                                   | `User` × 2                                                                 | Only a count (`src/coach/coach.service.ts` L707) and deletion. **Not a destination**: the live thread is `CoachMessage`                                                                                   |
| `LoggedFoodEntry` (L838-860)                                       | P                             | Out-of-band only (`rls_fitness_backend.sql` L197-201)                                                                                            | `client_uuid @unique` L856 (mobile offline queue; not import identity)                        | `user_id`, `date`, `meal_type` (enum), `food_item_id` (FK)                                                                            | → `FoodItem`                                                               | `src/log/log.service.ts` L65; `coach.service.ts` L388; AI context                                                                                                                                         |
| `FoodItem` (L808-836)                                              | **G** (no owner column)       | In-tree (`20261213000000_rls_tier3_nutrition`)                                                                                                   | `barcode @unique` L828                                                                        | `name`, `serving_description`, `serving_size_grams`, macros                                                                           | log entries                                                                | Food search for **every** user (`src/food/food.service.ts` L162). An imported food here would leak into other tenants' search                                                                             |
| `WaterLog` (L1170-1181)                                            | P                             | In-tree (`rls_tier3_nutrition`)                                                                                                                  | none                                                                                          | `user_id`, `amount_ml` (Int); `logged_at` is an instant                                                                               | —                                                                          | `src/water/water.service.ts` L21, L41                                                                                                                                                                     |
| `MacroTarget` (L2390-2408)                                         | P (coach-set)                 | In-tree (`20260607000000_rls_remaining_gaps` L78-79)                                                                                             | none                                                                                          | `client_id`, `coach_id`, four integer macros                                                                                          | `User` × 2                                                                 | `src/macros/macros.service.ts` L80; AI context                                                                                                                                                            |
| `MealPlan` (L1142-1168)                                            | P, or C when `client_id` NULL | In-tree (`rls_tier3_nutrition` L36-47): client, the client's coach, or the plan coach                                                            | none                                                                                          | `title`, `items` (Json)                                                                                                               | `coach_id`, `client_id` nullable with SET NULL                             | `src/meal-plans/meal-plans.service.ts` L49, L99                                                                                                                                                           |
| `CoachingSession` (L3081-3134) + `SessionParticipant` (L3139-3150) | C + P (`client_id` nullable)  | In-tree (`20261213000000_rls_tier2_sessions`)                                                                                                    | `provider_idempotency_key` (live path only); none for import                                  | `coach_id`, `start_at`, `end_at`, `title`; `status` enum L2932-2940. Participant requires `user_id`                                   | session type, participants                                                 | `src/scheduling/scheduling.service.ts` L314, L338. **Side effect:** `jobs/reminder.job.ts` L46-47 sends reminders for `status = 'scheduled'` in a time window                                             |
| `CoachMediaAsset` (L5212-5241)                                     | C (sellable content)          | No in-tree policy found (`rg` over `prisma/migrations/**/*.sql`)                                                                                 | `mux_upload_id @unique` (upload path only)                                                    | `coach_id`, `kind` (pdf or video), `title`, `storage_key`, `provider`                                                                 | granted to buyers through `ClientAssetGrant` (L5261-5271)                  | `src/coach-media/coach-media.service.ts`; package resolver `src/packages/asset-resolvers/media-asset.resolver.ts`. **Not a destination for client media**: rows here can be attached to packages and sold |
| `BloodworkAttachment` (L2898-2914)                                 | P (via panel)                 | In-tree (`20261213000000_rls_tier1_phi_financial_privacy`)                                                                                       | none                                                                                          | `panel_id`                                                                                                                            | panel                                                                      | Precedent only: `scan_status` lifecycle for uploaded files                                                                                                                                                |

Findings that shape §3 and §7:

- **FI-1.** Only the five S8D-DOC §2.1 tables become person-capable in #587. Six more client-owned
  destinations need the same expansion first: `CoachMessage`, `LoggedFoodEntry`, `WaterLog`,
  `MacroTarget`, `MealPlan` and `CoachingSession`. The expansion is nullable `person_id`, an
  exactly-one-owner CHECK, a composite tenant FK to `Person(id, coach_id)`, and a
  `person_id IS NULL` guard on every non-owner RLS branch. Until a table has it, its family goes to
  PRESERVE (§4) and graduates later (§4.6).
- **FI-2.** `FoodItem` is global. An imported food must not be written there. Food logs need a
  tenant-scoped food row first (slice FAM-N2a), or they stay preserved.
- **FI-3.** Three native models use insert time as the event time that the app displays:
  - `CoachMessage.created_at` orders the thread (index L1227; S8-DOC §3.3 forbids writing source
    time into audit columns);
  - `LoggedFoodEntry.logged_at` and `HabitLog.logged_at` default to `now()`, but both carry a
    calendar `date` that is what the app shows.

  Only `CoachMessage` needs an exception to §3.3 (D-FAM-4).

- **FI-4.** Live side effects to suppress, on top of S8-DOC §3.6:
  - message push and PTM signals (`messaging.service.ts` L461, L493-499, L548);
  - session reminders (`reminder.job.ts` L46-47);
  - the check-in review queue (`coach.service.ts` L702, L728).
- **FI-5.** The existing media store is a provider interface (`src/coach-media/storage-provider.ts`
  L82 signed upload, L96 signed download, L116 delete) over one bucket
  (`supabase-storage.provider.ts` L36). Its only table, `CoachMediaAsset`, is sellable content.
  Client media needs its own table (§5).

## 3. Canonical family set

### D-FAM-1: the closed family catalogue (TGP-side; a new family is a core change, a new source is not)

The catalogue extends `RECONSTRUCT_FAMILY` (`scout-reconstruct.dto.ts` L13-18) and therefore
`CANONICAL_FAMILIES` (`mapping-spec.ts` L69). S8-DOC D-S8-1 keeps adding a canonical family a
deliberate core change, with no source names. Tokens are vendor-neutral and stable.

**Children.** Child families (`<family>.<child>`) are provenance and preserve namespaces only,
never staged families. This matches the existing `workouts.exercise` child
(`native-contract.ts` L45).

**Owner column:** C = coach-owned; P = person-owned; the person edge is resolved as in D-FAM-2.

| Family                | Owner | Destination (exactly one)                                                                               | Gate before native writes                                        | Until the gate is passed |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------ |
| `clients`             | C     | `Person`                                                                                                | exists (S8-D1)                                                   | —                        |
| `client_profile`      | P     | PRESERVE (graduation target: `UserProfile` fields on link, OQ-6)                                        | a design for a person-capable profile                            | PRESERVE                 |
| `programs`            | C     | `WorkoutProgram`                                                                                        | exists (S8-C)                                                    | —                        |
| `workouts`            | C     | `WorkoutPlan`; child `workouts.exercise` → `WorkoutPlanExercise`                                        | exists (S8-C); references per EX1                                | withheld plan → PRESERVE |
| `exercises`           | C     | `CoachExercise`                                                                                         | EX1-A, EX1-B                                                     | PRESERVE                 |
| `workout_assignments` | P     | `ClientWorkoutAssignment`, inactive                                                                     | #587 + S8-E1d + S8D-DOC OQ-12                                    | PRESERVE                 |
| `workout_logs`        | P     | `WorkoutSession`; child `workout_logs.set` → `ExerciseSet`                                              | #587 + S8-E1a                                                    | PRESERVE                 |
| `client_history`      | P     | legacy generic token. Evidence row as today (`families.ts` L100-140); **preserved** as well under FAM-0 | none: new and learned specs must map to a specific family (V-L3) | PRESERVE                 |
| `messages`            | P     | `CoachMessage`                                                                                          | FAM-N1 (FI-1 expansion + writer)                                 | PRESERVE                 |
| `food_logs`           | P     | `LoggedFoodEntry` + tenant-scoped food row                                                              | FAM-N2a (FI-2) + FAM-N2b                                         | PRESERVE                 |
| `water_logs`          | P     | `WaterLog`                                                                                              | FAM-N2b                                                          | PRESERVE                 |
| `nutrition_targets`   | P     | `MacroTarget`                                                                                           | FAM-N2c                                                          | PRESERVE                 |
| `meal_plans`          | C / P | `MealPlan` (`client_id` / `person_id` NULL ⇒ coach template)                                            | FAM-N2c                                                          | PRESERVE                 |
| `checkins`            | P     | `CheckIn`                                                                                               | #587 + S8-E1b                                                    | PRESERVE                 |
| `body_weights`        | P     | `WeightLog`                                                                                             | #587 + S8-E1b                                                    | PRESERVE                 |
| `body_measurements`   | P     | PRESERVE (no native model: `CheckIn` and `WeightLog` carry weight only)                                 | a native design                                                  | PRESERVE                 |
| `habits`              | P     | `Habit`; child `habits.log` → `HabitLog`                                                                | #587 + S8-E1c                                                    | PRESERVE                 |
| `coaching_sessions`   | C / P | `CoachingSession` (past sessions with a terminal status only; D-FAM-4)                                  | FAM-N6                                                           | PRESERVE                 |
| `notes`               | P     | PRESERVE (no coach-note model; `CoachingSession.coach_notes_md` is per session)                         | a native design                                                  | PRESERVE                 |
| `goals`               | P     | PRESERVE                                                                                                | a native design                                                  | PRESERVE                 |
| `forms`               | C     | PRESERVE (form or questionnaire templates)                                                              | a native design                                                  | PRESERVE                 |
| `form_responses`      | P     | PRESERVE                                                                                                | a native design                                                  | PRESERVE                 |
| `media`               | C / P | PRESERVE media (§5), attached to its parent record                                                      | FAM-M1                                                           | not moved, with a reason |
| `billing_history`     | P     | PRESERVE, read-only (OQ-1)                                                                              | never native: no charge or subscription side effect              | PRESERVE                 |
| `unclassified`        | C / P | PRESERVE (a reachable coaching collection the validated mapping cannot name; OQ-7)                      | —                                                                | PRESERVE                 |

Non-records stay out of scope by the existing structural exclusion rule, never by an AI choice:
account settings, UI configuration and similar (L0-DOC D-L0-6.1 (i) `confirmExclusion`). A
confirmed exclusion is listed in `excluded[]`, never counted as moved.

### D-FAM-2: per-family contract (common rules, then per-family specifics)

**Common rules** (they extend S8-DOC §3; nothing below relaxes it):

- **Identity and idempotency key.** Every top-level record is keyed on the D-S8-3 key
  `(coach_id, source_namespace, entity_type = family, source_id)`. Native records carry it in
  `ImportNativeProvenance` (unique L7027). Preserved records carry the same four-tuple in their own
  unique key (§4.1). At most one destination holds a key at any time (graduation, §4.6).
  - `source_id` is read from the spec-declared id path, never from a name or model output (EX1-DOC
    D-EX1-1).
  - Children use the injective encoding `childSourceId` (`native-contract.ts` L110-120) under
    `<family>.<child>`.
- **Spec grammar.** Every family has one minimum role set, declared per source step:
  - `idField` (required);
  - `personSourceId` (P families; the existing `clientSourceId` role, `mapping-spec.ts` L97-100);
  - `occurredAt` or `occurredOn`, with the declared zone basis (S8-DOC §3.9);
  - `title` (display label, trimmed).

  Native typed roles come from the native rule registry (`native-rules.ts`, `parseNativeRuleSet`
  L794). A family whose native rules the source does not declare, or whose gate is closed, is
  **preserved**, never "unresolved". The spec `families` object (`mapping-spec.ts` L118-123) becomes
  a map over the catalogue with this role set. That is a grammar change in FAM-C1. Learned specs
  pass the same validators (L0-DOC V-L3), and the model never picks a destination: the destination
  is a fixed function of the family.

- **Person edge (P families).** `personSourceId` resolves only through provenance of the `clients`
  identity (kind `person`) on the D-S8-3 key, never by name or email (S8-DOC §3.8, S8D-DOC L1).
  - **Resolved:** the native row is person-owned (`person_id = Person.id`, owner `User` column
    NULL), which needs #587 for the table. The preserved row carries `person_id`.
  - **Unresolved** (the client is not in this run, or `clients` is unmapped): the record is
    **preserved** with `person_id` NULL and `person_source_id` kept as a soft edge. S9 edge E-R3 then
    reports `relationship_unverified`. On a later run the edge is re-resolved and the row attached
    (an update of `person_id` only, from NULL, under a `FOR UPDATE` lock). Nothing else changes.
  - **Linked Person:** a native writer for a Person that is already linked writes person-owned, and
    the S8D-DOC §2.7 link re-own moves it. It never writes `user_id` directly, because the link
    transaction owns that flip.
- **Timestamps.** Source instants go to UTC (S8-DOC §3.9). Calendar dates need the source's local
  date or a declared zone basis, never the server zone. Native audit columns keep their defaults
  (S8-DOC §3.3), except `CoachMessage.created_at` (D-FAM-4). Preserved rows store `occurred_at` or
  `occurred_on` as data columns, used for ordering in the display.
- **Archived and inactive source records** are reachable, so they move. This amends S8-DOC §3.7
  `source_archived`:
  - native, with `archived_at` set when the model has the column (`WorkoutProgram`, `WorkoutPlan`,
    `MacroTarget`, `MealPlan`);
  - otherwise preserved, with `source_archived = true`.
- **Side effects.** S8-DOC §3.6 plus FI-4. Writers use `tx` row writes only and never call
  `MessagingService.sendAsCoach` or `sendAsClient` (`messaging.service.ts` L406, L510), emitters,
  PTM, the scheduling lifecycle or any notification path. The module-boundary spec of S8-C extends
  to every FAM writer.
- **Create-only** (S8-DOC D-S8-4): replay verifies, never updates. Coach edits and deletions stand.

**Per-family specifics** (native families; preserved families need only the common rules):

| Family                | Native fields (beyond owner and person)                                                                                                                                                                                                                                                                           | Parent / person edge                                               | Timestamps                                                                                    | Idempotency key (entity_type / source_id)       | Collisions and closed codes                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `messages`            | `body`; `voice_url` from a §5 media ref; `sender`: an explicit enum map from the source's author role to `coach` or `client`. Coach ⇒ `sender_id = coach`. Client ⇒ new `sender_person_id = person` (FAM-N1). Group or multi-party threads are preserved (the model is one coach ↔ one client thread, L1183-1188) | thread = (coach, person); `coach_id = bearer`                      | `created_at := occurredAt` (D-FAM-4); `read_at := settle instant`, labelled not-a-source-fact | `messages` / message id                         | Author role unmapped ⇒ preserved. No `occurredAt` ⇒ preserved (the thread order cannot be invented)       |
| `food_logs`           | `date`, `meal_type` (enum map), tenant food row (name, serving, macros as declared), `quantity_multiplier`, `original_quantity` / `original_unit`, `notes`                                                                                                                                                        | person                                                             | `date` calendar; `logged_at` default                                                          | `food_logs` / entry id                          | Macros missing or enum unmapped ⇒ preserved                                                               |
| `water_logs`          | `amount_ml` (Int; declared unit; exact conversion or preserved)                                                                                                                                                                                                                                                   | person                                                             | `logged_at := occurredAt` (a data column, not audit)                                          | `water_logs` / id                               | Non-integral ml after conversion ⇒ preserved                                                              |
| `nutrition_targets`   | four macros (Int), `fiber_g`, `notes`                                                                                                                                                                                                                                                                             | person; `coach_id = bearer`                                        | `effective_from := occurredAt` (data column)                                                  | `nutrition_targets` / id                        | Non-integral ⇒ preserved                                                                                  |
| `meal_plans`          | `title`, `items` (Json; spec-declared item roles only), `notes`                                                                                                                                                                                                                                                   | optional person (template when absent)                             | default                                                                                       | `meal_plans` / id                               | —                                                                                                         |
| `checkins`            | S8-DOC §4.5 plus S8-E1b; `soreness` is required, so its absence ⇒ preserved (never defaulted silently)                                                                                                                                                                                                            | person; `coach_id = person.coach_id` (S8D-DOC §2.2 item 3)         | `date` calendar                                                                               | `checkins` / id                                 | `(person_id, date)` collision ⇒ the second record is **preserved**, not dropped (was `native_uniqueness`) |
| `body_weights`        | `weight_lbs` (declared unit, `toPounds` L136), `notes`                                                                                                                                                                                                                                                            | person                                                             | `date` calendar                                                                               | `body_weights` / id                             | —                                                                                                         |
| `habits`              | `name`, `category`, `target_value`, `unit`; logs: `date`, `value`, `completed`                                                                                                                                                                                                                                    | person; log → habit via provenance                                 | log `date` calendar                                                                           | `habits` / id; `habits.log` / child encoding    | Log with an unresolved habit ⇒ preserved child                                                            |
| `workout_logs`        | S8-DOC §4.5; `muscle_group` enum map required                                                                                                                                                                                                                                                                     | person; set → session                                              | `date` calendar                                                                               | `workout_logs` / id; `workout_logs.set` / child | Unmapped muscle group ⇒ preserved child (the session is still native)                                     |
| `coaching_sessions`   | `title`, `start_at`, `end_at`, `status` ∈ {`completed`, `canceled`, `no_show`, `declined`} via enum map, `coach_notes_md`, `client_recap_md`; providers stay `stub`                                                                                                                                               | person optional; no `SessionParticipant` rows (they need a `User`) | `start_at` / `end_at` from source instants                                                    | `coaching_sessions` / id                        | A future or non-terminal session ⇒ **preserved** (never `scheduled`: that would send reminders, FI-4)     |
| `workout_assignments` | S8D-DOC OQ-12                                                                                                                                                                                                                                                                                                     | person; plan via provenance                                        | `scheduled_for`                                                                               | `workout_assignments` / id                      | Preserved until OQ-12 is answered                                                                         |
| `exercises`           | EX1-DOC D-EX1-2                                                                                                                                                                                                                                                                                                   | —                                                                  | —                                                                                             | EX1-DOC                                         | EX1 withheld plans are preserved (§8 C-2)                                                                 |

**Residual fields.** A native record whose source row has fields the native model cannot hold (for
example a check-in with a custom question) is not narrowed silently. The unconsumed fields go to a
**preserved sidecar** keyed on the same identity, with `native_kind` / `native_id` set (§4.1). The
display shows them under the native record.

### D-FAM-3: how S8-D person link and #587 gate client-owned families

- A native P-family writer may run only when both hold:
  - its table carries the #587 shape (the five S8D-DOC §2.1 tables), or the FI-1 expansion for the
    other six;
  - S8-D1's typed `person` handoff resolves the person edge.

  The check is in code: the writer registry lists a family as native only for tables whose
  migration is present. Otherwise the family persists to PRESERVE.

- The S8D-DOC §2.7 link transaction re-owns rows in the five tables through the provenance join.
  Every FI-1 table joins that list in its FAM-N slice, including the `CoachMessage` second owner
  column (`sender_person_id` → `sender_id`). S8D-DOC §2.7 steps 4-5 must be amended in the same
  slice. Otherwise a linked client would lose sight of imported messages.
- Preserved rows never flip owner. They stay keyed on `person_id`. After a link the client's read,
  if the owner allows it (OQ-2), goes through `Person.linked_user_id` (#587). Unlink then needs no
  data movement.
- RLS never widens. A person-owned native row is service-role only (S8D-DOC §2.2 item 1).
  PRESERVE is service-role only (§4.2).

### D-FAM-4: event time for messages and sessions (scoped amendment to S8-DOC §3.3)

- `CoachMessage` has no event-time column besides `created_at`, and the thread is ordered on it
  (index L1227). An imported message therefore writes `created_at := occurredAt`. Without it,
  history would appear as "just now" and reorder live threads. The exception applies to this one
  column only.
- `read_at` is set to the settle instant. The recipient then gets no unread badge for history that
  was already seen on the source. The value is not a source fact, and the display never shows it as
  one.
- `CoachingSession` imports only terminal statuses. `start_at` and `end_at` are data columns, not
  audit columns.

## 4. PRESERVE: the universal destination

### 4.1 Schema sketch (FAM-P1; additive migration with a refusing down)

```prisma
model ImportPreservedRecord {
  id                String    @id @default(uuid())
  coach_id          String                       // bearer coach; tenant key
  person_id         String?                      // FK (person_id, coach_id) → Person(id, coach_id), ON DELETE RESTRICT
  person_source_id  String?                      // soft edge while the Person is unresolved (D-FAM-2)
  import_intent_id  String?   @db.Uuid           // FK (import_intent_id, coach_id) → ImportIntent(id, coach_id), RESTRICT
  source_namespace  String                       // D-S8-3; = source_platform until G3
  family            String                       // closed CHECK = the D-FAM-1 catalogue + child families
  source_id         String                       // top-level id or childSourceId encoding
  parent_family     String?                      // soft edge (e.g. a form response → form)
  parent_source_id  String?
  occurred_at       DateTime? @db.Timestamptz
  occurred_on       DateTime? @db.Date
  title             String?                      // ≤ 200 chars, display only
  source_archived   Boolean   @default(false)
  fields            Json                         // bounded preserved projection (§4.3)
  fields_sha256     String                       // 64-hex; drift evidence, never identity
  byte_size         Int                          // CHECK 0 < byte_size ≤ SCOUT_PRESERVE_MAX_BYTES
  state             String    @default("preserved") // CHECK IN ('preserved','graduated','sidecar')
  native_kind       String?                      // set iff state IN ('graduated','sidecar')
  native_id         String?
  graduated_at      DateTime?
  created_at        DateTime  @default(now())

  @@unique([coach_id, source_namespace, family, source_id], map: "ImportPreservedRecord_identity_key")
  @@index([coach_id, person_id, family, occurred_at(sort: Desc)])
  @@index([coach_id, family, state])
  @@index([coach_id, native_kind, native_id])
}
```

**Constraints**, hand-written SQL on the S8-B shape-CHECK precedent (`20270122000000` L141-149):

- closed `family` and `state` sets;
- `(native_id IS NULL) = (state = 'preserved')`;
- the size CHECK;
- `person_id IS NULL OR person_source_id IS NULL`.

The composite FK needs the `Person(id, coach_id)` unique that #587 creates
(`20270125000009_scout_person_owned_keys` on the #587 branch). FAM-P1 therefore lands after #587.

**Ledger.** `ScoutReconstructionLedger.target_kind` gains `preserved_record` (a CHECK expand of
L191). A preserved top-level identity is ledger `reconstructed` with that kind. Sidecars and
preserved children are not ledger rows (S8-DOC §3.2).

### 4.2 RLS and tenancy

The posture is the `Person` / provenance posture exactly:

- ENABLE + FORCE;
- a permissive `service_role` policy;
- RESTRICTIVE deny-all for `anon` and `authenticated` (`20261223000200` L73-86;
  `20270122000000` L175-181).

No client or coach principal reads the table directly. Every read goes through a service-role
route that filters `coach_id = req.user.id` and re-asserts `Person.coach_id` (the roster
discipline, `scout-roster.service.ts` L30-35). A cross-tenant row is impossible by construction,
because the composite FK ties `person_id` to the same `coach_id`.

The FAM-P1 RLS spec follows the S8D-DOC §2.2 item 4 matrix: every principal is denied, and the
service role is allowed.

### 4.3 The preserved projection (bounded; not a raw payload store)

`fields` is computed by one pure core function, `preserveProjection(payload, spec)`. It is never
the staged payload verbatim. The steps:

1. **Secret-class removal.** A closed, versioned `SECRET_KEY_VOCABULARY` names key tokens that are
   removed with their values, at any depth. It includes `password`, `secret`, `token`, `api_key`,
   `access_token`, `refresh_token`, `session`, `cookie`, `authorization`, `csrf`, `signature`,
   `private_key`, `card_number`, `cvv`, `cvc`, `iban`, `account_number`, `routing_number` and `ssn`.
   String values in credential shapes are replaced with `{"$dropped":"secret_class"}`: a JWT shape,
   `Bearer …`, and 13-19-digit Luhn-valid numbers. The count of dropped values is kept on the row.
   Credentials are never stored (brief invariant).
2. **URLs.** Query string and fragment are stripped, because signed CDN URLs carry tokens. A URL
   that the spec declares as a media role becomes `{"$media":"<ImportPreservedMedia id>"}` once §5
   stores the bytes. Until then it is `{"$media_pending":<ordinal>}`.
3. **Bounds.** Depth ≤ 8, ≤ 500 keys, each string ≤ 16 KiB, canonical JSON ≤
   `SCOUT_PRESERVE_MAX_BYTES`. The default is 64 KiB, and the environment may raise it to a hard
   cap of 256 KiB. An over-bound record is **not moved** with `preserve_over_bound` (counted,
   blocks `complete`, never truncated).
4. **Canonical form.** Sorted keys, the source's own key names kept (data, not code) and
   `fields_sha256` over the canonical bytes.

**Relation to TM-14** (`docs/decisions/2026-06-17-tm-14-no-raw-payload-storage.md`). TM-14 refused
a payment provider's raw blob because the provider stays the system of record. Here the source
**stops** being the system of record when the coach leaves it. So the projection is the product
record and must be kept. It is TM-14's option (C), a sanitized projection, with a versioned
removal list and bounds. Staged `ScoutIngestEntity.payload` (L6930) is unchanged, and PRESERVE
does not depend on its retention.

### 4.4 Retention, export and erasure

- **Retention:** as long as the coach account and the Person exist, like native records.
  - A **graduated** row keeps only its identity columns and residual fields (§4.6), so no value is
    stored twice.
  - A **sidecar** keeps its residual fields.
- **Person erasure** (S8D-DOC §2.3 explicit path) deletes that Person's preserved rows and their
  media objects (`deleteObject`, `storage-provider.ts` L116) in the same audited operation. RESTRICT
  on the FK means a Person is never dropped around them.
- **Coach account deletion:** `src/account-deletion/account-deletion.service.ts` must delete
  preserved rows and media by `coach_id` (FAM-E1).
- **Export:**
  - a coach export of preserved records per Person (JSON plus media links) is added in FAM-E1;
  - the client data export (`src/data-export/data-export.service.ts` L86, L412-419 is user-scoped)
    includes preserved records only for families the owner makes client-visible (OQ-2).

### 4.5 Display

- **Coach mobile, client detail:** a section "From your previous platform". It shows:
  - per family, the count and a date-ordered list;
  - per record, the title, `occurred_at`, and humanised key/value fields;
  - media thumbnails through short-lived signed URLs (`createSignedDownloadUrl`, L96);
  - a "hidden: sensitive" marker where `$dropped` appears.

  It is read-only (create-only import). Unlinked Persons reach it from the S8-D2 roster (#577).

- **Coach-owned preserved records** (`forms`, `meal_plans` templates, `unclassified` without a
  person) appear on an "Imported library" list.
- **Sidecars** render under their native record as "More from your previous platform".
- **Client visibility:** coach-only by default (OQ-2). Coach-private families (`notes`, session
  notes) are never client-visible.
- The server projection is one read (FAM-P3). Mobile and extension render it and never re-derive
  it.

### 4.6 Graduation to native without loss (FAM-G1)

When a family's native writer lands (its gate in D-FAM-1 passes), preserved rows of that family
graduate:

1. **Trigger (a), on the next run of that source.** The native writer looks up provenance (none),
   then the preserved key. It finds a `preserved` row and graduates it in the same transaction,
   using the fresh staged payload.
2. **Trigger (b), on demand per coach.** A graduation pass re-interprets `fields` with the native
   rules of that source. The input is `{source_id, source_platform: source_namespace, payload:
fields}`, which is the same `map()` input shape (`native-families.ts` L31-36). It is used when
   the source is gone.
3. **Transaction.**
   1. `SELECT … FOR UPDATE` the preserved row; assert provenance is absent.
   2. Write the native row(s) and provenance `created` (`native-provenance.ts` L53).
   3. Set `state = 'graduated'`, `native_kind` and `native_id`.
   4. Replace `fields` with the **residual** (source paths the native rules did not consume; the
      consumed set is the rule paths, so it is deterministic).

   If the native interpretation is not `ok`, the row stays `preserved` and nothing changes.

4. **Accounting.** S9 counts the identity once: native if graduated, else preserved (§6). Replay
   is a no-op. A graduation racing an import converges on the provenance unique key
   (`families.ts` retry-once, S8-DOC §3.4).
5. **Media refs** carry over unchanged. `$media` ids are stable, and native media columns take the
   signed-storage reference.

### 4.7 Preserved values never reach the AI or cross-coach memory

- **Module boundary spec** (FAM-P2 acceptance, extending S8-C's). Outside an allow-list of files
  under `src/scout/preserve/**`, `src/scout/reconciliation/**`, `src/account-deletion/**` and
  `src/data-export/**`, no file references the Prisma delegates `importPreservedRecord` or
  `importPreservedMedia`. The following never import the preserve module: `src/ai/**`,
  `src/roman/**`, `src/insights/**`, `src/coach/brief/**`, `src/coach/command-center/**`,
  `src/notifications/**`, `src/community/**` and `src/scout/learn/**`. The spec is `rg`-based and
  fails on a new reference.
- **Learn memory** is structure-only and device-built (L0-DOC D-L0-2, D-L0-5). The learn route
  writes only learn tables (L0-DOC L459). Preserved values are server-side rows, never digest input.
- **Logs and telemetry** carry counts and closed codes only. The existing reason grammar forbids
  values (S9-DOC D-S9-7).
- **Graduated native rows** follow existing per-client product behaviour. For example the AI
  context reads `CoachMessage` by client (`client-ai-context.service.ts` L192). That context is
  one coach and one client, not cross-coach memory, and it applies only after a link makes the row
  user-owned. This is stated for the owner as OQ-5.

## 5. Media, photos and files (FAM-M1)

- **Tables.**
  - `ImportMediaBlob`: `coach_id`, `content_sha256`, `byte_size`, `content_type`, `storage_key`,
    `state` (`uploading | ready | rejected`) and `scan_status` (the `BloodworkAttachment`
    precedent, L2898-2914). Unique on `(coach_id, content_sha256)`.
  - `ImportPreservedMedia`: identity `(coach_id, source_namespace, 'media', source_id)`, where
    `source_id` is the source media id or the child encoding under its parent. It points at a blob
    and at its parent: a preserved record id, or `native_kind` / `native_id`.
  - Both tables use the §4.2 RLS posture.
- **Dedup** happens within one coach only. Cross-coach dedup would reveal that another tenant holds
  the same file.
- **Path.** Credentials never leave the device, and the server never fetches the source.
  1. The extension fetches the bytes in the authorized tab, from origins in the run's confined
     origin set only (OQ-4).
  2. It computes SHA-256 and calls a scout media route with
     `{family, source_id, parent key, sha256, byte_size, content_type}`.
  3. The server answers `already_present` if the blob is `ready`. Otherwise it mints a signed PUT
     (`createSignedUploadUrl`, `storage-provider.ts` L82) for `imports/<coach_id>/<sha256>` in a
     separate private bucket, `SUPABASE_IMPORT_BUCKET`. The default is a new private bucket, not
     `coach-media` (`supabase-storage.provider.ts` L36).
  4. On confirm, the server reads the object back once. It checks `byte_size`, SHA-256 and magic
     bytes against `content_type`, then sets `ready`. Failure gives `media_verify_failed`.
- **Size bounds** (defaults; environment-tunable down only):
  - image ≤ 25 MB;
  - PDF ≤ 50 MB (`PDF_MAX_BYTES`, `coach-media.dto.ts` L12);
  - audio ≤ 25 MB (voice messages; `messaging.service.ts` L176 bounds live voice);
  - video ≤ 500 MB, stored as a file and served by signed URL, never transcoded;
  - any other file type ≤ 25 MB, served download-only as `application/octet-stream`;
  - run budget 20 GB; coach total 100 GB.

  Excess is **not moved**, with `media_over_bound` or `media_quota_exceeded`, and counted.

- **Storage-cost note for the owner.** Current list prices: Pro includes 100 GB of storage, then
  $0.0213 per GB-month ([Supabase storage pricing](https://supabase.com/docs/guides/storage/pricing)).
  Egress includes 250 GB, then $0.09 per GB uncached
  ([Supabase egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress)).
  - Illustration: 100 clients × 150 photos × 1.5 MB ≈ 22 GB per coach, about $0.47 per month
    beyond the quota. 500 such coaches ≈ 11 TB ≈ $235 per month in storage.
  - Viewing egress, not storage, dominates once thumbnails are browsed. A thumbnail derivative is a
    later cost slice.
  - Video is the outlier. One 500 MB clip is as large as about 330 photos.

## 6. Reconciliation and `complete`

### D-FAM-5: S9 buckets gain one preserved bucket; `complete` counts native + preserved

- **New bucket j-p `preserved_present_verified`.** It is evaluated after S9-DOC bucket j and
  before k. Its conditions:
  - ledger `reconstructed` with `target_kind = preserved_record`;
  - the preserved row present under the same D-S8-3 key and `coach_id`, in state `preserved`.

  A `graduated` row is classified through bucket j logic on its `native_kind` / `native_id`
  (native row present, owned, not archived). Bucket f (evidence only) stays for legacy
  `scout_entity` rows. Under FAM-0 each such row also has a preserved twin, so j-p counts it.

- **Children.** An unresolved child with a preserved child row counts `preserved_children`.
  `unresolved_children` (S9-DOC D-S9-2) counts only children that are neither native nor preserved.
- **Conditions** (S9-DOC D-S9-2 order unchanged):
  - **C-FAM** fires only for a staged token that resolves to no family. Under FAM-0 that is a spec
    defect, because every reachable collection has a family or `unclassified`.
    `no_native_destination` leaves the catalogue for reachable families.
  - **C-ID** counts `unresolved + rejected + failed` and excludes j-p.
  - **C-REL** includes unresolved person edges on preserved rows.
  - **C-COV** (L3 basis, closure) is unchanged.
- **`complete` ⇔** all of:
  - closure closed and every family `coverageKnown` (L0-DOC D-L0-6.1 (i)-(ii), L3 #589);
  - every staged identity and child in {j, j-p};
  - every media ref `ready`;
  - relationships verified;
  - zero not-moved records.

  The arbiter stays the only terminal writer (S7-L).

- **Release gate.** Preserved records may count toward `complete` only once the coach can see
  them (FAM-P3 and UX-P3 live). Before that, j-p reports `preserve_display_pending` and holds the
  run at `partial`.

### D-FAM-6: per-family run-status projection (one server projection; additive optional DTO fields)

The projection adds optional fields to `ScoutImportFamilyDto` (`src/scout/scout.dto.ts` L240-339),
using the S9-C additive rule: fields are omitted when no report applies.

| Field                                          | Meaning                                                                  | Unknown rule                              |
| ---------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| `observed_unique` (existing L249)              | **source-visible**: identities the L3 basis proves the site exposes      | `null` when the basis is unknown, never 0 |
| `native_present_verified` (existing, optional) | **moved natively** (bucket j, including graduated)                       | counted fact                              |
| `preserved`                                    | **preserved** (bucket j-p)                                               | counted fact                              |
| `not_moved`                                    | `staged − native − preserved` plus `observed_unique − staged` when known | `null` when `observed_unique` is `null`   |
| `not_moved_reasons`                            | `{code, count}[]` over the closed catalogue below                        | codes only, no values                     |
| `children`                                     | `{native, preserved, not_moved}` for child families                      | same rules                                |
| `destination`                                  | `native` \| `preserve` \| `mixed` (from counts)                          | —                                         |

- **Invariant:** when `observed_unique` is known,
  `observed_unique = native_present_verified + preserved + not_moved`.
- **Closed not-moved codes** are appended to the S9-DOC D-S9-7 histogram:
  - existing S9 codes: `missing_source_id`, `unsupported_platform:<p>`, `failed`,
    `unresolved:not_reconstructed`, `unresolved:pass_ceiling_exceeded`,
    `unresolved:identity_conflict`, `unresolved:native_target_removed` (OQ-3);
  - new FAM codes: `preserve_over_bound`, `preserve_display_pending`, `media_over_bound`,
    `media_quota_exceeded`, `media_fetch_failed`, `media_origin_unconfined`,
    `media_verify_failed`, and `not_observed` (`observed_unique − staged`).
- **Gap codes.** L0-DOC `RUN_GAP_CODES` `unsupported_coaching_data` and
  `native_destination_pending` stop being terminal for any reachable family. A family without a
  native writer is preserved, so neither code is emitted once FAM-P2 lands. They remain only as
  historical codes (append-only list).
- **Consumers.** Extension result detail and mobile read this one projection, with a closed-enum
  decode and an `'unknown'` fallback (L0-DOC R2).

## 7. Slice plan (value order; each slice independently landable)

Tiers follow the T0-T4 doctrine: the first higher trigger wins. "Pin" means the slice ships a
migration and re-pins the S11 harness (S8D-DOC §6 migration sequencing).

| #   | Slice                                                                                                                                                                                                 | Tier                 | Depends on                                 | Pin | Why this tier                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------ | --- | ------------------------------------------- |
| 0   | **FAM-0** this record                                                                                                                                                                                 | T3                   | —                                          | no  | cross-domain ownership and lifecycle design |
| 1   | **FAM-C1** catalogue: `RECONSTRUCT_FAMILY` tokens (D-FAM-1), spec grammar role set, `preserved_record` ledger kind CHECK expand, learn contract vocabulary and V-L3 update, contract regeneration     | T4                   | L2a #588                                   | yes | terminal-truth and identity vocabulary      |
| 2   | **FAM-P1** `ImportPreservedRecord` schema, RLS, composite FKs, down, RLS matrix spec                                                                                                                  | T4                   | #587 (Person unique), FAM-C1               | yes | RLS, tenant boundary, persisted PII         |
| 3   | **FAM-P2** preserve writer: projection (§4.3), bounds, person edge via provenance, sidecars, module-boundary spec (§4.7). The default persist for every PRESERVE family and for gated native families | T4                   | FAM-P1, S8-D1                              | no  | irreversible writes, secrets removal        |
| 4   | **FAM-P3** coach read route for preserved records (per Person, coach library), signed media URLs, contract regeneration                                                                               | T4                   | FAM-P1, S8-D2 #577                         | no  | tenant-scoped PII read                      |
| 5   | **UX-P3** mobile "From your previous platform" and "Imported library"                                                                                                                                 | T2                   | FAM-P3                                     | —   | renders server state                        |
| 6   | **FAM-R1** reconciliation: bucket j-p, preserved children, projection fields (D-FAM-6), not-moved codes, display gate, extension and mobile decode                                                    | T4                   | FAM-P2, L3 #589, UX-P3 for the gate        | no  | terminal truth                              |
| 7   | **FAM-N1** messages: `CoachMessage` person expansion (`person_id`, `sender_person_id`, CHECKs, RLS guard), writer (D-FAM-4, no push or PTM), S8D-DOC §2.7 re-own amendment                            | T4                   | #587 pattern, FAM-G1, S8-D4b/D5 for re-own | yes | RLS, re-own, side effects                   |
| 8   | **FAM-N2a** tenant-scoped food rows (`FoodItem.coach_id` nullable + search exclusion, or a coach food table)                                                                                          | T4                   | —                                          | yes | global catalogue tenancy                    |
| 9   | **FAM-N2b** `food_logs` + `water_logs` person expansion and writers                                                                                                                                   | T4                   | FAM-N2a, FAM-G1                            | yes | RLS, persisted PII                          |
| 10  | **FAM-N2c** `nutrition_targets` + `meal_plans` person expansion and writers                                                                                                                           | T4                   | FAM-G1                                     | yes | same                                        |
| 11  | **S8-E1b** check-ins + body weights (existing slice; amended: collisions and unmapped required values are preserved)                                                                                  | T4                   | #587, S8-E1a, FAM-G1                       | no  | as S8D-DOC §6                               |
| 12  | **S8-E1c** habits (amended likewise)                                                                                                                                                                  | T4                   | S8-E1a                                     | no  | as S8D-DOC §6                               |
| 13  | **S8-E1a** workout logs (amended likewise)                                                                                                                                                            | T4                   | #587, S8-D1                                | yes | as S8D-DOC §6                               |
| 14  | **FAM-G1** graduation engine (§4.6), with residual computation                                                                                                                                        | T4                   | FAM-P2 + the first native FAM writer       | no  | irreversible identity move                  |
| 15  | **FAM-M1** media: blob and media tables, bucket, signed upload and verify, quotas; extension fetch under origin confinement                                                                           | T4                   | FAM-P1, L3 (origin set), OQ-3/OQ-4         | yes | storage, credentials boundary, cost         |
| 16  | **FAM-N6** coaching sessions (terminal statuses; person expansion; no reminders)                                                                                                                      | T4                   | FAM-G1                                     | yes | side effects, RLS                           |
| 17  | **FAM-E1** erasure and export (account deletion, Person erasure, coach export)                                                                                                                        | T4                   | FAM-P1, FAM-M1                             | no  | deletion and export guarantees              |
| 18  | EX1-A/B, S8-E1d: unchanged, except that withheld and blocked records are preserved                                                                                                                    | T4                   | EX1-DOC, OQ-12                             | —   | —                                           |
| 19  | Native designs for `notes`, `goals`, `forms`, `form_responses`, `body_measurements`, `client_profile` (each its own T3 record; preserved meanwhile)                                                   | T3 design → T4 build | owner product decisions                    | —   | new product models                          |

**Order rationale.** Slices 1-6 make every reachable family land in TGP (preserved) and make
`complete` reachable for a pilot site once L3 closes coverage. Messages, nutrition, check-ins, body
metrics and habits then graduate to native, in that order of coach value. Media follows as soon as
the owner sets its budget, because it is the only cost-bearing family.

**Learn-chain dependencies.**

- FAM-C1 needs L2a (#588): one provider resolves families for ingest, reconstruct and S9.
- FAM-R1 needs L3 (#589): `observed_unique` and closure.
- V1-C (L0-DOC D-L0-8) then needs FAM-R1 in place of the FAM-n rows of its table (L0-DOC L777,
  L803).

## 8. Contradictions with other records (flagged; this record proposes the amendment)

| #   | Record                                                                                                                             | Contradiction under the owner directive                                      | Proposed resolution                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C-1 | L0-DOC r3 Q-L0-10 (recommends messages and photos NO for V1) and D-L0-8 table (`unsupported_coaching_data` blocks `complete`)      | The directive says all families YES                                          | L0 r4 points to FAM-0. `unsupported_coaching_data` is no longer emitted for reachable data once FAM-P2 lands. FAM-n is replaced by §7                              |
| C-2 | EX1-DOC EQ-3 (recommends excluding exercise media) and D-EX1-7 (withheld plan = not moved)                                         | Media is in scope. A withheld plan is reachable                              | Exercise media goes through FAM-M1 (EX1-M1 is not needed; EX1-M2 = FAM-M1). A withheld plan is preserved whole, with its children, and graduates when CX-REF binds |
| C-3 | S8-DOC §3.7 `source_archived` (archived records not imported), §4.6 (messaging absent by design), `scout-reconstruct.dto.ts` L9-11 | Archived and messaging data are reachable                                    | D-FAM-2 archived rule; `messages` family                                                                                                                           |
| C-4 | S8-DOC §3.3 (no source time in audit columns)                                                                                      | `CoachMessage` orders on `created_at`                                        | D-FAM-4 scoped exception                                                                                                                                           |
| C-5 | S8-DOC §3.5 `native_uniqueness` and §3.7 `no_native_destination` as final outcomes                                                 | A second same-day check-in and a family without a native model are reachable | Preserved instead. The codes stay in the catalogue only for history                                                                                                |
| C-6 | S8D-DOC OQ-9 (notes, goals, measurements, profile stay unresolved)                                                                 | Answered by the directive                                                    | Preserved now; native designs in slice 19                                                                                                                          |
| C-7 | L0-DOC D-L0-6.1 (v) (billing out of scope by interpretation)                                                                       | "Anything reachable"                                                         | OQ-1                                                                                                                                                               |
| C-8 | TM-14 (no raw payload storage)                                                                                                     | PRESERVE stores record content                                               | §4.3: a sanitized, bounded projection; the source stops being the system of record                                                                                 |

## 9. Open questions for the owner (each has a safe interim default)

| OQ   | Question                                                                                                                                                            | Interim default                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Is past billing and payment history a "coaching record" to move?                                                                                                    | Preserve read-only: amounts, dates, statuses and descriptions only, with secret-class removal. It never creates a charge, subscription or payout. If you say no, it is a disclosed exclusion |
| OQ-2 | After a client joins, may they see preserved records about them (messages, logs, check-ins)?                                                                        | Coach-only. Coach-private families (notes, session notes) are never client-visible                                                                                                           |
| OQ-3 | Media budget: are the caps in §5 (video 500 MB, 20 GB per run, 100 GB per coach) acceptable, and should a coach deleting an imported record keep the run `partial`? | The §5 caps apply. A coach deletion keeps S9 behaviour (blocks `complete`, shown as "removed by you")                                                                                        |
| OQ-4 | May the extension fetch media from a source's separate media host when that host is proven by observation, or only from the confined origin set?                    | Confined set only. Media elsewhere is `media_origin_unconfined` (counted, blocks `complete`)                                                                                                 |
| OQ-5 | Once imported history is native and the client has joined, may it feed that client's AI context for that same coach (as live data does today)?                      | Yes for native rows (existing behaviour). Never for preserved rows                                                                                                                           |
| OQ-6 | Should imported profile fields fill the joined client's own profile on link?                                                                                        | No. They stay preserved and shown to the coach                                                                                                                                               |
| OQ-7 | May an unnameable reachable coaching collection land as `unclassified` (preserved) instead of blocking `complete`?                                                  | Yes                                                                                                                                                                                          |

## 10. Invariant cross-check

| Invariant                                         | How this record holds it                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| New source → core diff = 0                        | The catalogue is TGP-side (D-FAM-1). Sources are specs; no source name appears in this record or in core           |
| AI returns data only, never decides completion    | The destination is a fixed function of the family. S9, S10 and the arbiter decide `complete`                       |
| Deterministic identity, writes, reconciliation    | D-S8-3 key everywhere; the projection is a pure function; graduation is transactional                              |
| Credentials never stored, learned, logged or sent | §4.3 secret-class removal; media fetched on the device; URL tokens stripped                                        |
| Customer data never in cross-coach memory         | §4.7 boundary spec; dedup per coach only                                                                           |
| Unknown ≠ 0; no false `complete`                  | `observed_unique` / `not_moved` are null when the basis is unknown; the display gate; over-bound records not moved |
| RLS never weakened                                | Service-role-only tables; the person expansion adds `person_id IS NULL` guards only                                |
| Replay, cancel, timeout and process-loss safe     | Create-only, unique keys, one transaction per identity, fencing as S8-G                                            |
