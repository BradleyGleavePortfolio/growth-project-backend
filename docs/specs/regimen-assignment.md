# Spec — Per-client regimen assignment

**Roadmap row:** #35.
**Status:** Pre-work — spec only; no runtime, no migration, no
module wiring.

> **Status update (2026-05-10):** Sprint B (PR #188, merged) ships
> two narrow per-client assignment primitives:
>
> - `ClientWorkoutAssignment` — assigns one `WorkoutPlan` to one
>   client for one scheduled date. Source: migration
>   `20260508000000_add_workout_builder`, model in
>   `prisma/schema.prisma`, controller at
>   `src/workout-builder/workout-builder.controller.ts`.
> - `DailyMealPlanAssignment` — assigns one `DailyMealPlan` to
>   one client over a `starts_on` / `ends_on` date range.
>   Source: migration
>   `20260509000000_add_sprint_b_macros_meals_insights`,
>   controller at
>   `src/real-meal-plans/real-meal-plans.controller.ts`.
>
> Both are single-day-granular and silo-specific (workouts only,
> meals only). Neither covers the multi-week, multi-pillar
> regimen-assignment surface this spec describes — a single
> durable row that ties a client to a versioned regimen
> containing workouts, meals, lessons, and challenges. This spec
> stays open. When the runtime PR for #34 (regimens) lands, the
> assignment row described here will sit *above* the two Sprint B
> primitives, not replace them: the regimen assignment fans out
> into per-day workout and meal assignment rows during its
> publish/transaction step.
**Handoff brief:** [`../architecture/handoff/35-regimen-assignment.md`](../architecture/handoff/35-regimen-assignment.md).
**Cross-references:** [`regimens.md`](./regimens.md) (#34 — regimen
recipe); PR #121 spec
[`program-templates.md`](./program-templates.md) (#28 — clone
transaction); PR #117 RFC §12 (transactional publish); merged
`ClientCoachConsent` (`prisma/schema.prisma:918`); merged
`WorkoutRoutine` / `MealPlan` / `Lesson` / `CoachGuideline`.

---

## 1. Status

Net-new feature. The merged schema has `WorkoutRoutine.client_id`
and `MealPlan.client_id` foreign keys, but no durable row that
ties a *client* to a *regimen version* over time. See
[`../architecture/gap-map-coach-experience.md`](../architecture/gap-map-coach-experience.md)
§"Row #35."

## 2. WHY

A regimen (#34) is a recipe; an assignment is the bake. The
assignment row does work the existing schema cannot:

- **Pin a version.** A client's program must not silently jump
  to a new regimen version if the coach edits and re-publishes.
  The assignment row holds `regimen_version_id` and freezes the
  version the client follows.
- **Track a cursor.** "What week is this client on?" is asked
  on every dashboard read. Without an assignment row,
  computing the answer requires joining
  `WorkoutRoutine.created_at` for the client and bucketing by
  week — fragile and slow.
- **Support pause + resume.** A client takes a vacation; the
  cursor pauses; on resume, the regimen continues from where it
  paused. There is no place to record "paused" on the existing
  `WorkoutRoutine` rows.
- **Survive re-assignment.** A coach moves a client from
  regimen A to regimen B. The historic A assignment must not be
  deleted (audit, plateau-detection input, future reporting).

Without this row, the platform cannot answer "what is this
client doing this week" in O(1), cannot honor pause/resume, and
cannot show a coach's history with a client over time.

## 3. WHEN

Trigger conditions:

1. Spec #34 (`regimens.md`) is reviewed and the
   `RegimenVersion` schema is final.
2. Spec #28 (PR #121 — `program-templates.md`) §"Clone
   transaction" is final; this spec reuses the clone path.
3. Founder signs off on the pause-resume cursor behavior
   (default: cursor is real-time elapsed weeks; paused
   intervals subtract from elapsed).
4. Backend lead signs off on the consent gate (assignment
   requires an active `ClientCoachConsent`).

## 4. WHERE

- **New module:** `src/regimen-assignments/` —
  `regimen-assignments.module.ts`,
  `regimen-assignments.controller.ts`,
  `regimen-assignments.service.ts`,
  `clone.service.ts`,
  `cursor.service.ts`.
- **New tables:** `RegimenAssignment`, `RegimenAssignmentEvent`.
- **New routes (paths under `/api/`):**
  - Coach:
    - `GET /coach/clients/:client_id/regimen-assignments`
    - `POST /coach/clients/:client_id/regimen-assignments`
    - `POST /coach/regimen-assignments/:id/pause`
    - `POST /coach/regimen-assignments/:id/resume`
    - `POST /coach/regimen-assignments/:id/end`
    - `POST /coach/regimen-assignments/:id/migrate` (move to
      a different regimen / version)
  - Client:
    - `GET /me/regimen-assignment` (the active one, if any)
    - `GET /me/regimen-assignment/this-week` (resolved week)
- **Reads:** `Regimen` / `RegimenVersion` / `RegimenWeek` /
  `RegimenBlock` (#34); `ProgramTemplate` (#28);
  `ClientCoachConsent`.
- **Writes (during clone):** `WorkoutRoutine`,
  `RoutineExercise`, `MealPlan`, `Lesson`, `CoachGuideline`,
  `ContentBoardSubscription` (#33 — auto-subscribe).

## 5. WHO

- **Sign-off:** founder for the pause/resume policy and the
  re-assignment behavior; backend lead for the clone-transaction
  contract and the cursor algorithm; product for the per-client
  regimen UI.
- **On the hook:** backend platform.
- **Downstream consumers:** spec #36 (progress envelope reads
  `RegimenAssignment` to compute adherence-to-week-N); spec
  #29 (revenue dashboard segments coaches by active
  assignments); the AI Program Builder PR #117 §22 (Outcome
  Graph hooks).

## 6. WHAT

**Already exists:**

- `WorkoutRoutine.client_id` and `MealPlan.client_id` foreign
  keys.
- The `ClientCoachConsent` row.
- The clone-into-workout/meal/lesson transactional shape from
  PR #121 spec #28.

**New surface:**

- The assignment row (one client + one regimen version +
  optional schedule).
- The cursor service (pure function over assignment +
  `now()`).
- The pause/resume/end/migrate state machine.
- The per-week resolve endpoint that returns the
  `WorkoutRoutine` / `MealPlan` / `Lesson` / `Guideline` rows
  the client should be reading this week.
- The auto-subscribe hook that subscribes the client to any
  `ContentBoard` (#33) referenced by a regimen block of kind
  `content_board_ref`.

**Non-goals:**

- Per-client adaptation (RPE-driven progression). Parking-lot
  row #04.
- Group / cohort assignment. Parking-lot row #09.
- Schedule recurrence beyond linear (every-other-week,
  alternating). Parked.
- Assignment-driven push notifications. Out of scope; row
  #07.

## 7. HOW

Smallest first PR: the migration + the read endpoints +
`POST /coach/clients/:client_id/regimen-assignments` doing the
*non-cloning* part (write the row, no client-visible
`WorkoutRoutine`s yet). The clone is added in a follow-up
phase.

Rollout phases:

1. **Phase 1 — schema + read.** Migration, read endpoints, no
   writes.
2. **Phase 2 — assign without clone.** `POST /assignments`
   writes the row but does not yet clone templates into
   client-visible workouts. The client read endpoint
   `GET /me/regimen-assignment/this-week` resolves directly
   from `RegimenBlock` + `ProgramTemplate` (read-only path).
3. **Phase 3 — clone on assignment.** `POST /assignments`
   transactionally clones the first week's
   `WorkoutRoutine` / `MealPlan` / `Lesson` rows so the
   client's existing fitness surfaces continue to work.
4. **Phase 4 — pause / resume / end.** State machine.
5. **Phase 5 — migrate.** Move a client to a new regimen
   version; archive the prior assignment.
6. **Phase 6 — auto-subscribe.** Content-board fan-out on
   assignment (#33 wiring).

Feature flag: `REGIMEN_ASSIGNMENT_ENABLED`
(`off` | `coach_only` | `on`). Default `off`.

## 8. Data model sketch

```prisma
enum RegimenAssignmentState {
  active
  paused
  ended
  migrated_out         // a successor assignment exists
  archived             // hard-archive (manual coach action; hidden but readable)
}

model RegimenAssignment {
  id                          String                       @id @default(uuid())
  coach_user_id               String
  client_user_id              String
  regimen_id                  String
  regimen_version_id          String
  state                       RegimenAssignmentState        @default(active)
  starts_on                   DateTime                      @db.Date    // local-date semantics
  ends_on                     DateTime?                     @db.Date
  paused_at                   DateTime?
  total_paused_seconds        Int                          @default(0)
  predecessor_assignment_id   String?                       // chain: previous version this client was on
  successor_assignment_id     String?                       // chain: next assignment
  consent_snapshot            Json                          // ClientCoachConsent fields at assignment time
  acted_by_member_user_id     String?                       // PR #118 forward-compat
  created_at                  DateTime                      @default(now())
  updated_at                  DateTime                      @updatedAt

  coach                       User                          @relation("RegimenAssignmentCoach", fields: [coach_user_id], references: [id])
  client                      User                          @relation("RegimenAssignmentClient", fields: [client_user_id], references: [id])
  regimen                     Regimen                       @relation(fields: [regimen_id], references: [id])
  version                     RegimenVersion                @relation(fields: [regimen_version_id], references: [id])
  events                      RegimenAssignmentEvent[]

  @@index([client_user_id, state])
  @@index([coach_user_id, state])
  @@unique([client_user_id], where: { state: "active" })   // application-enforced; Postgres partial unique not allowed in Prisma directly — use a trigger or app-layer guard
}

model RegimenAssignmentEvent {
  id                  String     @id @default(uuid())
  assignment_id       String
  actor_user_id       String     // coach (always) or OWNER for moderation
  kind                String     // 'created' | 'paused' | 'resumed' | 'ended' | 'migrated' | 'archived' | 'auto_subscribed'
  detail              Json
  created_at          DateTime   @default(now())

  assignment          RegimenAssignment   @relation(fields: [assignment_id], references: [id], onDelete: Cascade)

  @@index([assignment_id, created_at])
}
```

**Cursor algorithm.**

Given `(starts_on, paused_at, total_paused_seconds, ends_on, now)`:

```
elapsed_seconds = (now - starts_on) - total_paused_seconds
                  - (now - paused_at if state = paused else 0)
elapsed_weeks   = floor(elapsed_seconds / (7 * 86400))
current_week    = min(elapsed_weeks + 1, version.total_weeks)   // 1-indexed
```

Pure function in `cursor.service.ts`; testable; no DB access.

**Active-assignment uniqueness.**

A client can have **at most one** assignment in `state=active`
at any time. Postgres-level enforcement uses a partial unique
index:

```sql
CREATE UNIQUE INDEX one_active_assignment_per_client
  ON "RegimenAssignment" (client_user_id)
  WHERE state = 'active';
```

(Prisma 5 supports partial-index syntax in `@@index` with
filter expression in the `extendedWhereUnique` preview, but
this is a SQL-only step in the migration if not.)

## 9. API sketch

### Assign

`POST /api/coach/clients/:client_id/regimen-assignments`

Request:
```json
{
  "regimen_id": "...",
  "regimen_version_id": "...",
  "starts_on": "2026-06-01"
}
```

Validation:
- The coach has an active subscription
  (`SubscriptionGuard`).
- An active `ClientCoachConsent` exists between
  `(coach_user_id, client_user_id)`.
- `regimen_version_id.state = 'published'`.
- `Regimen.state != 'archived'`.
- The client has no other `state=active` assignment.

Response (201): the assignment + the resolved week-1 envelope
(the same shape `GET /me/regimen-assignment/this-week`
returns).

Side effects (transactional):
- Insert `RegimenAssignment`.
- Insert `RegimenAssignmentEvent` with `kind='created'`.
- Clone week-1 templates into client-visible
  `WorkoutRoutine` / `MealPlan` / `Lesson` / `CoachGuideline`
  rows (transactional; failure rolls back the assignment).
- Auto-subscribe the client to every `ContentBoard`
  referenced by a `regimen_block` of kind
  `content_board_ref` (#33 wiring).
- Write an `AuditLog` row.

### Pause / resume / end / migrate

`POST /api/coach/regimen-assignments/:id/pause`

Effect:
- Transition `state` to `paused`.
- Set `paused_at = now()`.
- Subsequent week-clones are blocked until resume.
- Existing client-visible rows are *not* deleted.

`POST /api/coach/regimen-assignments/:id/resume`

Effect:
- `total_paused_seconds += now() - paused_at`.
- Clear `paused_at`.
- `state = 'active'`.
- Resume week-clones from the new cursor.

`POST /api/coach/regimen-assignments/:id/end`

Effect:
- `state = 'ended'`.
- `ends_on = today()`.
- Future week-clones blocked.
- Existing client-visible rows preserved.

`POST /api/coach/regimen-assignments/:id/migrate`

Request: `{"new_regimen_version_id": "..."}`

Effect (transactional):
- `state = 'migrated_out'` on the existing assignment;
  `successor_assignment_id` set on insert.
- A new `RegimenAssignment` row created with
  `predecessor_assignment_id` pointing back; `state=active`,
  `starts_on = today()`.
- Week-1 of the new version is cloned.
- `AuditLog` row.

### Client read

`GET /api/me/regimen-assignment`

Returns the active assignment envelope or `null`.

`GET /api/me/regimen-assignment/this-week`

Returns the resolved week:
```json
{
  "week_number": 4,
  "regimen_title": "12-week ramp",
  "blocks": [
    {"kind": "workout_template", "workout_routine_id": "..."},
    {"kind": "meal_template", "meal_plan_id": "..."},
    {"kind": "lesson_template", "lesson_ids": ["..."]},
    {"kind": "content_board_ref", "board_id": "..."}
  ]
}
```

The blocks resolve to *already-cloned* client-visible rows
when those rows exist; for a future week (not yet cloned), the
endpoint returns the *template* envelope (read-only preview).

### Coach roster read

`GET /api/coach/clients/:client_id/regimen-assignments`

Returns the chain of assignments for that client (active +
historic), most-recent first.

## 10. Rollout / feature flags

- **Env var:** `REGIMEN_ASSIGNMENT_ENABLED` (`off` |
  `coach_only` | `on`). Default `off`.
- **Tier gate.** Per-tier max active assignments per coach
  (#37): L1 has the same client cap that already exists in
  billing (no regimen feature, but the tier defines whether
  the assignment endpoint returns 402); L2 has the active
  client cap from L2 packaging; L3 uncapped.
- **Fan-out order.** Backend → BFF → mobile read → mobile
  client tab.

## 11. RBAC and privacy

- **Coach side.** Scoped to `coach_user_id = req.user.id`;
  cross-coach reads impossible.
- **Client side.** A client only reads *their own* assignment
  via `GET /me/...`.
- **Consent gate.** The assignment write is rejected if
  there is no active `ClientCoachConsent`. The consent
  snapshot at assign-time is captured into
  `consent_snapshot`; revoking consent later does **not**
  retroactively invalidate the assignment (it goes to `ended`
  state on the next coach action).
- **GDPR.**
  - Client delete: assignments transition to `archived`; the
    `client_user_id` FK is **not** nulled (audit and lineage
    integrity); the client is no longer queryable as a `User`.
  - Coach delete: cascades to the assignment row via FK.
- **AuditLog.** Every write writes an audit entry per
  [`../audit-and-gdpr.md`](../audit-and-gdpr.md).

## 12. Tests

- **Unit:**
  - Cursor algorithm (no pause; one pause; resume; multiple
    pauses; pause spanning end of regimen).
  - Active-assignment uniqueness rejection.
  - Validators (regimen state, version state, consent gate).
- **Integration:**
  - Assign → week-1 clone → client read returns week-1 rows.
  - Pause → week-2 read does not advance.
  - Resume → week-2 read advances.
  - Migrate → predecessor + successor chain.
  - Cascade on coach delete.
- **Smoke:**
  - `GET /me/regimen-assignment` returns 404 / null when
    none.
- **Manual eval:** founder runs a real client through the
  pause-resume flow on staging.

## 13. Risks

- **Clone failure mid-transaction.** Mitigation: use a
  Prisma `$transaction` block; failure rolls back the
  assignment row. The audit row is written *only* after
  commit.
- **Cursor drift on DST / leap seconds.** Mitigation: cursor
  is a pure function over UTC seconds; DST is handled by the
  client-side render (which already handles DST for
  `WorkoutSession` timestamps).
- **Active-uniqueness race.** Two concurrent assigns. Mitigation:
  partial unique index forces a 23505 conflict; the second
  request returns 409.
- **Migrate that fails after writing successor.** Mitigation:
  full transaction; both predecessor state-flip and successor
  insert in one tx.
- **Auto-subscribe fan-out timeout.** Spec #33 fan-out is
  best-effort; failure is logged but does not roll back the
  assignment. A follow-up reconciler resyncs.

## 14. Dependencies

- **Roadmap rows.** #34 (regimens), #28 (templates), #33
  (content boards), #36 (progress envelope), #37 (tier gate).
- **Existing modules.** `src/audit/`, `src/auth/`,
  `src/billing/`, `src/coach/`.
- **External services.** None.
- **Decisions that must close.**
  - Pause cursor: subtract paused seconds from elapsed
    (default) vs delay end-date (alternative). Spec defaults
    to subtract.
  - Re-assign vs migrate semantics: migrate creates a chain;
    re-assign-after-end creates an unrelated new assignment.
  - Whether a coach can assign a *draft* version for
    testing on themselves only (founder request; spec
    defaults to no — only published versions assignable).

## 15. Acceptance criteria

1. Migration adds the two tables and the partial unique
   index idempotently.
2. Assign → clone → client read works on real Postgres.
3. Pause / resume / end / migrate state machine passes
   integration tests.
4. Active-assignment uniqueness enforced under concurrent
   write.
5. Tier-gating verified.
6. Auto-subscribe wires to #33 successfully on staging.
7. AuditLog rows present for every state transition.
8. Handoff brief updated.

## 16. Operator handoff

- **Runbook entry**: flag flips, manual end of an
  assignment, manual migrate procedure, how to re-clone
  week-N if a clone failed mid-transaction.
- **Dashboard tiles:**
  - "Active assignments by tier."
  - "Assignments paused > 30 days" (potential churn signal).
  - "Migrate frequency" (signals regimen iteration).
- **Alerts:**
  - Clone error rate > 1%.
  - Active-uniqueness conflicts > 0 (signals UI race).
- **Kill switches:**
  - `REGIMEN_ASSIGNMENT_ENABLED=off` — disables all routes;
    existing assignments continue to be readable from the
    underlying tables but the API surface is hidden.
