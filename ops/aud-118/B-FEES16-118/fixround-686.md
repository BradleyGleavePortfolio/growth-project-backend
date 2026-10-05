FIX ROUND 17 (merge-only restack, B-FEES16-118, agent 118) — growth-project-backend#686 @ 8cb7b2d4bee3bccb65596581f84bccf9227ffc4b

Builder: agent 118, job B-FEES16-118, fees lock held. This is a merge commit of #685 F5 round 17 restack (`c5e282fbfa3e7fe6a5593949182e17c91a011738`) into this piece (old head `b002ec21`). It merged cleanly: no conflict and no content edit. Own-diff patch-id `f14b1e32b05a` and size 1,355 (+1,355 / -0) are unchanged.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none in this piece | Merge of F3 round 16, which changes `charge-settlement.service.ts` and `money-errors.ts`. Sol B-683-7: an unrecorded notice with no saved retry flag fails the delivery. Sol B-683-8: the retry flag keeps the dispute id, and a lost dispute's terminal notice is re-derived under the lock | `8cb7b2d4bee3bccb65596581f84bccf9227ffc4b` | build-and-test at this head |

Prior probe replay at this fees top ([run 37225776608](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225776608), 13 suites / 427 tests: 373 pass, 54 expected MUTANT failures):

| Lens | Probe (branch head) | Result |
|---|---|---|
| Opus | AUD-OPUS-F56-116 canary and mutants (`de2f96ab`) | CONTROL block all green; the C-685-2 canary acceptance is green; all 4 mutants are killed: fee-190bps 41, fence-always-passes 3, no-send-start-budget 3, no-forward-netting 7, which is 54 expected failures, all inside MUTANT blocks, the same as round 15 |
| Sol | AUD-SOL-F23-117 settlement boundaries (`80ca936a`), AUD-SOL-F34-116 683 (`b3077cad`) | PASS |
| Sol | AUD-SOL-F23-118 notice recovery (this round's F3 findings) | PASS 6/6 |
| Opus | AUD-OPUS-F23-118 683 probe P1-P6 | PASS 6/6 |
| Sol / Opus | #682 probes: Sol F12-117 reversal, Sol F12R13 transfer and listing, Opus F12R 682-probe, F12-117 extra, F12R live-db | PASS |
| builder | F3 rounds 15 + 16 spec (21/21), round-15 R75 probe | PASS |

Local at this head: 26 fee suites / 445 tests pass.

Money self-check (merge-only; the behaviour change comes from F3 round 16, `cc183e0a`):
- Webhook order and redelivery: a delivery is acknowledged only after the payee notice is recorded or its retry flag is saved. Otherwise the retryable `SFEE_NOTICE_UNRECORDED` fails it and Stripe redelivers; the replay moves no money and writes the notice once. A lost dispute's terminal notice survives the sweep, a late `created`, the closed redelivery and later sweeps (F3 spec, Sol and Opus probes green here).
- Concurrency (two workers, lock order): unchanged. The same per-charge lock and fence; the lost status is the dispute read already done under the lock; the run flag stays call-local.
- Terminal states (refunded, disputed, canceled, deleted account): the lost-dispute notice is kept on the coach and head-coach legs; a missing settlement row fails the delivery instead of a silent 2xx; other paths are unchanged and this piece's specs are green.
- List pagination and completeness: unchanged; incomplete Stripe lists fail closed.
- Currency (presentment vs settlement, minor units): no arithmetic change.
- Copy truth: no payee copy change; two log lines now say which retry path applies.

R75: `check-r75 --mode=range` main `b644198b`..`8cb7b2d4` is OK (no positive class). R75 at this fees top: `check-r75 --mode=range` main `b644198b`..`8cb7b2d4` is OK with no positive class (`as unknown as` +9 / -9, `as never` +60 / -60, empty-catch-undefined +1 / -1, all net 0).

CI at this head: every check is green. That covers build-and-test ([run 37225036205](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225036205), [run 37225036263](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225036263)) plus Schema parity, rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, npm audit, size-label, test-deploy-readiness, comment-deploy-readiness; deploy-readiness-gate is skipped (conditional, as before). Two CI runs were started for this head; both are green. A `comment-deploy-readiness` failure belongs only to a cancelled duplicate run (missing artifact), and the run that superseded it is green.

READY FOR AUDIT
