FIX ROUND 15 (merge-only restack, B-FEES15-118, agent 118) — growth-project-backend#686 @ 5937064f66cbf17cc2b0cd7b09e7cf5f62467f66

Builder: agent 118, job B-FEES15-118, fees lock held. Merge commit of #685 F5 round 15 (`07fd138938bb29e2cc3296fafafc2f050a3bf8d8`) into this piece (old head `13c814f7`); merged cleanly, no conflict, no content edit. Own-diff patch-id `f14b1e32b05a` unchanged; size 1,355 (+1,355 / -0), unchanged.

| Finding | Change | Commit | Test |
|---|---|---|---|
| none in this piece | merge of the lower pieces' round 15 (F2 B-682-9 test-only; F3 Sol B-683-1 and B-683-5 in `charge-settlement.service.ts`) | `5937064f66cbf17cc2b0cd7b09e7cf5f62467f66` | build-and-test at this head |

Prior probe replay at this head ([run 37220644877](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220644877)):

| Lens | Probe (branch head) | Result |
|---|---|---|
| Opus | AUD-OPUS-F56-116 canary and mutants (`de2f96ab`) | CONTROL block all green; C-685-2 canary controls and acceptance green; all 4 mutants killed (54 expected failures, none outside MUTANT blocks) |
| Sol | AUD-SOL-F23-117 settlement boundaries (`80ca936a`), AUD-SOL-F34-116 683 (`b3077cad`) | PASS |
| Sol / Opus | #682 probes: Sol F12-117 reversal, Sol F12R13 transfer and listing, Opus F12R 682-probe, F12-117 extra, live-db | PASS |
| builder | F3 round-15 spec, R75 probe | PASS |

Sol's #686 verdict ran no probe branch.

Money self-check (merge-only; the behaviour change comes from F3 round 15):
- Webhook order and redelivery: a refund deferred before the fee is known settles in the settlement currency; redelivery and replay move nothing (F3 spec green here).
- Concurrency (two workers, lock order): unchanged; per-charge lock and fence as before; a run never clears the retry flag it raised.
- Terminal states (refunded, disputed, canceled, deleted account): unchanged paths; this piece's specs green.
- List pagination and completeness: unchanged; incomplete Stripe lists fail closed (refund list unreadable at settle keeps the row awaiting).
- Currency (presentment vs settlement, minor units): converted charges book settlement-currency minor units only.
- Copy truth: no copy change.

R75 at this fees top (main..`5937064f`): the only positive class is #697's `as unknown as` +1 (`test/s-fee-r13-refund-list-notices-deadline.spec.ts:140`, operator item in the #697 FIX ROUND); every other class net 0 or lower. Scratch merge with recurring top #701 `67905b43`: no positive class. Local at this head: 20 fee suites / 301 tests green; on the scratch merge 19 suites / 293 tests green.

CI at this head: every check green (build-and-test [run 37220312060](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220312060), Schema parity, rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, npm audit, size-label, test-deploy-readiness, comment-deploy-readiness); deploy-readiness-gate skipped (conditional, as before).

READY FOR AUDIT
