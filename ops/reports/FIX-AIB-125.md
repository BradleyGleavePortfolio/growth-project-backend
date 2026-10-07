# FIX-AIB-125 — one fix round on backend b#807 and b#805 (agent 125, FINAL WAVE)

Fixer: Claude Opus 5.5, T4. Start 16:59 PDT 10-06, hard stop 17:35. No merge, deploy, flags or production touched.
Inputs: ops/reports/L4-OPUS-125.md (B-807-1), ops/reports/L4-SOL-125.md (B-805-1), ops/reports/B-AIB1-125.md, verdict files
ops/aud-125/L4-OPUS-125/807.md and ops/aud-125/L4-SOL-125/805.md.

## Scope traced
- b#807: PATCH /ai/gateway/drafts/:id -> AiApprovalService.decide (coach branch: tenant, subject roster, NEW payload roster) ->
  CapabilityMaterializerRegistry -> AssignWorkout / AssignMealPlan / CreateWorkoutPlan / SendNotification materialisers.
- b#805: POST /coach/ai/workout-program | meal-plan | client-insight -> CoachAIService.assertBudget (canCharge(0)) ->
  AnthropicAdapter.completeStructured -> recordSpend -> CoachAIBudgetService.recordUsage (guarded increment).

## B list (fixed this round)
- B-807-1 (Opus L4): a coach who runs alone creates an assign_workout / assign_meal_plan draft whose payload names another coach's
  client, approves it, and that client gets the plan and a push. FIXED: decide() coach branch refuses (403 "Draft is outside your
  tenant") when any payload client id (clientId / client_id / target_client_id) is neither the draft subject nor has
  coach_id == decider; runs before the requester rule and before any materialiser.
- B-805-1 (Sol L4): a coach near the end of the AI pool keeps generating for free because a call costing more than the remainder is
  never debited. FIXED: recordSpend follows the B-668-1 pattern (RomanService.debitCoachPool / AiService): on recorded:false re-read
  the pool and debit min(rest, cost), so the pool reads used up and the next call gets 402 before any provider call.

## U list
- None.

## C one-liners
- C: AiGatewayService.invoke post-call debit (ai-gateway.service.ts:357-374) has the same un-debited-remainder shape; pre-existing on
  main, gateway runs the stub provider in production (response.enabled false -> no debit path). Same B-668-1 fix applies when the
  gateway is turned on.
- C (edge, deferred to 10k clients): two simultaneous near-empty generations can both pass the pre-check; one call may overshoot.

## Covered by open PRs
- None (the fixes are inside b#805 / b#807 themselves).

## PRs (fix round 1 pushes)
- b#807 agent125/b-aib1-approve: 0cdafb37 -> 91f103066dd6763930218ff491d66d3bebd01f9a (fix commit 4f8d02a3 + merge of origin/main
  8e9e1c43). 428 lines vs main (402+/26-). Local: ai-approval.service.spec 20/20 (4 new fail on old head),
  ai-approval-materialiser-integration 11/11, ai-execution-stream2 47/47. CI GREEN at 91f10306 (15 SUCCESS, deploy-readiness-gate
  SKIPPED). DELTA https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/807#issuecomment-6027911246 READY
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/807#issuecomment-6027911400 (17:12).
- b#805 agent125/b-aib1-meter: 41493e41 -> 0096987c0d7f34345f56cfa61c45837ec28c9cc2 (merge of origin/main df9e63e4 with the
  coach-ai.service.ts import conflict resolved by keeping both import sets, + fix commit). 342 lines vs main (340+/2-). Local:
  coach-ai-metering.spec 23/23 (3 new near-empty tests fail on old head), no-pii-in-logs 11/11. CI GREEN at 0096987c (15 SUCCESS,
  deploy-readiness-gate SKIPPED). DELTA https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/805#issuecomment-6027943203
  READY https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/805#issuecomment-6027943343 (17:15).

## Not fixed (needs operator)
- None blocking. Gateway parity (C above) is recommended for the gateway-on PR, not for launch.

## HANDOFF
- DONE 17:15 PDT. Both PRs READY FOR AUDIT at new heads with green CI: b#807 @ 91f103066dd6763930218ff491d66d3bebd01f9a,
  b#805 @ 0096987c0d7f34345f56cfa61c45837ec28c9cc2. L5-OPUS-125 / L5-SOL-125 review next (delta scope: the B + changed lines + merge).
- Comment texts: ops/reports/FIX-AIB-125-{805,807}-{delta,ready}.md.
- Worktrees removed (all work pushed), local branches deleted. No ci/* lane branches. No locks. No merge, deploy or flag change.
