# Tier Classification — SubscriptionGuard Endpoints

**Spec:** hybrid_coach_pricing_spec.md §5  
**PR:** feat/hybrid-coach-pricing  
**Generated:** 2026-06-14  
**Methodology:** `grep -r "SubscriptionGuard" src/ --include="*.ts" -l` + manual route inspection.

---

## Policy

- **Pro-locked** (`@RequiresTier('pro')` added): free coaches receive `403 TIER_UPGRADE_REQUIRED` in enforce mode.
- **Free** (no tier decorator): any valid coach passes; subscription status is **not** checked on free endpoints under the hybrid model (spec §6 invariant 4).
- `BILLING_ENFORCEMENT=observe` allows all coaches through regardless of tier, logging telemetry.
- OWNER role bypasses all checks.

---

## Complete Classification Table

| Controller | File | Route(s) | Tier Required | @RequiresTier Added | Rationale |
|---|---|---|---|---|---|
| `CoachAIController` | `src/ai/coach/coach-ai.controller.ts` | `GET /coach/ai/status` | `pro` | ✅ (class-level) | Coach AI is the core Pro feature — costs real money per call (Anthropic). All handlers inherit via class decorator. |
| `CoachAIController` | `src/ai/coach/coach-ai.controller.ts` | `POST /coach/ai/workout-program` | `pro` | ✅ (inherited) | AI generation — Pro only. |
| `CoachAIController` | `src/ai/coach/coach-ai.controller.ts` | `POST /coach/ai/meal-plan` | `pro` | ✅ (inherited) | AI generation — Pro only. |
| `CoachAIController` | `src/ai/coach/coach-ai.controller.ts` | `POST /coach/ai/client-insight` | `pro` | ✅ (inherited) | AI generation — Pro only. |
| `CoachAIController` | `src/ai/coach/coach-ai.controller.ts` | `GET /coach/ai/drafts` | `pro` | ✅ (inherited) | Draft management for Pro AI feature. |
| `CoachAIController` | `src/ai/coach/coach-ai.controller.ts` | `GET /coach/ai/drafts/:draftId` | `pro` | ✅ (inherited) | Draft management for Pro AI feature. |
| `CoachAIController` | `src/ai/coach/coach-ai.controller.ts` | `POST /coach/ai/drafts/:draftId/approve` | `pro` | ✅ (inherited) | Draft management for Pro AI feature. |
| `CoachAIController` | `src/ai/coach/coach-ai.controller.ts` | `POST /coach/ai/drafts/:draftId/edit` | `pro` | ✅ (inherited) | Draft management for Pro AI feature. |
| `CoachAIController` | `src/ai/coach/coach-ai.controller.ts` | `POST /coach/ai/drafts/:draftId/reject` | `pro` | ✅ (inherited) | Draft management for Pro AI feature. |
| `InviteCodesController` | `src/invite-codes/invite-codes.controller.ts` | `POST /coach/invite-codes` | `free` | ❌ | Single invite code creation is a free feature. Invite-based client acquisition is core to the free tier value prop. |
| `InviteCodesController` | `src/invite-codes/invite-codes.controller.ts` | `POST /coach/invite-codes/bulk` | `free` | ❌ | Bulk invite codes are free. Same rationale as single — client acquisition should not be paywalled. |
| `CoachMealPlansController` (legacy) | `src/meal-plans/coach-meal-plans.controller.ts` | `GET /coach/clients/:client_id/meal-plans` | `free` | ❌ | Legacy meal plan read — free core feature. |
| `CoachMealPlansController` (legacy) | `src/meal-plans/coach-meal-plans.controller.ts` | `POST /coach/clients/:client_id/meal-plans` | `free` | ❌ | Legacy meal plan create — free core feature. |
| `CoachMealPlansController` (legacy) | `src/meal-plans/coach-meal-plans.controller.ts` | `PATCH /coach/meal-plans/:id` | `free` | ❌ | Legacy meal plan update — free core feature. |
| `CoachMealPlansController` (legacy) | `src/meal-plans/coach-meal-plans.controller.ts` | `DELETE /coach/meal-plans/:id` | `free` | ❌ | Legacy meal plan delete — free core feature. |
| `PackagesController` | `src/packages/packages.controller.ts` | `GET /v1/coach/packages` | `free` | ❌ | **MUST stay free** — this is the rev-cut path. Blocking it breaks TGP primary revenue stream (spec §5 seed list). |
| `PackagesController` | `src/packages/packages.controller.ts` | `POST /v1/coach/packages` | `free` | ❌ | **MUST stay free** — package creation enables client payments and rev-cut earnings. |
| `PackagesController` | `src/packages/packages.controller.ts` | `PATCH /v1/coach/packages/:id` | `free` | ❌ | **MUST stay free** — package editing is part of the core free coaching flow. |
| `PackagesController` | `src/packages/packages.controller.ts` | `DELETE /v1/coach/packages/:id` | `free` | ❌ | **MUST stay free** — package management is core free functionality. |
| `V1CoachController` | `src/v1/v1-coach.controller.ts` | `POST /v1/coach/me/threads/:clientId/messages` | `free` | ❌ | Messaging is core free functionality — coaches need to communicate with clients at any tier. |
| `V1CoachController` | `src/v1/v1-coach.controller.ts` | `POST /v1/coach/me/threads/:clientId/draft` | `free` | ❌ | Message draft saving is free — write-heavy autosave; blocking would degrade UX for free coaches. |
| `WorkoutBuilderController` | `src/workout-builder/workout-builder.controller.ts` | `GET /workout-plans` | `free` | ❌ | Workout plan management is a core free feature (not AI-generated; hand-crafted by the coach). |
| `WorkoutBuilderController` | `src/workout-builder/workout-builder.controller.ts` | `POST /workout-plans` | `free` | ❌ | Workout plan creation — free core feature. |
| `WorkoutBuilderController` | `src/workout-builder/workout-builder.controller.ts` | `GET /workout-plans/:planId` | `free` | ❌ | Workout plan read — free core feature. |
| `WorkoutBuilderController` | `src/workout-builder/workout-builder.controller.ts` | `PATCH /workout-plans/:planId` | `free` | ❌ | Workout plan update — free core feature. |
| `WorkoutBuilderController` | `src/workout-builder/workout-builder.controller.ts` | `DELETE /workout-plans/:planId` | `free` | ❌ | Workout plan archive — free core feature. |
| `WorkoutBuilderController` | `src/workout-builder/workout-builder.controller.ts` | `PUT /workout-plans/:planId/exercises` | `free` | ❌ | Exercise set management — free core feature. |
| `WorkoutBuilderController` | `src/workout-builder/workout-builder.controller.ts` | `POST /workout-plans/:planId/assignments` | `free` | ❌ | Workout assignment to client — free core feature. |
| `WorkoutBuilderController` | `src/workout-builder/workout-builder.controller.ts` | `GET /workout-plans/:planId/assignments` | `free` | ❌ | Workout assignment listing — free core feature. |
| `CoachMealTemplatesController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `POST /coach/meal-templates` | `free` | ❌ | Meal template management is a free core feature. |
| `CoachMealTemplatesController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `GET /coach/meal-templates` | `free` | ❌ | Meal template read — free core feature. |
| `CoachMealTemplatesController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `GET /coach/meal-templates/:id` | `free` | ❌ | Meal template read — free core feature. |
| `CoachMealTemplatesController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `PATCH /coach/meal-templates/:id` | `free` | ❌ | Meal template update — free core feature. |
| `CoachMealTemplatesController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `DELETE /coach/meal-templates/:id` | `free` | ❌ | Meal template delete — free core feature. |
| `CoachDailyMealPlansController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `POST /coach/daily-meal-plans` | `free` | ❌ | Daily meal plan management is a free core feature. |
| `CoachDailyMealPlansController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `GET /coach/daily-meal-plans` | `free` | ❌ | Daily meal plan read — free. |
| `CoachDailyMealPlansController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `GET /coach/daily-meal-plans/:id` | `free` | ❌ | Daily meal plan read — free. |
| `CoachDailyMealPlansController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `PATCH /coach/daily-meal-plans/:id` | `free` | ❌ | Daily meal plan update — free. |
| `CoachDailyMealPlansController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `DELETE /coach/daily-meal-plans/:id` | `free` | ❌ | Daily meal plan delete — free. |
| `CoachDailyMealPlansController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `POST /coach/daily-meal-plans/:id/assignments` | `free` | ❌ | Meal plan assignment — free. |
| `CoachDailyMealPlansController` | `src/real-meal-plans/real-meal-plans.controller.ts` | `GET /coach/daily-meal-plans/:id/assignments` | `free` | ❌ | Meal plan assignment read — free. |

---

## Notes on Uncertain Cases

None — all SubscriptionGuard usages in `src/` match the spec seed list or are covered by clear rationale above. No `NEEDS_REVIEW` flags required.

### Things intentionally NOT guarded (no change made)

| Controller | Route | Reason |
|---|---|---|
| Practice type controller | `/coach/practice` | No guard today, spec §1 non-goal. Cross-pillar is free (spec decision). |
| AssignmentController | `GET /assignments/me`, `GET /assignments/:id`, `PATCH /assignments/:assignmentId/complete` | Client-facing; uses `ClientEntitlementGuard`, not `SubscriptionGuard`. |
| InviteLanding / public routes | `/join/:code`, `/invite/:code` | Public unauthenticated routes. |

### White-label / custom-domain routes

No dedicated controller routes exist in `src/` for white-label, custom-domain, or branding configuration. When added, they must receive `@RequiresTier('pro')` at class level. See commit 8 for details.

---

*Last updated: 2026-06-14 by feat/hybrid-coach-pricing PR.*
