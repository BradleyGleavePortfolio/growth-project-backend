AUDIT Claude Opus 5.5 — growth-project-backend#683 @ cc183e0ae05158290e5db77ef645578667133e0f — VERDICT: APPROVE
A/B/C = 0/0/4

Job AUD-OPUS-F3-119 (agent 119). Tier T4 (money: settlement, refunds, disputes, payee notices). Base F2 #682 @ 70f879a2 (dual APPROVE, not re-audited). Size 2,959 (+2,933/−26; 7 files; operator SIZE ASSESSMENT KEEP). This lens's last verdict here was APPROVE 0/0/4 @ 438d29e6 (5982917163). This verdict covers 438d29e6..cc183e0a, which is two linear commits:
- 55d871b0: tests only, 6 cases appended to `test/s-fee-r15-deferred-fx-notice-flag.spec.ts` (+103);
- cc183e0a: the fix, `src/connect/fees/charge-settlement.service.ts` (+25/−16) and `src/connect/fees/money-errors.ts` (+13/−1).

### Scope and evidence reuse (G09)
- **Re-audited in full here:** every line of cc183e0a and 55d871b0; every caller of `applyAdjustments` at this head (`resolveStuckReversals` :1067, `rerunFlagged` :1100) and at the restacked F4 #684 6b13af56 / fees top #686 8cb7b2d4 (`refund-dispute-handler.service.ts` :391, :737, :757, :1230, and the admin refund catch at :1383); every `isRetryableMoneyError` consumer (`safeAttempt`, `attemptTransferUnderLock`, the F4 dispute handler level choice and admin refund catch); `flagForReconcile`, `clearReconcileFlag`, `currentDispute`, `noticeEventFor` and the notice idempotency checks; and the webhook dedup contract (`billing.service.ts` inserts `StripeProcessedEvent` inside the outer transaction, so a thrown handler rolls the dedup row back and Stripe's redelivery runs the handler again).
- **Unchanged since 438d29e6:** all other F3 code is byte-identical (`git diff 438d29e6 cc183e0a` touches only the three files above; 70f879a2 is an ancestor of 438d29e6). It rests on this lens's 438d29e6 APPROVE and the audits it cites.
- **Independence.** Sol's verdict at this head (if any) was not read before this one was written.

### Prior findings decided first
**Opus C-683-7 = Sol B-683-7 (notice write and retry-flag write both fail, webhook still 2xx): closed.**
- `flagForReconcile` returns `saved.count === 1` (:1391) and `false` in its catch or with no row. `recordAdjustmentNotices` flags first (:1679) and throws `NoticeUnrecordedError` (closed code `SFEE_NOTICE_UNRECORDED`, retryable) when the flag was not saved (:1683). The error leaves `chargeLock.run`; `applyAdjustments`' catch tries the flag once more (:1367) and rethrows, so the delivery fails and Stripe redelivers.
- **No double-apply on redelivery:** the throw is reachable only after the claim compare-and-set, the ledger write and every `convergeLeg` call have committed (all money writes are outside any transaction that the throw could roll back). The redelivery re-reads refunds and the dispute under the lock, finds the same state (`unchanged`), converges to the same targets (no reversal, no recovery), and writes the notice under its existing key.
- **Proof:** this lens's own round-15 probe P4 now passes (6/6) at the exact head; builder failing-before [run 37224835684](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37224835684) (lane 025d9a3c = 55d871b0 + probe files + lane files, no src change: 10 fail / 23 pass, P4 among the failures) and passing-after [run 37224855812](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37224855812) (lane bf0814ec = cc183e0a + probe files + lane files: 54/58; the 4 failures are Sol F34-117 v1/v2's two known cases each: platform cash (Sol C-683-4) and the malformed-fixture control).

**Sol B-683-8 (terminal dispute intent lost during retry): closed.** The run's dispute id (`input.dispute_id ?? row.reconcile_dispute_id`, :1432) is carried on the notice-failure flag, and `currentDispute` returns `lost: fresh.status === 'lost'` from the canonical read under the lock (:1742), so `hint = input.notice_event ?? (dispute?.lost ? 'dispute_lost' : null)` (:1563). Any later run (sweep, redelivery, `transfer.reversed` sync, a late `created`) re-derives the terminal event and the flag clears only after it is recorded.

### This lens's independent probe (round-16 delta)
`test/audit-opus-f3-119-683.spec.ts` on audit/AUD-OPUS-F3-119/683-r16-probe (lane d4e5907c = cc183e0a + this probe + the round-15 Opus probe + lane files only). [Run 37228953907](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37228953907): 33/33 pass (Q1-Q6, Opus F23-118 P1-P6, builder spec 21/21). Discrimination: the same probe at 438d29e6 ([run 37229072725](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229072725), lane 9c78e0a6 = 438d29e6 + probe + lane files) fails Q1-Q4 and Q6 and passes the Q5 control. Coach and head-coach legs throughout.
- **Q1** (B-683-7 x B-683-8): the lost-dispute notice fails and both flag attempts fail. `dispute.closed` rejects with the retryable `SFEE_NOTICE_UNRECORDED charge=ch_1`; no flag; money unchanged. The redelivery returns `unchanged` and writes `dispute_lost` once per leg; two more replays and a sweep add nothing; reversals, recoveries and both payees' nets unchanged.
- **Q2** (webhook order): the first observation is already `lost` (a late `created`, no intent). One `dispute_lost` per leg and no `chargeback`; the closed redelivery and another replay add nothing; money moved once.
- **Q3** (sticky dispute id): after a flagged lost retry (history read fails, flag saved with `dp_1`), a caller with no dispute id re-reads the dispute (one extra `retrieveDispute`), writes the terminal notice, clears the flag; a later sweep adds nothing.
- **Q4** (the sweep is the failing run): with a saved flag, the sweep's own notice and flag writes fail. `runSettlementSweep` resolves (row-level catch at :1106), the original flag is kept, and the next sweep writes `dispute_lost` once per leg and clears it.
- **Q5** (terminal state won, control): a reinstated dispute (status `won`) writes `dispute_won`, never `dispute_lost`.
- **Q6** (two workers): after a `NoticeUnrecordedError`, a closed redelivery and a sweep race on the charge lock. Exactly one `dispute_lost` per leg, no extra reversal or recovery.

### Findings (all optional; FREEZE: into the operator's follow-up list)
- **C-683-8 (new, log truth):** `charge-settlement.service.ts:1681` logs "the delivery fails for redelivery" on every unflagged path, but two callers have no delivery: the sweep (`rerunFlagged` :1100, `resolveStuckReversals` :1067) keeps its older flag and retries next run, and the F4 admin refund catch (`refund-dispute-handler.service.ts:1383` at #684) defers to the `charge.refunded` webhook. Money and notices are unaffected (Q4). Fix rule: neutral text naming both paths ("the caller retries: webhook redelivery, or the next sweep while an earlier flag stands").
- **C-683-4 (carried, Opus):** unbounded per-purchase Stripe reads in reconciliation, `src/connect/fees/reconciliation.service.ts`. Fix rule: bound reads per run with a cursor.
- **C-683-5 (carried, Opus; = Sol C-683-6):** an incomplete paid-invoice page resets the backfill cursor, `charge-settlement.service.ts` ~:1161-1164, :1226-1236. Fix rule: only a validated terminal page ends the scan; otherwise keep the cursor and log `invoiceBackfillFailed`.
- **C-683-6 (carried, Opus):** no unit cases for the succeeded-only filter, `reconciliation.service.ts:350-354`. Fix rule: add pending/failed/canceled refund cases to `reconciliation.service.spec.ts`.

Concur with the builder's new test-infra C (`test/utils/settlement-fakes.ts:19-23, :42`: the fake's compare lets NULL satisfy `lte`; the round-16 spec and this probe filter flagged rows locally). Not counted here.

### Money list (this delta)
- **Webhook order and redelivery:** acknowledged only after the notice or its flag is saved; otherwise the handler throws inside the billing transaction, the dedup row rolls back and Stripe redelivers; the replay is `unchanged` and writes the notice once (Q1, builder 4 cases). A late `created` after loss writes the terminal notice directly (Q2).
- **Concurrency (two workers, lock order):** both changes sit inside the existing `chargeLock.run` section; the extra flag write is a plain update with no transaction and no new lock; the dispute status comes from the read already made under the lock (Q6).
- **Terminal states:** lost (Q1-Q4, Q6) and won (Q5) correct; refunded (builder cases) converges then notices; closed/other statuses are not `lost`, so no hint; a settlement row deleted mid-run makes `flagForReconcile` return false, so the delivery fails instead of being acknowledged silently; the redelivery takes the unchanged no-row path (settle first, then `no_settlement`), so this round adds no new loop.
- **List pagination and completeness:** untouched (round-13 reader, fail closed).
- **Currency:** no arithmetic changed.
- **Copy truth:** no payee copy changed. The only text issue is the log line under C-683-8.

### Piece boundary, R75, size
- Type-check and Build pass at this head; nothing imports a later piece; no migration; no dependency edit. The new error class is used by F4 only through `isRetryableMoneyError`, which was already imported there.
- R75: `node scripts/check-r75.js --mode=range --base=b644198b90bb9ab1dc62a78794e12cf09f8ace7c --head=cc183e0a...` reports OK (as any 23/23, empty-catch-undefined 1/1, no positive change); 438d29e6..cc183e0a reports OK.
- Size 2,959 (`gh pr view` additions + deletions = local `git diff 70f879a2...cc183e0a`), 41 lines of headroom.

### CI at cc183e0a (red by design, verified)
- **build-and-test** ([run 37225035844 / job 111502834528](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37225035844/job/111502834528)): Lint, Lint control sources, Type-check and Build pass; only the Test step fails, with exactly 9 tests in 3 suites: `checkout-webhook-fee-split` (2) and `purchase-split-handler.service` (2), `connectTransfer.updateMany is not a function`; `reconciliation.service` (5), `Cannot read properties of undefined (reading 'findMany')`. 727 suites and 12,579 tests pass, including the 6 new cases. F4 #684 carries those three specs green.
- **Green:** rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, Schema parity, npm audit, size-label, test-deploy-readiness, comment-deploy-readiness. deploy-readiness-gate skipped. CodeQL, danger, banned casts and SBOM run only at the composed main-based candidate.

Landing: the stack lands as one (rule 11). This verdict approves F3 at this exact head only. Later pieces restacked on it need only a merge-only delta check.
