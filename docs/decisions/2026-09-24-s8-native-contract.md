# S8-0: source-to-native contract for deterministic native writers

- **Status:** local candidate contract (T3). Not merged, deployed, consumer-frozen or
  product-accepted. It binds the S8-A, S8-B, S8-C, S8-F build slices; it changes no code,
  schema or API.
- **Date:** 2026-09-24
- **Decision owner:** Bradley Gleave (repo owner). D-S8-2 end state is reserved to the owner;
  the interim below is the executing parent's disposition.
- **Base:** backend `integration/importer` `c7a5fe8dd0b82fb2c81847d875e0e03912faff26`. Unless
  stated otherwise, every `path Lx` citation is at this base.
- **Other sources:** N/Q1 draft `61b93cff` ("NQ"); extension `land/s4-r6` `aa0abd83` ("X");
  the canonical plan
  [CONTINUATION_AND_ROMAN_IMPORT_PLAN.md at 1ebbed7](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/1ebbed7/handoffs/op81/CONTINUATION_AND_ROMAN_IMPORT_PLAN.md)
  ("PLAN").

## 1. Why this exists

PLAN L298 requires a published source-to-native contract before any family is called
complete: fields, required relationships, units and time zones, conflicts and provenance.
PLAN L313 adds that migrating history is not a new live business action. Today no import
path writes a native TGP feature table:

- `clients` upserts the scout-only, non-login `Person` and writes only `display_name`
  (`src/scout/reconstruct/families.ts` L60-88; `prisma/schema.prisma` L6920-6934).
- `workouts` and `client_history` upsert the generic `ScoutReconstructedEntity`
  `{client_source_id, label}` (`families.ts` L97-130; `schema.prisma` L6981-6993).
- The coach roster reads `User`, not `Person` (`src/coach/coach.service.ts` L133-147).

PLAN L298 keeps the generic reconstructed entities as evidence/transition structures, not
permanent substitutes for native features. This document fixes what "native" means per
family and what must be reported when it cannot be reached.

## 2. Decisions

### D-S8-1: mapping authority is data, interpreted by one generic core

- Per-source TypeScript mappers are retired in favour of one pure, total interpreter over
  a data-only `SourceMapping` spec (S8-A). Today they live in core:
  `src/scout/mappers/truecoach-{clients,entity}.mapper.ts` and `conformance-alpha.mapper.ts`,
  with a hard-coded registry array (`src/scout/reconstruct/source-mapper-registry.ts` L64-66).
- Source field meaning is currently code, for example TrueCoach `name`
  (`truecoach-clients.mapper.ts` L57), `client_id`/`clientId` and `title`/`name`
  (`truecoach-entity.mapper.ts` L70, L83).
- A spec declares, per source step: the canonical TGP family; field roles as JSON paths
  (id, soft links, label and the typed fields in §4); explicit typed coercions; explicit
  enum maps; declared units; declared date/zone basis; and declared defaults, if any.
- The interpreter never guesses. A role it cannot resolve from data yields an unresolved
  code (§3.7), never a silent default or a fuzzy match.
- Existing skip reasons stay byte-identical: `unsupported_platform:<token>` and
  `missing_source_id` (`families.ts` L50-53; `truecoach-clients.mapper.ts` L35-41).
- For S8, specs are repository-resident JSON. In S10 they come from induced, intent-bound
  blueprint data validated by the same interpreter. A new source is then a data change only:
  NEW SOURCE → CORE DIFF = 0.
- The locked envelope `{sourceId, sourcePlatform, capturedAt, payload}` is unchanged
  (X `extractors/_interface.js` L32-39; backend `src/scout/scout-ingest.dto.ts` L55-56).
- The closed canonical-family allow-list (`src/scout/scout-reconstruct.dto.ts` L11-18) is
  TGP-side, not a source leak. Adding a canonical TGP family (for example `programs`) is a
  core change by design; adding a source is not.
- **One source step per canonical family, unless the id space is declared shared.** A spec
  may map at most one source step to a given canonical family. Two or more steps may map to
  the same family only if the spec explicitly declares that those steps share one source id
  space. Otherwise the interpreter rejects the whole spec (fail closed) before any row is
  mapped. Reason: the D-S8-3 key drops the source step label, so two steps with overlapping
  ids (for example `workouts` and `workout_templates`, both numeric) would otherwise merge a
  different record into `already_present`. S8-A proves this in
  `test/scout/reconstruct/mapping-spec-validation.spec.ts`: a spec with two steps mapped to
  one family and no shared-id-space declaration is rejected; the same spec with the
  declaration is accepted.

### D-S8-2: client principal for client-owned native data

**Interim (adopted by the parent, option b):** S8 writes only coach-owned families natively.
Client-owned history is reported truthfully as `unresolved:no_native_client_principal`: never
silently absent and never `complete`.

- Fact: every client-owned native table has a required foreign key to `User`:
  `ClientWorkoutAssignment.client_id` (`schema.prisma` L2327-2328), and `user_id` on
  `WorkoutSession` (L864-865), `WeightLog` (L932-933), `Habit` (L1038-1039) and `CheckIn`
  (L1104-1105).
- D2 forbids minting an auth `User` for an imported person (`schema.prisma` L6904-6911), and
  `User.email` is `@unique` (L158). `Person` has no relation to `User` (L6920-6934).
- Excluded routes: a non-login `User` (violates D2 and needs fabricated email), and an
  import-held parallel timeline (PLAN L313: "do not ... create a parallel domain store").
- **Reserved to Bradley, option (a):** add a nullable `person_id` beside the `User` foreign
  key on each client-owned table, family by family, and make the coach roster show imported
  `Person` rows as "imported, not yet joined". This changes the native client model and roster
  semantics.
- S8-D (roster bridge) and S8-E (client-owned writers) stay blocked on this decision. Nothing
  else is blocked by it.

### D-S8-3: native identity key

- Native provenance is keyed on `(coach_id, source_namespace, entity_type, source_id)`,
  where `entity_type` is the canonical TGP family. This is safe only because D-S8-1 allows
  at most one source id space per canonical family.
- Until G3 source principal/workspace attribution lands, `source_namespace` equals
  `source_platform`. After G3 it becomes platform plus workspace/account identity (PLAN
  L309). It is an opaque string, never parsed by writers.
- Current keys lack workspace scope (`Person` `schema.prisma` L6932; generic L6992), so two
  source accounts on one platform can merge. **Recorded limitation:** until G3, one source
  workspace per (coach, platform). S8-B reserves the column now.
- Email is never an identity or linking key (`schema.prisma` L6907-6911; PLAN L309).

### D-S8-4: import context (no live side effects, create-only, non-destructive)

- Native writers use persistence primitives inside the reconstruct transaction: Prisma `tx`
  row writes only. They do not call public live-action service methods (§3.6).
- S8 native writes are **create-only**. A native row that already carries import provenance
  is never updated by a later pass, so coach edits are preserved by construction.
- Conflicts become non-destructive `unresolved` outcomes (PLAN L311-313).
- The generic `update: {client_source_id, label}` overwrite semantics (`families.ts` L124)
  are **not** carried onto native tables.

## 3. Rules common to every family

### 3.1 Input

- Input is one settled intent's staged `ScoutIngestEntity` rows: `coach_id`, `intent_id`,
  `entity_type`, `source_id`, `source_platform`, `captured_at`, `payload`
  (`schema.prisma` L6882-6898).
- Writers read only these rows and native rows owned by the same `coach_id`. They read no
  raw source capture and store no raw payload in native tables (see
  `docs/decisions/2026-06-17-tm-14-no-raw-payload-storage.md`).
- The staged `entity_type` is the source's label. Ingest accepts any string of 1-128
  characters (`scout-ingest.dto.ts` L141-142). The S8-A spec maps it to a canonical family.
  An unmapped label yields `unresolved_family:<token>` (§3.7). The live TrueCoach blueprint
  already emits such a label, `notes` (X `extractors/truecoach/blueprint.js` L40-47).

### 3.2 Outcomes and counts

Each source identity ends a pass in exactly one outcome:

| Outcome            | Meaning                                                                                                                                       | PLAN L248 count            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `created`          | This pass created the native row(s) and their provenance.                                                                                     | `created_native`           |
| `already_present`  | Provenance exists and the native row exists, is owned by the coach and is not archived. Its persisted child provenance is re-reported (§3.4). | `already_present_verified` |
| `unresolved`       | A valid source record has no truthful native result yet; the reason is a §3.7 code.                                                           | `unresolved`               |
| rejected (skipped) | The source row is unusable (`unsupported_platform:<token>`, `missing_source_id`).                                                             | `rejected`                 |
| `failed`           | Transient or poison-row error; retried on replay.                                                                                             | reported as failed         |

- The existing ledger vocabulary `reconstructed|skipped|failed`
  (`scout-reconstruct.dto.ts` L109-114) is unchanged. `created` and `already_present` are
  recorded as ledger `reconstructed` with a typed target (S8-B `target_kind`). `unresolved`
  and rejected are ledger `skipped` with the reason string. The existing invariant
  `staged = reconstructed + skipped + failed` holds.
- Only rows whose target is a **native kind** count toward `created_native` or
  `already_present_verified`. A generic `ScoutReconstructedEntity` row is evidence
  (`target_kind` `scout_entity`). It never counts as native. A client-owned row written only
  as evidence is counted `unresolved:no_native_client_principal` in native counts.
- Child counts (for example exercises) come from child provenance rows, not the ledger;
  children are never ledger rows. "Tally = ledger" applies to top-level rows only.
- A family is `complete` only when every staged identity is `created` or
  `already_present` **and** no child provenance row under any of its parents is
  `unresolved`. Any `unresolved` or `failed` row, top-level or child, makes the family at
  most `partial`.
  An unmapped family makes the run at most `partial` (PLAN L307). The terminal verdict itself
  belongs to the S7-L single arbiter, not to writers.

### 3.3 Provenance

- S8-B `ImportNativeProvenance` fields: `coach_id`, `import_intent_id` (nullable until S7-L
  L4 binds Scout runs to server intents), `source_namespace`, `entity_type`, `source_id`,
  `native_kind`, `native_id`, `outcome`, `reason`.
- One provenance record is written per native row written (top-level or nested child),
  with `native_id` set and outcome `created`.
- One provenance record is also written per **unresolved nested child**, with
  `native_id = null`, outcome `unresolved` and the §3.7 reason. It is written in the
  parent's transaction. `native_id` is therefore nullable, and it is null exactly when the
  outcome is `unresolved`. Top-level unresolved and rejected rows are recorded in the ledger
  (`skipped` + reason), not in provenance.
- It is unique on the D-S8-3 key. It is written in the **same transaction** as the native
  row, so a native row never exists without provenance, and provenance never points at a
  row that was not committed.
- Nested child identity (for example an exercise inside a workout) uses
  `entity_type = <family>.<child>` (for example `workouts.exercise`). Its `source_id` is an
  injective encoding: `<n>:<parent source_id>#id:<child source id>` when the source gives a
  child id, else `<n>:<parent source_id>#ord:<ordinal>`. Here `<n>` is the decimal character
  length of the parent source id, and `<ordinal>` is the decimal 0-based source position.
  The length prefix makes the parent boundary unambiguous even if the parent id contains `#`
  or `:`. The distinct `#id:` / `#ord:` markers keep a child whose id is `3` apart from an
  id-less child at position 3.
- The minimum `native_kind` / `target_kind` set required by this contract is: `person`,
  `scout_entity`, `workout_program`, `workout_plan`, `workout_plan_exercise` (child only,
  not a ledger target). S8-B owns the final closed CHECK list.
- Source timestamps are **not** written into native audit columns (`created_at`,
  `updated_at` keep their database defaults). Otherwise imported rows would reorder "recent"
  native views. The capture instant stays on the staged row (`captured_at`).

### 3.4 Idempotency and replay

- Per source identity, one transaction does the following: look up provenance by the
  D-S8-3 key, then either verify it (outcome `already_present`) or insert the native row(s)
  and provenance.
- **Children on replay.** An `already_present` parent writes nothing. On every pass it
  re-reads its child provenance and re-reports every persisted `unresolved` child in the
  pass counts. A replay or a new intent therefore can never report the family `complete`
  while an exercise stays unresolved.
- **No late child inserts.** S8 never inserts a later-resolved child into an existing
  imported plan. That would be an update under create-only (D-S8-4), and it could collide
  with an exercise the coach added at that `order`. The child stays `unresolved` for S9, or
  until this contract is explicitly amended.
- A unique-key race on provenance re-reads and converges to `already_present`. This matches
  the engine's retry-once convergence (`families.ts` L25-28).
- Replay creates zero duplicates and zero drift: same staged input, same native rows, same
  outcomes. Deterministic order is family order (§3.8), then `source_id` within a family.
- S8 does not detect source-side value drift on already-imported identities. That needs a
  value fingerprint, which is an S9 reconciliation item. The first imported value stands
  (create-only, D-S8-4).

### 3.5 Conflicts (default: non-destructive `unresolved`)

| Situation                                                                                   | Outcome                                                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Provenance exists and the native row is present and owned by the coach                      | `already_present`; no write; persisted unresolved children are re-reported (§3.4)                |
| Provenance exists but the coach archived or deleted the native row                          | `unresolved:native_target_removed`; do not recreate (coach removal is an edit)                   |
| Provenance points at a row owned by another coach, or of another kind                       | `unresolved:identity_conflict`; no write                                                         |
| A pre-existing native row not created by import has the same name                           | No merge by name or email; create a separate imported row. Names are not identity (PLAN L309)    |
| Parent (program or client) not yet present for a child                                      | `unresolved:relationship_pending:<family>`; converges on replay after the parent family          |
| Parent is itself `unresolved` or absent from the intent                                     | `unresolved:relationship_missing:<family>`; S9 closes relationships                              |
| Same source identity under two workspaces of one platform                                   | Merges (D-S8-3 recorded limitation until G3)                                                     |
| Native uniqueness would reject a source record (for example `CheckIn` one per user per day) | `unresolved:native_uniqueness:<model>`; never overwrite the other record (`schema.prisma` L1129) |

### 3.6 Side-effect suppression

Native writers must not cause assignments, completions, notifications, messages, emails,
drip or progression triggers, webhooks, invitations, payment actions or scheduled workflows
(PLAN L313). Concretely:

- **No live-action calls.** Writers must not call `WorkoutBuilderService.assignPlan`
  (`src/workout-builder/workout-builder.service.ts` L551), `assignProgramToClient` (L1336),
  `cloneProgramToClient` / `cloneProgramToClientResult` (L1125, L1283),
  `completeAssignment` (L746, which fires the drip trigger at L800-830),
  `emitAssignmentPush` (L1535-1550), `NotificationsService` (imported at L52),
  `DripTriggerService` (L50, L101), any AI materialiser, or any messaging, email, invite or
  billing service.
- **Module boundary (S8-C acceptance).** The native writer module (`src/scout/reconstruct/native/**`)
  imports only Prisma types and the provenance helpers. It must not import from
  `notifications/`, `packages/`, `workout-builder/`, `ai/`, messaging, email or billing
  modules. A notifications and drip spy must record zero calls across a full import and a
  replay.
- **No assignment rows.** S8 creates no `ClientWorkoutAssignment` (client-owned; D-S8-2).
  Imported programs and plans are coach templates, never assigned. Genuinely future source
  assignments are client-owned scheduling metadata. They are reported
  `unresolved:no_native_client_principal` until S8-E, and even then are imported inactive
  (PLAN L313).
- **No live flags.** Imported programs keep `is_regime = false`. Regime promotion and
  package attachment are live coach actions (`schema.prisma` L2205-2223).
- **Native invariants, not live paths.** Writers reproduce the row set that the equivalent
  native coach template-create path leaves, and nothing more. The revision rule is fixed:
  - **Program-day `WorkoutPlan`** (`program_id` set): the import follows `copyProgramPlans`
    as used by `forkTemplate` (`workout-builder.service.ts` L913-1009, called at
    L1060-1066). In the same transaction it writes the plan, its resolved exercise rows and
    one `WorkoutPlanRevision`, then sets the plan's `head_revision_id` (L1001-1004).
    - The revision has `revision_index = 0`, `cause = 'initial'`, `author_kind = 'coach'`
      and `author_id` = the importing coach.
    - `exercises_json` is the `serialiseExerciseRows` shape (L1446-1470) over the exercise
      rows actually written. Unresolved children are absent.
    - `plan_meta_json` is `{name, type, duration_estimate_minutes, week_index, day_index}`
      (L989-995).
    - Autosave and undo reject a plan with a null head (409 "Plan has no revision baseline",
      `workout-builder-autosave.service.ts` L494-522). This rule keeps imported program days
      editable and undoable in the builder.
  - **Standalone `WorkoutPlan`** (`program_id` null): the import follows `createPlan`
    (L345-366), with no revision and `head_revision_id` null. Native standalone plans have
    no revision baseline either, so imported standalone plans behave exactly like native
    ones: the legacy exercise editor works (`setExercises`, L460), and autosave/undo is
    unavailable, as it is natively. Giving them a revision would create a baseline that the
    legacy editor never maintains, so a later undo could restore a stale snapshot.
  - **`WorkoutProgram`:** the import follows the fork precedent (`forkTemplate` program
    create, L1046-1060): no `WorkoutProgramRevision`, `head_revision_id` null, `version = 1`.
    Two other program-create paths are **not** precedents. Clone-to-client (L1204, L1252)
    uses `cause = 'clone'` and `is_template = false`. The AI materialiser's program revision
    uses `author_kind = 'ai'` (`create-workout-plan.materialiser.ts` L493-521).
  - No new `author_kind` or `cause` token is introduced (vocabulary at `schema.prisma`
    L2252-2255, L2271-2274). Provenance lives in the provenance table, not in the revision
    vocabulary.
- No database trigger exists on the S8-C target tables at this base (no `CREATE TRIGGER`
  touching them under `prisma/migrations`). S8-C re-checks this at its own base.

### 3.7 Unresolved and rejection codes (closed catalogue)

The reason string is `unresolved:<code>[:<qualifier>]`. There is one exception granted
byte-exact to S8-A: `unresolved_family:<token>`. Rejection reasons stay byte-identical to
today's.

| Reason                                         | Level | When                                                                                                   |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------ |
| `unsupported_platform:<token>` (rejected)      | row   | No mapping spec for `source_platform` (existing, `families.ts` L50-53)                                 |
| `missing_source_id` (rejected)                 | row   | Blank source id (existing, `truecoach-clients.mapper.ts` L38-41)                                       |
| `unresolved_family:<token>`                    | row   | Staged `entity_type` has no canonical-family mapping (for example `notes`)                             |
| `unresolved:no_native_client_principal`        | row   | Client-owned family or record under D-S8-2 interim                                                     |
| `unresolved:no_native_destination:<family>`    | row   | Canonical family with no coach-owned native target (for example exercise definitions, billing history) |
| `unresolved:missing_required_field:<field>`    | row   | A required native column has no source value and no spec-declared default                              |
| `unresolved:invalid_value:<field>`             | row   | The declared coercion fails (non-numeric, out of range, non-finite)                                    |
| `unresolved:enum_unmapped:<field>`             | row   | The source value is absent from the spec's explicit enum map, with no declared default                 |
| `unresolved:unit_unknown:<field>`              | row   | A quantity has no declared source unit                                                                 |
| `unresolved:date_zone_unknown:<field>`         | row   | A calendar-date field derives from an instant with no declared zone basis                              |
| `unresolved:prescription_not_integral:<field>` | child | A range or non-integer where the native column is `Int` (for example "8-12" reps)                      |
| `unresolved:exercise_reference`                | child | No exact, verified native exercise reference (§4.4)                                                    |
| `unresolved:relationship_pending:<family>`     | row   | See §3.5                                                                                               |
| `unresolved:relationship_missing:<family>`     | row   | See §3.5                                                                                               |
| `unresolved:native_target_removed`             | row   | See §3.5                                                                                               |
| `unresolved:identity_conflict`                 | row   | See §3.5                                                                                               |
| `unresolved:native_uniqueness:<model>`         | row   | See §3.5                                                                                               |
| `unresolved:source_archived`                   | row   | The source marks the record archived or deleted; S8 does not import archived content                   |

A spec-declared default is allowed only when it is explicit data. The provenance `reason` on
the `created` record then carries `defaulted:<field>`. An interpreter-implicit default is
never allowed. Codes are stable identifiers, with no personal data in the code or qualifier.
The S9 reason-code catalogue (CQ-17) adopts this list.

### 3.8 Family order and relationships

- Order: `clients` → `programs` → `workouts` (coach templates) → client-owned families
  (blocked, D-S8-2).
- Relationships are resolved only through provenance lookups on the D-S8-3 key, never by
  name, email or label.
- `client_source_id` stays a soft link with no foreign key (`families.ts` L90-95;
  `schema.prisma` L6973-6975). S9 validates closure.
- **Classification rule.** A source workout or program that carries a client link (a
  resolved `client_source_id` role) is client-owned: it is an assignment or history, not a
  coach template. It is reported `unresolved:no_native_client_principal`, never written as a
  template. Only unlinked records are coach-owned templates.

### 3.9 Units, numbers and time

- **Weight.** `WorkoutPlanExercise.weight_lbs` (`schema.prisma` L2308) and
  `WeightLog.weight_lbs` (L935) are pounds. `CheckIn.weight_kg` (L1112) is kilograms.
  - The source unit must be declared by the spec (per field path or per source).
  - Conversion uses the exact factor 1 lb = 0.45359237 kg, stored at full float precision
    with no rounding.
  - An undeclared unit yields `unit_unknown`. The unit is never inferred from magnitude.
- **Durations.** `duration_estimate_minutes` is whole minutes (`schema.prisma` L2147). It
  accepts an integer only; convert from declared seconds only when the result is exact,
  otherwise `invalid_value`. `rest_seconds` is whole seconds (L2309).
- **Prescriptions.** `reps_or_duration_seconds` is dual-purpose: reps, or seconds for
  time-based work (`schema.prisma` L2306-2307). The import follows the same native meaning.
  Time-based items are tagged `prescription:time` in the provenance reason for S9.
  - Ranges, "AMRAP" or other non-integral prescriptions yield
    `prescription_not_integral`. No lower bound or midpoint is invented.
- **Integers.** A numeric string such as `"12"` coerces only through a declared coercion.
  Floats coerce to `Int` columns only when integral.
- **Instants.** Native `DateTime` values are UTC instants. Source instants with an explicit
  offset convert exactly. Source instants without an offset need a spec-declared zone basis.
- **Calendar dates.** `@db.Date` columns (`WorkoutSession.date` L866, `WeightLog.date` L934,
  `CheckIn.date` L1107) are calendar days, used by S8-E only.
  - Use the source's own local date when the source provides one.
  - Otherwise, derive it from an instant only with a declared zone basis (the source
    workspace zone, or the coach zone `CoachProfile.timezone` at L533 only if the spec
    declares it).
  - Never derive it from the server zone. Otherwise `date_zone_unknown`.
- **Ordering.** Program and plan structure uses source ordinals converted to TGP 0-based
  `week_index`, `day_index` and `order` (`schema.prisma` L2160-2161, L2304). The spec
  declares the source base (0 or 1). Ties break by source order, then `source_id`.

## 4. Per-family contracts

### 4.1 `clients` → `Person` (existing; D2 imported identity)

| Native column                 | Source role / rule                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coach_id`                    | Bearer coach (never the body)                                                                                                                         |
| `source_platform` / namespace | Row `source_platform` (D-S8-3)                                                                                                                        |
| `source_person_id`            | Source id. Today it is trimmed (`truecoach-clients.mapper.ts` L38), unlike the ledger. S8-A normalizes once only if persisted output stays byte-equal |
| `display_name`                | `label` role, trimmed, empty → null (`truecoach-clients.mapper.ts` L52-61)                                                                            |
| `state`                       | Default `InvitePending` (`schema.prisma` L6926, L6912-6918); no invitation is sent                                                                    |

- `native_kind` is `person`. There is no login, no `User`, no email column and no
  invitation (`schema.prisma` L6904-6911).
- Profile attributes beyond the display name are client-owned. When mapped, they yield
  `unresolved:no_native_client_principal`.
- **Qualifier:** until S8-D, imported clients are not shown in the `User`-based coach
  client list. The family result must state this as `roster_bridge_pending`. It is not a
  per-row failure, but it must never be presented as "clients are in your roster".

### 4.2 `programs` → `WorkoutProgram` (new canonical family; S8-C; coach-owned)

| Native column                                                         | Rule                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `coach_id`, `owner_user_id`                                           | Both the importing coach (`schema.prisma` L2187-2191)                                                                                       |
| `visibility`                                                          | `owner_only` (schema default, L2194)                                                                                                        |
| `name`                                                                | Required `label` role, trimmed; empty → `missing_required_field:name`                                                                       |
| `description`                                                         | Optional text role                                                                                                                          |
| `weeks`, `days_per_week`                                              | Required integers ≥ 1, from the program payload directly or by a spec-declared count of its nested structure; else `missing_required_field` |
| `is_template`                                                         | `true` (master template; L2201-2203)                                                                                                        |
| `forked_from_id`, `cloned_from_id`, `goal_tag`, `regime_display_name` | `null` (goal tag only if spec-declared)                                                                                                     |
| `is_regime`                                                           | `false`                                                                                                                                     |
| `version`, `head_revision_id`                                         | `1`, `null`; no program revision (fork precedent, §3.6)                                                                                     |
| `archived_at`                                                         | `null`; archived source programs → `unresolved:source_archived`                                                                             |

### 4.3 `workouts` (unlinked coach templates) → `WorkoutPlan` (S8-C)

| Native column                                        | Rule                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `coach_id`                                           | Importing coach                                                                                                                     |
| `name`                                               | Required `label` role                                                                                                               |
| `type`                                               | Enum `strength \| cardio \| mobility` (`schema.prisma` L2135-2139), through the spec's explicit enum map; else `enum_unmapped:type` |
| `duration_estimate_minutes`                          | Optional integer minutes (§3.9)                                                                                                     |
| `program_id`                                         | Parent program via provenance (`programs`, parent source id); no parent role → `null` standalone plan (L2156-2161)                  |
| `week_index`, `day_index`                            | 0-based when there is a parent program; `null` when standalone                                                                      |
| `is_template`                                        | Mirrors the parent program (`true`) when there is one (L2162); standalone keeps the `createPlan` default (`false`)                  |
| `version`, `cloned_from_plan_id`, `head_revision_id` | `1`, `null`. Program day: the revision-0 id written in the same transaction. Standalone: `null` (§3.6)                              |

- Client-linked workouts are client-owned (§3.8) and yield
  `unresolved:no_native_client_principal`. Their generic evidence row may continue.
- Changing `workouts` persist from the generic table to native is S8-C's contract change.
  It must stay coordinated with S8-F readers so that native targets do not vanish from
  review.

### 4.4 Workout exercises → `WorkoutPlanExercise` (nested child of 4.3; S8-C)

| Native column                | Rule                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workout_plan_id`            | Parent plan written in the same transaction                                                                                                                                                                          |
| `exercise_external_id`       | Required, not null; "ExerciseDB catalog identifier — NOT a FK" (`schema.prisma` L2302). Written only for an exact, verified reference; otherwise the child is **not written** and is `unresolved:exercise_reference` |
| `order`                      | Source ordinal, 0-based. Gaps left by unresolved children are kept, so native order matches source order; no later insert fills them (§3.4). Unique per plan among non-archived rows (partial index, L2315-2317)     |
| `sets`                       | Required integer ≥ 1                                                                                                                                                                                                 |
| `reps_or_duration_seconds`   | §3.9                                                                                                                                                                                                                 |
| `weight_lbs`, `rest_seconds` | Optional; §3.9                                                                                                                                                                                                       |
| `superset_group_id`          | Deterministic token `<parent source_id>:<source group key>` when the source groups exercises; else `null`                                                                                                            |
| `notes`                      | Optional coach-authored text role                                                                                                                                                                                    |

- **Exercise reference policy.** No name similarity or fuzzy matching.
  `ExerciseCatalogItem` is global (`slug @unique`, `schema.prisma` L4332-4336), so it is not
  a coach-owned import target. Coach-defined exercise definitions yield
  `no_native_destination:exercises`.
- **S8-C precondition.** Before writing any resolved reference, S8-C must confirm which
  identifier space the native renderers resolve `exercise_external_id` against. The writer
  paths pass it through unvalidated (`workout-builder.service.ts` L526, L967). Until that is
  confirmed, every exercise reference is `unresolved:exercise_reference`.
- **Unresolved exercise records.** An unresolved exercise has no `WorkoutPlanExercise` row.
  Its record is a child provenance row (§3.3): `entity_type = workouts.exercise`, the
  injective child `source_id`, `native_kind = workout_plan_exercise`, `native_id = null`,
  `outcome = unresolved` and the reason (for example `unresolved:exercise_reference`).
- A plan whose children are partly or wholly unresolved is still `created`, and an
  `already_present` plan re-reports those children on every pass (§3.4). The `workouts`
  family is never `complete` while any child exercise is unresolved. Under the S8-C
  precondition above, that currently means every plan with exercises.

### 4.5 Client-owned families (blocked on D-S8-2; recorded for S8-E)

`client_history` and every client-owned canonical family (sessions and sets, check-ins,
weights, habits, notes, goals, measurements, profile) currently resolve to
`unresolved:no_native_client_principal`. The existing generic evidence write for
`client_history` (`families.ts` L141-142) continues unchanged until S8-E. When unblocked, the
native targets and the constraints S8-E must honour are:

- `WorkoutSession` (`schema.prisma` L862-876): `date` (calendar), `workout_name`,
  `workout_type` (free string), `duration_minutes`, `intensity` (enum
  `light|moderate|hard|max`, L104-109; mapped, not defaulted silently), `notes`.
- `ExerciseSet` (L879-891): `exercise_name`, required `muscle_group` enum (L111-120; mapped
  or unresolved), `sets_completed`, `reps_per_set Int[]`, `weight_per_set Float[]` (declared
  unit), `rpe`, `notes`, `video_url`. Media must have a durable destination or be reported as
  a gap (PLAN L319).
- `CheckIn` (L1102-1133): one per user per day (L1129), required `soreness` 1-5 (L1110),
  `weight_kg` in kilograms.
  - Historical check-ins must not flood the coach dashboard's unreviewed queue
    (`reviewed_by_coach`, L1116-1119).
  - S8-E must record that choice as an explicit contract amendment. It must not invent a
    review.
- `WeightLog` (L930-941, pounds); `Habit` / `HabitLog` (L1036-1058).
- Historical ordering comes from source dates, never from import time.

### 4.6 Excluded or absent families

- Billing and messaging are absent by design; reconstruct returns 400
  (`scout-reconstruct.dto.ts` L4-10).
- Read-only billing history is a later requirement (PLAN L306). Until it has a native
  destination, a staged billing family is
  `unresolved:no_native_destination:<family>`. It never produces a charge or subscription
  side effect.
- The 10,000-row per-pass ceiling (`scout-reconstruct.dto.ts` L98-107) must surface as a
  truthful `partial` or `blocked` (S9), not an opaque error.

## 5. Dependencies and fencing

- **Lifecycle fencing.** S7-L execution-epoch fencing (PLAN L251) is not implemented; ingest
  has no epoch check. Until it lands, native writers run only behind the existing
  post-settle gate. Once it lands, each native commit checks the epoch in its transaction
  (S8-G).
- **Intent binding.** `import_intent_id` stays nullable until S7-L binds Scout runs to
  server-owned intents (PLAN decision 5).
- **Generated contracts.** Contract regeneration for new families, counts and target kinds
  goes through the single generator owner (`scripts/importer-contract.ts`,
  `docs/contracts/importer-openapi.json`), serialized with S7-REV/S7-L.

## 6. Acceptance hooks this contract gives the build slices

- **S8-A:** interpreter output deep-equals every existing mapper fixture, including skip
  reasons.
  - Unmapped labels yield `unresolved_family:<token>`.
  - A spec with two or more steps mapped to one family and no shared-id-space declaration
    is rejected (`test/scout/reconstruct/mapping-spec-validation.spec.ts`, D-S8-1).
  - A third source lands as JSON plus a test, with zero `src/**/*.ts` in that commit.
- **S8-B:** provenance keyed per D-S8-3; the §3.3 minimum `native_kind` / `target_kind`
  set; outcomes `created|already_present|unresolved`; `native_id` nullable (null only for
  `unresolved`); a `source_id` column wide enough for the §3.3 child encoding.
- **S8-C:**
  - §4.2-4.4 column rules.
  - §3.4 replay produces zero duplicates or drift.
  - §3.5 coach edits and deletions are preserved.
  - §3.6 spies record zero calls and the module-boundary check passes.
  - Cross-tenant isolation.
  - Tally equals the ledger; unresolved children are counted.
- **S8-F:** native targets resolve by `target_kind` to owned native IDs. The
  `roster_bridge_pending` qualifier is visible.
- **S8-D / S8-E:** blocked on D-S8-2. §4.1 and §4.5 are their starting contracts.
