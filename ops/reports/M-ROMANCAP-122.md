# M-ROMANCAP-122 (agent 122) — mobile AI daily cap pop-up
Started 16:50 PDT 2026-10-05. Worktree /home/user/workspace/wt/M-ROMANCAP-122-1, branch agent122/roman-daily-cap-popup off mobile main 2c88eae5.

## Status
- PR growth-project-mobile#379 @ 67d9aaa (+657/-6, 8 files, under 1,500). Opened 17:03 PDT.
- CI lane ci/M-ROMANCAP-122-1 run 37391654204: tsc + 15 related specs green.
- PR CI run 37391878122 attempt 1: 1 unrelated flaky suite failed (src/screens/client/wearables/__tests__/ConnectProviderSheet.attemptFence.test.tsx, 2 sign-out tests; 509/510 suites passed). Same file passes locally on this branch (21/21) and on main CI. Re-ran failed job at 17:09 (no push); attempt 2 GREEN 17:14. CodeQL green.
- PR body: ops/aud-122/M-ROMANCAP-122/PR_BODY.md

## What was built
- src/lib/ai/aiDailyCap.ts: maps 429 ROMAN_RATE_LIMIT (Retry-After), 503 ROMAN_CAPACITY_REACHED (HTTP + in-stream; b#669), 429 AI_DAILY_QUOTA_EXCEEDED (legacy `error` slot) to a cap with a reset time; uncoded 429 (throttle) stays the short wait.
- src/components/ai/AiDailyCapModal.tsx: owner words verbatim + "AI help resets today at 5:00 PM." (local) + what keeps working; OK closes.
- romanApi / useRomanChat / RomanChatScreen: kind `dailyCap`; pop-up replaces the inline row; draft kept (before store) or stored turn kept (in-stream); composer never blocked (crisis turns are never capped server-side).
- AIGuideScreen: 429 AI_DAILY_QUOTA_EXCEEDED -> pop-up, draft back, nothing saved (was the generic "service problem" reply).

## Configured caps (backend)
- Roman per person: ROMAN_RATE_LIMIT_FREE_PER_DAY = 50 user turns / rolling 24 h (clients resolve to free; pro 500). Constant in src/roman/roman.constants.ts, no env.
- Roman spend: env ROMAN_DAILY_COST_CAP_USD, default 25 USD / UTC day (b#669 6386c00b). GLOBAL: assertDailyCapacity sums all `roman.chat` ledger rows, no requester filter.
- AI guide: DAILY_TOKEN_QUOTA = 12,000 tokens / UTC day per person, each call reserves PER_CALL_TOKEN_RESERVATION 6,600 first (pre-check rejects once consumed > 5,400). Constant in src/ai/ai.service.ts, no env.

## Operator decisions (recommended defaults)
1. ROMAN_CAPACITY_REACHED is a server-wide spend cap, not per client: one heavy day makes every client see "You've used your maximum AI allotment today." after one message (false claim). Default: b#669 fix round scopes the spend cap per client (requester_id filter) or adds a per-client spend cap; mobile mapping unchanged (same code).
2. AI guide quota may not be "rare": each call reserves 6,600 of 12,000, so the pre-check refuses once the day's actual use passes 5,400 tokens (a handful of long-context messages). Default: backend raises DAILY_TOKEN_QUOTA (and makes it env-configurable) or retires the AI guide in favour of Roman.
3. AI guide (/ai/chat) has no crisis short-circuit on the backend, so a capped client's crisis message there gets the pop-up, not 988/911. Default: backend follow-up runs the SafetyRouter before reserveDailyTokens.
4. Uncoded 429 (burst throttle) keeps the short wait copy, not the pop-up. Default: keep.
5. Coach pool (COACH_AI_BUDGET_EXHAUSTED) is not mapped here (own code and copy per SoT). Default: separate job.

- Comment: FIX ROUND 1 (OPENING, M-ROMANCAP-122, agent 122) + READY FOR AUDIT https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/379#issuecomment-6006235540 (17:15 PDT).

## HANDOFF
- DONE 17:15 PDT. m#379 @ 67d9aaa33afe9740201f8e110649967c832bd461, PR CI green, READY FOR AUDIT posted.
- Worktree removed; ci/M-ROMANCAP-122-1 branch deleted; branch agent122/roman-daily-cap-popup stays (PR head).
- Next: AUD pair on m#379 (lens claims: mobile-379-67d9aaa3-{opus,sol}). Backend follow-ups are operator decisions 1-3 above (not mobile).
- Artifacts: ops/aud-122/M-ROMANCAP-122/{PR_BODY.md,comment1.md,prci1.log}.
