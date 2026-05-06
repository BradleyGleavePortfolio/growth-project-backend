# Build Week (Phase 4)

The 7-day guided coaching arc that turns the onboarding process into an in-app
experience. Day 1 is an audit, Day 7 is a lock-in; every day in between is a
sequenced beat the user must clear before the next unlocks.

## Day catalog (seeded by migration)

| Day | Title          | Focus area                       | Expected artifact                                                                  |
| --- | -------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Audit          | Diagnostic + Baseline            | Diagnostic + baseline snapshot (weight, income, hours, 90-day success statement). |
| 2   | Strategy       | 90-Day Arc + Calendar Cuts       | Confirmed income lever and a written list of calendar cuts for the week.           |
| 3   | Income Setup   | Offer + Outreach                 | Offer brief, LinkedIn headline, five outreach sends, populated tracker link.       |
| 4   | Body Protocol  | Macros + Training + Sleep        | Macro targets, training schedule, sleep audit, Week 1 body target.                 |
| 5   | Environment    | Calendar + Surroundings          | Redesigned weekly calendar, environment change, optional relocation target.       |
| 6   | Integration    | Operating Rhythm + Tooling       | Scheduled coaching call, operating rhythm doc, three confirmed tracking tools.    |
| 7   | Lock-In        | Self-Assessment + Certificate    | Three-pillar self-assessment, 60-second build video, completion certificate.      |

The full per-day copy (narrative, prompt questions, action items) lives in
`prisma/seed-build-week.json` and is loaded into the `BuildWeekDay` table by
the additive migration `20260506020000_add_build_week`. Copy edits ship via a
new migration — never an in-place UPDATE of seeded rows.

## Endpoints

### Client-facing (`JwtAuthGuard`)

| Method | Path                                         | Purpose                                          |
| ------ | -------------------------------------------- | ------------------------------------------------ |
| GET    | `/build-week/days`                           | Public catalog (the 7-day arc).                  |
| POST   | `/build-week/enroll`                         | Enrol the requesting user. Idempotent.           |
| GET    | `/build-week/me`                             | Current enrolment + completions for the user.    |
| GET    | `/build-week/days/:dayNumber`                | Catalog row + the user's own completion (if any).|
| POST   | `/build-week/days/:dayNumber/complete`       | Mark the current day complete. Body: `{ responses, artifact_text? }`. |

### Coach-facing (`JwtAuthGuard + CoachGuard`)

| Method | Path                                              | Purpose                                              |
| ------ | ------------------------------------------------- | ---------------------------------------------------- |
| GET    | `/coach/clients/:clientId/build-week`             | Coach view of a client's enrolment + completions.    |

Tenancy: the controller asserts the requested client belongs to the
requesting coach. Owners bypass via the OWNER role on `CoachGuard`. A coach
probing other coaches' rosters gets `404 Not Found` — never a 403, so they
cannot enumerate user IDs.

### Admin (`@Roles('owner')`)

| Method | Path                                  | Purpose                                                |
| ------ | ------------------------------------- | ------------------------------------------------------ |
| GET    | `/admin/build-week/enrollments`       | List enrolments. Filters: `status`, `completed_after`, `before`, `limit`. |
| GET    | `/admin/build-week/funnel`            | Aggregate: total enrolled, completion rate, drop-off per day.            |

## Sequential ordering

`completeDay(N)` requires `enrollment.current_day === N`. Skipping is a
coaching-doctrine violation and throws `ConflictException`. Day-7
completion sets `status='completed'` and `completed_at=now()`.

A user can have at most one enrolment row (unique on `user_id`). Re-enrolling
after `completed` or `abandoned` resets the same row in place; prior
completions are deleted, the audit trail records the transition.

## PTM signal hook

Day 7 completion fires a fire-and-forget PTM signal:

```
PtmService.emit(userId, 'finance_milestone', 1, {
  source: 'build_week',
  day_number: 7,
  total_days: 7,
})
```

Days 1–6 do **not** emit PTM signals — the catalog tracks itself; emitting
on every day would dilute the meaning of `finance_milestone`.

## Env flags

- `BUILD_WEEK_ENABLED` — default `true`. Set to `false` to disable writes
  and zero the funnel report.
- `BUILD_WEEK_AUTO_START_ON_SIGNUP` — default `false`. The flag is exposed
  for staged rollout; the auto-enrolment wiring lands in a follow-on PR.

## Tests

- `test/build-week.service.spec.ts` — enrolment idempotency, sequential
  ordering, day-7 PTM signal, funnel drop-off math.
- `test/coach-build-week.controller.spec.ts` — coach can only see own
  clients; cross-coach hits return 404. Owners bypass.
- `test/admin-build-week.controller.spec.ts` — funnel aggregation on
  empty and synthetic cohorts.
