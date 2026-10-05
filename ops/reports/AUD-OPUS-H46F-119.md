# AUD-OPUS-H46F-119: Claude Opus 5.5 lens, Health Connect #362 FIX ROUND 5, #363, #364 (T4: health data, SHORT delta)

- **Operator:** agent 119.
- **Run time:** 15:28-15:38 PDT 10-04. All times come from `TZ=America/Los_Angeles date`.
- **Claims (15:29):** ops/lanes119/claims/ mobile-362-261e7d4c-opus, mobile-363-5266d658-opus and mobile-364-1266038c-opus.
- **Notes:** ops/aud-119/AUD-OPUS-H46F-119/. It holds:
  - 362-delta.diff
  - verdict-{362,363,364}.md
  - posted-{362,363,364}.txt
  - run37240428066.log and run37240438780.log
  - probes/onDeviceState.opus119e.test.ts (the H46E probe with C-362-13 flipped to null)
  - probes/onDeviceState.opus119f.test.ts (new, 8 cases)

## Verdicts posted
Each head was re-read just before posting (15:37) and was unchanged.

| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile #362 (H4) | 261e7d4c37429c65bf8e84468c5521380ff5b0cc | APPROVE | 0/0/2 (C-362-14 rated C, C-362-15 new) | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5985217014 |
| mobile #363 (H5) | 5266d6587cdccb4f01d9a3f33bb1c80a402be747 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5985217271 |
| mobile #364 (H6) | 1266038cd311f3dcfd8e472c04e3241a3061866b | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5985217588 |

**PR CI.** "Typecheck, lint, test" is green at every head:

| PR | Run |
|---|---|
| #362 | 37239676176 |
| #363 | 37239694880 |
| #364 | 37239695876 |

Analyze runs only on PRs based on main.

## Facts verified
- **#362 delta (df44285d..261e7d4c).** One commit and two files: onDeviceState.ts (+47/-4) and authActions.ts (+3/-6). Every line was read.
- **C-362-12 / Sol B-362-7: closed.**
  - The sign-out epoch drops every write still queued.
  - `signedOutThroughSeq` voids earlier grants for the rest of the run.
  - The prefix removal is chained behind the write in flight. Its promise never rejects and is awaited in signOut's `Promise.all`.
  - The raw prefix sweep is gone.
- **C-362-13: closed.** A failed grant write restores the previous `authWrittenAt` value.
- **Stale Connect after sign-out is fenced.** `assertCurrent` re-checks the generation after its await, and only microtasks run between that check and the sequence bump.
- **#363.** ec2d1dac adds tests only (Sol's sol119e unchanged plus signOutDrain, 7 cases). The merge 5266d658 is pure (tree 91cc4d07 matches `git merge-tree`).
- **#364.** The merge is pure (tree 027f7537). The delta is byte-identical to #363's, and the own-diff patch-id is e50c714e at both heads.

## Probes (CI lane)
- **Run 37240428066 at #362 + probes:** 13 suites, 167/167 pass.
- **Run 37240438780 at the #364 top:** 63 suites, 757/758 pass.
  - This is the B-HC7 top list plus opus119f.
  - The single failure is the superseded AUD-SOL-H6-118 audit364.samsungRetirement expectation (SAMSUNG_HEALTH vs HEALTH_CONNECT). Its adapted hc4 copy passes, so the failure is by design.

## Follow-ups (C)
- **C-362-14 (rated C).** Location: onDeviceState.ts `retireOnDeviceStateAtSignOut`.
  - Problem: if the removal fails, the grant is voided for this run only. After a restart, the same account reads the old grant again (another account still reads null).
  - Fix rule: persist a sign-out marker or pending-removal list, and retry the removal at launch before any grant read.
  - Test: the restart case (DOCUMENTS C-362-14 in opus119f) should then see null.
- **C-362-15 (new).** Location: onDeviceState.ts, the `recordLocalAuthorization` catch block.
  - Problem: when two overlapping grant writes both fail, the second restores the first one's failed sequence, so an older Disconnect keeps the old grant.
  - Fix rule: keep a committed-sequence map that is set only after `setItem` resolves, and restore from it on failure.
  - Test: flip DOCUMENTS C-362-15 to null.
- **Carried open:** C-362-3 remainder, C-362-4, C-362-5, C-362-7, C-362-8, C-362-9, C-362-10, C-363-1, C-364-1..5, H3 INGEST_DISABLED_COPY.
- **Closed:** C-362-12 and C-362-13 (by 261e7d4c).

## Operator decisions (recommended defaults)
1. **C-362-14.** Ticket it as a C (default). It stays within the account that granted it, needs a storage failure, and matches the behaviour before this round.
2. **C-362-15.** Ticket it as a C (default).
3. **#363 SIZE ASSESSMENT.** Keep (default). It is 1,944 lines, test-only and grandfathered.
4. **#362 size.** It is at 2,983 of its 3,000 ceiling. Any further fix needs its tests in #363.

## HANDOFF
- **Verdicts.** Opus APPROVE at all three current heads: #362 261e7d4c, #363 5266d658, #364 1266038c.
- **Next step.** Sol's H46F verdict decides whether H1-H6 land as one, with Analyze at the main-based landing. If any head moves, a fresh Opus lens posts a delta from these heads and replays the probes from:
  - ops/aud-119/AUD-OPUS-H46F-119/probes/ (use this opus119e copy, not the H46E one)
  - ops/aud-119/AUD-OPUS-H46D-119/probes/
  - ops/aud-119/AUD-OPUS-H46-119/probes/
  - ops/aud-118/AUD-OPUS-H6-118/*.test.*
  - ops/aud-118/AUD-OPUS-H45-118/probes/

  At the #364 top, use ops/reports/B-HC7-119-probes.sh and B-HC7-119-specs-top.txt.
- **Cleanup.**
  - Done: audit/AUD-OPUS-H46F-119/{362,364}-probes deleted at 15:38, worktrees wt/AUD-OPUS-H46F-119-{1,2} removed, claims left in place.
  - Not done, by design: no push to a PR branch, no merge, no build or dispatch.
