FIX ROUND 15 (merge-only restack, B-FEES15-118, agent 118) — growth-project-backend#685 @ 07fd138938bb29e2cc3296fafafc2f050a3bf8d8

Builder: agent 118, job B-FEES15-118, fees lock held. Merge commit of #697 F4b round 15 (`45ebb1e18764c2dbe72475317fe24cda8e5bc91e`) into this piece (old head `8dc2c2ed`); merged cleanly, no conflict, no content edit. Own-diff patch-id `d88942b5b1d2` unchanged; size 2,958 (+2,958 / -0), unchanged.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none in this piece | merge of the lower pieces' round 15 (F2 B-682-9 test-only; F3 Sol B-683-1 and B-683-5 in `charge-settlement.service.ts`) | `07fd138938bb29e2cc3296fafafc2f050a3bf8d8` | build-and-test at this head |

Prior probe replay: Opus AUD-OPUS-F56-116 canary and mutants (`de2f96ab`, run on the F6 head) replayed at the fees top #686 `5937064f`, which contains this piece ([run 37220644877](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220644877)): CONTROL block (conc, r4, r5, r9, r7, r8, renew) all green; the C-685-2 canary controls and acceptance both green (closed in F2 round 11); all four mutants killed (fee-190bps 41 failures, fence-always-passes 3, no-send-start-budget 3, no-forward-netting 7). Sol's #685 verdict ran no probe branch.

Money self-check (merge-only; the behaviour change comes from F3 round 15):
- Webhook order and redelivery: a refund deferred before the fee is known settles in the settlement currency; redelivery and replay move nothing (F3 spec green here).
- Concurrency (two workers, lock order): unchanged; per-charge lock and fence as before; a run never clears the retry flag it raised.
- Terminal states (refunded, disputed, canceled, deleted account): unchanged paths; this piece's specs green.
- List pagination and completeness: unchanged; incomplete Stripe lists fail closed (refund list unreadable at settle keeps the row awaiting).
- Currency (presentment vs settlement, minor units): converted charges book settlement-currency minor units only.
- Copy truth: no copy change.

R75 (main..`07fd1389`): the only positive class is #697's `as unknown as` +1 (`test/s-fee-r13-refund-list-notices-deadline.spec.ts:140`, operator item in the #697 FIX ROUND); this piece adds none.

CI at this head: every check green (build-and-test [run 37220310173](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220310173), Schema parity, rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, npm audit, size-label, test-deploy-readiness, comment-deploy-readiness); deploy-readiness-gate skipped (conditional, as before).

READY FOR AUDIT
