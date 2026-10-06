Tier: T3
Why: Coach AI "Approve & assign" told the coach a workout program was assigned while the client got nothing; this writes the client's workout assignments (tenancy-checked, one transaction, idempotent).
T4 trigger scan: none (no auth, RLS, PII egress, money, credentials or destructive data change; the assignment path reuses WorkoutBuilderService.assertCanAccessClient and the existing snapshot fan-out)
T3 trigger scan: client-visible workout assignments (writes ClientWorkoutAssignment + ClientWorkoutAssignmentSnapshot rows) and a client push
Bounded T1: NO (writes client data, multi-file)
Canonical builder: Claude Opus 5.5 (B-AIASSIGN-125, agent 125)
Parent owner: agent 125 operator
Acceptance evidence: test/ai/coach-ai.controller.spec.ts — 5 new tests fail on main (a6f4b5a9) and pass here (12/12); test/ai/ai-program-start.spec.ts 4/4 (new module). Targeted eslint clean; scripts/check-r75.js range check OK (net 0). Full suite + tsc in this PR's CI.
Promotion triggers: any change to auth/tenancy checks, the AI gateway, or money paths.

## What it fixes

- **B1 (AUDIT-14-125, false claim + train flow).** A coach taps Generate workout program, then "Approve & assign", and is told the program was assigned, but the client never sees a single workout because the backend only created unassigned plans in the coach's library.

## Change

- `CoachAIService.approveDraft` (WORKOUT_PROGRAM): after `materializeWorkoutProgram` creates one plan per AI day, ONE transaction writes one `ClientWorkoutAssignment` + snapshot per plan via the existing WorkoutBuilderService fan-out (offset `(week-1)*7 + (day-1)` days) and stamps the draft `APPROVED` + `approvedAsId`, so `approvedAsId` set means the assignments exist. One `WORKOUT_ASSIGNED` push after commit (`notifyProgramAssigned`). The response adds `assigned_count` (mobile m#425 already reads it and says "N workouts assigned").
- Start date: next Monday 09:00 in the client's time zone (`resolveRecipientTimeZone`; UTC when none is known), unless the draft payload carries a valid `start_date` (YYYY-MM-DD). New pure helper `src/ai/coach/ai-program-start.ts`.
- Double tap: a conditional `DRAFT -> APPROVED` claim (`updateMany where status=DRAFT`) fences the approve. A second request after completion replays `{...draft, assigned_count}`; a second request while the first is still running gets 409 "This program is already being assigned." If materialisation or the assignment transaction fails, the claim is released back to `DRAFT` so the coach can retry.
- Tenancy: approve re-checks `assertCoachOwnsClient` (same gate generation uses; 404 opacity) before writing assignments.
- `WorkoutBuilderService.writePlanAssignmentsInTx`: small public wrapper over the private `fanOutProgramPlans` for plan lists that are not one WorkoutProgram. No behaviour change to existing callers.
- MEAL_PLAN and INSIGHT approvals unchanged.

## Not touched / overlap

- Does not touch `src/ai/gateway` or `ai-approval.service.ts` (B-AIB1-125 owns them).
- `src/workout-builder/workout-builder.service.ts` is also touched by old open PRs #587 / #593 (RLS/scout stack, last updated 09-30); this PR only adds one 20-line method after `notifyProgramAssigned`.
- No migration, no new dependency, no flag, no lockfile change.

## C one-liners

- C (edge, deferred to 10k clients): if the assignment transaction fails after plans were created, the created plans stay in the coach library (the draft returns to DRAFT and a retry creates fresh plans).
