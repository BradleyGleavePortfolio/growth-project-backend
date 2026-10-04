AUDIT Claude Opus 5.5 — growth-project-backend#683 @ 438d29e64f24e6f803a578dae56e0140a44d1c52 — VERDICT: APPROVE
A/B/C = 0/0/4

Job AUD-OPUS-F23-118 (agent 118). Tier T4 (money: settlement, refunds, currency, payee notices). Base F2 #682 @ 70f879a2. Size 2,835 (+2,809/−26; 7 files). This lens's last verdict here was REQUEST CHANGES 0/1/4 @ 33a9d83b (5977756981, concurring with Sol B-683-1). This verdict covers 33a9d83b..438d29e6, which is three commits:
- merge b52c1265: F2 round 15;
- 2bce9e19: tests only, the 293-line `test/s-fee-r15-deferred-fx-notice-flag.spec.ts`;
- 438d29e6: the fix, `src/connect/fees/charge-settlement.service.ts` only (+29/−13).

### Scope and evidence reuse (G09)
- **The merge is clean.** b52c1265's tree 65514ac8 equals `git merge-tree --write-tree 33a9d83b 70f879a2`. 33a9d83b..b52c1265 is F2's two round-15 test files only, and F3 touches neither.
- **Re-audited in full here:**
  - every line of 438d29e6 and the new spec;
  - every reader and writer of `refunded_cents` and `currency` on the awaiting → settled path;
  - `markAwaiting` (only writes `last_error`), `ensureProvisionalRow` (`currency = purchase.currency`), the `createSettlementRow` currency choice and the awaiting branch of `applyAdjustmentsLocked`;
  - `flagForReconcile` and `clearReconcileFlag`, every `flagForReconcile` call site, and the sweep's `rerunFlagged`.
- **Unchanged since 33a9d83b:** all other F3 code. It rests on this lens's 33a9d83b audit (the round-13 refund-list reader, succeeded-only settle and adjust, converted notices) and the 35a18539 APPROVE.
- **Independence.** Sol's verdicts at this head were not read before this one was written.

### Closed
**Sol B-683-1 (this lens concurred; deferred-fee currency switch): closed.**
- **The fix** (`charge-settlement.service.ts:695-703`):
  - `sameCurrency = row.currency === bt.currency`.
  - The awaiting row's `refunded_cents` joins the max only when it is already in the settlement currency.
  - On a converted row with a deferred refund, the list is read even when `amount_refunded` is stale (0).
  - An unreadable or incomplete list returns `markAwaiting`: nothing moves, and the row keeps `currency` and `refunded_cents`.
- **Every way an awaiting row gets its refund was traced:**
  - **Provisional row, or created without a balance transaction:** the row holds the presentment currency (`:2077`, `:602`). `fx` is false (`:1436`), so the deferred refund is stored in presentment cents. At settle `sameCurrency` is false, so the settlement-currency list is the answer.
  - **Created with a balance transaction** (no payout account yet, or the charge is not yet succeeded): the row holds the settlement currency. `fx` is true, so the awaiting branch stores the list's USD debit. At settle `sameCurrency` is true, so `max(USD, USD)`.
  - **Dispute amounts on the awaiting row** come from dispute balance transactions (`disputeAmountsFrom`), which are always in the settlement currency. No mixing.
  - **The settle claim** still compares-and-sets on the row's original `refunded_cents` (`:720-727`) and writes the settlement-currency value. A concurrent adjustment makes the claim miss.
- **Builder proof, provenance checked:**
  - Before: [run 37219928918](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219928918). Lane commit 6155e28f = 2bce9e19 + lane files only; 11 fail / 4 controls pass.
  - After: [run 37219950755](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219950755). Lane commit e27b7e3f = 438d29e6 + lane files + 4 Sol probes; the new spec passes 15/15 and Sol's `aud-sol-f23-117-settlement-boundaries` passes.
  - tsc: [run 37219940228](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219940228) at 5d277bea = 438d29e6 + lane files.
  - Both deferral paths pay USD 56.40, store 2000 USD, and show drift 0 after redelivery, a second settle and a sweep.
- **This lens's independent probe:** `test/audit-opus-f23-118-683.spec.ts` on audit/AUD-OPUS-F23-118/683-r15-probe. Lane commit 2158b0a1 = 438d29e6 + probe + lane files only. In [run 37222906855](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222906855) the builder's spec passes 15/15 again, and the probe's B-683-1 cases (P1, P2, P3, P5, P6) pass. P4 fails as designed (C-683-7 below).
  - **P1** (control): an awaiting row already in USD (no payout account yet) defers the refund as USD 2000. Once the account exists it settles to 2000 USD, coach 5,640, drift 0.
  - **P2** (terminal state): a deferred **full** CAD 100 refund books USD 8,000 (not 10,000). Nothing is sent, the coach owes exactly 360 (TGP's 2% + Stripe fee), and a redelivery adds no second recovery.
  - **P3:** a succeeded converted refund with no balance transaction at settle keeps the row awaiting (`cad`/2,500, nothing moved), then settles to 5,640 once Stripe reports it.
  - **P5:** a later CAD 10 refund (USD 8 debit) after the deferred settle books 2,800 USD, coach 4,840. The notice carries `customer_refunded_cents` 2,800 USD and `client_refunded_cents` 3,500 CAD, drift 0.
  - **P6** (two workers): two settles and one adjustment race on the deferred converted row. The result is one coach transfer, 2000 USD, coach 5,640, drift 0.

**Sol B-683-5 (this lens rated it C): closed.**
- **The fix:**
  - `recordAdjustmentNotices` returns `false` when it could not record a notice (`:1675`).
  - `applyAdjustmentsLocked` sets `run.flagged` (`:1561`).
  - `applyAdjustments` skips `clearReconcileFlag` for that run (`:1352`, `:1357`).
  - A run that recorded its notices still clears only flags raised before it started (`lte startedAt`). The fix needs no clock comparison for its own failure.
- **Proof:** the builder's frozen-`Date` case keeps the flag, and the sweep two minutes later writes the notice once, clears the flag and sends no second reversal. The control (a flag 10 minutes old is cleared) passes.
- **Residual (not a finding):** a flag raised by a *different* run can still be cleared only if the wall clock steps backwards between this run's start and that run's flag. That run's locked section would also have to fit between this run's lock release and its clear.

### Findings (all optional; FREEZE: into the operator's follow-up list)
- **C-683-7 (logged by the builder; judged here; stays C, now probe-proven).**
  - **What happens:** the payee-notice write fails and then the flag write also fails (`flagForReconcile` catch, `:1388-1393`). `recordAdjustmentNotices` returns false (`:1674-1675`) and `applyAdjustments` resolves normally. So the webhook answers 2xx: no flag, no redelivery, no notice.
  - **Proof:** probe **P4** fails as designed: `retried: false`, `notices` 0, coach 5,640 ([run 37222906855](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37222906855)).
  - **The logs are wrong in this path:** "the sweeper retries the notice" (`:1672`) and "relying on Stripe redelivery" (`:1391`).
  - **Why C, not B** (the same rarity class as B-683-5, which this lens rated C):
    - The money is converged and idempotent.
    - The window is only after the last money write of a locked run. An outage any earlier throws, the delivery fails and Stripe redelivers.
    - Two `alert=true` lines with the charge id give on-call a manual path (admin sweep).
    - For refunds, the F4 handler's per-refund coach alert (`emitRefundCoachAlert`) is sent on its own. For a lost dispute, however, this notice is the only coach-facing record.
  - **Fix rule:** `flagForReconcile` returns whether the flag was written. When `recordAdjustmentNotices` could neither record nor flag, rethrow, so the delivery fails and Stripe redelivers. A replay is idempotent for money and notices. Use P4 as the failing-before test. Recommended for the first fees round after the freeze. It is about 6 lines in F3, which has room (2,835).
- **C-683-4 (carried, Opus):** unbounded per-purchase Stripe reads in reconciliation, `src/connect/fees/reconciliation.service.ts`. Fix rule: bound reads per run and resume from a cursor.
- **C-683-5 (carried, Opus; = Sol C-683-6):** an incomplete paid-invoice page marks the backfill exhausted and resets the cursor, `charge-settlement.service.ts:1152` (`page.data ?? []`), `:1224-1227` and `:1233`. Fix rule: only a validated terminal page ends the scan; otherwise keep the cursor and log `invoiceBackfillFailed`.
- **C-683-6 (carried, Opus):** the succeeded-only branch, `reconciliation.service.ts:350-354`, has no unit case in `reconciliation.service.spec.ts`. The new spec and P2/P5 exercise it end to end (pending/failed refunds reconcile to drift 0). Fix rule: add the two unit cases.

Sol's C-683-4 (platform-cash naming) is Sol's to decide. The builder reports that the Sol F34-117 v1/v2 probes fail the same 2 cases at 33a9d83b and 438d29e6, so this round introduced no regression.

### Money list (this delta)
- **Webhook order and redelivery:** a refund before the fee waits on the awaiting row and is resolved at settle from Stripe's list; redelivery, a second settle and the sweep move nothing (builder spec, P2).
- **Concurrency:** both changes run under `chargeLock.run` and its fence; the run flag is call-local; the claim CAS is unchanged (P6).
- **Terminal states:** a full refund becomes an exact recovery (P2); disputes are unchanged.
- **List pagination and completeness:** the settle path uses the round-13 reader; an incomplete or malformed list or a missing refund balance transaction keeps the row awaiting (P3, builder's unreadable cases).
- **Currency:** only settlement-currency minor units reach `refunded_cents` on a converted charge; presentment cents stay in the notice's client fields (P5).
- **Copy:** no user copy changed. The only false text is the two log lines under C-683-7.

### Piece boundary
- Type-check and Build pass at this head. Nothing imports a later piece, and there is no migration.
- R75: `check-r75 --mode=range` main..438d29e6 reports OK, and so does the current fees top #686 b002ec21.

### CI at 438d29e6 (red by design, verified)
- **build-and-test** ([run 37219975200 / job 111488162329](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219975200/job/111488162329)):
  - Lint, Type-check and Build pass.
  - Test: exactly 9 tests in 3 suites fail:
    - `checkout-webhook-fee-split` (2) and `purchase-split-handler` (2): `connectTransfer.updateMany is not a function`;
    - `reconciliation.service` (5): `Cannot read properties of undefined (reading 'findMany')`, because the old mock has no `chargeSettlement`.
  - 727 suites and 12,573 tests pass, including `s-fee-r15-deferred-fx-notice-flag`.
- **F4 carries the fix.** F4 #684 @ bbf2eac6 (438d29e6 is an ancestor) updates all three specs and is fully green ([run 37220306306](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220306306)).
- **Green:** rls-floor-guard, rls-live-tests, community-live-tests, mwb-3-live-tests, Schema parity, npm audit, test-deploy-readiness, size-label, comment-deploy-readiness. deploy-readiness-gate was skipped.
- **Not run on a stacked base:** CodeQL, danger, banned casts and SBOM run only at the composed candidate.

Landing: the stack lands as one (rule 11). This verdict approves F3 at this exact head only. Later pieces restacked on it need only a merge-only delta check.
