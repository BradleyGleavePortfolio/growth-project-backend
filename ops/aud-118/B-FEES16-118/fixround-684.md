FIX ROUND 16 (merge-only restack, B-FEES16-118, agent 118) — growth-project-backend#684 @ 6b13af56bf2d8a36ae5559a537ee565555a6c4c7

Builder: agent 118, job B-FEES16-118, fees lock held. This is a merge commit of #683 F3 round 16 (`cc183e0ae05158290e5db77ef645578667133e0f`) into this piece (old head `bbf2eac6`). It merged cleanly: no conflict and no content edit. Own-diff patch-id `a5d4d171b301` and size 2,435 (+2,009 / -426) are unchanged.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none in this piece | Merge of F3 round 16, which changes `charge-settlement.service.ts` and `money-errors.ts`. Sol B-683-7: an unrecorded notice with no saved retry flag fails the delivery. Sol B-683-8: the retry flag keeps the dispute id, and a lost dispute's terminal notice is re-derived under the lock | `6b13af56bf2d8a36ae5559a537ee565555a6c4c7` | build-and-test at this head |

Prior probe replay at this head ([run 37225764023](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225764023), 7 suites / 44 tests, all pass):

| Lens | Probe (branch head) | Result |
|---|---|---|
| Sol | AUD-SOL-F34-116 684-boundaries (`43f0d5dd`) | PASS |
| Sol | AUD-SOL-F34-117 684 refunds and budget (`2ca1520a`, `19cac0a9`) | PASS (both suites) |
| Opus | AUD-OPUS-F34-117 684-asyncrefund / 684pre-asyncrefund (`0fa1f3e4`, `52ebdba8`; same spec) | PASS, P1-P5 |
| Sol | AUD-SOL-F23-118 notice recovery (this round's F3 findings) | PASS 6/6 |
| Opus | AUD-OPUS-F23-118 683 probe P1-P6 | PASS 6/6 |
| builder | `test/s-fee-r15-deferred-fx-notice-flag.spec.ts` (F3 rounds 15 + 16) | PASS 21/21 |

Money self-check (merge-only; the behaviour change comes from F3 round 16, `cc183e0a`):
- Webhook order and redelivery: a delivery is acknowledged only after the payee notice is recorded or its retry flag is saved. Otherwise the retryable `SFEE_NOTICE_UNRECORDED` fails it and Stripe redelivers; the replay moves no money and writes the notice once. A lost dispute's terminal notice survives the sweep, a late `created`, the closed redelivery and later sweeps (F3 spec, Sol and Opus probes green here).
- Concurrency (two workers, lock order): unchanged. The same per-charge lock and fence; the lost status is the dispute read already done under the lock; the run flag stays call-local.
- Terminal states (refunded, disputed, canceled, deleted account): the lost-dispute notice is kept on the coach and head-coach legs; a missing settlement row fails the delivery instead of a silent 2xx; other paths are unchanged and this piece's specs are green.
- List pagination and completeness: unchanged; incomplete Stripe lists fail closed.
- Currency (presentment vs settlement, minor units): no arithmetic change.
- Copy truth: no payee copy change; two log lines now say which retry path applies.

R75: `check-r75 --mode=range` main `b644198b`..`6b13af56` is OK (no positive class). F4 carries the 9 red-by-design F3 tests: all green in this head's build-and-test.

CI at this head: every check is green. That covers build-and-test ([run 37225036796](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225036796)) plus Schema parity, rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, npm audit, size-label, test-deploy-readiness, comment-deploy-readiness; deploy-readiness-gate is skipped (conditional, as before).

SIZE (1,500-3,000 band, for the operator's SIZE ASSESSMENT): 2,435 of 3,000 (+2,009 / -426), unchanged by this merge-only round.

READY FOR AUDIT
