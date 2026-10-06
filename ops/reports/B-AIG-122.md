# B-AIG-122 — AI guide crisis reply before the daily limit (agent 122 builder, Opus)

Started 17:16 PDT 10-05. Time box 35 min (ends 17:51).

## PR
- growth-project-backend#736 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736
- Branch agent122/ai-guide-crisis-before-limit, base main a70533d53c5833c5e998a8de363de3eeb81d9eb8
- Head f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5 (one commit, pushed 17:21)
- Size 213 changed lines (src/ai/ai-crisis-router.ts +127, src/ai/ai.service.ts +20/-1, test/ai.service.spec.ts +65). Under 1,500.

## What changed
- New src/ai/ai-crisis-router.ts: classifyAiGuideCrisis() (emergency | self_harm | null) with normalization of smart punctuation;
  patterns copied from the Roman SafetyRouter emergency + self_harm classes (Roman stack @ 8cfad607, not on main). Fixed impersonal
  replies AI_GUIDE_CRISIS_REPLIES (988 for self-harm, 911 for emergency; no first person, no contractions, no exclamation marks).
- AiService.chat: crisis check is the first statement. Crisis -> fixed reply, model_used 'safety', degraded false; returns before the
  consent gate, context build, reserveDailyTokens and the model. No analytics event or AiRequestAudit row for the turn (health data).
- Token limit unchanged.

## Proof
- Failing before: 3 of the 4 new tests fail on main (at-cap suicidal -> 429; at-cap overdose -> 429; no consent -> 403); the 4th
  (ordinary message at cap still 429) passes before and after.
- After: test/ai.service.spec.ts 35/35 locally (heavy.sh). eslint clean on the three files. R75 staged check: net 0.
- CI lane run 37393636969 (ci/B-AIG-122-1, test/ai.service.spec.ts): success
  https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37393636969
- PR CI at f2dd87ad: 16 check runs, 15 success + deploy-readiness-gate skipped (by design); build-and-test, R75, danger, CodeQL green.

## Status
- 17:36 PDT: FIX ROUND 1 (OPENING, B-AIG-122, agent 122) + READY FOR AUDIT posted
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6006627739
- Lane branch ci/B-AIG-122-1 deleted; worktree wt/B-AIG-122-1 removed (clean, nothing unpushed). Done 17:37.

## Decisions (recommended defaults)
1. Controller burst throttle (@Throttle 20/hour on POST /ai/chat) still answers 429 before the service. Default: leave (the daily quota
   bites far earlier; C follow-up to skip the throttle for crisis turns).
2. Two crisis pattern lists (AI guide + Roman). Default: once the Roman stack is on main, make the AI guide import Roman's
   classifySafety (C follow-up).
3. Daily token limit size (M-ROMANCAP decision 2). Default: separate operator follow-up, untouched here per the job.

## Cs
- C: the 20/hour throttle path above.
- C: shared pattern list after Roman lands.

## HANDOFF
- PR #736 open at f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5, CI green, READY FOR AUDIT comment
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6006627739
- Next: AUD pair on b#736 (claims backend-736-f2dd87ad-{opus,sol}).
- Worktree removed, lane branch deleted. No locks held. Builder job complete.
- Artifacts: ops/aud-122/B-AIG-122/{PR_BODY.md,comment1.md}.
