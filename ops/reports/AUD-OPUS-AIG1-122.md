# AUD-OPUS-AIG1-122 — Claude Opus 5.5 lens, growth-project-backend#736 (AI guide crisis reply before the daily limit, T4)

Agent 122 lens. Started 17:37 PDT 2026-10-05; verdict posted about 17:42 PDT. Claim: ops/lanes122/claims/backend-736-f2dd87ad-opus.

## Verdict
AUDIT Claude Opus 5.5 — growth-project-backend#736 @ f2dd87ad8cf57906e5693413a6a61f9ec88dd8d5 — VERDICT: REQUEST CHANGES
A/B/C = 0/2/6. Comment: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/736#issuecomment-6006734594
Full text: ops/aud-122/AUD-OPUS-AIG1-122/verdict-736-f2dd87ad.md. CI at the head: all 16 checks green. Size: 213 lines.

## Checked and fine
- The crisis check is the first statement of AiService.chat (src/ai/ai.service.ts:391). It runs before contextSvc.build, egress.assertMaySend
  (consent), reserveDailyTokens (limit) and the model. It writes no quota, audit or analytics row.
- Non-crisis messages are unchanged: the limit still returns 429 AI_DAILY_QUOTA_EXCEEDED.
- Both replies are impersonal and correct: self_harm gives 988 call or text plus 911; emergency gives 911 or the local number.
- Mobile AIGuideScreen (mobile main a9bd947) keeps send enabled after the cap pop-up and renders `reply`, so the story works end to end.

## Bs
- B-736-1 (regression, every client): crisis replies replace normal answers to ordinary fitness phrases.
  - src/ai/ai-crisis-router.ts:54: the bare word `overdose` or `poisoning` gives the 911 reply ("overdose on cardio", "can you overdose on creatine?",
    "how much protein is an overdose", "mercury poisoning from tuna").
  - :70: `hurt myself` gives the 988 reply ("hurt myself deadlifting last week, can I train").
  - :36: breathing-technique questions give the 911 reply ("hard to breathe during heavy squats").
  - :42: "unconscious snacking" gives the 911 reply.
  - The fix rule and the acceptance phrases are in the comment.
- B-736-2 (crisis miss): SELF_HARM :62-83 misses "I am going to hang myself", "shoot myself", "jump off a bridge/roof", "slit my wrists"
  and "I just want it all to end". A client at the limit gets the limit pop-up. Fix: add the method phrases listed in the comment.
- Probe (a pure function, transpiled in memory plus node; no jest/tsc/npm): ops/aud-122/AUD-OPUS-AIG1-122/probe.js, probe-output.txt.

## Cs
- C-736-1: the 20/h throttle runs before the crisis check (builder follow-up). No normal-use story.
- C-736-2: ClientEntitlementGuard 403 comes first (outside this diff).
- C-736-3: shared pattern list with Roman. Roman's safety-router (origin/agent115/roman-split-b-guardrails) has the same B-736-1 patterns.
  This is for the operator to raise on the Roman PR; it does not block #736.
- C-736-4: hyperbole such as "want to die" or "killing myself at the gym" gets a crisis reply. Conservative routing is acceptable.
- C-736-5: the emergency text for an intentional overdose has no 988 line.
- C-736-6: daily limit size and slang or passive phrases ("kms", "disappear forever"). C (edge, deferred).

## HANDOFF
- Done: one verdict posted at f2dd87ad. No worktree was created and no branches were pushed, so there is nothing to clean up. The claim file stays.
- Next: the builder fixes B-736-1 and B-736-2 in one round. A fresh Opus lens then runs a delta re-review (20 min) and checks only:
  1. The 12 fitness phrases now return null.
  2. The 7 method phrases now return self_harm.
  3. The story phrases still route: "I want to kill myself" and "I want to die" give self_harm; "I took a whole bottle of pills",
     "I took 20 of my sleeping pills", "I overdosed" and "I can't breathe" give emergency.
  4. The changed lines break nothing.
  Rerun the probe with `node probe.js` after copying the new ai-crisis-router.ts into this folder; probe-output.txt is the baseline.
- Operator: decide whether the Roman PR should get the same false-positive fix (C-736-3).
