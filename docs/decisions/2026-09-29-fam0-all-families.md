# FAM-0: every reachable family lands in TGP (native map + preserve destination) — contract

- **Status:** T4 design record, **r11, condensed contract**; doc only, claims nothing has run; not
  merged. **Owner:** Bradley Gleave. **Date:** 2026-09-29. **Prior text:** r10 at `61c7c97f` in git
  history; r11 replaces it and carries nothing by reference.
- **Binds** the rules, invariants and tests of the FAM-\* slices (§7); mechanism (locks, batching,
  registry discovery, storage calls) is each slice's own design, verified at its own T4.
- **Split with L0** (`2026-09-27-learn-and-remember.md` r9): FAM-0 owns the catalogue, destinations,
  PRESERVE, redaction, erasure, the media contract and reconciliation inputs; L0 owns the run,
  origins and credentials (D-L0-6.2) and the run-status projection (D-L0-6.3), cited, never restated.
  Extends the S8, S8D, S9 and EX1 decision records in `docs/decisions/`.

## 1. Owner decisions recorded (binding)

- **D4 no unsupported families:** everything reachable moves into TGP, native or preserved; both
  count as "in TGP" once viewable. `complete` stays unreachable until CL (L0 §7).
- **D10 / OQ-1 billing:** billing and payment history move — preserved, coach-visible, read-only,
  with a per-client recurring schedule (D-FAM-5); no live charge moves. **D12 / P4:** media storage
  spend approved on the existing S3-compatible backend; no new vendor; caps are defaults (OQ-3).
- **D14 / B2 (P6):** partner data reachable through the coach's own logged-in page **moves** within
  L0 D-L0-6.2, every outside origin named (D-L0-6.3). Executive reading: "requests the page itself
  made" covers the page's own learned templates with other ids and pages; nothing else is synthesized.

## 2. Catalogue and destinations

### D-FAM-1 The closed catalogue; destination is derived, never proposed

- Adding a family is a deliberate core change with no source names; child families
  (`<family>.<child>`) are provenance and preserve namespaces only. The model proposes a `family`
  label and a field mapping, **never a destination**.
- `destinationFor(family, gateState, typedResult) → 'native' | 'preserve'` (pure, per record):
  `native` iff the writer registry lists a native writer **and** the typed interpretation is `ok`.
- **Non-records:** a record set's items carry distinct `idField` values other than the bearer's own
  account id; a singleton (settings, UI config, flags) is not staged, not a `not_moved` row, no gap.

| Family                | Owner | Native model when the gate is open             | Gate                      | Not native when (⇒ preserved)                  |
| --------------------- | ----- | ---------------------------------------------- | ------------------------- | ---------------------------------------------- |
| `clients`             | C     | `Person` (always, incl. former clients)        | exists (S8-D1)            | —                                              |
| `client_profile`      | P     | none yet                                       | profile design (OQ-6)     | always                                         |
| `programs`            | C     | `WorkoutProgram`                               | exists (S8-C)             | typed result not ok                            |
| `workouts`            | C     | `WorkoutPlan`; `workouts.exercise` child       | exists (S8-C)             | EX1-withheld plan                              |
| `exercises`           | C     | `CoachExercise` (EX1 D-EX1-2)                  | EX1-A, EX1-B              | EX1 withheld                                   |
| `workout_assignments` | P     | `ClientWorkoutAssignment`, inactive            | #587 + S8-E1d + S8D OQ-12 | until OQ-12 answered                           |
| `workout_logs`        | P     | `WorkoutSession`; `.set` → `ExerciseSet`       | #587 + S8-E1a             | unmapped muscle group (child only)             |
| `client_history`      | P     | none (legacy generic token)                    | new specs name a family   | always                                         |
| `messages`            | P     | `CoachMessage` (authorship D-FAM-4)            | FAM-N1                    | group thread; author neither bearer nor Person |
| `food_logs`           | P     | `LoggedFoodEntry` + tenant food row            | FAM-N2a + FAM-N2b         | macros missing or enum unmapped                |
| `water_logs`          | P     | `WaterLog` (exact unit conversion)             | FAM-N2b                   | non-integral ml                                |
| `nutrition_targets`   | P     | `MacroTarget` (`effective_from := occurredAt`) | FAM-N2c                   | non-integral                                   |
| `meal_plans`          | C / P | `MealPlan` (no person ⇒ coach template)        | FAM-N2c                   | —                                              |
| `checkins`            | P     | `CheckIn` (`soreness` required)                | #587 + S8-E1b             | `soreness` absent; collision loser             |
| `body_weights`        | P     | `WeightLog`                                    | #587 + S8-E1b             | —                                              |
| `body_measurements`   | P     | none                                           | a native design           | always                                         |
| `habits`              | P     | `Habit`; `habits.log` → `HabitLog`             | #587 + S8-E1c             | log whose habit is unresolved                  |
| `coaching_sessions`   | C / P | `CoachingSession`, terminal statuses only      | FAM-N6                    | future or non-terminal (never `scheduled`)     |
| `notes`, `goals`      | P     | none                                           | a native design           | always                                         |
| `forms`               | C     | none                                           | a native design           | always                                         |
| `form_responses`      | P     | none                                           | a native design           | always                                         |
| `media`               | C / P | preserved media on its parent                  | FAM-M1 (§4)               | not moved until FAM-M1                         |
| `billing_history`     | P     | none; read-only (D-FAM-5)                      | FAM-P2                    | always                                         |
| `billing_schedule`    | P     | none; structured schedule (D-FAM-5)            | FAM-P2 + FAM-B1           | always                                         |
| `unclassified`        | C / P | none (collection the mapping cannot name)      | — (OQ-7)                  | always                                         |

- **Partner-origin rule (FAM-0 owns it; structural, no value test).** A foreign origin is in scope
  iff the authorized page itself issued a GET/HEAD to it this run, it is in the run's contacted set
  (credentialed or not) and the response is JSON; admission, `https` and origin identity (scheme +
  host + port) are L0 D-L0-6.2. **Excluded categories** (analytics, feature flags, ads, error
  reporting, identity-provider token endpoints, payment-card entry) are recognized by structural
  signatures in the rules file, classified before buffering and **not captured**: no record, no
  `not_moved`, no gap; counted per category as L0 `excluded_origins[]`. Naming, the 8-origin cap and
  `outside_origin_refused` are L0's. An unmapped reachable collection is gap `collection_unmapped`;
  an owner-confirmed exclusion is `not_moved: excluded_by_policy`; never both. None is excluded today.

### D-FAM-2 Per-family contract

- **Identity** `(coach_id, source_namespace, entity_type = family, source_id)`; `source_id` from the
  declared id path, never a name or model output. **Exactly one destination holds a key:** a
  resolved provenance row (`created|already_present`, `native_id` set) and a `preserved` row never
  coexist (I-1). An `unresolved` provenance row is a writer note, not a destination.
- **Spec roles** per step: `idField`, `personSourceId` (P families), `occurredAt`/`occurredOn` with
  zone basis, `title`, `authorSourceId`/`authorRole` (`messages`), media roles. No value-class list.
- **Person edge:** `personSourceId` resolves only through `clients` provenance, never by name or
  email. Unresolved ⇒ preserved with `person_source_id` as a soft edge (exactly one of `person_id`,
  `person_source_id`). A `Deleted` Person is a tombstone read directly from `Person`, never through
  provenance: nothing resolving to it is written (`not_moved: excluded_by_policy`).
- **Former and archived:** `clients` is always native (`Person.source_archived_at` ⇒ "Former
  clients"); other archived records move native with `archived_at := source value` where the model
  has it, else preserved with `source_archived`; provenance keeps `imported_archived_at`.
- **Time and side effects:** instants to UTC; dates need the zone basis; audit columns keep defaults
  except `CoachMessage.created_at`. Writers use transaction row writes only — no send, emitter, push,
  scheduling or notification path. **Create-only:** replay verifies, never updates. **Collision
  winner** on a native unique key: earliest `occurredAt`, then smallest `source_id`; losers preserved.
- **Person expansion (FI-1)** for `CoachMessage`, `LoggedFoodEntry`, `WaterLog`, `MacroTarget`,
  `MealPlan`, `CoachingSession`: nullable `person_id`; `person_id IS NULL` guard on every non-owner
  RLS branch; **exactly-one** owner CHECK where the client column is NOT NULL today, **at-most-one**
  where both-NULL rows are valid (templates, group sessions, set-null messages); tenant FK
  `(person_id, coach_id) → Person` plus `CHECK (person_id IS NULL OR coach_id IS NOT NULL)` where
  `coach_id` is nullable; writer-asserted tenancy where the table has no `coach_id`; NOT VALID +
  VALIDATE with populated-fixture survival and RLS negatives. Until then the family is preserved.

- **Residual fields:** preserved paths native rules do not consume stay in a `graduated` row under
  the same identity (native pointer + residual), computed by every native write from FAM-G1 on.

### D-FAM-3 Gates

A native P-family writer runs only when its table has the FI-1 shape and S8-D1's `person` handoff
resolves the edge; the writer registry is the gate state and a flip to `native` ships with its writer.
Each FI-1 table joins the S8D §2.7 re-own transaction in its FAM-N slice; preserved rows never flip
owner. RLS never widens: person-owned native rows and PRESERVE are service-role only.

### D-FAM-4 Event time, authorship, imported history

- `CoachMessage.created_at := occurredAt` (imported only). Native iff `authorSourceId` is the
  bearer's own source account (`sender_id`) or the thread Person (`sender_person_id`); else preserved.
- **Imported history = provenance:** each import-written table gains indexed `imported_at`, set iff
  provenance is written; no read, review or notification state is invented. Every consumer excludes
  it except the record's own screens, the two disclosed per-client AI-context modules and owner
  opt-ins (OQ-11). **CI check** per W slice from the Prisma DMMF (delegate reads, relation filters,
  raw SQL naming the table) fails on any hit outside its allow-list; post-link tests show zero badge,
  queue entry, push, digest, brief, leaderboard/streak, active-count, metric or reminder.

### D-FAM-5 Billing history and the recurring schedule

- `billing_history` (invoices, payments, refunds, statuses, amounts, currency) is preserved per
  client; payment instruments are removed at ingest (redaction category 3); last-4 and brand stay.
- `billing_schedule` (FAM-B1): roles `amount`, `currency` (ISO 4217), `interval`, `intervalCount`
  (default 1), `sourceStatus` (`active|paused|cancelled|past_due|trialing|unknown`, raw kept),
  `anchorAt`, `nextDueAt` (only when shown), optional `pausedAt`/`cancelledAt`. Stored: derivation
  inputs only (`amount_minor` exact by ISO exponent or no schedule; `source_time_zone`;
  `observed_at`). **No computed date is stored.** `BillingScheduleReadPort.listForCoach` computes
  `next_due` at read time, first match wins (month-end clamps to the last day in the source zone):

| #   | `source_status`        | observed date | period | `next_due`                                                 |
| --- | ---------------------- | ------------- | ------ | ---------------------------------------------------------- |
| 1   | `active`, `trialing`   | future or now | any    | `observed` (`trialing` labelled "trial ends/first charge") |
| 2   | `active`, `trialing`   | past          | any    | `stale` (reference, never actionable)                      |
| 3   | `active`               | absent        | yes    | `estimated`: first period end after now                    |
| 4   | `active`, `trialing`   | absent        | no/any | `none`                                                     |
| 5   | `paused`, `past_due`   | any           | any    | `none`; an observed date shows as "was due"                |
| 6   | `cancelled`, `unknown` | any           | any    | `none`                                                     |

- The port is the only cross-module billing surface (one consumer: BILL-1). **No live charge moves;**
  TGP never stores card or bank data; **no imported date triggers a charge, reminder escalation or
  dunning** without fresh coach or client confirmation; the display says so on every row.

## 3. PRESERVE — the universal destination (FAM-P1, FAM-P2)

- **`ImportPreservedRecord`** (additive, refusing down): `coach_id`; `person_id` (tenant FK) xor
  `person_source_id` for P families; `import_intent_id`; `source_namespace`, `family` (closed CHECK),
  `source_id` (unique identity key); parent keys; `occurred_at|on`; `title` ≤ 200; `source_archived`;
  `fields` (canonical JSON), `fields_sha256`, `byte_size` ≤ `SCOUT_PRESERVE_MAX_BYTES`; `dropped`
  (codes → counts); `projection_version`, `rules_version`, `device_rules_version`; `state`
  `preserved|graduated` with `native_kind/native_id` set iff graduated.
- `preserved` is the only destination; `graduated` (native pointer + residual) is never counted as
  preserved. Provenance gains `residual_required` ⇔ `residual_id`, the three version columns (0 =
  pre-FAM, no residual claim) and `imported_archived_at`.
- **Staged rows** gain `person_source_id`, `person_key_basis` `declared` (stamped at ingest) |
  `backfilled` (once at FAM-P1 deploy via `forRun` incl. file registries, legacy evidence or the
  `clients` row) | `none` (step has no person role) | `unknown` (unprovable), `erased_at` and the
  version columns. Fixture: after backfill every P-family row is `declared`/`backfilled`.
- **Ledger** gains `preserved_record` and each new native kind; **no third destination:** from
  FAM-P2 no run writes evidence rows; FAM-P2 converts legacy evidence rows once per coach.
- **RLS:** the `Person`/provenance posture (FORCE, service-role only, RESTRICTIVE deny, REVOKE ALL);
  reads filter `coach_id` and re-assert parent ownership; a miss is an opaque 404.
- **`preserveRecord(payload, spec, family)`** (pure, versioned) re-applies the current rules, then:
  contact PII → `{"$dropped":"contact_pii"}` (OQ-8; native rules may never consume it); media-role
  values → `{"$media": id}` once FAM-M1 holds bytes, else `{"$media_pending": n}`; bounds (depth ≤ 8,
  ≤ 500 keys, string ≤ 16 KiB, ≤ 64 KiB default / 256 KiB hard) else `not_moved: over_limit`, never
  truncated; canonical sorted form. Legacy rows without payload become exactly `{ "label": … }`.
- **Display:** coach-only "From your previous platform" per client, "Imported library", residuals
  under their native record; `PRESERVE_VIEWABLE` (FAM-P3) gates counting; client visibility OQ-2.
- **Boundary:** only preserve, reconciliation, account deletion and data export touch the preserve
  and media delegates (billing imports only the read port); AI, Roman, insights, brief, notifications,
  community and `src/scout/learn/**` never import preserve. Preserved values are never digest input.

### Redaction (FAM-P1 owns; X-RED1 mirrors)

- **Invariant:** no credential and no payment instrument is durably stored anywhere — staged
  payload, preserved or native row, derivative, log. Redaction runs at ingest before the first
  durable write for every family, with the same rules on the device and the backend.
- **Categories** (closed; the rules file lists members): (1) credential keys — whole-key match after
  normalization, any depth, incl. URL query names; no word logic (`session_id`, `auth_user_id`,
  `token_count` stay); (2) unmistakable credential value shapes (JWT, auth scheme + token, `Basic`
  decoding to `user:pass`, PEM); no entropy test (`Basic Strength Program` stays); (3) payment
  instruments, **context-gated, never bare digits**: instrument-named keys, instrument leaves under
  an instrument parent, or separator-grouped Luhn values (`bank.items[].number`, ids, timestamps stay).
- **One file** `shared/redaction-rules.json` (`rules_version`, the lists, `excluded_origin_categories`)
  owned by FAM-P1, vendored by X-RED1 with a pinned hash; X-RED1 retires the device's word-logic
  redactor. The **acceptance corpus** (must-drop, must-keep) gates both repos with **zero** must-keep
  false positives; owner sign-off changes entries, never the budget.
- **Versions:** batches carry `device_rules_version` (unstamped = 0); the backend screens every batch
  with its own file and stamps `rules_version`. Once `SCOUT_MIN_RULES_VERSION` (starts 0) is raised,
  a lower batch is refused and the run settles `failed/extension_update_required` (L0 D-L0-6.3).
  Device-0 rows are disclosed as possibly altered by the pre-v1 device redactor, make no residual
  claim (gap `residual_unknown`); a destination inherits the minimum device version it consumed.
- **Quarantine and re-screen:** pre-P1 staged rows are `rules_version = 0`, read by no writer or S9
  until re-screened (`destination_gate_closed`, never dropped). **RS-1:** after re-screen for _v_ no
  copy rules _v_ would drop exists in staged, preserved, graduated, native or **derivative** rows
  written by any code; the registry is by data flow with a CI check failing on an unregistered
  write; rewrites are audited (`ImportRedactionAudit`, paths and counts only) and are the only
  permitted mutation of create-only rows. **OQ-12 residual:** secrets under keys that name nothing
  are not provable. **No staged purge before FAM-G1** (terminal, settled, version ≥ 1, retention).

### Erasure, retention, export (FAM-L1, FAM-E1a, FAM-E1b)

- **E-1 no surviving copy:** after erasure of Person P no staged, preserved, graduated, native or
  derivative copy of any value of P exists; only the tombstone (value columns NULL) and payload-less
  skeletons remain. Staged rows of P's `clients` key, P's person key **or `unknown` basis** become
  skeletons (`payload = {}`, `erased_at`); **no payload-content test**.
- **E-2** ingest (both paths) and erasure are serialized for the same Person: a batch commits before
  erasure (and is cleared) or observes the tombstone and writes only a skeleton.
- **E-3** no row proven to another Person or to none is deleted or cleared; the only over-erasure is
  the `unknown` basis, never silent. **E-4** erasure completes for arbitrarily large histories (no
  per-identity lock under the exclusive coach lock). **L-1** lock order: per-coach lock (shared by
  ingest, reconstruct, graduation, conversion, re-screen, backfill, purge; exclusive for erasure and
  coach deletion), then the identity lock.
- **E-5 counts stay truthful (counting rule).** Each identity is counted **once**. An identity whose
  destination is P's, or that has no destination, counts `not_moved: excluded_by_policy` (histogram
  `erased`, or `erased_unproven_owner` for an `unknown`-basis skeleton). An `unknown`-basis skeleton
  whose identity already landed in a destination proven to another Person or to no person **keeps
  that destination and its `moved_native`/`preserved` count**; it is never also `excluded_by_policy`.
  `source_count = moved_native + preserved + not_moved` holds after erasure; no value of P shows.
- **CD-1** coach account deletion leaves no import row in any model with an FK to `Person` or
  `ImportIntent` or a `coach_id`/`person_id` column (a DMMF test, never a name list), except rows a
  linked client owns since link. Export: coach per Person; client per OQ-13.
- **Sequencing:** FAM-P2 writes only after FAM-E1a is tested; FAM-M1 writes no blob before FAM-E1b.

### One native write path (FAM-P2 guard, FAM-G1 engine)

Every native write (S8-D1, S8-C incl. EX1-withheld, every W slice, on-demand graduation) goes
through `nativeWrite(identity, input)`, one transaction per identity tree, under L-1: resolved
provenance ⇒ verify only; a preserved row ⇒ its `fields` is the input and its columns give the
person edge; not-ok or gate closed ⇒ stays preserved and any `unresolved` provenance of the identity
is deleted; ok ⇒ native rows + provenance (`imported_at`, `imported_archived_at`, version), residual
as a `graduated` row (FAM-G1), ledger retargeted for every intent. **Guard before engine:** FAM-P2
ships the lookup and "stays preserved" branch into every existing writer, so I-1 holds from FAM-P2.

## 4. Media — deferred whole to FAM-M1

FAM-M1 is its own T4 record and owns every media test (ex-L0 T-17); this record fixes only the
invariants it must prove, no mechanism. Until it lands, media-role values are `$media_pending` and
media is `not_moved: destination_gate_closed`.

- **Fetch:** GET only, no body, from the tab or `https` origins the page loaded media from, within
  L0's 8-origin cap, the verbatim URL the page used, no vocabulary hit, under L0's credential
  invariants; every failure a counted `not_moved` outcome. Other media hosts: OQ-4.
- **Storage and reads:** clean-scan gate (no scanner ⇒ nothing ready, OQ-9); immutable per-coach
  deduplicated blobs in a private bucket on the existing S3-compatible storage (caps OQ-3);
  coach-only reads re-verifying blob, row and parent ownership; person keys kept through graduation.
- **Serialization invariants:** admission serialized with erasure (no reference to a released blob);
  tombstone first, then sweep; orphaned copies swept; a shared blob survives another's erasure.

## 5. Reconciliation inputs (FAM-R1)

- Preserved counts once viewable (before: `destination_gate_closed`); the arbiter alone settles.
- **S9 amendments** (`report_version = 2`): bucket **j-p** `preserved_present_verified` is matched
  first (graduated ⇒ `ledger_stale`, absent ⇒ `preserved_missing`, both `write_failed`); bucket j's
  residual check applies only at `projection_version ≥ 1` and `device_rules_version ≥ 1` on the
  destination row, else no residual claim and gap `residual_unknown`; coach-archived iff
  `archived_at` differs from `imported_archived_at`; **bucket i** (written, then removed after
  import by anyone) counts `moved_native` with neutral copy "removed after import"; children neither
  native nor preserved count `unresolved_children`.
- **Projection** is L0 D-L0-6.3. FAM-R1 fills family counts from a **live read-only recompute** for
  every intent; verdict fields stay historical, shown "at settle"; stored reports are never rewritten.
- **FAM facts → `NotMovedReason`** (extends L0's placement table; changes no L0 row):

| FAM fact                                                                                    | `NotMovedReason`          |
| ------------------------------------------------------------------------------------------- | ------------------------- |
| owner-confirmed exclusion; erased identity (`erased`, `erased_unproven_owner`, per E-5)     | `excluded_by_policy`      |
| child whose parent is neither native nor preserved                                          | `unresolved_parent`       |
| legacy evidence row not converted; quarantined staged row; preserved before viewable; media | `destination_gate_closed` |
| preserve over bound                                                                         | `over_limit`              |
| `residual_missing`; `preserved_missing`; `ledger_stale`                                     | `write_failed`            |

## 6. Invariants and acceptance tests

| Id   | Invariant                           | Owner tests (real PostgreSQL where stated)                                                                   |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| I-1  | one destination per key             | S8-D1, S8-C (withheld/bound), each W; two-writer race on one absent key ⇒ one destination (P2/G1)            |
| I-2  | destination derived, never proposed | FAM-C1 validator refuses a proposal carrying a destination; `destinationFor` fixtures                        |
| I-3  | no credential or instrument stored  | corpus zero must-keep FP (P1, X-RED1); mixed-version cells {min 0,1}×{unstamped, 0, 1}; RS-1 derivative test |
| I-4  | no loss in rollout                  | byte-identical S8-C rows and S9 facts before/after P2; version-0 backfill; no purge before G1                |
| E-1  | no surviving copy                   | `clients`, declared, backfilled and `unknown` rows (numeric leaf, embedded path); before settle and blocked  |
| E-2  | ingest ⟂ erasure                    | two connections, ingest paused between tombstone check and insert; legacy path; backfill race                |
| E-3  | no over-erasure of proven rows      | another Person's row containing P's short id survives; `none` row survives                                   |
| E-4  | large histories erase               | more identities than the lock budget, first attempt                                                          |
| E-5  | truthful counts after erasure       | arithmetic holds; **`unknown` skeleton landed under another Person keeps its count; counted once**           |
| CD-1 | coach deletion complete             | path equals DMMF scan; one linked + one unlinked Person                                                      |
| L-1  | lock order                          | lock-order test (FAM-L1)                                                                                     |
| R-1  | reconciliation truthful             | j-p present/graduated/absent; archived predicate; bucket i neutral; conversion → graduation → erasure        |
| B-1  | billing never charges               | one read-port fixture per next-due row; exact minor units or no schedule                                     |
| H-1  | imported history silent             | DMMF CI check per W slice; post-link zero-signal tests                                                       |

## 7. Slices and dependency graph

| #   | Id         | Repo      | Tier  | Scope                                                                                    | Deps                      |
| --- | ---------- | --------- | ----- | ---------------------------------------------------------------------------------------- | ------------------------- |
| 1   | FAM-C1     | backend   | T4    | Catalogue, spec roles, `destinationFor`, validators, ledger kinds, provenance columns    | L2a, L0 r9                |
| 2   | FAM-P1     | backend   | T4    | PRESERVE schema/RLS, staged person key + backfill, rules file + corpus, quarantine, RS-1 | #587, FAM-C1              |
| 2x  | X-RED1     | extension | T4    | Vendored rules + corpus, `device_rules_version`, retire device redactor                  | FAM-P1, X3                |
| 2l  | FAM-L1     | backend   | T4    | Per-coach lock (L-1) in reconstruct and both ingest paths                                | —                         |
| 3   | FAM-E1a    | backend   | T4    | Erasure E-1..E-5, CD-1, erasure job, export                                              | FAM-P1, FAM-L1            |
| 4   | FAM-P2     | backend   | T4    | `preserveRecord`, preserve writer, legacy conversion, guard retrofit, boundary spec      | FAM-P1, FAM-E1a, S8-D1    |
| 4b  | FAM-B1     | backend   | T4    | Billing roles and `BillingScheduleReadPort`                                              | FAM-P2                    |
| 5   | FAM-P3     | backend   | T4    | Coach read route, `PRESERVE_VIEWABLE`                                                    | FAM-P2, S8-D2             |
| 6   | UX-P3      | mobile    | T2    | "From your previous platform", "Imported library", "Former clients"                      | FAM-P3                    |
| 7   | FAM-G1     | backend   | T4    | Graduation engine, residual backfill, ledger retarget, staged purge                      | FAM-P2                    |
| 8   | FAM-R1     | backend   | T4    | S9 v2 buckets, live recompute, `not_moved[]` mapping, E-5 arithmetic                     | FAM-P3, FAM-G1, L2d, L3b  |
| 9   | S8-E1a     | backend   | T4    | (W) workout logs                                                                         | #587, S8-D1, FAM-G1       |
| 10  | S8-E1b     | backend   | T4    | (W) check-ins + body weights                                                             | S8-E1a                    |
| 11  | S8-E1c     | backend   | T4    | (W) habits                                                                               | S8-E1a                    |
| 12  | FAM-E1b    | backend   | T4    | Media erasure (person-keyed selection, tombstone, sweep)                                 | FAM-E1a                   |
| 13  | FAM-M1     | ext+back  | T4    | Media record and slice (§4)                                                              | FAM-G1, FAM-E1b, L0 X3    |
| 14  | FAM-N1     | backend   | T4    | (W) messages: person expansion, authorship, exclusions, voice                            | FAM-G1, FAM-M1, S8-D4b/D5 |
| 15  | FAM-N2a    | backend   | T4    | Tenant-scoped food rows                                                                  | —                         |
| 16  | FAM-N2b    | backend   | T4    | (W) food + water logs                                                                    | FAM-N2a, FAM-G1           |
| 17  | FAM-N2c    | backend   | T4    | (W) nutrition targets + meal plans                                                       | FAM-G1                    |
| 18  | FAM-N6     | backend   | T4    | (W) coaching sessions                                                                    | FAM-G1                    |
| 19  | EX1/S8-E1d | backend   | T4    | Exercises and assignments (W); withheld records preserved                                | EX1-DOC, FAM-G1, OQ-12    |
| 20  | Designs    | backend   | T3→T4 | Native designs for notes, goals, forms, responses, measurements, profile                 | owner decisions           |

**W** slices write only through `nativeWrite`, add `imported_at`, ship the D-FAM-4 check and I-1,
E-1, E-5 coverage. Graph: L2a → FAM-C1 → {FAM-P1, L1}; FAM-P1 + FAM-L1 → FAM-E1a → FAM-P2 → {FAM-B1,
FAM-P3 → UX-P3, FAM-G1}; FAM-G1 → {W slices, FAM-M1}; FAM-E1a → FAM-E1b → FAM-M1 → FAM-N1; FAM-P3 +
FAM-G1 + L2d + L3b → FAM-R1; FAM-P1 + X3 → X-RED1. No W slice for a preserved family before FAM-G1.

## 8. Open questions (safe interim default applies until answered)

**OQ-2** clients see preserved records about them → coach-only. **OQ-3** media caps → defaults.
**OQ-4** media from hosts the page did not load from → no. **OQ-6** profile fills on link → no.
**OQ-7** `unclassified` → yes. **OQ-8** contact PII → not stored ("contact details hidden"). **OQ-9**
scanner → none, no media ready. **OQ-10** altered content limited to redaction, PII drop, media refs
and audited re-screens → yes, disclosed. **OQ-11** imported history in live surfaces → excluded.
**OQ-12** bounded credential guarantee → stands. **OQ-13** client export → OQ-2-visible only. Notes:
graduated rows follow live AI behaviour after link; non-terminal sessions preserved; deletion after
import counts as moved.

## 9. Rejected and deferred

- **Rejected:** model-proposed destinations; a second catalogue; exclude-by-default partner origins;
  billing as a gap; live charges or dunning from imported dates; stored computed due dates;
  bare-digit instrument tests; word-logic redaction; payload-content tests in erasure; a third
  destination; purging before FAM-G1; per-identity locks in erasure; rewriting stored reports;
  `scheduled` sessions as native; media mechanism in this record.
- **Deferred:** CL (release gate as a `complete` condition, every media reference ready, zero
  not-moved, staged > observed arithmetic, preserved-family closure; L0 §7); the FAM-M1 record;
  native designs (slice 20); BILL-1 (reminders and checkout from the schedule, fresh confirmation).
- **Owed by other records** (their next rounds): S8 `source_archived`, `no_native_destination` final,
  `created_at` exception; S8D `Deleted` at erasure with NULL values; S9 buckets i/j/j-p; EX1 withheld
  plans preserved; TM-14 bounded projection; `Person` "email not stored" comment. L0 r9 carries A1-A8.
