AUDIT Claude Opus 5.5 — growth-project-backend#697 @ be7efc09d8a2caa2252b7ac51081e5ed6b8fa214 — VERDICT: APPROVE
A/B/C = 0/0/0

AUD-OPUS-FL2-119, agent 119. Delta from my APPROVE at c2585c97, every line read.
- afe59a5d adds test/s-fee-r19-refund-cas-send-window.spec.ts (515 lines). 57972e21 and be7efc09 are type and format edits to the same spec only.
- f70234ff merges #684 c1a07d9c. Its tree b2f5dda8 equals `git merge-tree --write-tree afe59a5d c1a07d9c`: no hand edits.
- The rest of this PR's own diff is unchanged. Excluding the r19 spec, patch-id bf28b411 is the same as at c2585c97.

**The r19 spec** asserts exact amounts (4,900 charge, 172 fee, net 4,630).
- B-684-12, a paused writer at each write point:
  - refund.updated and charge.refund.updated: failed or canceled wins.
  - charge.refunded snapshot vs failure: refunded_cents stays 0.
  - The failed writer paused while succeeded applies: flagged once, with 1 reversal.
  - Stale pending: applied once.
  - P2002 insert race.
  - Bounded 5-retry fail-closed with net unchanged.
  - Legacy writer keeps failed and its failure_reason.
- Sol B-684-3, each boundary:
  - Email-attempt write past the deadline.
  - Stolen attempt number.
  - Real pushToUser token read past the claim: Expo never called.
  - Real EmailService insert past the claim: transport never called, key e2 next run.
  - The signal's timer and clock read.
- This closes my C-697-3: L0-L3 are covered here, and my original probe also passes unchanged.

**Proof**
- My replay is https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37236744088 at this head plus my probes: 7 suites, 68/68 pass.
- The builder's failing-before run 37234800001 at c2585c97 (17 fail) confirms that the new cases bite.

Size: 2,791 (grandfathered, ceiling 3,000). CI: required checks green at this head (pass=10, skipping=1).
