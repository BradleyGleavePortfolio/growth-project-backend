# Build Week — operator runbook

Build Week is the Phase 4 7-day guided coaching arc. It turns the
canonical onboarding process into a sequenced in-app experience: each day
gates the next, the seventh day is a milestone, and a small admin funnel
shows where users drop off.

This runbook covers what to expect when the module is live in production,
how to read the funnel, and what the PTM milestone signal means for the
risk-board downstream.

## The 7 days

The catalog is seeded by migration `20260506020000_add_build_week` from
`prisma/seed-build-week.json`. Copy edits ship via a new migration — never
an in-place UPDATE of the seeded rows. The current arc:

| Day | Title          | Focus area                       |
| --- | -------------- | -------------------------------- |
| 1   | Audit          | Diagnostic + Baseline            |
| 2   | Strategy       | 90-Day Arc + Calendar Cuts       |
| 3   | Income Setup   | Offer + Outreach                 |
| 4   | Body Protocol  | Macros + Training + Sleep        |
| 5   | Environment    | Calendar + Surroundings          |
| 6   | Integration    | Operating Rhythm + Tooling       |
| 7   | Lock-In        | Self-Assessment + Certificate    |

Day-by-day narrative, prompt questions, and action items are stored in the
`BuildWeekDay.narrative`, `prompt_questions`, and `action_items` columns
respectively — see `prisma/seed-build-week.json` for the source of truth.

## Enrolment lifecycle

```
                       enroll() ─────────► active (current_day=1)
                            ▲                   │
                            │                   │ completeDay(1..6)
                            │                   ▼
                            │              active (current_day=N+1)
                            │                   │
                            │                   │ completeDay(7)
                            │                   ▼
                            │              completed (status='completed',
                            │                         completed_at=now)
                            │                   │
                            └─── re-enroll ─────┘  (resets row in place)
```

- **One row per user** — the `BuildWeekEnrollment` table has a unique
  index on `user_id`. Re-enrolment resets the same row in place
  (status='active', current_day=1, started_at=now, completions cleared)
  and writes an `AuditLog` entry `build_week.enrolled` with a
  `reenroll: true` metadata flag.
- **Sequential ordering enforced** — `completeDay(N)` requires
  `enrollment.current_day === N`. Any other day throws
  `ConflictException`. The mobile UI surfaces this as a "wait, you are on
  day X" message.
- **Idempotent completions** — calling `completeDay(N)` twice for the
  same N upserts the `BuildWeekDayCompletion` row by
  `(enrollment_id, day_number)`. The second call overwrites the
  responses + artifact text but does not double-advance current_day.

## Drop-off interpretation

`GET /admin/build-week/funnel` returns:

```jsonc
{
  "total_enrolled": 173,
  "total_completed": 41,
  "completion_rate": 0.237,
  "dropoff_per_day": [
    { "day_number": 1, "reached": 173, "dropped": 5 },
    { "day_number": 2, "reached": 168, "dropped": 12 },
    // ...
    { "day_number": 7, "reached": 42, "dropped": 1 }
  ]
}
```

Reading the chart:

- `reached[N]` is the count of enrolments that have a completion row for
  day N (i.e. they finished day N).
- `dropped[N]` is `reached[N] - reached[N+1]` — users who finished day N
  but not day N+1.
- For day 7, `dropped` is `reached[7] - completed_count` — users who
  finished day 7 in the catalog sense but whose enrolment status never
  flipped to `completed`. In normal operation this is 0; non-zero values
  signal a backend bug.

The expected pattern is a steep drop between day 1 → day 2 (the audit
filters out the not-yet-committed) and another between day 3 → day 4 (the
outreach action is the hardest gate). A flat profile across days 1–6
followed by a sharp day-7 drop usually means the certificate generation
flow on mobile is breaking.

## PTM signal emission

Day 7 completion fires a single PTM signal:

```ts
PtmService.emit(userId, 'finance_milestone', 1, {
  source: 'build_week',
  day_number: 7,
  total_days: 7,
});
```

This is intentional and narrow:

- The signal type is `finance_milestone`, which the heuristic engine
  treats as a strong protective factor.
- The `metadata.source` discriminator lets the future weighted v2 engine
  separate Build Week milestones from other finance milestones if they
  diverge in predictive value.
- Days 1–6 do **not** emit. The catalog tracks itself; emitting on every
  day would dilute the meaning of `finance_milestone` for the heuristic
  engine.

Operationally, after a Build Week completion you should see:

1. A new row in `ClientSignal` with `signal_type='finance_milestone'`
   and the metadata blob above.
2. The next nightly PTM recompute (cron `PTM_SCORING_CRON`, default 04:00
   UTC) will pick this up — risk_score should drop slightly the morning
   after a Day-7 completion.
3. An `AuditLog` row `build_week.day_completed` with metadata
   `{ day_number: 7, total_days: 7 }`.

If the signal does not appear:

- Check `BUILD_WEEK_ENABLED` (defaults to true; explicit `false` disables
  writes).
- Check that the user's enrolment actually transitioned to
  `status='completed'` — a partial completion (current_day stuck at 7)
  means the request body validation failed; see the `BuildWeekDayDto`
  rules in `src/build-week/build-week.dto.ts`.
- The signal write is fire-and-forget; `PtmService.emit` swallows
  failures and logs them to the `PtmService` logger. Search for
  `PTM signal write failed (user=<id> type=finance_milestone)` in
  Fly logs.

## Mobile follow-on

Auto-start on signup is gated by `BUILD_WEEK_AUTO_START_ON_SIGNUP`. The
flag is exposed in this PR but the wiring (call `BuildWeekService.enroll`
from the auth `selectRole('student')` path) lands in a follow-on PR. Until
then, every user enrols themselves via `POST /build-week/enroll` from the
mobile app.
