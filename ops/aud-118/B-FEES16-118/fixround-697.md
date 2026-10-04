FIX ROUND 17 (merge-only restack, B-FEES16-118, agent 118) — growth-project-backend#697 @ 88c722003c23634df69338e4ee6ceb2dd71068e6

Builder: agent 118, job B-FEES16-118, fees lock held. This is a merge commit of #684 F4 round 16 restack (`6b13af56bf2d8a36ae5559a537ee565555a6c4c7`) into this piece (old head `1807d4cc`). It merged cleanly: no conflict and no content edit. Own-diff patch-id `a2b7fb56801a` and size 1,831 (+1,831 / -0) are unchanged.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none in this piece | Merge of F3 round 16, which changes `charge-settlement.service.ts` and `money-errors.ts`. Sol B-683-7: an unrecorded notice with no saved retry flag fails the delivery. Sol B-683-8: the retry flag keeps the dispute id, and a lost dispute's terminal notice is re-derived under the lock | `88c722003c23634df69338e4ee6ceb2dd71068e6` | build-and-test at this head |

No lens probe branch exists for #697 (tests-only piece). Its specs run in this head's build-and-test; the #683/#684 probes pass at #684 `6b13af56` ([run 37225764023](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225764023)) and at the fees top #686 `8cb7b2d4` ([run 37225776608](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225776608)). The operator FIX ROUND 16 test-only change (`1807d4cc`, R75) is kept byte-identical.

Money self-check (merge-only; the behaviour change comes from F3 round 16, `cc183e0a`):
- Webhook order and redelivery: a delivery is acknowledged only after the payee notice is recorded or its retry flag is saved. Otherwise the retryable `SFEE_NOTICE_UNRECORDED` fails it and Stripe redelivers; the replay moves no money and writes the notice once. A lost dispute's terminal notice survives the sweep, a late `created`, the closed redelivery and later sweeps (F3 spec, Sol and Opus probes green at #684 and at the fees top, which bracket this piece).
- Concurrency (two workers, lock order): unchanged. The same per-charge lock and fence; the lost status is the dispute read already done under the lock; the run flag stays call-local.
- Terminal states (refunded, disputed, canceled, deleted account): the lost-dispute notice is kept on the coach and head-coach legs; a missing settlement row fails the delivery instead of a silent 2xx; other paths are unchanged and this piece's specs are green.
- List pagination and completeness: unchanged; incomplete Stripe lists fail closed.
- Currency (presentment vs settlement, minor units): no arithmetic change.
- Copy truth: no payee copy change; two log lines now say which retry path applies.

R75: `check-r75 --mode=range` main `b644198b`..`88c72200` is OK (no positive class). 

CI at this head: every check is green. That covers build-and-test ([run 37225036314](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225036314), [run 37225036328](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225036328)) plus Schema parity, rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, npm audit, size-label, test-deploy-readiness, comment-deploy-readiness; deploy-readiness-gate is skipped (conditional, as before). Two CI runs were started for this head; both are green. A `comment-deploy-readiness` failure belongs only to a cancelled duplicate run (missing artifact), and the run that superseded it is green.

SIZE (1,500-3,000 band, for the operator's SIZE ASSESSMENT): 1,831 of 3,000 (+1,831 / -0), unchanged by this merge-only round.

READY FOR AUDIT
