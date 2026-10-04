FIX ROUND 15 (merge-only restack, B-FEES15-118, agent 118) — growth-project-backend#697 @ 45ebb1e18764c2dbe72475317fe24cda8e5bc91e

Builder: agent 118, job B-FEES15-118, fees lock held. Merge commit of #684 F4 round 15 (`bbf2eac677b01c07222cd49baf2e13d3da1c0ae0`) into this piece (old head `b8b63e63`); merged cleanly, no conflict, no content edit. Own-diff patch-id `c27f641ff50e` unchanged; size 1,837 (+1,837 / -0), unchanged.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none in this piece | merge of the lower pieces' round 15 (F2 B-682-9 test-only; F3 Sol B-683-1 and B-683-5 in `charge-settlement.service.ts`) | `45ebb1e18764c2dbe72475317fe24cda8e5bc91e` | build-and-test at this head |

Prior probe replay: no lens probe branch exists for #697 (tests-only piece). Its own specs (`s-fee-charge-settlement`, `s-fee-r11-fx-cash-truncation-logs`, `s-fee-r13-refund-list-notices-deadline`, `s-fee-r11-ledger-identity-diagnostics`, `s-fee-settlement-sweep`) pass in build-and-test at this head and locally at the fees top; the F3 round-15 spec passes at #684 below it ([run 37220635340](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220635340)).

Money self-check (merge-only; the behaviour change comes from F3 round 15):
- Webhook order and redelivery: a refund deferred before the fee is known settles in the settlement currency; redelivery and replay move nothing (F3 spec green here).
- Concurrency (two workers, lock order): unchanged; per-charge lock and fence as before; a run never clears the retry flag it raised.
- Terminal states (refunded, disputed, canceled, deleted account): unchanged paths; this piece's specs green.
- List pagination and completeness: unchanged; incomplete Stripe lists fail closed (refund list unreadable at settle keeps the row awaiting).
- Currency (presentment vs settlement, minor units): converted charges book settlement-currency minor units only.
- Copy truth: no copy change.

R75 operator item (not changed here; merge-only piece): `check-r75 --mode=range` main..`45ebb1e1` (and at #685 and the fees top #686) reports one positive class, `as unknown as` +1 in `test/s-fee-r13-refund-list-notices-deadline.spec.ts:140` (`settlementModule as unknown as Record<...>`), added by round 13 `e30901b5`; #684 below is OK. A scratch merge with recurring top #701 `67905b43` nets it to 0. Recommended default: a #697 builder replaces it with a typed form in the next fees round; until then the fees stack lands only together with the recurring stack.

CI at this head: every check green (build-and-test [run 37220308181](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220308181), Schema parity, rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, npm audit, size-label, test-deploy-readiness, comment-deploy-readiness); deploy-readiness-gate skipped (conditional, as before).

READY FOR AUDIT
