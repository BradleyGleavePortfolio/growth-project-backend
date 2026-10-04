FIX ROUND 11 (restack, merge-only) (B-F12-116, agent 116) — growth-project-backend#686 @ b5bbe806f4709d79702d0525211c106bc46afa48

Merge-only restack under the fees stack lock (taken at 03:19 UTC, released after the push). `b5bbe806` = `7be7d396` (the previous head) + a merge of F5 restack `1e446acb`. There are no content changes in this piece.
- The delta against `7be7d396` is byte-identical to the F1 + F2 round 11 delta: the `git patch-id --stable` of `git diff 7be7d396 b5bbe806` equals the patch-id of `git diff 007d3dcb a5d6a434`.
- Files: `money-diagnostics.ts` (new), `charge-lock.ts`, `split-ledger.service.ts`, `stripe-connect-api.service.ts`, `schema.prisma` (comment only), `transfer-orchestrator.service.ts`, `payout-notice-copy.ts`, `test/utils/settlement-fakes.ts`, and the two new `s-fee-r11-*` specs.
- Findings and evidence: FIX ROUND 11 on #681 and #682.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none in this piece (merge-only) | merge of the lower piece | `b5bbe806` | build-and-test [run 37173716806](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173716806/job/111351847887): red by design. The same 7 r5 copy-pin tests as #685 fail. One unrelated timing failure: `test/prod-readiness/operator-keys-artifact.spec.ts` exceeded its 10 s jest timeout. That suite is identical at F5 `1e446acb`, where it passed, and this round touches nothing it reads; no rerun was made because the sha is superseded. comment-deploy-readiness failed because the board artifact was missing after test-deploy-readiness was cancelled by the newer push. Every other context at this sha is green. |

Head moved after this push: the PR head is now `1895147dce06953061dce594220cef82f97f9e0e` (B-F34-116 round 11 on F3/F4, which contains `b5bbe806` as an ancestor). READY FOR AUDIT at that head belongs to that job's round comment, so this merge-only round does not post one for a superseded sha.

Red by design after round 11 (for whoever posts READY FOR AUDIT on this piece): `test/s-fee-r5-or-111-1.spec.ts` (in F5) pins the old first-person payout-notice strings, and 7 of its tests fail until a later #685 job updates them. Old -> new:

| # | Where (src/connect/fees/payout-notice-copy.ts) | Old | New |
|---|---|---|---|
| 1 | heldSentence, any event, held_open_cents > 0 | `We will hold {held_open} from your next sale.` | `{held_open} is held from your next sale.` |
| 2 | refund / chargeback, coach, reversed_cents > 0 | ` We took {reversed} back from that sale's payout.` | ` {reversed} was taken back from that sale's payout.` |
| 3 | refund / chargeback, head coach, reversed_cents > 0 | ` We took {reversed} back from your share of that sale.` | ` {reversed} was taken back from your share of that sale.` |
| 4 | dispute_won, reinstated_cents > 0 | `We paid {reinstated} back to you` | `{reinstated} was paid back to you` |
| 5 | dispute_won, reinstated and released | ` ... and released the {released} hold.` | ` ... and the {released} hold was released.` |
| 6 | dispute_won, released only | ` We released the {released} hold.` | ` The {released} hold was released.` |

Unchanged (already impersonal): titles, `A client got {x} back.`, `A client's bank took back {x} in a dispute.`, `You won the dispute on a {x} charge.`, `Nothing is held from your next sale.`, the dispute_lost body, heldBreakdownLines labels.

#685 expectations a later #685 job must update (test/s-fee-r5-or-111-1.spec.ts; 7 tests red by design after this restack):
- :304 and :310 -> `A client got $100.00 back. $94.80 was taken back from that sale's payout. $5.20 is held from your next sale.`
- :401 -> `A client's bank took back $100.00 in a dispute. $94.80 was taken back from that sale's payout. $20.20 is held from your next sale.`
- :460 -> `A client got $100.00 back. $100.00 is held from your next sale.`
- :530 -> `You won the dispute on a $100.00 charge. $79.80 was paid back to you and the $20.20 hold was released. Nothing is held from your next sale.`
- :543 -> `A client got $40.00 back. $40.00 was taken back from that sale's payout. Nothing is held from your next sale.`
- :927 -> `$4.20 is held from your next sale.`
- :937, :962, :965 -> `$1.00 is held from your next sale.`
