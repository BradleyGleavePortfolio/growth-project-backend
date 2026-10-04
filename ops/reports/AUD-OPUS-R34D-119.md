# AUD-OPUS-R34D-119 — Claude Opus 5.5 lens, recurring R3 #680 + R4 #696 FIX ROUND 7 (+ R5 #701 restack) (T4)

Started 13:34 PDT 10-04. Claims: lanes119/claims/backend-680-f267417a-opus, backend-696-13c9a6c8-opus, backend-701-d624144c-opus.
Notes, verdict texts, the probe spec and the run log are in /home/user/workspace/ops/aud-119/AUD-OPUS-R34D-119/:
- verdict-680.md, verdict-696.md, verdict-701.md
- fix-680.diff
- aud-opus-r34d-119-probe.spec.ts
- run-37232952084.log
- comments.txt

## Verdicts (posted 13:58 PDT)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| #680 R3 | f267417a3ccd0864d3c8ba848323da16225d7aab | APPROVE | 0/0/7 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/680#issuecomment-5984321005 |
| #696 R4 | 13c9a6c8a8f237f1d2ebf2cf280828f2fed778cb | APPROVE | 0/0/0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/696#issuecomment-5984321161 |
| #701 R5 | d624144c26e957a2fc70dcd2780d208f08b84654 | REQUEST CHANGES | 0/1/0 (B-701-1 R75) | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/701#issuecomment-5984321334 |

CI at all three heads: 10 pass, 1 skip (deploy-readiness-gate). The build-and-test runs are 37232586036 (#680), 37232573191 (#696) and 37232574316 (#701).

## Evidence
- **#680 merge `bef96175`.** Diff from 216489ff equals 8bbf4a41..23d2c04c, and its tree equals the clean merge-tree 51dc1b17.
- **#680 fix `f267417a`.** +34/-21, read in full.
- **#696.** `7392761f` is merge-only (identical, clean tree). `13c9a6c8` adds only the 287-line spec.
- **#701.** `d624144c` is merge-only (identical, clean tree). It has two test files, including the byte-identical moved spec (sha 0d33b62c).
- **Closed at f267417a:**
  - Sol B-680-1 residual: all Stripe-event grant writers are fenced under the lock. The old reopen was removed safely because R2 `endUnpaid` voids, then cancels, then expires.
  - Sol B-680-2 residual: the exemption was removed; the operator accepted one redelivery.
  - Opus C-680-11 and C-680-12.
- **Probe lane** https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37232952084 at f267417a plus probes (branch audit/AUD-OPUS-R34D-119/680-probes). 38 tests: 28 pass, 10 fail.
  - Old R34-119 probe: 2 red (the no-redelivery control changed by the B-680-2 rule; C-680-13 is a follow-up). Its C-680-11 and C-680-12 cases are now green.
  - PG lock: 4/4.
  - New probe: 13 controls green. 8 expected red: C-680-18 x7 and C-680-19 x1.
- **R75 (`scripts/check-r75.js --mode=range`).**
  - #680 own range: OK. #696 own range: OK.
  - #701 own range: FAIL (as any +5).
  - Simulated merge-only restack of d624144c onto fees top 30a118dd (local commit 8a788350, not pushed), from main 3e9a9a75: FAIL (as any net +1). The same restack of #696 13c9a6c8: OK (-4).
  - Recurring stack alone vs its fees base 13c814f7: as any +15, from #678 +9, #679 +2, #680 -1, #696 0 and #701 +5.

## Findings
- **B-701-1** (#701): R75 as described above. Fix rule: the piece adds no net `as any`. Type the doubles, and do not swap to `as unknown as` / `as never`. The minimum is the 2 in b-recur7a-119-r2.spec.ts:45,47.

## Follow-ups (C)
- **C-680-18** — checkout-webhook-handler.service.ts:1826-1846 and dunning-v2.service.ts:88-91 (main). On D2 #688 the code is at dunning-v2.service.ts:957-966, where only rows with a lock are affected.
  - Problem: when the flag is on, an invoice.paid on a revoked row runs `applyImmediateClear`, which sets `entitlement_active` true. The next sub.updated then reopens the plan to `active`. Proven by the probe.
  - Fix rule: skip the clear when `purchaseHasEnded(updated)`, and make applyImmediateClear refuse revoked rows under the purchase lock.
  - HARD OBLIGATION before FEATURE_DUNNING_V2=true. Carried by whichever of recurring or D2 lands second.
- **C-680-19** — refund-dispute-handler.service.ts:952-956.
  - Problem: a won dispute writes `paid`. Once R-DISPUTE-PAUSE revokes access, the next sub.updated restores access, which breaks "no automatic restore".
  - Fix rule: a won dispute keeps a recurring row revoked; only the coach restart grants access. Belongs to the B-DUNSPLIT-119 R-DISPUTE-PAUSE build.
- **C-680-16** — refund-dispute-handler.service.ts:301-302 and 1408-1411.
  - Problem: a full refund on a recurring plan is now a permanent revocation, but Stripe keeps billing.
  - Default: pause billing in the same tx (owner decision pending).
- **C-680-7, C-680-13, C-680-14, C-680-15** — unchanged. Fix rules are in ops/reports/AUD-OPUS-R34-119.md.

## Findings for other PRs (operator)
- R1 #678 (+9 `as any`) and R2 #679 (+2) also add casts. If pieces ever land one at a time onto main, #678's own range fails R75. The composed landing is OK only once #701 nets zero.
- C-680-18 also concerns D2 #688's `applyImmediateClear`.
- C-680-19 concerns the R-DISPUTE-PAUSE build.

## Log
- 13:34 rules read; claims taken; report started.
- 13:42 delta read: merges verified identical with clean trees; fix traced (grant writers, R2 expiry, refund/dispute writers, dunning v2).
- 13:41 probe lane 37232952084 started; 13:51 results read.
- 13:52 CI green at all three heads.
- 13:55 R75 ranges and the simulated restack computed.
- 13:57 verdict drafts written.
- 13:58 heads re-read (unchanged); three verdicts posted, first lines verified.
- 13:59 audit/AUD-OPUS-R34D-119/680-probes deleted (remote and local); worktree removed; probe spec copied to the notes folder.

## Operator decisions (recommended default)
1. **B-701-1 owner.** A fresh builder types the 5 `as any` doubles in #701 (tests only, freeze-compatible B) and re-proves R75 on the own range and on the simulated fees-top restack. Default: yes, in the same pass as the fees-top restack.
2. **C-680-18.** Make it a hard merge obligation: whichever of recurring or dunning D2 #688 lands second carries the guard, and FEATURE_DUNNING_V2 stays off until it lands. Default: yes.
3. **C-680-19.** It goes into the B-DUNSPLIT-119 R-DISPUTE-PAUSE build: a won dispute keeps a recurring row revoked. Default: yes.
4. **C-680-16.** Owner decision on a full refund of a recurring plan. Default: pause billing in the same tx, as R-DISPUTE-PAUSE does.

## HANDOFF
- **State.**
  - #680 @ f267417a: Opus APPROVE 0/0/7 (5984321005).
  - #696 @ 13c9a6c8: Opus APPROVE 0/0/0 (5984321161).
  - #701 @ d624144c: Opus REQUEST CHANGES 0/1/0 (5984321334, B-701-1).
  - No audit/* branches or worktrees remain. Claims stay in lanes119/claims.
- **Next.**
  - Sol verdicts at these heads.
  - A builder round on #701 for B-701-1 only (tests). A fresh Opus lens then posts a short delta: diff 5e8f1ceb..new must touch only the two specs' casts, plus R75 OK.
- **A merge-only restack onto the final fees top** (currently 30a118dd; a fresh Opus lens checks it) must preserve:
  1. Runtime files. `git diff f267417a <new #680 head>` on the following files must equal only the fees-side changes to them (confirm with the old fees top..new fees top on the same paths), and every conflict hunk must be read:
     - checkout-webhook-handler.service.ts
     - refund-dispute-handler.service.ts
     - stripe-connect-api.service.ts
     - coach-first-payment.service.ts
     - dunning-v2.service.ts
  2. These points must be byte-identical to f267417a unless fees edits them:
     - `REVOKED_STATUSES` (6 statuses) and `purchaseHasEnded` (status in set and no access).
     - The unconditional `if (purchaseHasEnded(fresh)) return fresh;` in applyInvoicePaid under the lock, before the revision fence.
     - The `purchaseHasEnded` checks in applySubscriptionUpdated L1320, the decline L1872/L1917 and endSubscriptionPurchase L1489.
     - The decline fence with no exemption (`writeVersion(fresh) !== authority.version` redelivers).
     - `unpaid` kept on decline.
     - Lock order: package FOR UPDATE, then purchase FOR NO KEY UPDATE.
  3. If fees changes the refund/dispute status writes (refunded, chargeback_lost, disputed, won → paid), re-check that each value is in, or deliberately out of, REVOKED_STATUSES, and re-run C-680-19.
  4. Test files:
     - `git diff 13c9a6c8..<new #696>` must hold no R4 test change beyond the merge.
     - `git diff d624144c..<new #701>` must hold no R5 change beyond the merge and the B-701-1 fix.
     - The R4 spec b-recur7b-119-authority.spec.ts and the #680 b-recur5b-117 paired control (one redelivery) must survive unchanged.
  5. Gates:
     - R75: `node scripts/check-r75.js --mode=range --base=<main> --head=<new top>` must be OK. Before B-701-1 it was +1 `as any`.
     - All required checks green at each new head.
     - CodeQL, danger, banned casts and SBOM appear only on a main-based composition.
  6. Probes: re-run the probe specs in the CI lane at the new #680 head and expect the same results (28 pass, 10 known red). Copies are in ops/aud-119/AUD-OPUS-R34-119/ and ops/aud-119/AUD-OPUS-R34D-119/:
     - aud-opus-r34d-119-probe.spec.ts
     - aud-opus-r34-119-probe.spec.ts
     - aud-opus-r34-119-pg-lock.spec.ts
     If C-680-18 or C-680-19 has been fixed by then, the matching red cases must turn green.
