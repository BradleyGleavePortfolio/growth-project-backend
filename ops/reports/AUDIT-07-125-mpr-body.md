**Tier:** T3
**Why:** A client read path (the client's own workout assignments) and the coach plan editor's save gate. No auth, tenancy, money, PII or credential change; the request still goes to the same client-scoped route.
**T4 trigger scan:** none. No auth/session, RLS/tenancy, payments, PII export, secrets or destructive data path touched. The Save gate only adds a "plan loaded" condition, which removes a way to send an empty exercise list.
**T3 trigger scan:** client-visible data shape (GET /assignments/me pagination) and the coach editor's save behaviour.
**Bounded T1:** none.
**Canonical builder:** AUDIT-07-125 (Claude Opus 5.5), agent 125.
**Acceptance evidence:**
- New `src/api/__tests__/workoutBuilderApi.myAssignments.test.ts` (4 tests) and one new test in `src/__tests__/coachWorkoutBuilderAutosave.test.tsx`. Both fail on main (ci-lane run 37531499797 on `ci/AUDIT-07-125-1` = main + these tests only) and pass at this head (PR CI).
- Works against the current production backend: production already answers `{ items, nextCursor }`; a bare list is still accepted, so no backend deploy is needed.

## Fixes

**B1 (core flow: train).** GET /assignments/me answers one page, `{ items, nextCursor }`, but the app read it as a plain list. A client whose coach assigned them a program opens the Workouts tab and sees no assigned workouts at all (the card is hidden because the reply is not a list), and the Your workouts screen fails to render. Fix: `workoutBuilderApi.listMyAssignments` reads every page (50 per page, up to 20 pages) and returns a list; an unreadable reply fails the load with specific copy instead of showing an empty list. The screens are unchanged.

**U1 (coach builder).** A coach who opens a program day or a saved workout from the Programs library sees "Edit workout plan" with a blank name, the type set to Strength and Save greyed out, because the plan is not in the cache yet and the fields were only filled in from the cache on first render. Fix: fill the name, type and duration once when the plan arrives (unless the coach already typed), show "Loading workout plan" (and a Try again state if the load fails), and keep Save off until the plan has loaded so a full-replace Save can never send an empty exercise list over the saved one.

Overlap: m#406 touches `WorkoutScreen.tsx`; this PR does not touch that file (the fix is in the API layer the screen already reads).
