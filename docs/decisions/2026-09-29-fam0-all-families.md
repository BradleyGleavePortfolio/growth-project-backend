# FAM-0: every reachable family lands in TGP (native map + preserve destination) — r8

- **Status:** T4 design record, draft, r8 (closes R590-A through R590-A6 and R590-B through R590-B6; applies owner decisions of 2026-09-29 09:52 PDT on OQ-1/P2, P4, P6; §11). It
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
  unknown = `null`. **Executive direction r4 (2026-09-29):** existing native writers keep reading the staged payload; ingest redaction = exact normalized key denylist + unmistakable value shapes only; no purge before the residual writer; media references keep the person key and are admitted under the blob lock; imported history is defined by provenance with an enforced CI check; the projection is D-L0-6.3 by name, not restated. **Executive direction r7:** redaction = one versioned rules file + acceptance corpus (zero false positives on must-keep), context-gated payment instruments at ingest, `rules_version` on rows with a re-screen job, deterministic partner-origin capture rule.
- **Open PRs this depends on:** #587 (S8-D3 person-owned schema and RLS), #588 (L2a one
  `SourceRegistryProvider`), #589 (L3 per-family evidence grammar), #577 (S8-D2 roster).

## 1. Owner directive, the reset, and what this record decides

Owner, 2026-09-29: there are **no unsupported families**. Anything reachable on a source site moves
into TGP, native or preserved. `complete` = every reachable client and coaching record is in TGP
with every list proven exhausted.

RESET §1 defers the completeness proof: until a separate completeness-closure record lands, every
run settles `partial` with gap `completeness_not_proven` (test-only `source_signed_enumeration`
excepted). **FAM-0 defines no `complete` mechanics beyond one rule: native and preserved records
both count as "in TGP" once the coach can view them (§6.1).**

This record decides:

1. A closed, vendor-neutral **family catalogue** (§3). A record's destination is a deterministic
   function of its family, the gate state and its typed rules, never a model choice.
2. **One native write path** (§4.6): every native writer, existing or new, resolves a preserved
   row for the same identity in its own transaction. Existing writers (S8-C, S8-D1) keep reading
   the staged payload exactly as today.
3. **PRESERVE** (§4): tenant-scoped, person-linked, idempotent, credential-screened, displayed to
   the coach, never read by AI. Staged payloads are never purged before the residual writer exists.
4. **Media** (§5): clean-scan gate, immutable blobs, person-keyed references admitted under the
   blob lock, tombstone-then-sweep erasure.
5. **Reconciliation inputs** (§6) and the mapping of FAM facts into the L0-owned projection
   (D-L0-6.3).
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
- The ingest redactor (`src/scout/scout-ingest.service.ts` L19-39, L149-183) is an exact
  lower-cased key denylist; native writers and S9 facts read the staged payload
  (`native-rules.ts` L435; `reconciliation/facts.service.ts` L830-845). FAM-0 keeps both facts.

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

**Destination determinism (R590-B-B9, R590-A2-06, R590-B3-B6).** A learned or authored spec (and
therefore the model, via L0-DOC `LearnedProposalV1`) proposes **data only**: a `family` from this
catalogue (including `unclassified`) and a field mapping. It never proposes a destination; L0
removes `destination.kind` from `LearnedProposalV1` in its next round, and until then FAM-C1's
validator ignores it and refuses a proposal whose `kind` disagrees with `destinationFor`. The
destination is decided **per record** by one pure function,
`destinationFor(family, gateState, typedResult) → 'native' | 'preserve'`: `native` iff the writer
registry (D-FAM-3) lists a native writer for the family **and** that writer's typed interpretation
is `ok`; otherwise `preserve`. A family can be partly native and partly preserved; the projection
expresses that with `moved_native` and `preserved` counts (D-L0-6.3). `unclassified` is the only
catch-all label. `entity_type` in the identity key is always the family.

| Family                | Owner | Native model (when the gate is open)                                 | Gate                                            |
| --------------------- | ----- | -------------------------------------------------------------------- | ----------------------------------------------- |
| `clients`             | C     | `Person` (always native, including former clients; D-FAM-2)          | exists (S8-D1)                                  |
| `client_profile`      | P     | none yet (OQ-6)                                                      | a person-capable profile design                 |
| `programs`            | C     | `WorkoutProgram`                                                     | exists (S8-C)                                   |
| `workouts`            | C     | `WorkoutPlan`; child `workouts.exercise` → `WorkoutPlanExercise`     | exists (S8-C); withheld plan (EX1) ⇒ preserve   |
| `exercises`           | C     | `CoachExercise`                                                      | EX1-A, EX1-B                                    |
| `workout_assignments` | P     | `ClientWorkoutAssignment`, inactive                                  | #587 + S8-E1d + S8D-DOC OQ-12                   |
| `workout_logs`        | P     | `WorkoutSession`; child `workout_logs.set` → `ExerciseSet`           | #587 + S8-E1a                                   |
| `client_history`      | P     | none (legacy generic token; new runs preserve only, §4.1)            | none: new specs must name a specific family     |
| `messages`            | P     | `CoachMessage`                                                       | FAM-N1                                          |
| `food_logs`           | P     | `LoggedFoodEntry` + tenant food row                                  | FAM-N2a + FAM-N2b                               |
| `water_logs`          | P     | `WaterLog`                                                           | FAM-N2b                                         |
| `nutrition_targets`   | P     | `MacroTarget`                                                        | FAM-N2c                                         |
| `meal_plans`          | C / P | `MealPlan` (`client_id`/`person_id` NULL ⇒ coach template)           | FAM-N2c                                         |
| `checkins`            | P     | `CheckIn`                                                            | #587 + S8-E1b                                   |
| `body_weights`        | P     | `WeightLog`                                                          | #587 + S8-E1b                                   |
| `body_measurements`   | P     | none                                                                 | a native design                                 |
| `habits`              | P     | `Habit`; child `habits.log` → `HabitLog`                             | #587 + S8-E1c                                   |
| `coaching_sessions`   | C / P | `CoachingSession` (terminal statuses only; D-FAM-4)                  | FAM-N6                                          |
| `notes`, `goals`      | P     | none                                                                 | a native design                                 |
| `forms`               | C     | none                                                                 | a native design                                 |
| `form_responses`      | P     | none                                                                 | a native design                                 |
| `media`               | C / P | preserved media (§5) attached to its parent                          | FAM-M1 (until then: not moved, with a reason)   |
| `billing_history`     | P     | none; preserved, coach-visible, read-only (OQ-1 answered; D-FAM-5)   | FAM-P2 (instrument screen is at ingest, FAM-P1) |
| `billing_schedule`    | P     | none; structured preserved schedule per client (D-FAM-5)             | FAM-P2 + spec roles of D-FAM-5                  |
| `unclassified`        | C / P | none (a reachable coaching collection the mapping cannot name; OQ-7) | —                                               |

Non-records (account settings, UI configuration) stay out of scope by the structural exclusion
rule, never by a model choice. **Third-party and partner-service data reachable through the
coach's own session moves and is used** like any other reachable record of its family (owner
decision P6, 2026-09-29); the former exclude-and-disclose default is deleted. Bounds unchanged: no
credential is stored (§4.3), the extension never logs into a partner service (RESET §2, §4), and
only what the coach's session can reach is read.

**Partner-origin rule (FAM-0 owns it; deterministic at capture, no content test; R590-A5-B2,
R590-B5-B5).** A foreign origin is in scope iff all of: (a) the page in the authorized tab itself
issued the request during this run under L0-DOC's **MAIN-world replay credential model**
(D-L0-6.2: replay re-attaches only the headers the page itself sent to that origin, side-effect
bounds apply); (b) the origin is in the run's contacted set — (a) already implies (b); (b) is
kept only to name the set the replay router is bounded to, not L0's `credentialed` subset
(R590-B6-C7); (c) the response is JSON. Non-JSON foreign responses stay `origin_rejected` per
D-L0-6.2; partner-origin **media** follows OQ-4 (default: confined set only; R590-B6-B3).
**Excluded categories** — analytics, feature flags, ads, error reporting,
identity-provider token endpoints, payment-card entry endpoints — are recognized by the
structural signatures listed in `shared/redaction-rules.json` `excluded_origin_categories` (§4.3;
e.g. a JSON response whose top level carries credential-key fields such as `access_token`/
`id_token`, non-GET traffic carrying payment-instrument keys, well-known telemetry path shapes)
and are **not captured**: no record is placed, no `not_moved` row, no gap; each match increments
L0's capture-time `origin_rejected` counter **per category** (count only, no origin string), and
the run report shows those counts (R590-B6-B4). The corpus (§4.3) holds must-capture (a partner
coaching JSON API; a coaching `events` calendar path) and must-exclude (IdP token response,
card-entry POST, telemetry beacon, flag fetch) origin-category cases. Placement of
captured records follows D-L0-6.3: an unmapped reachable collection is gap `collection_unmapped`
(uncounted); an owner-confirmed exclusion is `not_moved: excluded_by_policy` with the device-side
count. Never both. No family in the catalogue is currently excluded by policy.

**Required L0 r6 amendments** (accepted external dependency; R590-A4-B2, R590-B4-B5): drop
`LearnedProposalV1.steps[].destination.kind`; delete the `third_party_not_imported` and
`out_of_scope_billing` codes; admit partner-service origins by the rule above and count
`origin_rejected` per excluded category; **append `GapCode` `residual_unknown`** (family-attributed,
with a count of affected identities; R590-B6-B2); `FamilyLabel` = the D-FAM-1 catalogue; reference
FAM-0 slice ids.

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
  and for `messages` `authorSourceId` and `authorRole`; plus media roles (§4.3 transform 2). No
  declared-field or value-class list exists (R590-B3-B1). Native typed roles come from the native rule registry (`native-rules.ts`
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

**Residual fields.** A native record whose preserved record (§4.3) carries paths the native rules
do not consume keeps them in a `graduated` row of `ImportPreservedRecord` (§4.1) under the same
identity: native pointer plus residual. The obligation is computed by **every** native write from
FAM-G1 on, native-first or graduated (§4.6), and verified by S9 for `projection_version ≥ 1`
(§6.2). Nothing is purged before it exists.

### D-FAM-5: billing history and the recurring schedule (owner decision OQ-1/P2, 2026-09-29)

- **`billing_history`** (invoices, payments, refunds, statuses, dates, amounts, currency) is
  preserved per client (P family, `personSourceId` required), coach-visible, read-only. No native
  model; §4.3 applies unchanged (payment instruments are removed at ingest by category 3; last-4
  and brand stay).
- **`billing_schedule`** (roles and derivation owned by slice **FAM-B1**, §7). When the source
  exposes a recurring subscription for a client, the spec declares the roles `amountMinor`
  (integer minor units) and `currency` (ISO 4217), `interval` (`week|month|year`) and
  `intervalCount`, `sourceStatus` (`active|paused|cancelled|past_due|trialing|unknown`, mapped
  from the source string, the raw string kept), `anchorAt` (start or last-billed anchor),
  `nextDueAt` (only when the source shows it) and optionally `pausedAt`/`cancelledAt`. The
  preserved `fields` store the raw values plus the **derivation inputs only**:
  `{ amount_minor, currency, interval, interval_count, source_status, anchor_at, next_due_at_observed?, source_time_zone, observed_at }`
  where `source_time_zone` is the run's zone basis (S8-DOC §3.9) and `observed_at` is the
  intent's capture timestamp (R590-B5-C1). **No computed date is stored** (R590-A4-B1,
  R590-B4-B4). The typed read port computes `next_due` at read time: `source_status` not `active`,
  and `trialing` or any status without observed period evidence (`anchor_at` **and** `interval`
  from the source; R590-A6-B2) ⇒ **no due date** (`basis: 'none'`, status shown); `next_due_at_observed` present
  and ≥ reading time ⇒ `observed`; present but < reading time ⇒ `stale` (shown as a past reference,
  never actionable); otherwise the first period end after the reading time from `anchor_at` +
  `interval × interval_count` in `source_time_zone`, **always labelled `estimated`**; missing
  inputs ⇒ `none`. One row per (client, source subscription id); the coach display (FAM-P3/UX-P3,
  R590-B5-C3) shows the schedule beside the client.
- **Typed read port.** `BillingScheduleReadPort.listForCoach(coachId) → BillingScheduleView[]`
  (`{ person_id, amount_minor, currency, interval, interval_count, source_status, next_due:
{ at, basis: 'observed' | 'stale' | 'estimated' | 'none', observed_at } }`) lives inside
  `src/scout/preserve/**` and is the only cross-module surface for billing data (§4.7 boundary
  gains one named consumer: BILL-1's module — today `src/billing/**`, renamed if BILL-1 lives
  elsewhere, R590-B5-C5 — may import this port and nothing else from preserve).
- **What does not move.** Moving the schedule moves **no live charge**: the source keeps charging
  through the coach's connected payment account until the coach cancels there; TGP never stores
  or copies card or bank data and never creates a charge from imported data. The coach display
  says so on every schedule row.
- **Consumer, not designed here.** A future slice **BILL-1** (reminders + TGP checkout whose first
  charge lands on the carried due date, after which the coach cancels at the source) is the only
  consumer of the read port. **No imported date — `estimated`, `stale` or `observed` — triggers a
  charge, reminder escalation or dunning**: BILL-1 must obtain fresh coach or client confirmation
  of status and date first (R590-A4-B1, R590-B5-C2). Pointer only: BILL-1 maps a schedule to the existing
  `CoachPackage` (schema L3239) and `ClientPurchase` (L3529) concepts; FAM-0 writes neither.

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

### D-FAM-4: event time, authorship and the imported-history rule (R590-A-B2, R590-B-B6, R590-B2-B5, R590-B3-B4)

- **Event time.** `CoachMessage.created_at := occurredAt` for imported messages only (the thread
  orders on it, index L1227). This is the sole exception to S8-DOC §3.3.
- **Authorship.** The run carries the bearer's own source account id (RESET §2). A coach-authored
  message is native only when `authorSourceId` equals it; then `sender_id = bearer`. A
  client-authored message is native when `authorSourceId` equals the thread Person's
  `source_person_id`; then `sender_person_id = person`. Any other author ⇒ preserved. Thread
  `coach_id = Person.coach_id` (the tenant head coach, `coach-effectiveness.service.ts` L466-469).
- **Imported history is defined by provenance.** A native row is imported history iff an
  `ImportNativeProvenance` row points at it. Each table that gains an import writer also gains
  `imported_at DateTime?` (indexed), set in the writer's transaction iff the provenance row is
  written (invariant test: `imported_at IS NOT NULL ⇔ provenance exists`); queries filter on it.
  No read state, review state or notification is invented (`read_at` NULL unless a source
  read-state role exists; `CheckIn.reviewed_by_coach` default).
- **Rule.** Every consumer of such a table excludes imported history, except (a) the record's own
  history, thread and detail screens, (b) the disclosed per-client AI context — exactly
  `src/ai/client-ai-context.service.ts` and `src/ai/context/client-context.service.ts`
  (`src/ai/gateway/private-context.service.ts` is **not** allow-listed) — and (c) consumers the
  owner opts in (OQ-11, default none).
- **Enforced CI check** (each W slice ships it for its tables; it fails on any hit outside the
  slice's exclusion list or the allow-list). Derived from the Prisma DMMF, not a hand regex, it
  covers, per mapped table: (1) every delegate read method (`findMany`, `findFirst`,
  `findFirstOrThrow`, `findUnique`, `findUniqueOrThrow`, `count`, `aggregate`, `groupBy`);
  (2) relation fields of the table on any model in `include`, `select`, `where` (`some`, `none`,
  `every`) and `_count`; (3) `$queryRaw`, `$executeRaw`, `$queryRawUnsafe`, `$executeRawUnsafe`
  and `Prisma.sql` text containing the
  quoted table name. Current hits at `d6cf9eb6` outside the writer modules: raw SQL
  `coach/coach.service.ts` L515-527 (`LoggedFoodEntry` macro totals) and
  `coach/brief/coach-brief.service.ts` L908-917 (`WeightLog` latest weight); relation filters
  `coach-brief.service.ts` L963 (`check_ins: { none }`), `coach/cross-pillar/cross-pillar.service.ts`
  L142 (`logged_entries: { some }` active-client count), `ai/gateway/private-context.service.ts`
  L57 (`include: coach_messages_as_client`); `findUnique` `workout/workout.service.ts` L117, L158,
  L167; delegate reads: `workoutSession` 15 files, `coachMessage` 17, `checkIn` 16,
  `loggedFoodEntry` 12, `weightLog` 9, `coachingSession` 4, `mealPlan` 3, `habit` 3,
  `macroTarget` 2, `waterLog` 2, `habitLog` 1 (category (1) only; the CI check restates the full
  inventory per slice). Each W slice also ships a post-link test per consumer class: zero badge,
  queue entry, push, digest line, brief line, leaderboard/streak/community entry, active-client
  count change, admin-metric delta, reminder.
- **Disclosure.** The import itself is AI-free (§4.7). Once a row is native and the client linked,
  it follows live product behaviour, including the allow-listed AI context (N-1).

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
  title              String?                      // ≤ 200 chars
  source_archived    Boolean   @default(false)
  fields             Json                         // the preserved record (§4.3); residual only when graduated
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
preserved. `ImportNativeProvenance` gains `residual_required Boolean @default(false)`,
`residual_id String? @unique` (FK → `ImportPreservedRecord(id)` ON DELETE RESTRICT), a CHECK
`residual_required = (residual_id IS NOT NULL)`, `projection_version Int @default(0)` and
`imported_archived_at DateTime?`. **Backfill and meaning** (R590-A2-02, R590-B3-B5): existing rows
and every row written before FAM-G1 keep the defaults, `projection_version = 0` = "pre-FAM,
residual not captured"; the three provenance write sites (`native-provenance.ts` L60, L111,
L154) are untouched by FAM-C1 because every new column has a default. S9 claims residual
completeness only for `projection_version ≥ 1` (§6.2). FAM-G1 backfills version-0 rows from the staged
payload when it is present, else §4.3 "Legacy rows" applies (R590-A6-C2); such an identity is
bucket f `destination_gate_closed` until converted and gap `residual_unknown` if its payload is
gone.

**Ledger.** `ScoutReconstructionLedger.target_kind` gains `preserved_record` and every new native
kind (CHECK expand of L191; FAM-C1). A preserved top-level identity is ledger `reconstructed` with
that kind and `target_id = ImportPreservedRecord.id`. Children and residuals are not ledger rows.
The fence trigger (`20270119000000_scout_ledger_obsolete_writer_fence` L87-92) is INSERT only;
the §4.6 retarget UPDATE runs under the run-row lock (or the intent lock on demand).

**No third destination (R590-B-B2).** From FAM-P2 on, no run writes `ScoutReconstructedEntity`
evidence rows (the upserting `persist` in `families.ts` L117-134 is retired for new runs);
`client_history` and rule-less `workouts` go to PRESERVE with ledger kind `preserved_record`.
Legacy `scout_entity` rows are converted once, idempotently per coach, by FAM-P2: read
`ScoutIngestEntity.payload` (the evidence row has no payload, schema L7112-7125), build the
preserved record, retarget the ledger rows and delete the evidence row in one transaction.

### 4.2 RLS and tenancy

Exactly the `Person`/provenance posture: ENABLE + FORCE; permissive `service_role` policy;
RESTRICTIVE deny-all for `anon` and `authenticated`; explicit `REVOKE ALL ... FROM anon,
authenticated` (`20270122000000` L167-182). No principal reads the tables directly. Every read
route filters `coach_id = req.user.id` and re-asserts the parent's ownership (§5.3); any miss is an
opaque 404. The FAM-P1 RLS spec is the S8D-DOC §2.2 item 4 matrix plus role × tenant negatives.

### 4.3 Redaction: one rules file, one corpus, one invariant (R590-A-A1, A2-01, A4-01, A4-02, B-B3, B2-B3, B3-B1/B2, B4-B1/B2/B3, A5-B1/B3/B4, B5-B1/B2/B3/B4/B6)

**Invariant.** No credential and no payment instrument is durably stored anywhere in TGP: not in
`ScoutIngestEntity.payload`, not in a preserved row, not in a native row, not in logs. Redaction
therefore runs **at ingest, before the first durable write, for every family**, with the same
rules in the extension (device-side, before the request leaves the tab) and the backend.

**Categories** (closed; the rules file enumerates the members, this record only illustrates):

1. **Credential keys** — whole-key match after `norm(key)` (lower-case; `_`, `-`, whitespace
   removed), at any depth, and on URL query-parameter names inside string values. Illustrative:
   `password`, `passwordConfirm`, `user_password`, `access_token`, `personal_access_token`,
   `X-CSRF-Token`, `x-api-key`, `session_cookie`, `sessionid`, `otp_secret`, `2fa_code`, `card_cvc`.
   No word or word-pair logic; `session`, `session_id`, `sessionId`, `workout_session_id`,
   `pin_order`, `auth_user_id`, `token_count` are coaching data and stay (`sessionid` is listed
   only because the source-side spelling `session_id` never normalizes to it; owner may strike it).
2. **Credential value shapes** — unmistakable only: a JWT (whole value or after an auth scheme);
   `Bearer`/`Basic`/`Token` scheme (case-insensitive) followed by an RFC 6750 `b64token`
   (`[A-Za-z0-9._~+/-]+=*`, ≥ 20 chars, no whitespace, to end of string), **or** `Basic` followed
   by base64 decoding to `user:pass` of any length; a PEM block. Titles such as
   `Basic Strength Program`, `Bearer Crawl Complex`, `Basic StrengthTrainingPlan` stay (the last
   fails the decode test). No entropy, length or character-class test on other strings.
3. **Payment instruments** — **context-gated, never bare digits**: a value is dropped when (a) its
   key or parent key normalizes to a payment-instrument name (`card`, `cardnumber`, `pan`, `cvc`,
   `cvv`, `iban`, `bic`, `routing`, `routingnumber`, `accountnumber`, `bank`, `ach`,
   `paymentmethod`, `number` under any of these …) — so `card.number`, `bank.number`,
   `payment_method.card.number` drop regardless of shape — or (b) the value carries card-style
   grouping separators (`4111 1111 1111 1111`, `4111-1111-…`) and passes Luhn. A bare 13-19 digit
   run under a non-instrument key is never tested: epoch-millisecond timestamps, 19-digit ids,
   9-digit invoice numbers, EAN-13, amounts and spec-declared id/date/amount roles stay. Last-4
   and brand stay.

**One rules file.** `shared/redaction-rules.json` `{ rules_version: int, credential_keys: [...],
value_shapes: {...}, payment_instrument_keys: [...], excluded_origin_categories: [...] }` (the
last for D-FAM-1) is owned by **FAM-P1** and consumed by `redactPayload`
(`scout-ingest.service.ts` L149-183, which keeps its recursion and whole-key shape and gains
categories 2-3) and by the extension: the file is **vendored into the extension repo with a
pinned SHA-256 checked in both CIs**; the extension stamps `rules_version` on every batch and the
backend refuses a batch below `SCOUT_MIN_RULES_VERSION` (R590-B6-B1). **Today's device-side
redactor** (`shared/credential-policy.js` via `shared/capture-policy.js`) is **retired** by the
extension slice **X-RED1** (depends on FAM-P1): it uses its own list and word logic and, per
`reviews/scratch/R590-B6/t.mjs`, drops must-keep keys `session_id`, `sessionId`, `session`,
`session_key`, `signature`, `exercise_key`, `key` and rewrites titles — a defect X-RED1 must fix
by adopting the rules file and passing the corpus. `preserveRecord`, the FAM-P2 legacy conversion and the FAM-G1 backfill
call the same function with the current file before writing (a staged row may predate a version).
Any hand-written list in this record is illustrative; the file is authoritative.

**Acceptance corpus** (`src/scout/preserve/__fixtures__/redaction-corpus.json`, vendored with the
rules file; CI gate in **both repos** for FAM-P1, X-RED1 and every version bump; generated from
the reviewer scripts' inputs, not hand-copied, R590-B6-C1): a **must-drop** set and a **must-keep** set, seeded with every case
from R590-A4/A5/B4/B5 and `reviews/scratch/R590-B4/rule_r5.py`, `R590-B5/rule_r6.py` — must-drop:
`Bearer <full JWT>`, `Bearer ya29.<…>`, `bearer <hex>`, `Basic dXNlcjpwYXNz`, `passwordConfirm`,
`user_password`, `account_password`, `personal_access_token`, `private_token`, `two_factor_code`,
`2fa_code`, `card_cvc`, `credit_card_number`, `X-CSRF-Token`, `session_cookie`, `new_password`,
`X-Auth-Token`, `api_token`, `otp_secret`, `{"auth key": …}`, `{"Password hint": …}`,
`card.number`, `bank.number`, `payment_method.card.number`, `4111 1111 1111 1111`, a PEM block,
`?token=…`, `auth`, `recoveryPhrase`, `current_password`, `old_password`, `password_confirmation`,
`apiToken`, `x-api-key`, `sessionid`, `Bearer abc~DEF…`, `Basic dGVzdDp0ZXN0ZXN0ZXN0ZXN0`;
must-keep: every `session_id` form, `session_key`, `pin_order`, `auth_user_id`,
`author_id`, `account`, `signature`, `exercise_key`, `token_count`, `program_id`, all id classes,
13-digit ms timestamps (`created: "1727600000001"`), 19-digit ids, 9-digit invoice numbers beside
`amount_minor`, EAN-13, `Basic Strength Program`, `Basic Full Body A`, `Bearer Crawl Complex`,
`Basic StrengthTrainingPlan`, `Basic `, `Strength & Conditioning`, `Força`, `HIIT (30 min)`,
`a1b2c`, `Bench2024!`, `workoutSessionId`, `coaching_session_id`, `pinned`, `key`,
`BasicStrengthProgramWorkoutsAAAA`, `Basic StrengthProgramForBeginners`, `Token Economy Program`,
`payment_method.card.last4`, `card.brand`, `card.exp_month` (expiry is not an instrument unless
the owner says so), `{"card":{"title":"Leg day"}}`, `{"bank":{"name":"Exercise bank"}}`,
`{"invoice":{"number":"123456789"}}` (category 3 drops only instrument-named leaves under an
instrument parent — `number`, `pan`, `cvc`, `iban`, `routing`, `account_number` — never every key
under `card`/`bank`), every path segment of every native rule set and spec under
`src/scout/reconstruct/**`. **False-positive budget on must-keep: zero.** A rule change that drops
a must-keep entry fails CI; owner sign-off adds or removes corpus entries, never the budget.

**Rows carry `rules_version`.** `ScoutIngestEntity`, `ImportPreservedRecord` and
`ImportNativeProvenance` record the `rules_version` in force when written. **At FAM-P1 deploy**
every pre-P1 staged row is set to `rules_version = 0` and **quarantined** — not read by any native
writer or S9, not converted, not preserved, not graduated — until the job has re-screened it
(R590-A6-B1; fixture: pre-P1 row consumed natively and preserved only after re-screen).
**Re-screen job** (R590-B5-B4; an obligation of every slice that raises `rules_version`):
bounded, idempotent, per coach, over rows with `rules_version` below the current one: un-purged
staged `payload`, `preserved`/`graduated` `fields`, **and provenance-linked native free-text
columns written by import** (the writer registry names them per kind, e.g. `CoachMessage.body`,
`CheckIn.notes`, `WorkoutPlan.notes`; R590-A6-A1). It takes `SELECT … FOR UPDATE` on each row (and
on the provenance/preserved keys of the identity), applies the current rules, updates the
value/`fields_sha256`/`dropped`/`rules_version`, and writes an `ImportRedactionAudit` row (`row
id, from, to, key paths and counts` — never values; §4.2 RLS; deleted with the identity in FAM-E1a
erasure; in export scope; R590-B6-C5). Graduation and every preserve write re-apply the current
rules and check `rules_version` under the same lock, so a concurrent job cannot be overwritten
(R590-B6-B5). This is the **only permitted mutation of create-only rows**, security redaction
only, never a content update; replay verification compares by identity, not by hash.

Existing native writers (S8-C, S8-D1), the S9 facts interpreter and every future W writer read the
**staged payload as today** (R590-B3-B1): already redacted at ingest, no further gate on native
inputs; the corpus proves 0 native path segments are hit.

**The preserved record.** `preserveRecord(payload, spec, family) → { fields, dropped }`, pure and
versioned, runs at reconstruct and applies, after re-applying the current rules file:

1. **Contact PII** (OQ-8 default): values under normalized keys `email`, `emailaddress`, `phone`,
   `phonenumber`, `mobile`, `telephone`, `address`, `street`, `postalcode`, `zip`, `dob`,
   `dateofbirth`, `birthdate`, and any string matching the email grammar
   `^[^\s@]+@[^\s@]+\.[^\s@]+$`, become `{"$dropped": "contact_pii"}`. No phone-like test. A native
   rule may never consume a contact-PII key (FAM-C1 validator).
2. **Media.** A value under a spec-declared media role becomes `{"$media": "<ImportPreservedMedia
id>"}` once §5 holds the bytes, else `{"$media_pending": <ordinal>}`; media-role native rules
   resolve by the media identity key, never from a URL string, in both write paths.
3. **Bounds.** Depth ≤ 8, ≤ 500 keys, string ≤ 16 KiB, canonical JSON ≤ `SCOUT_PRESERVE_MAX_BYTES`
   (default 64 KiB, hard cap 256 KiB). Over-bound ⇒ `not_moved: over_limit`, never truncated.
4. **Canonical form.** Sorted keys; `fields_sha256`; `projection_version` and `rules_version`.

**Legacy rows with no staged payload** (R590-A4-01): a pre-P2 evidence or version-0 provenance
row whose `ScoutIngestEntity.payload` is absent or already `{}` gets **nothing fabricated**: the
conversion writes no preserved row, the backfill leaves `projection_version = 0` and
`residual_required = false`, and FAM-R1 reports gap `residual_unknown` per family with the count
of affected identities (the residual content is the unknown; the identities are known). Test fixtures: legacy row with payload, legacy row without.

**Residual, stated (OQ-12).** Provable: every listed key, every category-2 shape and every
context-gated payment instrument is removed before any durable write and re-screened on every
version bump. Not provable: a secret under a key that names nothing (`{"hint": "mydog"}`,
`{"note": "4111…"}` without separators), which no rule can distinguish from coaching data.

**Staged purge — ordering (R590-A2-02, R590-B3-B5).** FAM-P2 purges nothing. The purge ships in
or after FAM-G1 and clears `ScoutIngestEntity.payload` to `{}` for an intent only when all of:
the run is terminal, the arbiter has written the settled S9 report, every native identity of the
intent has `projection_version ≥ 1`, and `SCOUT_STAGED_RETENTION_DAYS` (default 7) have passed.

### 4.4 Retention, erasure and export (FAM-E1a lands before FAM-P2; R590-A-A4, R590-B-B7, R590-A3-01, R590-B3-B3)

- **Retention:** as long as the coach account and the Person exist. A `graduated` row keeps only
  identity and residual, so no value is stored twice.
- **Person erasure** (S8D-DOC §2.3 explicit path) selects by tenant-scoped source identity,
  including soft edges: `coach_id = P.coach_id AND (person_id = P.id OR (person_id IS NULL AND
source_namespace = P.source_platform AND person_source_id = P.source_person_id))` over
  `ImportPreservedRecord` **and** `ImportPreservedMedia` (media rows keep the person key through
  graduation, §5.1, so graduated voice notes and photos are selected too). One transaction deletes
  those rows, the ledger and provenance rows of those identities and P's native rows (S8D path);
  for each touched blob, `SELECT … FOR UPDATE` the blob row, count remaining `ImportPreservedMedia`
  references; zero ⇒ set `tombstoned_at = now()`. Nothing physical is deleted in the transaction.
- **Sweep** (`ImportErasureJob`, retryable, idempotent), after commit and after
  `MEDIA_TOMBSTONE_GRACE` (default 24 h): re-lock the blob, re-check zero references, delete the
  objects (import bucket and every copy, `deleteObject` L116), then the rows. A reference added
  meanwhile is impossible: every reference insert or re-parent takes `FOR UPDATE` on the blob row
  and fails if `tombstoned_at IS NOT NULL` (§5.2, §5.4). The sweep also deletes media rows whose
  native parent no longer resolves (coach deleted the imported message) and, when that leaves zero
  references, tombstones the blob. The Person transitions to `Deleted` when its sweep is done.
  `Deleted` is a tombstone (D-FAM-2): re-import refuses.
- **Coach account deletion** (`src/account-deletion/account-deletion.service.ts`, no Person or
  import handling today) tombstones every blob of the coach and deletes rows by `coach_id`; the
  same sweep deletes the objects.
- **Export:** coach export of preserved records per Person (JSON + signed media links) in FAM-E1a;
  the client data export (`src/data-export/data-export.service.ts`) includes preserved records only
  for OQ-2-visible families.
- **Sequencing rule:** FAM-P2 does not write where FAM-E1a's deletion paths are not present and
  tested; FAM-M1 does not write blobs before FAM-E1b (media erasure) is present.
- **Tests:** graduate A's voice note → erase A → blob and copy swept, B's shared blob survives;
  last-reference erase racing a new attachment at the commit boundary (attachment fails on the
  tombstone or erasure sees the reference); process loss between commit and sweep.

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
`nativeWrite(identity, input)`, in one transaction per identity tree (parent and children, or
none). `input` is the **staged payload** for a run (as today) or the stored `fields` of a
`preserved` row for graduation; both are redacted by the same rules file at ingest and differ
only by §4.3 transforms 1-2 and any later `rules_version` re-screen, none of which touches a
path a native rule consumes (corpus: 0 native segments hit), so both paths yield the same native
values within one `projection_version`.

1. `SELECT … FOR UPDATE` the provenance key and the preserved key. Provenance present ⇒
   create-only replay: verify, write nothing (S8-DOC D-S8-4). Preserved row present ⇒ its stored
   `fields` is the input from here on (the fresh payload is drift evidence, never an update) and
   its `person_source_id`/`person_id` columns supply the person edge.
2. Interpret with the family's native rules exactly as today. The interpreter returns not-ok for a
   `$dropped`, `$media_pending` value **at a path it consumes**. Not-ok, or gate closed ⇒ the
   record is (or stays) preserved; if it was a soft-edge row and the person now resolves, set
   `person_id`, clear `person_source_id`. Nothing else changes. There is no separate attach path.
3. Ok ⇒ write native rows and provenance `created` with `imported_at`, `imported_archived_at`,
   `projection_version`; media references re-parented under the blob lock (§5.4).
4. **Residual** (FAM-G1) = paths of `preserveRecord(input)` minus the paths the rules consumed
   (deterministic). Non-empty ⇒ write (native-first) or convert (graduation) the
   `ImportPreservedRecord` row to `state = 'graduated'` with the residual as `fields`, and set
   `residual_required = true`, `residual_id`. Empty ⇒ delete any preserved row. Before FAM-G1 the
   step is skipped, `projection_version` stays 0 and nothing is purged (§4.3), so G1's backfill
   computes the residual later from the intact staged payload.
5. **Retarget the ledger** for every intent of this identity: `UPDATE ScoutReconstructionLedger
SET target_kind = <native kind>, target_id = <native id> WHERE coach_id, entity_type,
source_platform, source_id match AND target_kind = 'preserved_record'`. Native-first writes insert
   the ledger row as today.

**Triggers for graduation** are callers of `nativeWrite`: (a) the next run of the source (step 1
finds the preserved row); (b) on demand per coach when the source is gone, over `preserved` rows of
families whose gate is open. A rule-outcome change without a registry flip (an EX1 binding that
now resolves) is the same path.

**Guard before engine.** FAM-P2 ships steps 1-2 and the "stays preserved" branch into every
existing writer (the guard); FAM-G1 ships steps 4-5 and the version-0 backfill. Between them an
existing writer that finds a preserved row writes nothing native, so I-1 holds from FAM-P2 on.

**Tests** (FAM-P2/G1): I-1 over S8-D1, S8-C (withheld and bound) and each W writer; every existing
fixture source yields byte-identical S8-C native rows and S9 facts before and after P2;
native-first residual present and RESTRICT-protected after G1 backfill; create → graduate →
reconcile → replay; residual deletion refused; children all-or-nothing; ledger retargeted for two
intents; graduated equals native-first per version.

### 4.7 Preserved values never reach the AI or cross-coach memory

- **Module boundary spec** (FAM-P2 acceptance): outside `src/scout/preserve/**`,
  `src/scout/reconciliation/**`, `src/account-deletion/**`, `src/data-export/**`, no file references
  the Prisma delegates `importPreservedRecord`, `importPreservedMedia`, `importMediaBlob`,
  `importMediaCopy`, `importErasureJob` (sole exception: `src/billing/**` imports the
  `BillingScheduleReadPort` of D-FAM-5, never a delegate). `src/ai/**`, `src/roman/**`, `src/insights/**`,
  `src/coach/brief/**`, `src/coach/command-center/**`, `src/notifications/**`, `src/community/**`,
  `src/scout/learn/**` never import the preserve module. `rg`-based, fails on a new reference.
- **Learn memory** is structure-only and, in V1, per coach (RESET §2). Preserved values are never
  digest input.
- **Logs and telemetry** carry counts and closed codes only (S9-DOC D-S9-7).

## 5. Media, photos and files (FAM-M1; R590-A-B1, R590-A-B3, R590-B-B5, R590-A2-04, R590-A2-05, R590-A3-01, R590-B3-B3)

### 5.1 Tables

- `ImportMediaBlob`: `coach_id`, `content_sha256`, `byte_size`, `content_type`, `storage_key` =
  `imports/<coach_id>/<sha256>` (immutable, never repointed), `state ∈ {uploading, verified,
ready, rejected}`, `scan_status ∈ {pending, clean, rejected, error}`, `scanned_at`,
  `tombstoned_at DateTime?`. Unique `(coach_id, content_sha256)`; dedup within one coach only.
- `ImportPreservedMedia`: identity `(coach_id, source_namespace, 'media', source_id)`; `blob_id`
  with FK `(blob_id, coach_id) → ImportMediaBlob(id, coach_id)`; **`person_id`/`person_source_id`**
  (same FK and CHECK as §4.1; copied from the parent record at creation and **kept through
  graduation**, so erasure selects it by person, R590-B3-B3); parent is either
  `preserved_record_id` (composite FK) or `(native_kind, native_id)` (CHECK exactly one). This row
  is the reference for every use of a blob.
- `ImportMediaCopy`: `blob_id` + `coach_id`, `bucket`, `storage_key`, `state ∈ {pending, ready,
failed}`, `attempts`, unique `(blob_id, bucket)`.
- **Reference admission (R590-A3-01):** every insert or re-parent of an `ImportPreservedMedia` row
  takes `SELECT … FOR UPDATE` on the blob row in the same transaction and fails if
  `tombstoned_at IS NOT NULL` or `state <> 'ready'` (`already_present` is answered under the same
  lock). Erasure and admission therefore serialize on the blob row.
- All tables use §4.2.

### 5.2 Path and scan gate

1. The extension fetches bytes in the authorized tab, from the run's confined origin set only
   (OQ-4), with `redirect: 'manual'`: every redirect hop is checked; an unconfined hop is
   `not_moved: excluded_by_policy`.
2. It computes SHA-256 and calls the scout media route with
   `{family, source_id, parent key, sha256, byte_size, content_type}`.
3. Server, under the blob lock: `already_present` if the blob is `ready` and not tombstoned; else
   a signed PUT (`createSignedUploadUrl`, L82) for the immutable key in a separate private bucket
   (`IMPORT_MEDIA_BUCKET`; never the sellable-content bucket) on the **existing S3-compatible
   storage backend** (the `storage_backend` convention `supabase | s3 | stub`, schema L2903); no
   new storage vendor. Storage spend approved (owner decision P4, 2026-09-29); OQ-3 caps stay as
   defaults.
4. On confirm the server reads the object once, checks size, SHA-256 and magic bytes
   (`verified`; failure `not_moved: write_failed`, R590-B3-C3), then `MediaScanProvider.scan`
   (vendor-neutral provider interface). `ready` only on `clean`. `rejected` ⇒ object deleted,
   `not_moved: excluded_by_policy`. `error`/timeout ⇒ stays `verified`, retried,
   `not_moved: destination_gate_closed`. No scanner configured ⇒ nothing becomes `ready` (OQ-9).
5. Signed download URLs only for `ready`, non-tombstoned blobs; a blob counts as "in TGP" only when
   `ready`.
6. Bounds (tunable down only): image ≤ 25 MB; PDF ≤ 50 MB (`PDF_MAX_BYTES`, `coach-media.dto.ts`
   L12); audio ≤ 25 MB; video ≤ 500 MB, never transcoded; other ≤ 25 MB as
   `application/octet-stream`; run 20 GB; coach 100 GB. Excess ⇒ `not_moved: over_limit` (OQ-3).

### 5.3 Ownership contract for reads

Every media route is **coach-only in V1** (client media is outside OQ-2 and would be its own T4
slice). It verifies, in order: `blob.coach_id = req.user.id`; the media row's
`coach_id = req.user.id`; the parent exists and belongs to the caller — a preserved parent by the
composite FK, a native parent by an `ImportNativeProvenance` row `(coach_id = caller, native_kind,
native_id)` **and** a per-kind resolver from the writer registry that loads the native row under
the caller's tenant and confirms it is present; the blob is `ready` and not tombstoned. Any miss is
an opaque 404. Tests: role × tenant negatives (anon, authenticated, linked client, other coach,
foreign parent id, deleted parent, foreign blob id, non-ready or tombstoned blob) and positives per
parent kind.

### 5.4 Graduated media stays playable (per-bucket copies; copy-then-commit)

Native surfaces resolve media by their own columns and buckets (`CoachMessage.voice_url`,
`messaging.service.ts` L214-249: storage host and `/<voice-notes bucket>/<owner>/` prefix;
`CoachExercise` demo media per EX1-C; check-in photos have no native column and stay preserved
media on the native `CheckIn` parent). The blob is never moved. FAM-M1 adds to `nativeWrite` step 3
(the hook lives in M1, which depends on G1; R590-B3-C1):

1. **Copy first, outside the SQL transaction, idempotent:** key
   `<native bucket>/<tenant coach user id>/imported/<sha256>.<ext>`; reuse a `ready`
   `ImportMediaCopy(blob, bucket)`, else copy within the storage provider, verify SHA-256, upsert
   `ready`. Failure ⇒ `failed` + `attempts`; the native write is not-ok for that record
   (`not_moved: write_failed`, retried next run).
2. **Then commit** the native row with the column derived from the copy key and the media row
   re-parented to `(native_kind, native_id)` under the blob lock (§5.1), `person_id` kept.
3. **Sweep:** a copy with no media row on the blob whose native parent kind uses that bucket is
   deleted after `MEDIA_COPY_ORPHAN_TTL` (R590-A3-C1); otherwise copies go only with the blob
   (§4.4).

Tests: shared blob with two parents, graduate one, both play; copy failure ⇒ record stays
preserved; process loss after copy ⇒ sweep; erase one Person ⇒ other Person's copy and blob
survive; FAM-N1 playback of an imported voice note for coach and linked client; EX1-C demo clip.

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
- **Bucket j residual check** (R590-A-A2, R590-A2-02, R590-B3-B5): for
  `provenance.projection_version ≥ 1`, j additionally requires `residual_required = false OR
residual row present with matching native_kind/native_id`, otherwise
  `unresolved:residual_missing`. Version-0 rows (pre-FAM-G1) are j without a residual claim.
- **Archived amendment** (R590-B-A2, R590-A2-03, R590-B2-C4): buckets i and j, and S8 §3.4
  `already_present`, treat a native row as coach-archived iff
  `archived_at IS NOT NULL AND archived_at IS DISTINCT FROM provenance.imported_archived_at`. An
  import-time archive is verified present; a later coach archive, un-archive + re-archive
  (different timestamp) or removal is bucket i. Test: import-archived → coach change → reconcile.
- **Coach's own removal (bucket i, decided; R590-B3-C2, was OQ-5).** A native row that was
  verified present in an earlier settled report and is later removed or archived by the coach
  **moved**: it is counted in `moved_native` and is **not** a `not_moved` row and not an eighth
  reason. The S9 histogram keeps `unresolved:native_target_removed` for the history detail
  ("removed by you") and for the deferred completeness rule (§6.4). A bucket-i row with no earlier
  verified report (removed before any reconciliation) is `identity_conflict`.
- **Children.** A child that is neither native nor preserved counts `unresolved_children`.
- **Conditions.** C-FAM fires only for a staged token that resolves to no family (a spec defect).
  C-ID excludes j-p. C-REL includes unresolved person edges on preserved rows.
- **Invariant test I-1** (§7): for every key, never both a provenance row and a preserved row in
  state `preserved`; covers S8-D1, S8-C (bound and withheld) and every W writer.

### 6.3 Run-status projection: owned by L0 (R590-B-A1, R590-B2-B1, R590-A2-06, R590-B3-B6)

FAM-0 defines no projection fields and restates none. `GET scout/import/status` returns
`RunStatusProjectionV1` exactly as **L0-DOC D-L0-6.3** defines it (families rows without a
`destination` field, closed `NotMovedReason`, `unclassified` catch-all, counted fact → `not_moved`,
unknown → `gaps`, unknown = `null`). Slice **L2d** creates it; FAM-R1 depends on L2d and L3b and
fills `moved_native` (bucket j, plus coach-removed rows per §6.2), `preserved` (j-p) and the
`not_moved[]` rows from this mapping. FAM-0 adds no reason code; its one `GapCode`, `residual_unknown`, is a required L0 r6 amendment (D-FAM-1):

| Fact (S9 histogram key or FAM state)                                                                                                                     | `NotMovedReason`          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| owner-confirmed exclusion with a device-side count (none in the catalogue today); media from an unconfined origin (OQ-4); scan `rejected`; erased Person | `excluded_by_policy`      |
| media fetch failed on the device (4xx/5xx)                                                                                                               | `source_refused`          |
| media whose parent record is not in TGP; child whose parent is neither native nor preserved                                                              | `unresolved_parent`       |
| `unresolved:identity_conflict` (h); `missing_source_id`; bucket i with no earlier verified report                                                        | `identity_conflict`       |
| bucket f legacy row not yet converted; preserved before `PRESERVE_VIEWABLE`; media before FAM-M1; scan `error`/timeout; `unsupported_platform:<p>`       | `destination_gate_closed` |
| preserve over bound; media over bound; media quota; `unresolved:pass_ceiling_exceeded`                                                                   | `over_limit`              |
| ledger `failed`; `unresolved:residual_missing`; media verify failed (size/sha/magic); media copy failed                                                  | `write_failed`            |

Unmapped reachable collections are gap `collection_unmapped`, uncounted; version-0 identities with no staged payload are gap `residual_unknown` per family with a count (§4.3). The S9
histogram keys (D-S9-7) stay on the settled report for the history detail; projection copy never
renders `identity_conflict` as "conflict" for a coach's own action because such rows are not in
`not_moved`. Per-record `dropped` counts (§4.3) are shown in the coach display, not in the
projection (N-2).

### 6.4 Deferred to the completeness-closure record (RESET §1)

Required inputs, not decided here: the release gate as a `complete` condition (R590-A-B1 "ready"
gating), C-COV, "every media ref ready", "zero not-moved", the `excluded[]` and staged > observed
arithmetic (R590-B-C5), and any run-level closure for preserved families.

## 7. Slice plan (landable order; R590-A-C1, R590-B-B1, R590-B-B7, R590-B2-B1, R590-B2-B5, R590-B3-B5)

Tiers follow the T0-T4 doctrine. "Pin" = ships a migration and re-pins the S11 harness (S8D-DOC
§6). **W** = a native writer slice: it writes only through `nativeWrite` (§4.6), adds
`imported_at` to its tables, ships the D-FAM-4 CI check and post-link tests, and I-1 coverage. No
W slice for a family that FAM-P2 preserves lands before FAM-G1. **No slice purges staged payloads
before FAM-G1.**

| #   | Slice                                                                                                                                                                                                                                                                                                             | Tier  | Depends on                                       | Pin |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------ | --- |
| 0   | **FAM-0** this record                                                                                                                                                                                                                                                                                             | T4    | —                                                | no  |
| 1   | **FAM-C1** catalogue tokens, spec grammar (role set, media roles), `destinationFor`, proposal validator (`kind` ignored/refused), contact-PII-path validator for native rules, `preserved_record` + new native ledger kinds, `Person.source_archived_at`, provenance columns with defaults, contract regeneration | T4    | L2a #588, L0 r6                                  | yes |
| 2   | **FAM-P1** `ImportPreservedRecord` schema (+ `rules_version`, `ImportRedactionAudit`), CHECKs, RLS, composite FKs, RLS matrix spec; **`shared/redaction-rules.json` v1 + acceptance corpus CI gate**; ingest redactor categories 1-3 via the rules file (extension and backend); re-screen job                    | T4    | #587, FAM-C1                                     | yes |
| 2x  | **X-RED1** (extension) retire `shared/credential-policy.js`; vendor the rules file + corpus with pinned hash; stamp `rules_version` per batch; corpus CI gate in the extension repo                                                                                                                               | T4    | FAM-P1                                           | —   |
| 3   | **FAM-E1a** erasure and export for preserved rows: Person erasure by source identity incl. soft edges, tombstone refusal, coach account deletion by `coach_id`, `ImportErasureJob`, coach export                                                                                                                  | T4    | FAM-P1                                           | yes |
| 4   | **FAM-P2** `preserveRecord` (re-applies current rules), preserve writer, legacy evidence conversion with with/without-payload fixtures, **guard retrofit into S8-D1/S8-C** (§4.6 steps 1-2), before/after regression pin, module-boundary spec, I-1. **No purge.**                                                | T4    | FAM-P1, FAM-E1a, S8-D1                           | no  |
| 4b  | **FAM-B1** billing roles (`amountMinor`, `currency`, `interval`, `intervalCount`, `sourceStatus`, `anchorAt`, `nextDueAt`), derivation-input storage incl. `source_time_zone` and capture `observed_at`, `BillingScheduleReadPort` with read-time `observed`/`stale`/`estimated`/`none`                           | T4    | FAM-P2 (display: FAM-P3/UX-P3)                   | no  |
| 5   | **FAM-P3** coach read route (per Person, former clients, library), `PRESERVE_VIEWABLE`, contract regeneration                                                                                                                                                                                                     | T4    | FAM-P2, S8-D2 #577                               | no  |
| 6   | **UX-P3** mobile "From your previous platform", "Imported library", "Former clients"                                                                                                                                                                                                                              | T2    | FAM-P3                                           | —   |
| 7   | **FAM-G1** graduation engine (§4.6 steps 4-5), version-0 residual backfill, ledger retarget + fence, on-demand trigger, staged purge job (§4.3 ordering)                                                                                                                                                          | T4    | FAM-P2                                           | no  |
| 8   | **FAM-R1** reconciliation: j-p, residual check (version ≥ 1), archived predicate, bucket-i rule, `not_moved[]` mapping, `moved_native`/`preserved` fill, extension/mobile decode                                                                                                                                  | T4    | FAM-P3, FAM-G1, **L2d** (L0), L3b #589           | no  |
| 9   | **S8-E1a** (W) workout logs                                                                                                                                                                                                                                                                                       | T4    | #587, S8-D1, FAM-G1                              | yes |
| 10  | **S8-E1b** (W) check-ins + body weights (collision winner; unmapped required values preserved)                                                                                                                                                                                                                    | T4    | S8-E1a                                           | yes |
| 11  | **S8-E1c** (W) habits                                                                                                                                                                                                                                                                                             | T4    | S8-E1a                                           | yes |
| 12  | **FAM-E1b** media erasure: person-keyed media selection, tombstone + grace sweep, copy deletion, dangling-parent cleanup                                                                                                                                                                                          | T4    | FAM-E1a                                          | no  |
| 13  | **FAM-M1** media: tables, bucket, signed upload, verify, `MediaScanProvider`, quotas, reference admission under the blob lock, ownership routes with parent resolvers, extension fetch with per-hop confinement, **media copy hook in `nativeWrite`**                                                             | T4    | FAM-P1, FAM-E1b, FAM-G1, L3 origin set, OQ-3/4/9 | yes |
| 14  | **FAM-N1** (W) messages: person expansion, `sender_person_id`, authorship, consumer exclusions, voice copy, §2.7 re-own amendment                                                                                                                                                                                 | T4    | #587 pattern, FAM-G1, FAM-M1, S8-D4b/D5          | yes |
| 15  | **FAM-N2a** tenant-scoped food rows                                                                                                                                                                                                                                                                               | T4    | —                                                | yes |
| 16  | **FAM-N2b** (W) `food_logs` + `water_logs`                                                                                                                                                                                                                                                                        | T4    | FAM-N2a, FAM-G1                                  | yes |
| 17  | **FAM-N2c** (W) `nutrition_targets` + `meal_plans`                                                                                                                                                                                                                                                                | T4    | FAM-G1                                           | yes |
| 18  | **FAM-N6** (W) coaching sessions                                                                                                                                                                                                                                                                                  | T4    | FAM-G1                                           | yes |
| 19  | EX1-A/B/C, S8-E1d (W): withheld and blocked records preserved; demo media via §5.4                                                                                                                                                                                                                                | T4    | EX1-DOC, FAM-G1, FAM-M1, OQ-12                   | —   |
| 20  | Native designs for `notes`, `goals`, `forms`, `form_responses`, `body_measurements`, `client_profile` (own T3 records)                                                                                                                                                                                            | T3→T4 | owner decisions                                  | —   |

Edges: FAM-C1 needs L2a (#588) and L0 r6 vocabulary (R590-A5-C2); L1 needs FAM-C1's vocabulary (RESET §7);
FAM-R1 needs L2d (projection + enums) and L3b (`source_count`); FAM-M1 needs FAM-G1 (the copy
hook extends `nativeWrite`; graph acyclic, R590-B3-C1). L0-DOC should reference these FAM-0 slice
ids in place of `PRES`/`FAM-n` (R590-B2-C7). The FAM-C1 eval-harness re-run is L1's CI job.

## 8. Contradictions with other records (this record proposes the amendment)

| #    | Record                                                                                                                                       | Contradiction                                                                                        | Resolution                                                                                                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1  | L0-DOC (`unsupported_coaching_data` as a gap; messages/photos NO for V1)                                                                     | All families YES                                                                                     | RESET §6 projection; `unsupported_coaching_data` deleted in L0 r4/r5                                                                                                                                                                                  |
| C-2  | EX1-DOC EQ-3, D-EX1-7                                                                                                                        | Exercise media and withheld plans are reachable                                                      | Media via FAM-M1 (§5.4); withheld plan preserved whole with children, graduates through `nativeWrite` when CX-REF binds                                                                                                                               |
| C-3  | S8-DOC §3.7 `source_archived`, §4.6 (messaging absent), `scout-reconstruct.dto.ts` L9-11                                                     | Archived and messaging data are reachable                                                            | D-FAM-2 archived rule + §6.2 predicate; `messages` family                                                                                                                                                                                             |
| C-4  | S8-DOC §3.3                                                                                                                                  | `CoachMessage` orders on `created_at`                                                                | D-FAM-4 single-column exception                                                                                                                                                                                                                       |
| C-5  | S8-DOC §3.5 `native_uniqueness`, §3.7 `no_native_destination` as final                                                                       | Reachable                                                                                            | Preserved; codes kept only for history                                                                                                                                                                                                                |
| C-6  | S8D-DOC OQ-9                                                                                                                                 | Answered by the directive                                                                            | Preserved now; native designs in slice 20                                                                                                                                                                                                             |
| C-7  | TM-14 (`docs/decisions/2026-06-17-tm-14-no-raw-payload-storage.md`)                                                                          | PRESERVE stores record content                                                                       | §4.3 sanitized bounded projection                                                                                                                                                                                                                     |
| C-8  | S9-DOC buckets i/j, S8-DOC §3.4 `already_present` ("not archived")                                                                           | Import-time archives would fail forever                                                              | §6.2 predicate on `imported_archived_at`                                                                                                                                                                                                              |
| C-9  | L0-DOC r5 (f4459fe2): `LearnedProposalV1.steps[].destination.kind` still model-proposed; `FamilyLabel` names "FAM-0 preserved-family labels" | Destination is derived per record; one catalogue                                                     | L0 removes `destination.kind` next round; FAM-C1 ignores and refuses a disagreeing `kind` until then (D-FAM-1); `FamilyLabel` = the D-FAM-1 catalogue (R590-B3-C5). Billing is now a moving family (D-FAM-5); L0 P2 is answered the same way          |
| C-10 | `Person` D2 comment (schema L6943-6950: "Email … deliberately NOT stored"), `families.ts` L105 ("Email/billing are never mapped or written") | Preserving `client_profile`, `forms`, `billing_history` would store contact and billing data as Json | **Reversal disclosed** (R590-B-B8) and **decided**: billing and payment history move (OQ-1 answered 2026-09-29, D-FAM-5); contact PII dropped by default (§4.3 transform 1) pending OQ-8. Card/bank data and email as identity are still never stored |
| C-11 | S8-DOC D-S8-4 writers read the staged payload; S8-C `native-rules.ts` L435; S9 `facts.service.ts` L830-845                                   | r3 proposed one canonical input for both destinations                                                | **Withdrawn in r4** (executive direction): writers and S9 keep reading the staged payload; the preserved record differs only by transforms native rules never consume (§4.3, §4.6)                                                                    |
| C-12 | North Star "credentials never stored"                                                                                                        | An unlisted-key or plain-word secret inside coaching data is indistinguishable from coaching data    | Guarantee stated in bounded form (§4.3); owner acknowledgement OQ-12                                                                                                                                                                                  |
| C-13 | L0-DOC `GapCode` closed, append-only                                                                                                         | FAM-R1 needs `residual_unknown` (family + count)                                                     | L0 r6 appends it (D-FAM-1 amendment list)                                                                                                                                                                                                             |

## 9. Open questions for the owner (each with a safe interim default)

| OQ    | Question                                                                                                                                                                                                                                                                                                                                                                              | Interim default                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| OQ-1  | **Answered 2026-09-29 (owner, with L0 P2):** billing and payment history **move** — preserved, coach-visible, read-only; recurring schedules extracted per D-FAM-5.                                                                                                                                                                                                                   | Applied (D-FAM-5); no gap, no exclusion                                                                       |
| OQ-2  | After a client joins, may they see preserved **records** about them? (Media reads stay coach-only in V1, §5.3)                                                                                                                                                                                                                                                                        | Coach-only; coach-private families never client-visible                                                       |
| OQ-3  | Media caps of §5.2 (video 500 MB, 20 GB per run, 100 GB per coach). **P4 answered 2026-09-29:** storage spend approved on the existing S3-compatible backend; caps remain tunable defaults.                                                                                                                                                                                           | Caps apply as defaults                                                                                        |
| OQ-4  | May the extension fetch media from a separate media host proven by observation? If no, most photo-bearing runs keep media not moved                                                                                                                                                                                                                                                   | Confined set only                                                                                             |
| P6    | **Answered 2026-09-29 (owner):** partner/third-party service data reachable through the coach's own session **moves and is used**; exclude-and-disclose deleted (D-FAM-1). Bounds: no credentials, no partner login, session reach only.                                                                                                                                              | Applied                                                                                                       |
| OQ-6  | Should imported profile fields fill the joined client's profile on link?                                                                                                                                                                                                                                                                                                              | No; preserved, coach-visible                                                                                  |
| OQ-7  | May an unnameable reachable coaching collection land as `unclassified`?                                                                                                                                                                                                                                                                                                               | Yes                                                                                                           |
| OQ-8  | Contact PII (email, phone, address, DOB) in `client_profile`, `forms`, `form_responses`: preserve coach-only, or never store?                                                                                                                                                                                                                                                         | **Not stored** (`contact_pii`, counted and shown as "contact details hidden") until answered                  |
| OQ-9  | Which malware scanner backs `MediaScanProvider`?                                                                                                                                                                                                                                                                                                                                      | None configured ⇒ no media becomes `ready` (fail closed)                                                      |
| OQ-10 | **Altered content.** Imported records may differ from the source only by: rules-file redaction (credential keys, credential value shapes, context-gated payment instruments), removed credential-named URL parameters, dropped contact PII (OQ-8), media replaced by refs, and later `rules_version` re-screens of already-imported rows (audited, disclosed per record). Acceptable? | Yes, disclosed per record                                                                                     |
| OQ-11 | **Joined client's imported history in live surfaces.** May imported workouts/weights/check-ins enter leaderboards, community, streaks, digests, coach analytics after link?                                                                                                                                                                                                           | **Excluded** everywhere except the record's own screens and the two allow-listed AI context modules (D-FAM-4) |
| OQ-12 | **Bounded credential guarantee.** Accept that "credentials never stored" is provable for credential-class keys and shapes only, with the residual of §4.3 stated (unlisted key names; plain-word secrets inside coaching data)?                                                                                                                                                       | The bounded guarantee stands as written; the list is versioned and grows on evidence; no relaxation           |

Notes (not questions): **N-1** graduated native rows follow live per-client AI behaviour after
link (existing behaviour; disclosed on the result). **N-2** a per-family redaction count in
`families[]` is proposed to L0 as an owner question; FAM-0 adds no fields. **N-3** future and
non-terminal source sessions are preserved, so they are absent from the TGP calendar and open-slot
computation (`scheduling-open-slots.service.ts` L90-97) would offer those times. **N-4** (was
OQ-5) a coach's deletion of an imported record is the coach's own action: counted as moved, shown
as "removed by you" in history (§6.2).

## 10. Invariant cross-check

| Invariant                                      | How this record holds it                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New source → core diff = 0                     | Catalogue is TGP-side; no source names; scanner and storage are provider interfaces                                                                                                                           |
| AI returns data only, never decides completion | Model proposes family + field mapping; `kind` ignored/refused; `destinationFor` is pure; closure is null (RESET §1)                                                                                           |
| Deterministic identity, writes, reconciliation | D-S8-3 key everywhere; one `nativeWrite`; existing writers unchanged in what they read; ledger retarget; collision winner rule                                                                                |
| Credentials never stored/learned/logged/sent   | One versioned rules file (keys, shapes, context-gated instruments) at ingest for every family, acceptance corpus with zero must-keep false positives, `rules_version` + re-screen job; bounded residual OQ-12 |
| Customer data never in cross-coach memory      | §4.7 boundary; V1 per-coach memory; dedup per coach                                                                                                                                                           |
| Unknown ≠ 0; no false `complete`               | D-L0-6.3 projection by reference; `complete` unreachable until the closure record; residual check for version ≥ 1; archived predicate                                                                         |
| RLS never weakened                             | Service-role-only tables with REVOKE; expansions add `person_id IS NULL` guards only; §5.3 parent-existence ownership on every read                                                                           |
| Erasure                                        | FAM-E1a before FAM-P2, FAM-E1b before FAM-M1; person-keyed media selection; blob lock on admission; tombstone + grace sweep                                                                                   |
| No loss during rollout                         | No purge before FAM-G1; `residual_required` default + version-0 backfill; guard before engine                                                                                                                 |
| Replay/cancel/timeout/process-loss safe        | Create-only, unique keys, one transaction per identity tree, copy-then-commit with orphan sweep, retryable erasure job                                                                                        |

## 11. Closure map — r8 (R590-A6, R590-B6), r7, earlier

r8: A6-A1 → §4.3 re-screen covers provenance-linked native free-text columns (writer registry names them); A6-B1 → §4.3 pre-P1 rows `rules_version 0` + quarantine until re-screened, §4.1 wording; A6-B2 → D-FAM-5 trialing/no-period-evidence ⇒ no due date; B6-B1 → §4.3 rules file vendored with pinned hash, corpus in both CIs, batch `rules_version` + backend minimum, today's extension redactor defect recorded, slice X-RED1; B6-B2 → `residual_unknown` in L0 amendments, §8 C-13, §6.3 sentence fixed, per family with count; B6-B3 → partner rule (c) JSON only, media per OQ-4; B6-B4 → per-category `origin_rejected` counts in the run report, origin-category corpus cases; B6-B5 → FOR UPDATE in the job, graduation re-applies rules and checks version under the lock; C1-C3 → corpus seeded (incl. `card.last4`/`card.brand`, coaching `card`/`bank`, ext must-keep keys); C4 → native columns in the job; C5 → audit paths/counts only, RLS, erasure/export; C6 → OQ-10; C7 → (a)/(b) clarified; C8 → graph acyclic with X-RED1 → P1.

r7: A4-01 → §4.3 legacy-rows paragraph (no fabrication, gap `residual_unknown`) + rules re-applied on every preserve write; A4-02/B5-B2/B5-B3/A5-B1 → §4.3 category 3 (context-gated, at ingest for all families, FAM-P1); A5-B3/B5-B1 → category 2 (RFC 6750 b64token, case-insensitive scheme, JWT after prefix, Basic decode test); A5-B4/B5-B6 → category 1 members + must-drop corpus; B5-B4/A5-C1 → `rules_version` + re-screen job as obligation of the version-raising slice; A5-B2/B5-B5 → D-FAM-1 partner-origin rule (structural, MAIN-world replay by name, excluded categories in the rules file, not captured); A4-B1/B5-C1/C2/C3/C5 → D-FAM-5 (non-active ⇒ no due date, `stale`, `source_time_zone`, capture `observed_at`, display in P3, module name); B4-C4 → header, §11; B5-C4 → §4.6; A5-C2 → §7 L0 r6.

Earlier maps (r2-r6: R590-A/B through R590-A4/B4, and the r5 owner decisions) are in the PR #590 body.
