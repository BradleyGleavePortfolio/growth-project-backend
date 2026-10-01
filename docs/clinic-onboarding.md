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
{ "version": "consult-v1", "answers": { "P0": { "agreed": true, "copy_version": "consult-consent-v1" } } }
```

Any other request (answers without P0, or answers bundled with the first P0)
is rejected with `409 { code: "consent_missing" }` before anything is
written, so those answers are never stored. A P0 with a copy version that is
not current (`CONSULT_CONSENT_COPY_VERSIONS`, default `consult-consent-v1`)
is also `409 consent_missing`; `P0: null` (withdrawal) is `400
invalid_answers`. Dependency: the combined consent record from backend #601
is not merged yet, so the verified record is the server-stamped P0
acknowledgement on the intake (`disclaimer_version`,
`disclaimer_accepted_at`). When #601 lands, the gate should switch to that
record.

`answers` is a patch keyed by screen id. The mobile app sends the full answer
set at every chapter end; `null` clears a key. Answers that no longer apply
are dropped server-side (`T3_areas`/`T3_note` when `T3` is not yes, `S3b`
when `S3` is not home, `Pn_note` when `Pn` is not yes).

Value shapes (match the mobile save payload, PR mobile #310):

| Key | Value |
|---|---|
| G1 | `fat_loss` \| `muscle_gain` \| `maintenance` \| `performance` |
| G2 | string[] up to 3 of `energy, strength, confidence, family, event, longevity, other`; `G2_other` text <= 140 |
| B1 | `female` \| `male` \| `prefer_not_to_say` |
| B2 | `'YYYY-MM-DD'`, age 16-100 |
| B3 | `{ height_cm: 90-250, weight_lbs: 60-1000, unit?: 'imperial' \| 'metric' }` (`weight_kg` accepted instead of `weight_lbs`) |
| B4 | goal weight in lb (number) or `null` |
| L1 | `sedentary` \| `light` \| `moderate` \| `active` \| `very_active` |
| L2 | `lt_6` \| `6_7` \| `7_8` \| `gt_8` |
| T1 | `beginner` \| `intermediate` \| `advanced` |
| T2 | string[] of `weights, classes, running, sports, yoga_pilates, home, swim_cycle, none` (`none` exclusive) |
| T3 | `yes` \| `no`; when yes `T3_areas` string[] (>= 1) of `lower_back, upper_back_neck, shoulder, elbow_wrist, hip, knee, ankle_foot, other`, optional `T3_note` <= 280 |
| T4 | `20_30` \| `30_45` \| `45_60` \| `60_plus` |
| S1 | `'2'..'5'` (`'2'` = 1-2, `'5'` = 5 or more) |
| S2 | `morning` \| `midday` \| `evening` \| `varies` |
| S3 | `gym` \| `home_some` \| `none` \| `mix` (`home`, `both` accepted) |
| S3b | string[] of `dumbbells, kettlebells, resistance_bands, barbell, pull_up_bar, cardio_machine, other` (required, non-empty, when `S3 = home_some`) |
| N1 | `none` \| `vegetarian` \| `vegan` \| `pescatarian` \| `keto` \| `paleo` \| `other` |
| N2 | string[] (>= 1) of `nothing, dairy, gluten, nuts, shellfish, eggs, soy, pork, halal, kosher, other` (`nothing` exclusive); `N2_other` <= 140 |
| N3 | `'2'..'5'` |
| N4 | `never` \| `some` \| `regular` |
| N5 | string[] up to 3 of `time, cravings, eating_out, late_nights, not_sure, other` |
| P0 | `{ agreed: true, copy_version: string, agreed_at?: ISO }` (server stamps its own accepted time; re-stamped only when `copy_version` changes) |
| P1-P7 | `yes` \| `no`; `Pn_note` <= 280 when yes |
| C1 | `'YYYY-MM-DD'` within the next 14 days |

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

### `GET /api/me/onboarding`

```json
{
  "version": "consult-v1",
  "answers": { },
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
intake row.

`200`:

```json
{
  "macros": { "calories": 1789, "protein_g": 150, "carbs_g": 185, "fat_g": 50, "method": "mifflin_st_jeor", "floor_applied": false },
  "program": { "id": "<client clone id>", "key": "considered-strength", "name": "Considered Strength", "days_per_week": 3, "weeks": 4, "start_date": "YYYY-MM-DD", "why": ["...", "...", "..."] },
  "spaces": [{ "id": "<all-members cohort id>", "name": "All members" }, { "id": "<program cohort id>", "name": "Considered Strength" }],
  "coach": { "id": "<coach id>", "display_name": "..." },
  "macro_display_mode": "simple | full",
  "simple_until": "ISO | null"
}
```

`409 { code, message, missing? }` machine codes:

| code | when |
|---|---|
| `not_attached` | the client has no coach (or the coach account is not a coach) |
| `consultation_incomplete` | required answers missing; `missing: string[]` lists keys (also used when macro inputs are implausible) |
| `consent_missing` | no current-version P0 acknowledgement |
| `clinic_not_configured` | the coach has no seeded program set, or its master/space rows are missing or not the coach's own |
| `completion_in_progress` | another completion for this client is running (retry shortly) |

Effects, in order:

1. Macros from the single calculator; one `MacroTarget` row under the coach.
2. Program: pure rule table (`program-rules.ts`) picks one of the three
   masters; the master is materialised into a client clone owned by the
   coach (frequency variant plans, home-dumbbell overrides, extra-care
   overlay) and assigned with the existing
   `WorkoutBuilderService.assignProgramToClient` under the coach's id. The
   clone+assign runs under `withIdempotency` so a retry never assigns twice;
   a failed assignment archives the orphan clone.
3. Spaces: memberships in the coach's clinic-wide cohort and the program's
   cohort, `joined_at` = completion time (kept on re-join) so the coach can
   split members by signup date.
4. Coach flag: when any P1-P7 is yes, an injury is reported, or the rule
   requires review, an in-app `coach_alert` notification is created (no
   screening details in the body) and `screening_flagged_at` is set.
5. `UserProfile.onboardingCompleted = true`; intake `completed_at` and the
   frozen `completion_result` are written.

Macro display (owner ruling item 8): when `N4 = never`,
`macro_display_mode = 'simple'` (calories and protein only) until
`simple_until` = completion + 7 days, then `'full'`. Carbs and fat are still
computed and stored. The same two fields are on `GET /api/me/macros/current`.

## Coach endpoints

### `GET /api/coach/clients/:clientId/consultation[?revision=N]`

Readers: the head coach who owns the client (`User.coach_id`), a sub-coach
with an open assignment to the client (`SubCoachScopeService`), or the head
coach of the client's coach. Anyone else, including the client, gets `404`.

```json
{
  "version": "consult-v1",
  "revision": 3,
  "revision_cause": "save | complete",
  "submitted_at": "ISO | null",
  "saved_at": "ISO",
  "chapters": [{ "key": "body", "title": "Body basics", "answers": [{ "screen": "B3", "question": "Your height and weight.", "answer_label": "5 ft 6 in (168 cm), 172 lb" }] }],
  "screening": { "any_yes": true, "items": [{ "key": "P2", "question": "...", "answer": "yes", "note": "..." }] },
  "consent": { "version": "consult-consent-v1", "agreed_at": "ISO" }
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

Migration `20270202000000_clinic_onboarding_intake` (additive):

- `ClientOnboardingIntake` (one per client; head pointer + completion state).
  RLS: SELECT client self, current coach (`app.is_current_coach_of`),
  platform owner; INSERT/UPDATE client self; no public DELETE; anon denied.
- `ClientOnboardingIntakeRevision` (append-only). RLS: SELECT as above;
  INSERT client self; no UPDATE/DELETE policy.
- `ClinicProgramSet` (seeded config). RLS: SELECT the owning coach; no public
  writes.

Roman reads intake data only inside the client's own request context, which
the "client self" policy covers.

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
