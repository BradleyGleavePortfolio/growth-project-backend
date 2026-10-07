Tier: T3 (client workout history read order; no money, auth, PII, tenancy or AI logic)
Why: owner 12:01 10-06 "TOP PRIOTY for the food and workout logging to be kick ass". Job FU-WORKLOG2-126 (agent 126), workout logging second pass; companion to mobile m#448 (works with or without this PR).
T4 trigger scan: none. One `orderBy` on GET /workouts (WorkoutService.getWorkouts). The `where: { user_id }` ownership filter is unchanged. No schema, no migration, no new route, no flag.
T3 trigger scan: src/workout/workout.service.ts getWorkouts only. Callers: mobile Workouts tab Recent Workouts (limit 5), the 50-workout chart/history window and the live workout "previous sets" hint.
Bounded T1: none.
Canonical builder: Claude Opus 5.5 (FU-WORKLOG2-126, agent 126).
Acceptance evidence: new `test/workout-history-order-fu126.spec.ts` (fails on main: orderBy was `{ date: 'desc' }` only). Local: workout-history-order-fu126 1/1, workout-routines-ux124 8/8; eslint on changed files clean. Full CI runs on the PR.

Size: 39 changed lines (38 additions, 1 deletion), 33 of them the test.

## What it fixes
- U1: a client who logs two workouts on the same day (morning cardio, evening lifting) can see the morning one above the one just finished in Recent Workouts, and the next workout's "previous sets" hint can read the older session, because `date` is a calendar day (@db.Date) and same-day rows tied with no tie-break. GET /workouts now orders by `date desc, created_at desc`.

## Overlap
No open PR touches src/workout/.
