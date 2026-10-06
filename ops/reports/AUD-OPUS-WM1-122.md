# AUD-OPUS-WM1-122: wizard W3 and money screens delta, m#347-#351 (Claude Opus 5.5 lens, agent 122)

Started 16:46 PDT 10-05. Verdicts posted 16:54-16:55. Finished 16:56 (time box 35 min; used about 10).
Repo: growth-project-mobile. Read-only: no worktree, no push, no probes, no local runs. Backend reference: growth-project-backend origin/main 95b0a05d (read with git show only; checkout unchanged).
Claims: ops/lanes122/claims/mobile-{347-ee8a7777,348-dca7e527,349-8603080a,350-3dbd4b1d,351-7bf7d696}-opus.
Notes and comment bodies: ops/aud-122/AUD-OPUS-WM1-122/ (c347.md to c351.md, posted.txt, CI job logs).

## Verdicts (all at the exact heads, re-checked just before posting)

| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #347 | ee8a7777f8411283304d17a319b2e474970da593 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6005876406 |
| #348 | dca7e527bd6d8480c8d93b3591eca13429c6b7a0 | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/348#issuecomment-6005876885 |
| #349 | 8603080a1c01581c04af0f01c63c23d9fad44e1f | APPROVE | 0/0/1 (+ carried Cs) | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349#issuecomment-6005877378 |
| #350 | 3dbd4b1d81f624bc09cd2b1f75554220de522c54 | APPROVE (merge-only) | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/350#issuecomment-6005877812 |
| #351 | 7bf7d6961df3e9586a1797452b524eed227a3fb2 | APPROVE (merge-only) | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/351#issuecomment-6005878224 |

## Prior Opus Bs
- B-349-1 (the charge detail presented a recurring plan's whole history as one payment) is CLOSED by 06ffbc24.
  - The header shows one payment with its cadence (`chargeHeadline`).
  - The breakdown is headed "This plan so far" and its first row reads "Clients paid so far".
  - A failed renewal on a plan that has paid before (`failed` and `settled`) keeps the breakdown, says the latest payment failed, and no longer says the client was not charged.
  - One-time charges are unchanged.
  - Tests: moneyChargeTruth.test.tsx.
- #347 and #348 had no open Opus Bs.

## Changed lines checked against backend main
- #347 B-347-1: the $0 one-time edit is accepted by the backend (`@Min(0)`; `assertValidPricing` allows free one-time; the floor applies only when the price config changes).
- #347 B-347-3: the publish route exists and returns the row. `isLivePackage` treats a row with no `published_at` as live, so legacy packages never show the draft line.
- #348: the "Not paid yet" label for `pending` is true against `toCharge`, `coach-money.service.ts:1651-1662`.
- #349: the new held-balance note matches the PayeeRecovery definition.

## Merge-only proof
- Every merge in 08c7416e/d55e6f56/53e36aaf/040a6a4e/f30c5dbb..new heads has a tree equal to `git merge-tree --write-tree` of its parents: dca7e527, 3690573, 8603080a, 3732d09, 3dbd4b1d, 4058546, 7bf7d696.
- The only non-merge commits are ee8a7777, 5ef94300 and 06ffbc24.
- The own-diff patch-ids for #348, #349, #350 and #351 are unchanged.
- #350's money.test.tsx blob is the same (41bdb865).

## CI
- PR CI is green at #347, #348 and #351.
- #349 and #350 are red by design: exactly 3 tests in paymentsConnectPackages and coachSaasBlockers fail (the retired Earnings routes). #351 retires them.
- Lane 37389877466 is green at 7bf7d696 plus lane files only (tsc plus 11 specs).

## Cs (follow-up, no fix now)
- C-347-6: "Make <name> live" publishes the saved row and ignores edits that were typed but not saved. Fix: disable it while the form is dirty, or save first.
- C-349-5: the pending card's "A free trial is billed when it ends." shows on one-time pending charges too. Fix: show it on recurring charges only.
- Carried: C-349-2/3/4 and C-332-4/5.

## HANDOFF
- Done: all 5 Opus verdicts are posted (APPROVE x5). Nothing is in flight.
- No worktrees or branches were created, so there is nothing to clean up.
- No lane runs were pushed.
- Next (operator): check Sol's verdicts at the same 5 heads.
  - With dual APPROVE, the train lands as one by A5 rule 11: #351 -> #350 -> #349 -> #348, then the stack bottom.
  - #345 and #346 are already dual APPROVE.
- If any head moves, a fresh Opus lens reviews only the delta from the heads above.
