**Tier:** T2
**Why:** Coach meal-plan edit path (PATCH /coach/meal-plans/:id) keeps the stored per-day copy in step with the edited items, and the item cap fits an AI-approved 7-day plan. Same ownership check, same route, no schema change.
**T4 trigger scan:** auth no; RLS/tenancy no (the coach_id + archived_at ownership filter is unchanged); PII no; money no; credentials no; destructive data no (days is rebuilt from the coach's own edit, or cleared only when an edited item has no day label).
**T3 trigger scan:** none (no migration, no flag, no new route).
**Bounded T1:** n/a
**Canonical builder:** AUDIT-08-125 (agent 125 worker, Claude Opus)
**Acceptance evidence:** new `test/meal-plans-ai-edit-125.spec.ts` (5 tests, pass locally; fail on main: `days` untouched by the edit and an 84-item edit refused by the 50-item cap); existing `test/meal-plans.service.spec.ts` 12/12 pass locally; PR CI full suite + tsc + lint.

## Fixes
- **U — coach edits of an AI meal plan never reach the client.** A coach who approved an AI meal plan edits it in the client's Plan tab: for the default 7-day plan (about 28 meals, well over 50 items) the save fails with "items must contain no more than 50 elements", and for a short plan the save succeeds but the client keeps seeing the original AI meals, because the client app renders `MealPlan.days` (written once by `CoachAiService.materializeMealPlan`) in preference to `items`, and the PATCH never touched `days`.
  - `updateByCoach`: when the plan has `days` and the edit changes `items`, `days` is rebuilt from the items' "Day N – slot" labels (the labels the materializer writes); if any edited item has no day label, `days` is cleared so the client shows the flat items.
  - `MEAL_PLAN_MAX_ITEMS = 300` replaces the 50-item cap on create and update items.

Mobile needs no change: the client Plan screen already renders both shapes. No overlap with open PRs (b#780 touches food, not meal-plans).
