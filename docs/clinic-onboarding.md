# Clinic consultation onboarding (C05 / C07 backend)

Personal training only. Nothing here is medical advice or a medical
assessment; the readiness screening (P1-P7) only routes a client to the
supported starting plan and flags their coach.

Module: `src/onboarding/`. All routes are under the global `/api` prefix and
require a JWT.

## Client endpoints (`@Roles('student')`)

### `PUT /api/me/onboarding/consultation`

Request:

```json
{ "version": "consult-v1", "answers": { "<screen key>": "<value>", "...": "..." } }
```

**Consent first (privacy ruling 2026-09-30).** The consent box (P0) is the
first question, right after the welcome screen. Until a current-version
consent is on file for the user, the only accepted request is P0 on its own:

```json
{
  "version": "consult-v1",
  "answers": { "P0": { "agreed": true, "copy_version": "consult-consent-v2" } }
}
```

Any other request (answers without P0, or answers bundled with the first P0)
is rejected with `409 { code: "consent_missing" }` before anything is
written, so those answers are never stored. A P0 with a copy version that is
not current (`CONSULT_CONSENT_COPY_VERSIONS`, default `consult-consent-v2`)
is also `409 consent_missing`; `P0: null` (withdrawal) is `400
invalid_answers`.

**D2 consent (operator ruling D2, 2026-10-01).** The
P0 screen shows two boxes. P0 here is **box 1 only** (required): the training
waiver plus collection and use of the client's information by The Growth
Project and their coach for coaching. The server stamps `disclaimer_version`
(the `copy_version` that was shown, default `consult-consent-v2`) and
`disclaimer_accepted_at` on the intake; that stamp is the box-1 record and the
only consent `POST /me/onboarding/complete` requires (`consent_missing` when it
is absent or not current). **Box 2** (optional: Roman and the coach's AI
drafts, processed by Anthropic) is recorded by the AI consent ledger
(`POST /me/ai-consent/roman`, the R2a PR split from #601). It is never part of
P0 (P0 accepts only `agreed`, `copy_version`/`version`, `agreed_at`,
`text_sha256`; any other key is `400 invalid_answers`), never stored on the
intake, and never required by any endpoint in this module. This module has no
dependency on #601 or R2a.

`answers` is a patch keyed by screen id. The mobile app sends the full answer
set at every chapter end; `null` clears a key. Answers that no longer apply
are dropped server-side (`T3_areas`/`T3_note` when `T3` is not yes, `S3b`
when `S3` is not home, `Pn_note` when `Pn` is not yes).

Value shapes (match the mobile save payload, PR mobile #310):

| Key   | Value                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1    | `fat_loss` \| `muscle_gain` \| `maintenance` \| `performance`                                                                                                       |
| G2    | string[] up to 3 of `energy, strength, confidence, family, event, longevity, other`; `G2_other` text <= 140                                                         |
| B1    | `female` \| `male` \| `prefer_not_to_say`                                                                                                                           |
| B2    | `'YYYY-MM-DD'`, age 16-100                                                                                                                                          |
| B3    | `{ height_cm: 90-250, weight_lbs: 60-1000, unit?: 'imperial' \| 'metric' }` (`weight_kg` accepted instead of `weight_lbs`)                                          |
| B4    | goal weight in lb (number) or `null`                                                                                                                                |
| L1    | `sedentary` \| `light` \| `moderate` \| `active` \| `very_active`                                                                                                   |
| L2    | `lt_6` \| `6_7` \| `7_8` \| `gt_8`                                                                                                                                  |
| T1    | `beginner` \| `intermediate` \| `advanced`                                                                                                                          |
| T2    | string[] of `weights, classes, running, sports, yoga_pilates, home, swim_cycle, none` (`none` exclusive)                                                            |
| T3    | `yes` \| `no`; when yes `T3_areas` string[] (>= 1) of `lower_back, upper_back_neck, shoulder, elbow_wrist, hip, knee, ankle_foot, other`, optional `T3_note` <= 280 |
| T4    | `20_30` \| `30_45` \| `45_60` \| `60_plus`                                                                                                                          |
| S1    | `'2'..'5'` (`'2'` = 1-2, `'5'` = 5 or more)                                                                                                                         |
| S2    | `morning` \| `midday` \| `evening` \| `varies`                                                                                                                      |
| S3    | `gym` \| `home_some` \| `none` \| `mix` (`home`, `both` accepted)                                                                                                   |
| S3b   | string[] of `dumbbells, kettlebells, resistance_bands, barbell, pull_up_bar, cardio_machine, other` (required, non-empty, when `S3 = home_some`)                    |
| N1    | `none` \| `vegetarian` \| `vegan` \| `pescatarian` \| `keto` \| `paleo` \| `other`                                                                                  |
| N2    | string[] (>= 1) of `nothing, dairy, gluten, nuts, shellfish, eggs, soy, pork, halal, kosher, other` (`nothing` exclusive); `N2_other` <= 140                        |
| N3    | `'2'..'5'`                                                                                                                                                          |
| N4    | `never` \| `some` \| `regular`                                                                                                                                      |
| N5    | string[] up to 3 of `time, cravings, eating_out, late_nights, not_sure, other`                                                                                      |
| P0    | `{ agreed: true, copy_version: string, agreed_at?: ISO }` (server stamps its own accepted time; re-stamped only when `copy_version` changes)                        |
| P1-P7 | `yes` \| `no`; `Pn_note` <= 280 when yes                                                                                                                            |
| C1    | `'YYYY-MM-DD'` within the next 14 days                                                                                                                              |

Required for completion: G1, B1, B2, B3, L1, T1, T3 (+T3_areas), S1, S3
(+S3b), N1, N2, P0, P1-P7, C1.

Response `200`:

```json
{ "saved_at": "ISO", "completed_chapters": ["goals", "body", "..."], "revision": 3 }
```

Errors: `400 { code: "unsupported_version" }`, `400 { code: "invalid_answers", errors: [{ key, message }] }` (messages never echo values), `409 { code: "consent_missing" }`.

**No answers in logs or analytics.** The onboarding module logs only ids and
error class names, sends no analytics events, and `answers`,
`consultation_answers`, `completion_result` and `screening` are in the
structured-log redaction list (`src/observability/log-redaction.ts`).
Unknown keys (including `__proto__`/`constructor`) are rejected and never
written.

Every save appends an immutable `ClientOnboardingIntakeRevision`
(`cause: "save"`); completion appends one more (`cause: "complete"`). Nothing
is overwritten. Answers are mapped onto the existing `UserProfile` columns
(never the screening answers) and the profile targets are recomputed with the
single calculator (`src/macros/macro-calculator.ts`).

**Concurrency (fix round B607-1).** Each save reads the head revision,
merges the patch onto it and commits with a compare-and-swap on
`current_revision` in one transaction that also appends the immutable
revision and syncs the profile. A save that loses a race re-reads and
re-merges (bounded, `SAVE_MAX_ATTEMPTS = 5`), so concurrent chapter saves
from two devices never lose answers; two simultaneous first saves resolve
through the unique `client_id` the same way (never a 500). After the bounded
retries the response is `409 { code: "save_conflict" }` (retry). While a
completion attempt holds a live claim, saves return
`409 { code: "completion_in_progress" }` (retry shortly) so the answers being
assigned from cannot change underneath it.

### `GET /api/me/onboarding`

```json
{
  "version": "consult-v1",
  "answers": {},
  "completed_chapters": [],
  "missing_required": ["B2"],
  "consent_recorded": true,
  "saved_at": "ISO | null",
  "completed": false,
  "completed_at": "ISO | null",
  "result": null
}
```

`result` is the frozen completion payload once completed.

### `POST /api/me/onboarding/complete`

No body. Idempotent: once completed, every call returns the same stored
payload (with `macro_display_mode` re-evaluated against the current time) and
assigns nothing new. Concurrent calls are serialised with a claim on the
intake row that carries a fencing token and the exact revision being
completed (fix round B607-2). Every effect, including the program clone, its
assignments and their snapshots, is written in ONE fenced transaction (fix
round A607-2-R1) that first locks the coach and client `User` rows `FOR
SHARE` and re-checks that the client is still attached to that live coach
(fix round A607-3), then completes the intake row conditionally on (token,
revision). A worker whose 120 s lease expired, whose answers were edited
meanwhile, or whose client changed coach rolls back without writing anything
(no clone, no assignment, no target, no space, no coach alert, no hook); the
assignment push is sent only after the commit. When the attachment changed,
the completion is re-run once against the current coach (and then answers
`not_attached` or `clinic_not_configured` as usual if that coach is not set
up).

`200`:

```json
{
  "macros": {
    "calories": 1789,
    "protein_g": 150,
    "carbs_g": 185,
    "fat_g": 50,
    "method": "mifflin_st_jeor",
    "floor_applied": false
  },
  "program": {
    "id": "<client clone id>",
    "key": "considered-strength",
    "name": "Considered Strength",
    "days_per_week": 3,
    "weeks": 4,
    "start_date": "YYYY-MM-DD",
    "why": ["...", "...", "..."]
  },
  "spaces": [
    { "id": "<all-members cohort id>", "name": "All members" },
    { "id": "<program cohort id>", "name": "Considered Strength" }
  ],
  "coach": { "id": "<coach id>", "display_name": "..." },
  "macro_display_mode": "simple | full",
  "simple_until": "ISO | null"
}
```

`409 { code, message, missing? }` machine codes:

| code                      | when                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `not_attached`            | the client has no coach (or the coach account is not a coach)                                                      |
| `consultation_incomplete` | required answers missing; `missing: string[]` lists keys (also used when macro inputs are implausible)             |
| `consent_missing`         | no current-version P0 acknowledgement                                                                              |
| `clinic_not_configured`   | the coach has no seeded program set, or its master/space rows are missing or not the coach's own                   |
| `completion_in_progress`  | another completion for this client is running, or the answers changed since this attempt read them (retry shortly) |

Effects, in order:

1. Macros from the single calculator; one `MacroTarget` row under the coach.
2. Program: pure rule table (`program-rules.ts`) picks one of the three
   masters; the master is materialised into a client clone owned by the
   coach (frequency variant plans, home-dumbbell overrides, extra-care
   overlay) and fanned out to the client inside the fenced completion
   transaction (`WorkoutBuilderService.writeProgramAssignmentsInTx`, the same
   row and snapshot writer `assignProgramToClient` uses), under the verified
   coach's id. The selection is always recomputed from the answers being
   completed (fix round A607-2: nothing from an earlier attempt is replayed).
   A failed or fenced-off attempt leaves no clone and no assignment, so a
   safety answer added meanwhile can never complete against an older,
   higher-intensity program; as defence in depth every other not-started
   onboarding clone for the client is unassigned and archived.
3. Spaces: memberships in the coach's clinic-wide cohort and the program's
   cohort, `joined_at` = completion time (kept on re-join) so the coach can
   split members by signup date.
4. Coach flag: when any P1-P7 is yes, an injury is reported, or the rule
   requires review, an in-app `coach_alert` notification is created (no
   screening details in the body) and `screening_flagged_at` is set.
5. `UserProfile.onboardingCompleted = true`; intake `completed_at` and the
   frozen `completion_result` are written.
6. Completion hooks: providers registered under
   `ONBOARDING_COMPLETION_HOOKS` (`src/onboarding/onboarding-completion-hooks.ts`)
   run inside the same fenced transaction with the transaction client and
   `{ client_id, coach_id, completed_at, first_session_date,
preferred_training_time }`. The welcome-message scheduler should insert its
   durable job row here, so it is written exactly once and rolls back with a
   fenced-off attempt.

Macro display (owner ruling item 8): when `N4 = never`,
`macro_display_mode = 'simple'` (calories and protein only) until
`simple_until` = completion + 7 days, then `'full'`. Carbs and fat are still
computed and stored. The same two fields are on `GET /api/me/macros/current`.

## Coach endpoints

### `GET /api/coach/clients/:clientId/consultation[?revision=N]`

Readers (CURRENT tenancy only, evaluated from live rows on every request,
fix round A607-1): the client's current coach (`User.coach_id`); the current
head coach of that coach; or a sub-coach whose current head is the client's
current head AND who holds an open `SubCoachAssignment` for the client issued
by that head. The client must be a live student and the reader and the
client's coach live coach-type users. A transfer, a sub-coach moved to
another team, or a revoked assignment loses access immediately; the
attach-code transfer also closes every open assignment for the client.
Anyone else, including the client, gets `404`. `@Roles` lists every Role
enum value (coach, student, owner, sub_coach) so no signed-in role is
stopped with a `403`; the service decides and every refusal is `404`. The
identical predicate is the SQL helper `app.can_read_client_consultation`
used by the RLS policies.

```json
{
  "version": "consult-v1",
  "revision": 3,
  "revision_cause": "save | complete",
  "submitted_at": "ISO | null",
  "saved_at": "ISO",
  "chapters": [
    {
      "key": "body",
      "title": "Body basics",
      "answers": [
        {
          "screen": "B3",
          "question": "Your height and weight.",
          "answer_label": "5 ft 6 in (168 cm), 172 lb"
        }
      ]
    }
  ],
  "screening": {
    "any_yes": true,
    "items": [{ "key": "P2", "question": "...", "answer": "yes", "note": "..." }]
  },
  "consent": { "version": "consult-consent-v2", "agreed_at": "ISO" }
}
```

Question and option labels come from `consultation-definitions.ts`, generated
from the mobile definitions so the coach sees the client's wording.

### `GET /api/coach/clients/:clientId/consultation/revisions`

`[{ revision, cause, created_at, screening_any_yes }]`, newest first. Same
access rule.

## Engagement read model (for the welcome-message and reminder jobs)

`OnboardingService.getEngagementInputs(clientId)` returns
`{ client_id, coach_id, onboarding_completed_at, first_session_date, preferred_training_time }`
or `null` before completion. The same data is in columns on
`ClientOnboardingIntake` (`completed_at`, `first_session_date` (C1, DATE),
`preferred_training_time` (S2)), indexed on `completed_at`.

## Data model and RLS

Migration `20270212000000_clinic_onboarding_intake` (additive):

- `ClientOnboardingIntake` (one per client; head pointer + completion state).
  RLS: SELECT client self, the consultation coach audience
  (`app.can_read_client_consultation`, same rule as the API), platform
  owner; INSERT/UPDATE client self; no public DELETE; anon denied. Completion
  claim columns: `completion_claim_token` (fencing token),
  `completion_claim_revision`.
- `ClientOnboardingIntakeRevision` (append-only). RLS: SELECT as above;
  INSERT client self; no UPDATE/DELETE policy.
- `ClinicProgramSet` (seeded config). RLS: SELECT the owning coach; no public
  writes.

Roman reads intake data only inside the client's own request context, which
the "client self" policy covers.

Live proof (fix round B607-3): `test/rls/onboarding-intake-rls.spec.ts` runs in
the required `rls-live-tests` CI job against Postgres 15 with this migration
applied verbatim. It runs as the non-bypass `authenticated`/`anon` roles with
the production GUCs and asserts, for every reader x client pair and after each
tenancy change, that `OnboardingService.canCoachRead` equals what RLS lets the
reader SELECT from both tables; plus self-only INSERT, coach read-only, no
re-owning, immutable revisions, no public `ClinicProgramSet` writes and anon
denial. The platform owner is the one documented difference (RLS admits it via
`app.is_owner()`; the coach API does not).

## Seeding the programs

`scripts/seed-clinic-programs.ts` reads `seed/clinic-programs.v1.json`
(draft; `production_seed_authorized: false`). It validates the fixture
(three 4-week programs, slugs in the manifest, selection rules identical to
the code rule table), checks every slug exists in `ExerciseCatalogItem`, and
writes the masters, one community workspace with an "All members" cohort plus
one cohort per program, and the `ClinicProgramSet`. Idempotent per
(coach, fixture_version); a changed fixture under the same version is
refused. Production is refused unless the fixture is owner-approved and
`CLINIC_PROGRAMS_SEED_APPROVED=<fixture_version>:<sha256>` is set.

```bash
CLINIC_OWNER_COACH_EMAIL=owner@example.com npx ts-node scripts/seed-clinic-programs.ts --dry-run
CLINIC_OWNER_COACH_EMAIL=owner@example.com npx ts-node scripts/seed-clinic-programs.ts
```
