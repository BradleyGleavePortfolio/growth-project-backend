**Tier:** T4 (money path). **Why:** M5 coach Money fix-round tests (tests only): the send-time retry admission and fail-closed Stripe reversal list fixes in M1 #674 (B-674-13, B-674-14) and the billed-evidence MRR fix in M3 #676 (B-676-5). **T4 trigger scan:** tests only (refunds, chargebacks, head-coach transfer reversals, recurring metrics); no runtime change. **T3 trigger scan:** none beyond T4. **Bounded T1:** no. **Canonical builder:** Claude Opus 5.5 (B-CM5-119, agent 119). **Parent owner:** #641 split stack (M1 #674 -> M3 #676 -> M4 #677 -> M5). **Acceptance evidence:** failing-before CI-lane runs (no fix) and after runs at the fixed heads, below. **Promotion triggers:** none (already T4).

Tests-only piece on the M4 #677 branch. M1 #674 (2,969 lines), M3 #676 (2,984) and M4 #677 (2,918) have no room for these specs under the 3,000-line ceiling they are grandfathered at, so the new tests live here. Size: +355/-0 = 355 changed lines (under the 1,500 limit for new PRs). Lands with the stack (merge guide rule 11); never alone.

- `test/refund-reversal-send-time.spec.ts` (9 cases): B-674-13 refund sweep admission at the time of each send (long run; window crossed by one second between selection and send; in-window control with the send-time attempt stamp; paging control); B-674-14 incomplete reversal lists (has_more with an empty page; non-empty page then no progress; owner reconcile closed 503 `TRANSFER_REVERSALS_LIST_INCOMPLETE`; complete two-page and complete empty-list controls).
- `test/coach-money-billed-mrr.spec.ts` (6 cases): B-676-5 a trial whose first invoice fails (real `CheckoutWebhookHandlerService` writer) is neither MRR nor paying; billed past_due renewal, first paid conversion, active trial, canceled never-billed, mixed client; exported `BILLED_WHERE` (C-673-3).

Failing-before: [run 37229228865](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229228865) (M1 cases, no fix: 6/9 red by assertion; the paging, two-page and complete-empty controls green) and [run 37229475145](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229475145) (M3 cases, no fix: 4/6 red by assertion, 2 controls green). After: [run 37229435769](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229435769) and [run 37229501779](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229501779) (all green).

## Fix rounds

| Round | Job | Head | Closes | Size |
|---|---|---|---|---|
| 0 | opened (B-CM5-119, agent 119) | `73fa700c` | tests for B-674-13, B-674-14 (#674) and B-676-5 (#676) | 355 |
