FIX ROUND 16 (B-FEES16-118, agent 118) — growth-project-backend#683 @ cc183e0ae05158290e5db77ef645578667133e0f

Builder: agent 118, job B-FEES16-118. Two commits on top of `438d29e6` (round 15):
- failing-before tests `55d871b031bcae6ddb93d984ec5e4caa700d6c12`;
- fix `cc183e0ae05158290e5db77ef645578667133e0f`.

Source change: `src/connect/fees/charge-settlement.service.ts` (+25 / -16) and `src/connect/fees/money-errors.ts` (+13 / -1). The tests are 6 new cases appended to `test/s-fee-r15-deferred-fx-notice-flag.spec.ts` (+103). F2 #682 (`70f879a2`, dual APPROVE) is untouched.

| Finding | Change | Commit | Test (`test/s-fee-r15-deferred-fx-notice-flag.spec.ts`, describe "round 16") |
|---|---|---|---|
| Sol B-683-7 (Opus rated it C-683-7, probe P4): the notice write failed and the retry-flag write also failed, yet `applyAdjustments` resolved (webhook 2xx). Result: no flag, no redelivery, no notice | `flagForReconcile` now returns whether the flag was saved (`updateMany` count 1). `recordAdjustmentNotices` still returns `false` when it saved the flag (round 15, B-683-5). When it could not save the flag, it throws `NoticeUnrecordedError` (closed code `SFEE_NOTICE_UNRECORDED`, retryable in `isRetryableMoneyError`). The error goes through `applyAdjustments`' catch: the flag is tried once more, then the delivery fails and Stripe redelivers. The money has already converged and stays idempotent. The `SFEE_NOTICE_FAILED` log now says which retry path applies | `cc183e0a` | 4 cases: {notice insert, notice history read} × {every flag write fails, only the first flag write fails}. Each case checks: the run rejects with the retryable `SFEE_NOTICE_UNRECORDED charge=ch_1`; coach 6,980; no notice. The flag is saved only when the second attempt succeeds. Then the outage ends. A saved flag alone lets the sweep write the notice, while with no flag the sweep writes nothing. Stripe's redelivery returns `unchanged`. Exactly one `refund` notice, the flag is cleared, the reversal count is unchanged and coach 6,980 |
| Sol B-683-8: a lost-dispute notice that failed to record was flagged with a null dispute id. The flagged sweep ran without `notice_event`, inferred `chargeback`, skipped the unchanged state and cleared the flag, so `dispute_lost` was never written | Two changes. (1) The notice-failure flag now carries the run's dispute id (`input.dispute_id ?? row.reconcile_dispute_id`), so retry authority keeps the canonical dispute identity. (2) `currentDispute` also returns `lost` (Stripe's dispute `status === 'lost'`, read under the charge lock). The hint is `input.notice_event ?? (lost ? 'dispute_lost' : null)`. So any retry (the sweep, another webhook, a `transfer.reversed` sync) records the terminal notice, and the flag is cleared only after that. The rule is the same one the dispute-closed handler uses (`dispute.status === 'lost'`). Lost-dispute idempotency is unchanged: same key per charge/leg/event/state, and the visible-amounts check also applies | `cc183e0a` | Coach and head-coach legs, with 2 cases {notice insert, notice history read}. Chargeback notices are recorded on both legs. The dispute is then lost and the terminal notice fails once: `unchanged`, flag saved. The sweep writes `dispute_lost` on both legs and clears the flag. Replays add nothing: a late `created` with no intent, the closed redelivery and a later sweep. Reversal count and recoveries are unchanged (no extra reversal or collection). Two mutants each fail both cases (local): dispute id not passed to the flag; `lost` not derived |

Evidence:
- **Failing-before:** [run 37224835684](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37224835684). Lane commit = `55d871b0` (tests on the round-15 source) + both lenses' round-15 probes + lane files: 10 failed / 23 passed.
  - Failed: the 6 new cases, Opus P4, and Sol's 3 acceptance cases (2 × B-683-7, 1 terminal).
  - Passed: the 15 round-15 cases, Opus P1-P3/P5/P6 and Sol's 3 controls.
- **Passing-after:** [run 37224855812](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37224855812) at `cc183e0a` + every prior probe below: 54 of 58 pass. The 4 failures are the 2 known v1/v2 cases each, unchanged since round 14 (see the replay table). The spec passes 21/21.
- **tsc:** [run 37224866058](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37224866058) green.
- **Composed fees top:** local at the restacked #686 `8cb7b2d4`, 26 fee suites / 445 tests pass. This includes `refund-dispute-handler.service.spec.ts`, `s-fee-r5-or-111-1.spec.ts`, `s-fee-r4-money-protocol.spec.ts`, `s-fee-r11-fx-cash-truncation-logs.spec.ts` and `s-fee-settlement-sweep.spec.ts`.

Prior probe replay (both lenses, every #683 probe branch):

| Lens | Probe | Before (`55d871b0`) | After (`cc183e0a`) |
|---|---|---|---|
| Sol | AUD-SOL-F23-118 `aud-sol-f23-118-notice-recovery.spec.ts` (byte-identical to the file in Sol's lane `4a1dccd4`; this round's findings) | 3 FAIL (B-683-7 insert, B-683-7 history read, terminal retry) / 3 controls pass | PASS 6/6 |
| Opus | AUD-OPUS-F23-118 `audit-opus-f23-118-683.spec.ts` P1-P6 | P4 FAIL (C-683-7 = B-683-7) / 5 pass | PASS 6/6 |
| Sol | AUD-SOL-F23-117 settlement boundaries (parent of `80ca936a`) | not run (closed in round 15) | PASS 13/13 |
| Sol | AUD-SOL-F34-116 683-boundaries (`b3077cad`) | not run | PASS 4/4 |
| Sol | AUD-SOL-F34-117 683-boundaries v1 and v2 (`faec1a52`; import renamed to the round-13 successor `chargeRefundsFromStripe`, as in round 15) | not run | 2 PASS / 2 FAIL each, identical to `438d29e6` and `33a9d83b`. One failure is platform cash with a never-sent pending transfer (Sol C-683-4, frozen). The other is the above-gross control, whose fixture refund page has no amount or currency; round 13 rejects that page as malformed (fail closed) |

Money self-check:
- **Webhook order and redelivery.** A delivery is acknowledged only after the notice is recorded or its retry flag is saved. Otherwise it fails with a retryable error and Stripe redelivers. The replay moves no money (`unchanged`) and records the notice once. A lost dispute's terminal notice survives the sweep, a late `created`, the closed redelivery and further sweeps, exactly once per leg.
- **Concurrency (two workers, lock order).** Both changes run inside the existing `chargeLock.run` critical section. The lost status comes from the dispute read already done under the lock; there is no new lock, transaction or lock-order change. The run flag stays call-local (round 15).
- **Terminal states.**
  - Refunded: money converges first, then notice or retry.
  - Disputed/lost: terminal notice kept on both legs.
  - Won: unchanged (still derived from money state).
  - Canceled: no new path.
  - Deleted account / missing settlement row: `flagForReconcile` returns false, so the delivery fails instead of being silently acknowledged.
- **Admin refund path.** `NoticeUnrecordedError` is retryable. So an admin refund that already exists at Stripe logs "payout adjustment deferred to the charge.refunded webhook" and returns as before, and that webhook records the notice.
- **List pagination and completeness.** Untouched: the round-13 reader still fails closed on incomplete lists.
- **Currency.** No arithmetic changed; notices keep the settlement and presentment fields.
- **Copy truth.** No payee copy changed. The two log lines are now true in every path: "the sweeper retries the notice" only when the flag was saved, otherwise "the delivery fails for redelivery". "relying on Stripe redelivery" is now always followed by a rethrow. Logs carry ids and closed codes only.

CI at this head:
- **build-and-test** ([run 37225035844 / job 111502834528](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225035844/job/111502834528)) is red by design, exactly 3 suites / 9 tests, the same as round 15:
  - `checkout-webhook-fee-split.spec.ts` 2 and `purchase-split-handler.service.spec.ts` 2 (`connectTransfer.updateMany is not a function`);
  - `reconciliation.service.spec.ts` 5 (main's mock lacks `chargeSettlement.findMany`).
  - Lint, Type-check and Build pass; 727 suites / 12,579 tests pass, including the 6 new cases.
- **F4 #684 carries the 9.** It is restacked to `6b13af56`, a merge-only round posted separately.
- **Every other check is green:** Schema parity, rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, npm audit, size-label, test-deploy-readiness and comment-deploy-readiness. deploy-readiness-gate is skipped.

R75: `check-r75 --mode=range` passes for main `b644198b`..`cc183e0a` (OK, no positive class), for `438d29e6`..`cc183e0a` (OK) and for main..#686 `8cb7b2d4` (OK).

SIZE (1,500-3,000 band, for the operator's SIZE ASSESSMENT): 2,959 of 3,000 (+2,933 / -26). This round adds +141 / -17 (103 test lines, 21 net source lines); 41 lines of headroom remain.

Not taken (FREEZE; listed in the report as follow-ups with file:line and fix rule): Sol C-683-4 (platform cash vs booked cash), Sol C-683-6 = Opus C-683-5 (paid-invoice cursor reset on an incomplete page), Opus C-683-4 (unbounded reconcile reads), Opus C-683-6 (succeeded-only reconciliation unit cases). There is also a new C: the shared fake treats SQL NULL as `<=` any timestamp (`test/utils/settlement-fakes.ts:19-23,42`), so a flagged-only sweep re-runs every row in the fakes. This round's spec and Sol's probe correct it locally.

READY FOR AUDIT (red by design: build-and-test, the 9 tests above; F4 #684 turns them green)
