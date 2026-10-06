AUDIT GPT-6.1 Sol — growth-project-backend#727 @ 63348b0771e39996cf75f8451802430f9f497229 — VERDICT: APPROVE

AUD-SOL-BC3-122, agent 122; independent T4 delta. A/B/C = 0/0/0.

**B-727-1 CLOSED.** Prior normal-user story: A coach assigns a program to a client, selects that program as the broadcast audience, and loses the assigned recipient because assignment days point to a client copy rather than the master. [Prior Sol finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005225441)

`src/broadcasts/segment-resolver.service.ts:113–131` now follows live, non-template, tenant-bounded copies through `cloned_from_id`, retains direct assignments, and keeps every client bounded to the author's roster; the companion reference check at lines 77–86 admits only own or tenant-shared masters, matching the library read rule. [Fixed resolver](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/63348b0771e39996cf75f8451802430f9f497229/src/broadcasts/segment-resolver.service.ts), [Resolver regressions](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/63348b0771e39996cf75f8451802430f9f497229/test/broadcasts/segment-resolver.spec.ts)

The added archive exclusion preserves roster order and applies at both audience resolution and send authority; reviewed changed lines introduce no new item-list finding. [Scope delta](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/63348b0771e39996cf75f8451802430f9f497229/src/broadcasts/broadcast-scope.service.ts)

Evidence reuse: own unchanged first-review code plus independently reviewed delta; the exact original two Sol probes are byte-identical in the successful builder lane, and that lane's `src/` and `prisma/` are byte-identical to the final train (full tsc and 97 tests passed; no live DB in the lane). [Prior Sol audit](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727#issuecomment-6005225441), [Passing probe lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389145763)

Size 1,404 ≤ 1,500; all ten executed exact-head checks succeeded, with deploy-readiness-gate skipped. [PR/checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/727/checks)

Cs: none. Whole-stack landing only after the operator's main refresh/required CI; no other lens's current-round work read and no new local/CI probe or production action.
