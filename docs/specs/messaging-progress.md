# Spec — Messaging + progress visibility

**Roadmap row:** #36.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.

> **Status update (2026-05-10):** Voice notes shipped via migration
> `20260506040000_add_voice_notes_and_coach_onboarding` on top of
> the pre-existing `src/messaging/` text surface. The migration
> adds `voice_url`, `voice_duration_sec`, `voice_size_bytes`,
> `voice_content_type` columns to `CoachMessage` and loosens
> `body` to nullable so voice-only messages can persist. The
> service layer enforces a content-type whitelist of
> `audio/mp4 | m4a | aac | webm | ogg` and clamps size/duration
> from `VOICE_NOTE_MAX_*` env vars (defaults: 5 MB / 300 s).
>
> The spec's three primitives are **NOT** shipped:
>
> - **Progress envelope endpoint** — no
>   `GET /coach/clients/:id/progress` or equivalent. Adherence
>   signals (regimen, check-ins, content boards, challenges,
>   weight log, fasting log) remain scattered.
> - **Deep-link convention** — `CoachMessage` has no
>   `subject_kind` / `subject_id` columns. A coach DM cannot
>   link back to "the missed check-in" today.
> - **`ProgressVisibilityPreference`** — no per-client
>   visibility row. The current model is still binary via
>   `ClientCoachConsent`.
>
> Adjacent shipped infrastructure that this spec's runtime PR
> should reuse rather than re-derive:
>
> - **Notification Center** (`src/notifications/`, migration
>   `20260507000000_add_notification_center`) — digest scheduler
>   plus emitters for `message-received`, `missed-checkin`,
>   `weight-trend-alert`, `coach-alert`, etc. The progress
>   envelope can subscribe to these emitters rather than
>   polling source tables.
>
> Spec stays open for the three remaining primitives.
**Handoff brief:** [`../architecture/handoff/36-messaging-progress.md`](../architecture/handoff/36-messaging-progress.md).
**Cross-references:** merged `messaging` module
([`src/messaging/README.md`](../../src/messaging/README.md)) and
`CoachMessage` (`prisma/schema.prisma:661`); merged `coach`
module ([`src/coach/README.md`](../../src/coach/README.md)); PR
#121 specs
[`outcome-check-ins.md`](./outcome-check-ins.md) (#21),
[`at-risk-detector.md`](./at-risk-detector.md) (#22),
[`weekly-recap.md`](./weekly-recap.md) (#23); this wave's specs
[`regimens.md`](./regimens.md) (#34),
[`regimen-assignment.md`](./regimen-assignment.md) (#35),
[`coach-challenges.md`](./coach-challenges.md) (#30),
[`content-boards.md`](./content-boards.md) (#33).

---

## 1. Status

Partial / extension feature. The merged `messaging` module is a
chat surface; the merged `coach` module is a roster + timeline.
Neither offers a *unified progress envelope* nor a
*deep-link convention* on a message. See
[`../architecture/gap-map-coach-experience.md`](../architecture/gap-map-coach-experience.md)
§"Row #36."

## 2. WHY

A coach loses the moment to act when:

- **The signal is in the data, but the action is in the chat.**
  A check-in is missed; the coach finds out from the at-risk
  detector (#22); the coach DMs the client. Today, those three
  surfaces are disjoint — the DM has no link back to "the
  missed check-in" and the at-risk view has no "send DM"
  button connected to the right context.
- **The client wants to control what the coach sees.** The
  current model is binary (consent given → coach reads
  everything; consent revoked → coach reads nothing). Real
  clients want partial visibility: "see my workouts, not my
  weight log."
- **The progress story is scattered across modules.** Adherence
  to a regimen (#35) is in `WorkoutSession` rows. Check-in
  responses (#21) are in another table. Challenge submissions
  (#30) are a third. A coach cannot get the answer to "how is
  this client doing this week" in one round-trip.

This spec adds two primitives:

1. A **progress envelope** — a single coach-side endpoint that
   collapses adherence signals from regimen, check-ins,
   content boards, challenges, weight log, and fasting log
   into one per-client envelope.
2. A **deep-link convention** on `CoachMessage` — every
   coach-side message can carry a `subject_kind` + `subject_id`
   pointing to a specific row (a workout, a missed check-in, a
   challenge submission, a content item). The mobile / console
   client renders the message inline with the subject.

The spec also adds a **per-client visibility setting**
(`ProgressVisibilityPreference`) that lets the client
fine-grain what the coach sees in the progress envelope, with
sane defaults derived from `ClientCoachConsent`.

## 3. WHEN

Trigger conditions:

1. Specs #21, #22, #23 (PR #121) are reviewed; the
   field-types vocabulary, at-risk score shape, and weekly
   recap envelope are stable.
2. Spec #35 is reviewed; `RegimenAssignment` is the source of
   truth for "what this client should be doing this week."
3. Spec #30 is reviewed; `CoachChallengeParticipation` is the
   source of truth for active challenges.
4. Founder signs off on the visibility default policy
   (default = full visibility on consent, granular opt-out).
5. Backend lead signs off on the deep-link `subject_kind`
   catalog.

## 4. WHERE

- **Module changes (additive):** `src/messaging/` gains a
  `subject_kind` + `subject_id` column on `CoachMessage` and a
  resolver. `src/coach/` gains a `progress.controller.ts`
  exposing the progress envelope endpoint. A new module
  `src/progress/` holds the projection logic.
- **New module:** `src/progress/` —
  `progress.module.ts`,
  `progress.service.ts`,
  `aggregator.service.ts`,
  `visibility.service.ts`.
- **New tables:** `ProgressVisibilityPreference`,
  `ProgressSnapshot` (optional cache; default off — see §10).
- **New columns (additive on existing rows):** `CoachMessage`
  gains `subject_kind` (string, nullable),
  `subject_id` (string, nullable). The two columns are nullable
  so existing rows are unaffected.
- **New routes (paths under `/api/`):**
  - Coach:
    - `GET /coach/clients/:client_id/progress`
    - `GET /coach/clients/:client_id/progress/timeline`
  - Client:
    - `GET /me/progress-visibility`
    - `PATCH /me/progress-visibility`
  - Messaging (extension):
    - existing `POST /messaging/...` accepts new
      `subject_kind` + `subject_id` fields.
    - `GET /messaging/threads/:id/with-subjects` — same
      thread shape, but each message is annotated with its
      resolved subject envelope.
- **Reads:** `CoachMessage`, `RegimenAssignment` (#35),
  `CheckIn` (`prisma/schema.prisma:596`),
  `WorkoutSession` (`prisma/schema.prisma:432`),
  `WeightLog` (`prisma/schema.prisma:500`),
  `FastingWindow` (`prisma/schema.prisma:490`),
  `HabitLog` (`prisma/schema.prisma:541`),
  `CoachChallengeParticipation` (#30),
  `ContentBoardSubscription` / `ContentBoardView` (#33),
  `ClientCoachConsent`.

## 5. WHO

- **Sign-off:** founder for the visibility default and the
  per-client opt-out policy; backend lead for the projection
  contract and the deep-link `subject_kind` catalog; security
  for the consent-vs-visibility split.
- **On the hook:** backend platform.
- **Downstream consumers:** spec #22 (at-risk detector reads
  the same projection or a subset), spec #29 (revenue
  dashboard reads aggregate at-risk count), the OWNER admin
  console, the coach-console BFF.

## 6. WHAT

**Already exists:**

- `CoachMessage` and the messaging module — extended with
  two columns.
- The roster / timeline / alerts surface in the `coach`
  module — extended with the new progress endpoint.
- `ClientCoachConsent` — the existing yes/no consent gate.
- The check-in / at-risk / weekly-recap specs (#21, #22,
  #23) — read by the projection.

**New surface:**

- The progress projection (one envelope per client).
- The visibility preference (granular per-source opt-out).
- The deep-link convention on messages.
- The "with subjects" annotated thread read.

**Non-goals:**

- New chat features (threads-per-topic, reactions, file
  attachments). Out of scope.
- Real-time progress streaming. The envelope is read on
  demand; the realtime ping is unchanged.
- Coach-side annotations on a client's progress (sticky
  notes). Parked.
- Push notifications when adherence drops. Row #07.

## 7. HOW

Smallest first PR: the visibility preference table + the
read-only `GET /me/progress-visibility` (returns the default
shape derived from consent). This unblocks the client UI to
ship the toggle screen before the projection is live.

Rollout phases:

1. **Phase 1 — visibility preference.** Migration +
   `GET/PATCH /me/progress-visibility`.
2. **Phase 2 — projection (read-only).** `progress.service`
   computes the envelope on demand from existing tables;
   `GET /coach/clients/:client_id/progress` returns it.
3. **Phase 3 — projection cache.** Optional
   `ProgressSnapshot` write-through cache (§10), keyed by
   `(client_id, day)`, rebuilt on demand or by a job.
4. **Phase 4 — deep-link columns.** Add
   `subject_kind`/`subject_id` to `CoachMessage`;
   `POST /messaging/...` accepts them; thread reads annotate.
5. **Phase 5 — coach UI integration.** Console + mobile
   render annotated threads.

Feature flag: `PROGRESS_ENABLED` (`off` | `read_only` |
`on`). `read_only` exposes the visibility preference but not
the coach progress endpoint; `on` exposes both.

## 8. Data model sketch

### Visibility preference

```prisma
model ProgressVisibilityPreference {
  id                          String     @id @default(uuid())
  user_id                     String     @unique
  see_workouts                Boolean    @default(true)
  see_meals                   Boolean    @default(true)
  see_check_ins               Boolean    @default(true)
  see_weight_log              Boolean    @default(true)
  see_fasting                 Boolean    @default(true)
  see_habits                  Boolean    @default(true)
  see_challenges              Boolean    @default(true)
  see_content_views           Boolean    @default(true)
  consent_baseline_at         DateTime   @default(now())
  updated_at                  DateTime   @updatedAt

  user                        User       @relation(fields: [user_id], references: [id], onDelete: Cascade)
}
```

The defaults are `true` for every source — the consent gate
already established trust; this table refines downward.
A row is **created lazily** on first `GET /me/progress-visibility`.

### Optional cache snapshot

```prisma
model ProgressSnapshot {
  id                          String     @id @default(uuid())
  client_user_id              String
  computed_at                 DateTime   @default(now())
  envelope                    Json
  source_versions             Json       // { regimen_assignment_id, last_check_in_id, last_workout_session_id, ... }

  client                      User       @relation(fields: [client_user_id], references: [id], onDelete: Cascade)

  @@index([client_user_id, computed_at])
}
```

Snapshots are an **optimization**, not a source of truth. Spec
defaults to no caching in Phase 2; Phase 3 enables snapshots
when the on-demand p95 exceeds 500 ms.

### CoachMessage extension

Two nullable columns:

```prisma
// On existing model CoachMessage
subject_kind   String?    // 'workout_session' | 'check_in' | 'challenge_submission' | 'content_item' | 'regimen_week' | 'weight_log' | 'lesson' | ...
subject_id     String?
```

Catalog (closed enum at the application layer; stored as
string for forward-compat):

| `subject_kind` | Resolves to |
|---|---|
| `workout_session` | `WorkoutSession` row |
| `routine` | `WorkoutRoutine` row |
| `check_in` | check-in response (#21) |
| `weight_log` | `WeightLog` row |
| `fasting_window` | `FastingWindow` row |
| `habit_log` | `HabitLog` row |
| `meal_plan` | `MealPlan` row |
| `lesson` | `Lesson` row |
| `regimen_week` | composite — `(regimen_assignment_id, week_number)` |
| `challenge_submission` | `CoachChallengeSubmission` (#30) |
| `content_item` | `ContentBoardItem` (#33) |
| `at_risk_alert` | derived (#22 score envelope) |

The resolver in `messaging.service.ts` validates that the
message's sender has read access to the subject (a coach
sending a deep-link to a client's workout session must have
the client in their roster).

## 9. API sketch

### Visibility preference

`GET /api/me/progress-visibility`

Returns the preference row (lazy-creates on first call).

`PATCH /api/me/progress-visibility`

Request:
```json
{ "see_weight_log": false }
```

Validation: `consent_baseline_at` is set when consent was
last given; if consent has been revoked since, the endpoint
returns 409.

### Progress envelope

`GET /api/coach/clients/:client_id/progress`

Response:
```json
{
  "client_user_id": "...",
  "computed_at": "...",
  "regimen": {
    "assignment_id": "...",
    "week_number": 4,
    "of_total_weeks": 12,
    "regimen_title": "12-week ramp",
    "state": "active"
  },
  "this_week": {
    "workouts_completed_of_planned": [3, 4],
    "meals_logged": 18,
    "weight_log_entries": 2,
    "check_in_completed": true,
    "habits_streak": {"hydration": 6, "sleep": 4}
  },
  "challenges": [
    {"challenge_id": "...", "title": "30-day steps", "rank": 4, "submissions_this_week": 5}
  ],
  "content": {
    "items_unviewed": 2
  },
  "at_risk_score": {
    "score": 0.31,
    "label": "moderate",
    "drivers": ["missed_check_in_2_weeks_ago"]
  },
  "visibility_redactions": ["see_weight_log"]
}
```

The envelope respects the per-client visibility preference: a
field hidden by the client appears in
`visibility_redactions` and is omitted from the body. The
coach UI renders a "client has hidden this" affordance.

`GET /api/coach/clients/:client_id/progress/timeline?from=...&to=...`

Returns a chronological list of progress events
(`{kind, occurred_at, summary, subject_id}`) suitable for the
coach timeline UI.

### Annotated thread

`GET /api/messaging/threads/:id/with-subjects`

Returns the same thread shape as the existing endpoint, with
every message annotated with `subject_envelope` resolved
inline (one DB read per unique subject; cached per request).

## 10. Rollout / feature flags

- **Env vars:**
  - `PROGRESS_ENABLED` (`off` | `read_only` | `on`).
  - `PROGRESS_CACHE` (`off` | `read_through` | `write_through`).
    Default `off`.
- **Tier gate.** Free for L1 (every coach reads progress for
  their existing roster cap); deep-link annotations and the
  timeline require L2 or L3 (#37) to keep parity with #22's
  proposed L2 gate.
- **Fan-out order.** Backend (preference + projection) →
  console (read) → mobile client (visibility toggles) →
  mobile coach (annotated thread render).

## 11. RBAC and privacy

- **Coach reads** are gated by an active
  `ClientCoachConsent` *and* the per-source visibility flags.
  A request that would return zero visible sources returns
  `403 PROGRESS_REDACTED` with the list of redactions.
- **Client reads** of `GET /me/progress-visibility` are
  always allowed (no consent required to manage your own
  preference).
- **Deep-link authz.** The resolver validates that the
  message's sender (or recipient, on read) has read access to
  the subject row. A coach cannot link to a client's workout
  if they are not the client's coach.
- **GDPR.**
  - Client delete: cascade on `ProgressVisibilityPreference`;
    cascade on `ProgressSnapshot`; `subject_id` references on
    `CoachMessage` are *not* nulled (the message body is the
    record), but the subject resolver returns
    `{kind, id, scrubbed: true}` for resolution attempts.
  - Coach delete: cascade on the consent rows handles
    visibility; the snapshot rows for that coach's clients are
    irrelevant.
- **Consent revocation.** Revoking consent immediately stops
  the projection from returning a body; the visibility
  preference row remains (the user may re-grant consent).

## 12. Tests

- **Unit:**
  - Visibility filter: each preference flag, each source.
  - Deep-link authz: every legal subject_kind, every illegal
    cross-coach attempt rejected.
  - Projection assembler: each source's read returns the
    expected shape.
- **Integration:**
  - End-to-end on a real Postgres: assign regimen → log a
    workout → check-in → progress envelope reflects all three.
  - Visibility patch: hide weight_log → projection redacts.
  - Annotated thread: send a message with subject_kind →
    thread read returns the resolved subject.
  - Consent revocation mid-day → projection 403.
- **Smoke:**
  - `GET /me/progress-visibility` returns 200.
- **Manual eval:** founder runs the coach UI flow against
  one real client.

## 13. Risks

- **Projection latency.** A real coach has 50+ clients;
  reading the envelope per client per page render is too
  slow. Mitigation: phase 3 cache; the on-demand path stays
  within a 500 ms p95 budget per client; a roster-level
  endpoint computes a *summary* envelope (regimen state, score,
  unread count) without the full body.
- **Visibility drift.** Default is `true`; a future schema
  add (a new source) defaults to "see_<source>=true" but a
  *user* with their preference saved before the new source
  exists has no row for it. Mitigation: column defaults are
  authoritative (Postgres, not application).
- **Deep-link broken-link rot.** A subject row deleted
  before the message is read. Mitigation: resolver returns
  `{kind, id, scrubbed: true, summary_at_send_time: "..."}`
  — the message body is the source of truth; the resolver
  is best-effort.
- **CoachMessage column add.** Two new nullable columns on a
  hot table. Mitigation: migration is `ADD COLUMN ... NULL`,
  no default backfill; Postgres's column metadata-only
  add is fast on Postgres 11+.

## 14. Dependencies

- **Roadmap rows.** #21, #22, #23, #28, #30, #33, #34, #35,
  #37.
- **Existing modules.** `src/messaging/`, `src/coach/`,
  `src/audit/`.
- **External services.** None.
- **Decisions that must close.**
  - Cache-on by default in production (default off).
  - Deep-link `subject_kind` enum vs string (string for
    forward-compat).

## 15. Acceptance criteria

1. Migrations: `ProgressVisibilityPreference`,
   `ProgressSnapshot` (optional), and the two columns on
   `CoachMessage` add idempotently.
2. Visibility preference round-trip works end-to-end.
3. Progress envelope returns every documented field for a
   real test client.
4. Visibility filter tests pass; redacted sources are listed.
5. Deep-link authz rejects every cross-coach attempt.
6. Annotated thread read returns resolved envelopes for at
   least 5 of the 12 catalog kinds.
7. Cascade behaviors verified.
8. Handoff brief updated.

## 16. Operator handoff

- **Runbook entry**: flag flips, how to disable a single
  visibility flag globally during incident, how to invalidate
  cached snapshots.
- **Dashboard tiles:**
  - "Progress endpoint p50/p95."
  - "Visibility redactions per source" (helps detect a UI bug
    flipping flags off en masse).
  - "Deep-link 410 rate" (broken-link rot).
- **Alerts:**
  - p95 progress endpoint > 1 s sustained 15 minutes.
  - Visibility-flag flip rate > expected baseline (anomaly
    detect on the client UI).
- **Kill switches:**
  - `PROGRESS_ENABLED=off` — disables progress + visibility
    endpoints.
  - `PROGRESS_CACHE=off` — forces on-demand projection.
