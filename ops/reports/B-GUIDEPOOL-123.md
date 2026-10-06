# B-GUIDEPOOL-123 — F2 AI Guide draws from the coach monthly pool (agent 123)

Started 22:02:34 PDT 10-05. Builder (Claude Opus 5.5). Evidence: ops/reports/S-AICOST-123.md (B-S-AICOST-123-1).

## State
- PR: growth-project-backend#754, branch fix/ai-guide-coach-pool, base main 8220f109.
- Head: 584b3c979ecee0c675758e3714f56b63536a6f78 (pushed 22:21). First head 8413701a failed build-and-test only on
  test/privacy/no-pii-in-logs.spec.ts (two new log lines printed error.message); second commit logs error.name only
  (spec passes locally 11/11).
- Size: 3 files, +453/-12 = 465 changed lines (<600).
- Local: new spec 6/6 pass; on main 3/6 fail (behaviour tests). test/ai.service.spec.ts 55/55. eslint on the 3 files clean.
- CI at 584b3c97: all green (deploy-readiness-gate skipped); build-and-test https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37418169026/job/112121348673
- Opening comment (22:32): https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/754#issuecomment-6010047298 (ends READY FOR AUDIT).

## Design
- AiService injects CoachAIBudgetService (@Optional, @Global AiCreditsModule).
- Attribution = Roman poolCoachIdFor: student -> coach_id -> resolveHeadCoachId; coach/sub_coach -> own head pool; owner and no-coach client -> no pool.
- Pre-check before quota reservation and provider call: canCharge(coach, worst-case cents of exact payload: UTF-8 bytes + 256 input, 600 output, $3/$15, ceil).
- Exhausted -> 200 reply with fixed client-safe copy + code COACH_AI_BUDGET_EXHAUSTED, model_used 'credits', degraded false. Mobile check: AIGuideScreen (mobile a727eb49) maps only 403 ai_consent_required / 503 ai_egress_blocked / 429 AI_DAILY_QUOTA_EXCEEDED; a 402 would fall to the generic "problem with The Growth Project service" text, so a 200 fixed reply is the only no-generic-error option without a mobile PR.
- Debit after call: ceil cents of reported tokens; short remainder consumed (Roman parity). Debit failure logged, never thrown.
- Crisis + deterministic never spend. Pool read failure: 503 AI_GUIDE_CREDITS_UNAVAILABLE (fail closed).

## Operator decision
1. Exhausted pool returns a 200 fixed reply (works on the shipped app) instead of a 402. Recommended default: keep. Optional follow-up C: mobile maps code COACH_AI_BUDGET_EXHAUSTED to a dedicated notice.

## C (follow-up)
- C-GUIDEPOOL-1: AICallLog for Guide calls still records coachId null (adapter log only; debit is correct). Deferred.

## HANDOFF
- Done 22:32 PDT (30 min of the 40 min box). PR growth-project-backend#754 @ 584b3c979ecee0c675758e3714f56b63536a6f78, CI green,
  FIX ROUND 1 (OPENING) comment posted, READY FOR AUDIT. A/B/C for this builder: 0/0/1 (C-GUIDEPOOL-1).
- Next: two lenses (Opus + Sol) at the exact head. Not merged, not deployed. No mobile change is required for the 10-07 build;
  the fixed reply shows on the shipped app.
- Worktree /home/user/workspace/wt/B-GUIDEPOOL-123 removed; lock released; no ci/* or audit/* branches created. The PR branch
  fix/ai-guide-coach-pool stays (it is the PR head).
- Operator decision 1 (200 fixed reply vs 402): recommended default keep 200.
