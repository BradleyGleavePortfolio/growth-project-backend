AUDIT Claude Opus 5.5 — growth-project-backend#677 @ 4aaee4ed601bb0afb3f00828e28ace286a80512e — VERDICT: APPROVE

A/B/C = 0/0/1

Lens AUD-OPUS-CM2-116 (agent 116 wave). T4 audit (money read model) of the complete M4 piece: one new 1,244-line test file, `test/coach-money.service.spec.ts`, with no runtime source, migration, dependency or CI gate change. Every required check that runs on a stacked base is green at this head; `build-and-test` reports `PASS test/coach-money.service.spec.ts` ([job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37148738593/job/111277955164)).

### Evidence reuse (G09) and why it applies
- `git merge-tree --write-tree f60ed603 d23fa317` gives `d4d5d4bc`. `git diff 4aaee4ed d4d5d4bc` touches only the three M2 files (#675). So M4 is exactly the refreshed #641 test file.
- The spec blob is byte-identical at `fb29fb9e`, `02cd3f88` and `f60ed603`. This lens APPROVED #641 at `fb29fb9e` with this file in the tree ([Opus APPROVE](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/641#issuecomment-5964726454)).
- The code under test, `src/coach-money/*`, is byte-identical between `fb29fb9e` and this head.
- I still read every assertion and fixture at this head, so the approval does not rest on the reuse alone.

### Piece boundary
- The spec imports only code present at the M3 parent (#676 `564f33bf`) or on main:
  - `coach-money.service` exports;
  - `deriveConnectState` and the 6-argument `CoachConnectService` constructor;
  - `connect-onboarding-return.controller`;
  - `public.decorator`.
- It imports nothing from M2 #675 and runs under the `test/` jest root.
- It adds no production behaviour, so it is inert.
- It lands as one with #674 and #676 (rule 11).

### What the spec proves (read line by line)
- **Fee identity:** `price - actual Stripe fee - 2% = net` for settled charges, and `price - 2%` with the platform paying processing for legacy charges. Both are checked as arithmetic identities, not snapshots.
- **Seller/payee isolation:** a destination slice paid to someone else counts for nothing. Every mocked ledger and purchase query is asserted to be scoped to the caller (`coach_user_id` or `payee_user_id`).
- **Reversal windowing (C-641-1):** a cumulative reversal split across its refund events sums exactly (1,960 + 2,842 = 4,802). A September refund of an August sale lowers September. The two windows together equal the all-time fold.
- **CSV export:**
  - `net_to_you` sums to the window net;
  - formula cells are neutralised;
  - cents are formatted without float maths;
  - an oversized export returns `MONEY_EXPORT_TOO_LARGE`.
- **Currency (B-641-3):** currencies are never summed, and the default and explicit currency are honoured. MRR only counts the summary currency.
- **Cadence (B-641-4, B-332-2):** quarterly, weekly, 2-year and combo MRR, rounded once. One-time charges and unknown intervals get a null cadence, never a guessed Monthly.
- **Charge states (B-641-2):** a lost chargeback shows as charged_back, never paid. Refunded, partially refunded, disputed and canceled states are covered.
- **Attention items:** attempt n of 4, next retry and the card-update link time come from the sent `DunningAttempt` (B-641-1).
- **Other:** another coach's charge returns `MONEY_CHARGE_NOT_FOUND`. The PayeeRecovery seam (C-641-3) reads `payee_user_id`, `status: 'open'`, `currency`, `amount_cents` and `collected_cents`, which match the `PayeeRecovery` model at fees F6 #686 (`7be7d396`) field for field.
- I found no tautologies and no assertion that passes against a stub of the function under test.

### Prior findings of this lens on #641
- **B-641-12 (concurrent refunds on one transfer lose one local reversal):** the code is in M1 #674 (`TransferOrchestratorService.recordReversal`, `SplitLedgerService.applyReversal`), not in this piece. FIX ROUND 5 does not list it. It is reported for #674's lens and does not block this test-only piece (guide rule 9). This piece cannot land before #674 anyway (rule 11).
- **C-641-13 (M3)** and **C-641-2 (carried integration):** not in this piece.

### C (optional)
- **C-677-1 — the MRR status set is pinned only by a `canceled` exclusion.**
  - `MRR_SUBSCRIPTION_STATUSES` (`src/coach-money/coach-money.service.ts:639`: active, trialing, past_due) has no test that `trialing` and `past_due` count while `payment_failed` and `expired` do not.
  - **Fix rule:** add one `getSummary` case with one row per status, so the trials and dunning stacks cannot change MRR silently.
  - Outside this diff: whether `trialing` should count in MRR at full price is a product question for M3/trials. It is noted in my report for the operator.

Restack note: B-CM1-116 will restack #677 after fixing #674/#676. That head needs a short delta verdict confirming the spec blob is unchanged, or auditing every changed line.

No push to the PR branch, no merge and no dispatch outside the CI lane by this lens.
