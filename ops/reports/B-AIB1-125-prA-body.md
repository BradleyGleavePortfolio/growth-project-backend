**Tier:** T4 (money: coach AI credit pool debits)
**Why:** Coach AI v1 generations (workout program, meal plan, client insight) call Anthropic but never check or debit the coach AI credit pool (AUDIT-14-125 U4); the MWB-5 live-create capabilities are not in the metered set (SAFE-MWBAI-125 "Not fixed" 1). Owner A6.4: every AI turn debits the pool.
**T4 trigger scan:** money (pool pre-check + debit) — yes. Auth/RLS/tenancy: no change (ownership 404 still runs first, before the budget read). PII: none. Credentials: none. Destructive data: none. No migration, no flag, no dependency.
**T3 trigger scan:** shared constant `COACH_AI_METERED_CAPABILITIES` gains `insight`, `draft.create_workout_plan`, `draft.edit_workout_plan`. No gateway code change; both live-create capabilities stay off (FEATURE_MWB_AI_LIVE_CREATE unset).
**Bounded T1:** `src/ai-credits/ai-credits.constants.ts`, `src/ai/coach/coach-ai.service.ts`, one new spec.
**Canonical builder:** B-AIB1-125 (Claude Opus 5.5, agent 125).
**Acceptance evidence:** `test/ai/coach-ai-metering.spec.ts` 17/17 pass locally at head; fails on main (the service takes no budget, so the used-up-pool cases reach the provider; the three capabilities are missing from the set).

## What changes
- `CoachAIService` injects `CoachAIBudgetService` (`@Optional()`, `AiCreditsModule` is `@Global`). Each `generate*` runs, after the ownership check and before the Anthropic call, the same pre-check as `AiGatewayService.invoke` (`resolveHeadCoachId` -> `canCharge(id, 0)` -> 402 `CoachAiBudgetExhaustedException` with the same structured body). After the call it `recordUsage`s `AnthropicAdapter.computeCostCents(tokensIn, tokensOut)`; a failed debit is logged, never thrown (gateway posture).
- `COACH_AI_METERED_CAPABILITIES` adds `insight` (the v1 insight capability string; `workout_program` / `meal_plan` were listed but never consulted), `draft.create_workout_plan`, `draft.edit_workout_plan`.

## Fixes
- U (AUDIT-14 U4, money): a coach taps Generate workout program / meal plan / insight and the Anthropic cost is never taken from their AI credits, so the pool meter is wrong and a used-up pool never stops generations.
- C-now / B-later (SAFE-MWBAI blocker 4): once live-create is turned on, every call would bypass the pool; now metered by the gateway's existing gate.

## Overlap
- B-AIASSIGN-125 edits `CoachAIService.approveDraft` in the same file; this PR touches only the constructor, two new private helpers and the three `generate*` methods.
- Mobile: a used-up pool now returns the gateway's 402 body (same `code`, pack options and budget snapshot) on `/coach/ai/*`. CoachAiSection shows `message` verbatim (`errorMessage`), so the message here is specific product copy with no purchase wording ("AI credits for this period are used up, so nothing was generated. Credits renew at the start of the next period."). Works with the current mobile build; no mobile change needed.
