# AUD-OPUS-RMN1-122 (Claude Opus 5.5 lens, agent 122) — Roman backend b#667, #665, #666, #668 after FIX ROUND 1 (T4)

Started 16:11 PDT 2026-10-05; verdicts posted 16:24:38 PDT; done 16:25 (times from `TZ=America/Los_Angeles date`).
Brief: ops/lanes122/_COMMON_122.md + JOBS122.md entry "AUD-OPUS-RMN1-122 / AUD-SOL-RMN1-122". RUTHLESS SCOPE, item-list only.
Independence: Sol's RMN1 notes, report and comments were not read before posting (the AUD-SOL-RMN1-122 worktrees were left alone).

## Heads (checked on GitHub at 16:12 and again at 16:24:29, right before posting; unchanged)
- #667 c5102cae659f87a4487a5756c52e8ab303664968 (base main d23fa317, 2,387/3,000)
- #665 4dde3ffed2f21937bc036203eb90afc0d84ecd5e (base #667, 2,992/3,000)
- #666 a3eb3206d3805dc765962528b6a1a3ab6e085b09 (base agent115/roman-split-a-context, 2,167/3,000)
- #668 dabed7388157c64a50ff32bc8e7e003c001af339 (base #666, 2,368/3,000)
Claims: ops/lanes122/claims/backend-{667-c5102cae,665-4dde3ffe,666-a3eb3206,668-dabed738}-opus.

## Verdicts posted
| PR | Verdict | A/B/C | Comment |
|---|---|---|---|
| #667 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/667#issuecomment-6005343285 |
| #665 | APPROVE | 0/0/2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/665#issuecomment-6005343486 |
| #666 | REQUEST CHANGES | 1/0/4 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/666#issuecomment-6005343708 |
| #668 | APPROVE | 0/0/5 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/668#issuecomment-6005343995 |
Comment bodies: ops/aud-122/AUD-OPUS-RMN1-122/comments/c{667,665,666,668}.md.

## Open finding (blocks the train)
- A-666-2 (crisis routing miss, same class as A-666-1, graded A by that precedent). safety-router.ts:72-87 (SELF_HARM), :68 (overdose without
  the word), :34 (chest). Normal-user story: a client in crisis types "I have been thinking about ending my life" and gets an ordinary model
  reply with no safety hint, or (no box-2 grant) a 403 ai_consent_required, instead of the 988 template. Probe: 7/7 ordinary phrasings ->
  `normal` ("ending my life", "take my own life", "take my life tonight", "ending it all", "end my own life", "don't see the point in living
  anymore", "better off without me"); INFO: "I took 20 of my sleeping pills" / "a bunch of pills" -> normal; "My chest hurts and my left arm
  is numb" -> injury_pain. Fix rule in the #666 comment (regex forms + 9 golden positives + negatives). Verify: re-run
  ops/aud-122/AUD-OPUS-RMN1-122/probes/audit-opus-rmn1-122.probe.spec.ts; all FINDING tests must pass, CONTROL stays green.

## Prior findings closed (verified in code + lane)
- #667 B-667-1 (draft, partial screen = completed): fixed (roman-consultation.source.ts:114-120).
- #665 B-665-1 (providers summed), B-665-2 (context/me while locked), B-665-3 (sub-coach rows): fixed (service.ts:1289-1307; guard :99/:220;
  service.ts:408-409). Dunning lockout specs PASS in the lane.
- #666 A-666-1, B-666-1, B-666-2, B-666-3: fixed (lane: rb121, guardrails, round2 PASS; my controls pass).
- #668 B-668-1 (coach AI pool): fixed; probe 3/3 PASS (open pool -> 1 debit {coach-1, roman.chat, 1 cent}; exhausted -> 402 before any
  provider call, no debit, no figures in client copy; crisis with exhausted pool -> 988 template, no pool call). C-668-5 fixed.

## CI / evidence
- PR CI at all four heads: cancelled (runner incident); no green required checks exist at these heads.
- Lane 1 (integrated stack = #668 dabed738 + merge #665 4dde3ffe (clean) + merge main 5cde6253 (clean) + tsc):
  https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37387249148 — tsc green; 19 suites PASS (all context,
  guardrails, streaming, service, prompts, lockout specs), 3 FAIL = 12 tests: 11 are mock fallout of B-668-1 (`this.roman.assertCoachPoolOpen
  is not a function` in roman.controller.spec.ts x2, roman-sse-error-contract.spec.ts x9) + the by-design FR1-651-3 red. Log:
  ops/aud-122/AUD-OPUS-RMN1-122/lane1-full.log.
- Lane 2 (crisis probe): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37387579682 (7 failed = A-666-2).
- Lane 3 (pool probe + crisis probe): https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37387916857 (pool 3/3
  PASS; crisis 7 failed again). Logs lane2-probe.log, lane3-probes.log.
- Probe specs + lane commit list: ops/aud-122/AUD-OPUS-RMN1-122/probes/.

## Follow-ups (C)
- C-667-1 docs/roman-client-context.md:1 ctx-v2 (code v3), :29 "Never read: CoachingSession" vs the narrow booking select.
- C-665-2 invalidation comment overstates callers (edge, deferred to 10k clients). C-665-3 macro simple display mode not carried.
- C-666-4 U+FE15/U+00A1 scrub; C-666-5 safety-copy doc v2 vs v3; C-666-6 coachless "Message your coach"; C-666-7 conservative 911 -> #670.
- C-668-6 11 mock tests red (stub assertCoachPoolOpen) -> #669 fix commit. C-668-7 OR-115-1: roman.service.ts:961 still writes
  roman.safety_emergency / roman.safety_self_harm (carried to #669; #668 must not land without it). C-668-2 coach-surface crisis template.
  C-668-3 req.on('close'). C-668-4 duplicate romanErrorTag.

## Operator decisions (recommended defaults)
1. Restack: #666 and #668 are built on #665's OLD head eb7cb7a8, so #665's fixes (lockout, sub-coach, wearables) are not in them. Default:
   when A-666-2 is fixed, the builder merges #665 4dde3ffe into #666 and #666 into #668 in the same round (the merge is clean, proven in lane
   1); lenses do a merge-only delta.
2. Locked client and Roman turns: a dunning-locked client can still post Roman turns (/roman/* carve-out); each turn is grounded with the
   coach's plan, meal plan and guidelines and debits the coach pool, while 13:37 locked GET /roman/context/me for the same data. Default:
   ground a locked caller's turn without coach-owned blocks (one check in loadTurnBundle), or rule that Roman stays fully open while locked.
3. C-668-6 home: Default: #669's fix commit stubs assertCoachPoolOpen (it already owns the B-668-1 tests); #668 is red until then and lands
   with #669 (A5 rule 11).
4. A-666-2 severity: graded A by the A-666-1 precedent. Default: fix in #666 now (small regex change + golden tests), before C2.

## HANDOFF
- Done 16:25 PDT. Four verdicts posted at the exact heads above. Next: builder fixes A-666-2 in #666 and restacks #665 -> #666 -> #668
  (decision 1); a fresh Opus lens re-reviews #666 (delta: A-666-2 + changed lines; re-run probes/audit-opus-rmn1-122.probe.spec.ts) and
  merge-only deltas on #668 (and #666's #665 merge). #667/#665 approvals stand unless their heads move.
- Cleanup: my worktree wt/AUD-OPUS-RMN1-122-lane removed; remote branches audit/AUD-OPUS-RMN1-122/stack-{1,2,3} deleted; no lane run in
  flight. Claims files left in ops/lanes122/claims/ for the operator. No locks held. Main clone checkout untouched.
