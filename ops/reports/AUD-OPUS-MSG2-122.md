# AUD-OPUS-MSG2-122: Opus lens, growth-project-mobile#377 delta re-review (agent 122)

- Started 16:58 PDT, posted 17:01 PDT, 2026-10-05 (times from `TZ=America/Los_Angeles date`). Time box: 20 minutes.
- PR: growth-project-mobile#377, head fae228c8f1609c24f9a581c74393b072eea23c12. The previous head was 316f0a130012509f498b36993ec304f0dc151b3a. The base is m#371 at d4244f2cab5a3d89124a5f56221ef389527d525b, unchanged.
- Claim: ops/lanes122/claims/mobile-377-fae228c8-opus
- Verdict: **APPROVE**, A/B/C = 0/0/1
- Comment: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6005987765
- Verdict text: ops/aud-122/AUD-OPUS-MSG2-122/verdict_377_fae228c8.md

## Findings
- B-377-1 (my round-1 B, comment 6005697049) is closed. `reconcilePending` (src/screens/client/MessagesScreen.tsx:792-793) now drops a keyed pending row only when the server returns the same `client_message_id`. Unkeyed legacy rows keep the old body and age rules.
- The backend returns `client_message_id` in both flag states. `listThread` uses `findMany` with no select, and the flag-ON `serializeMessage` spreads `...rest`. The mobile side maps it through `readThreadV2Fields`, so a send that did land still clears.
- Proof: lane run 37390700458 (ci/B-MSG2-122-377 @ 7bf314b4, which is this head plus lane files and probes only). tsc is green and 10/10 suites pass with 77/77 tests, including my AuditMsg1Probe.test.ts (byte-identical to the round-1 probe). PR CI run 37390955305 is green at this head.
- Delta: one commit, 2 files, 8 added lines. Size against #371 is 1,420 + 80 = 1,500, at the cap. That is allowed, because a PR fails only above 1,500.
- C-377-7 (edge, deferred to 10k clients): a keyed unsent row no longer ages out after it falls off the 100-message page.
- Round-1 Cs C-377-2..6 carry over unchanged.

## Process notes
- I did not read the Sol lens's work for this round before posting.
- I pushed nothing and merged nothing.
- I used one read-only worktree, wt/AUD-OPUS-MSG2-122-1, and have removed it.
- I created no ci/* or audit/* branches this round, and no lane runs of my own.

## HANDOFF
Done. The Opus verdict is posted at the exact head fae228c8. Nothing remains for this lens. If the #377 head moves, a fresh Opus lens does a delta check from fae228c8 to the new head and posts at the new head. For a pure main merge, the operator can use the A5 rule 12 tree check instead. The operator merges once the Sol verdict at fae228c8 is APPROVE and the stack order allows (m#371 first, or land as one).
