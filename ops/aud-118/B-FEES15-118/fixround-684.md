FIX ROUND 15 (merge-only restack, B-FEES15-118, agent 118) — growth-project-backend#684 @ bbf2eac677b01c07222cd49baf2e13d3da1c0ae0

Builder: agent 118, job B-FEES15-118, fees lock held. Merge commit of #683 F3 round 15 (`438d29e64f24e6f803a578dae56e0140a44d1c52`) into this piece (old head `7872a5335`); merged cleanly, no conflict, no content edit. Own-diff patch-id `a5d4d171b301` unchanged; size 2,435 (+2,009 / -426), unchanged.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none in this piece | merge of the lower pieces' round 15 (F2 B-682-9 test-only; F3 Sol B-683-1 and B-683-5 in `charge-settlement.service.ts`) | `bbf2eac677b01c07222cd49baf2e13d3da1c0ae0` | build-and-test at this head |

Prior probe replay at this head ([run 37220635340](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220635340), 26/26):

| Lens | Probe (branch head) | Result |
|---|---|---|
| Sol | AUD-SOL-F34-116 684-boundaries (`43f0d5dd`) | PASS |
| Sol | AUD-SOL-F34-117 684 refunds and budget (`2ca1520a`, `19cac0a9`) | PASS (both suites) |
| Opus | AUD-OPUS-F34-117 684-asyncrefund and 684pre-asyncrefund (`0fa1f3e4`, `52ebdba8`; same spec) | PASS, P1-P5 |
| builder | `test/s-fee-r15-deferred-fx-notice-flag.spec.ts` (F3 round 15) | PASS, 15/15 |

Money self-check (merge-only; the behaviour change comes from F3 round 15):
- Webhook order and redelivery: a refund deferred before the fee is known settles in the settlement currency; redelivery and replay move nothing (F3 spec green here).
- Concurrency (two workers, lock order): unchanged; per-charge lock and fence as before; a run never clears the retry flag it raised.
- Terminal states (refunded, disputed, canceled, deleted account): unchanged paths; this piece's specs green.
- List pagination and completeness: unchanged; incomplete Stripe lists fail closed (refund list unreadable at settle keeps the row awaiting).
- Currency (presentment vs settlement, minor units): converted charges book settlement-currency minor units only.
- Copy truth: no copy change.

R75 (`check-r75 --mode=range`, main..`bbf2eac6`): OK, no positive class.

CI at this head: every check green (build-and-test [run 37220306306](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220306306), Schema parity, rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, npm audit, size-label, test-deploy-readiness, comment-deploy-readiness); deploy-readiness-gate skipped (conditional, as before).

READY FOR AUDIT
