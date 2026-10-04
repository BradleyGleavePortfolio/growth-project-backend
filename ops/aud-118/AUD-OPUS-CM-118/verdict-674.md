AUDIT Claude Opus 5.5 — growth-project-backend#674 @ f9e21a87bf47502458a6ae21c2393010a1279198 — VERDICT: REQUEST CHANGES

A/B/C = 0/2/6 (C-641-2 is carried on top and not counted)

Lens AUD-OPUS-CM-118 (agent 118), T4 (money: refunds, chargebacks, transfer reversals). This verdict is independent of the builder and of the Sol lens. It was written before Sol's verdict at this head ([5982716289](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/674#issuecomment-5982716289)) was read. After reading it, Sol's B-674-13 and B-674-14 were derived again from source, proved again by this lens's own probe and adopted under Sol's ids. They are the only two Bs here.

**Evidence base (G09)**
- This lens's earlier work on this piece:
  - #641 APPROVE at fb29fb9e.
  - A full line-by-line audit of M1 at 9a512028 (116, RC 0/4/5).
  - A delta audit 9a512028..d9327546 (117, RC 0/1/5, [5976743131](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/674#issuecomment-5976743131)).
  - Every finding from those audits is decided below.
- Read in this round: every line of FIX ROUND 2 and FIX ROUND 3. That is `git merge-tree --write-tree b644198b d9327546` (a66e54b5) against f9e21a87, 14 files.
  - Source: `refund-dispute-handler.service.ts` +292, `transfer-orchestrator.service.ts`, migration and schema, runbook, `.env.example`.
  - Tests: `dispute-transfer-reversal-once.spec.ts` (new), the live spec, the harness, and the three specs moved byte-identically to #677.
- Every caller of `applyDisputeTransferReversalOnce`, `upsertAndApplyRefund`, `recordReversal`/`recordReconciledReversal`, the dispute sweep and the `transfer.reversed` observer was traced.
- Main merges 8cd0dbfe and 5bbcc92a are merge-only. Main is now 2af682ca (#698 data-export, #699 SBOM). The PR is BEHIND, but no file overlaps and `git merge-tree` is clean, so update-branch at landing is merge-only (rule 12).
- Probes ran in the CI lane with probe specs only, on this head:
  - audit/AUD-OPUS-CM-118/674-probes, commit a1d3c68f: [run 37221612173](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37221612173). Result: 30 pass, 2 red, both as predicted.
  - audit/AUD-OPUS-CM-118/674-send, commit 12e32313: [run 37222417496](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222417496). Result: 25 pass, 2 red (B-674-13, B-674-14).

**Prior findings from this lens, decided at this head**
- **B-674-5: CLOSED.**
  - The lost-chargeback head-coach reversal is sent once under `tgp-tr-rev-dispute-<id>` (:1235-1242), with its amount stamped before the first call (:1207-1213).
  - It is recorded once, by claiming `transfer_reversed_at` (`markDisputeTransferReversalDone`, :1254-1268) in the transfer and posting transaction.
  - A retry, from a redelivery or from the sweep, first records the reversal Stripe holds for that dispute (:1221-1233).
  - `transfer.reversed` with nothing owed raises Sentry `TRANSFER_REVERSAL_UNATTRIBUTED`, with ids and cents only.
  - The runbook now names a working action.
  - This lens's probe `audit-opcm1-117-674.spec.ts` passes unchanged in run 37221612173: Stripe 245, transfer 245, slice 245.
  - Failing before: [37179564456](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37179564456).
- **C-674-10: CLOSED.** Reconcile returns the bound reversal id (`boundId`). A chargeback reversal is never counted for a refund: it returns 409 when named and is excluded from the unattributed set. `.env.example` now says "drift check".
- **B-674-3 (116 probe): still closed.** `audit-cm1-674-reversal-mirror.spec.ts` gives 5/6.
  - The one red is `mirror_before_reconcile` (0 instead of 122). That is the in-between state that fix option (b) removed, and the 117 verdict accepted it.
  - The end state in the same case is right: `recorded_from_stripe`, local 122, Stripe 122.
  - This is not a regression. The builder's lane shows the same result at 39653f80 and at this head.
- **B-641-12 / B-674-1, B-674-2, B-674-4, C-674-5:** closed at d9327546, and their code is unchanged in this delta. The live contention job passes at this head ([mwb-3-live-tests](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219217342/job/111485943834)).

**New code in this round, checked**
- **First-time election (refund `posted_at` :505-512; dispute `closed_at` :1309-1322).**
  - Each first time is an `UPDATE ... WHERE <col> IS NULL`. The losing delivery writes status only (P2025 fallback) and reads the elected instant back.
  - Every ledger and inline head-coach posting uses the value the update returned.
  - The live Postgres trigger tests log exactly one change each, and every posting carries that instant.
  - A concurrent dispute ledger pass that loses is rolled back by the unique (entry, source_kind, source_id) posting index. The delivery fails, and Stripe redelivers into the `ledger_reversed` gate.
- **Dispute sweep (:806-857).**
  - Rows are ordered least recently attempted first, with nulls first.
  - A row is claimed with a compare-and-set on `transfer_reversal_last_attempt_at`. The claimed stamp equals `now`, so later pages, restarts and replicas move past it.
  - There is a 10-minute cooldown, and the work per run is bounded.
  - A skewed replica (`gt: now`) can double-attempt a row. That stays money-safe: the request carries the same key and amount, and the record is claimed once.
  - The stuck alert after 23 h carries ids only.
- **Lock order.** The refund or dispute claim row comes first, then the destination and fee slices in `findByPurchase` order. The transfer record path takes the transfer and then its head slice. The two sets are disjoint, so there is no cycle.
- **Currency and copy.** Amounts are integer minor units, and the dispute share is integer pro-rata. No new user-facing copy was added. No new `.message` or free-text sink was added (grep of the diff).
- **Migration 20270317116000.** It is unreleased (production latest is 20270301000000). It adds 5 nullable ChargeDispute columns and a unique index, and down.sql drops them. There is no user id, so the deletion manifest is unchanged.
- **Size and checks.** Size is +2,818/-130 = 2,948, and the operator SIZE ASSESSMENT is KEEP. All 11 required checks are green at this head; deploy-readiness-gate skips by design.

### B — must fix

#### B-674-13 (Sol's id; adopted after source derivation and an own probe): the refund sweep admits a resend against the run's start time
- **Where:** `src/checkout/refund-dispute-handler.service.ts`.
  - `retryPendingTransferReversals` takes one `now` (:743) and passes it to every row (:797-802).
  - `admitTransferReversalAttempt` checks `now - first_attempt <= 23 h` against that value (:687-688), not against the time of the send.
- **Why it matters:** the guard relies on a 1-hour margin between the 23 h retry window and Stripe's 24 h key retention. The sweep's own bound allows up to 1,000 refund rows, each with a 10 s provider timeout, which is about 2.8 h of work. A long run can therefore send under a key that Stripe has already forgotten.
- **Counterexample:** run 37222417496, `test/audit-opus-cm-118-674-send.spec.ts`.
  - Row B was first tried 22 h 59 m before the run. Stripe made that reversal, and the answer was lost.
  - The run's earlier provider calls take 61 minutes.
  - B is still admitted and sent at age 24 h 00 m. Result: **Stripe 244, local 122**, and B is not moved to review. The expected result was Stripe 122, no send, and review.
  - Control green: the same row without the elapsed time records the one reversal (122/122).
- **Minimal fix rule:** check retention against a fresh clock read taken immediately before each external request, and move the row to review when it is past the window or uncertain. Keep the run-start `now` only for the paging filter. The original key, the stamped amount, the least-recent-first order and the atomic claims stay as they are.
- **Verify:** the probe case passes unchanged. Add a row that crosses the window between selection and send, and keep the existing refund-reversal-once, dispute and live contention specs green.

#### B-674-14 (Sol's id; adopted after source derivation and an own probe): an explicitly incomplete Stripe list authorizes another reversal
- **Where:** `src/checkout/refund-dispute-handler.service.ts:1082`. `if (!res.has_more || res.data.length === 0) return out;` returns success when a page says `has_more: true` but carries no data.
  - The dispute retry (:1221-1242) then finds no receipt and resends.
  - After 24 h the key no longer protects that resend.
  - Owner reconcile (:952) consumes the same list.
- **Why B:** the binding money checklist (_COMMON_118 item 6) requires "fail closed on incomplete Stripe lists", and here the code fails open into a second money movement against a head coach. Real Stripe is not expected to send this page. The rule exists so that no provider anomaly can authorize a send.
- **Counterexample:** run 37222417496.
  - A lost dispute's first answer was lost, and the keys have expired.
  - The list answers `{data: [], has_more: true}`.
  - The sweep sends again: **Stripe 490, local 245**, and the dispute is no longer owed.
  - Control green: a complete list records the 245 Stripe holds, with no second send.
- **Minimal fix rule:** return success only after `has_more: false`. Treat an empty page with `has_more: true`, a repeated cursor, or no progress as incomplete, and raise a closed 503 (for example `TRANSFER_REVERSALS_LIST_INCOMPLETE`, with ids only). The dispute retry then stays pending with no send, and reconcile answers with an actionable error.
- **Verify:** the probe case passes unchanged. Add the reconcile equivalent and the case of a non-empty first page followed by no progress. Keep the 1,000-row cap, and keep the complete-empty-list control green.

### C (optional; to the operator's follow-up list under the freeze)
- **C-674-12 (new): the head-coach posting time depends on which overlapping delivery wins the transfer record.**
  - Where: `refund-dispute-handler.service.ts:568-574`. Only the delivery that claimed the ledger passes `posted_at` (`ledgerJustReversed ? row.posted_at : undefined`).
  - Counterexample (red as predicted in run 37221612173, `test/audit-opus-cm-118-674.spec.ts`):
    - A refund is stored pending, and two succeeded deliveries arrive at 2027-03-31T23:59:59.999Z.
    - A claims the ledger, and its Stripe call is slow. B arrives 1 ms later and wins the record.
    - The destination and fee postings are at 03-31 23:59:59.999. The head-coach posting is at **2027-04-01T00:00:00.000Z**.
  - Money stays exact (control green): Stripe 49, transfer 49, slice 49, one reversal. On #676, `client_refunded` still appears once across both files.
  - Why C: no cent is wrong and no row is duplicated. Only the month of the head-coach share moves, and only at a window edge. This matches the designed dating of a later recovery.
  - Fix rule: date the head-coach posting at the refund's `posted_at` whenever it is recorded by an attempt admitted within the same first-success pass (for example, when first_attempt_at was stamped within N seconds of posted_at). Keep record time only for a retry after a failed or unanswered first attempt.
- **C-674-6 (carried):** :952 and :1054 in reconcile. A provider outage escapes as a generic 500. Fix rule: map it to a closed 502/503 that says local recording did not finish and reconcile can be retried.
- **C-674-7 (carried):** `refund-reversal-admin.controller.ts:51-74`. Reconcile records no acting owner. Fix rule: pass `req.user.id` and persist it with the outcome (id only in logs).
- **C-674-8 (outside this diff, carried):** :517 and :531 (`status: args.status`). An out-of-order delivery can move a refund status backwards. Fix rule: never move a terminal status back, and handle succeeded -> failed as an explicit un-reversal path.
- **C-674-9 (outside this diff, carried):** :597-601. A head-coach transfer still pending at refund time makes the refund `nothing_owed`. Fix rule: keep it owed while a pending or retrying transfer exists.
- **C-674-11 (builder's, confirmed):** :519-522. `reason`, `note` and `initiated_by_user_id` are written back from the unlocked pre-read. This is metadata, not money. Fix rule: write `undefined` for absent fields, as `onDisputeClosed` now does.
- **C-641-2 (carried, not counted):** exact-candidate integration with the fee and recurring stacks. Also C-641 legacy float share arithmetic, which is main code.

**Next head:** approval needs B-674-13 and B-674-14 closed, with tests that failed before, all required checks green and #676/#677 restacked. Everything else decided above stays closed if its code is unchanged. A pure main update-branch with the PR files byte-identical needs no new verdict. No push, merge or dispatch to the PR branch by this lens.
