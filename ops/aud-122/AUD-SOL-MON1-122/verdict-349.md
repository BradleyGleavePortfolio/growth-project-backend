AUDIT GPT-6.1 Sol — growth-project-mobile#349 @ 53e36aaf4d9f7f708baea7fb6a3d76ecbb7359a4 — VERDICT: REQUEST CHANGES

Job AUD-SOL-MON1-122, agent 122. A/B/C = 0/2/0.

**B-349-1 — an unpaid trial falsely claims “Clients paid” and shows a false money equation.**

Normal-user story: A coach opens a client's normal $49 free-trial purchase and is told “Clients paid $49.00,” zero deductions and “Net to you $0.00,” although no payment has happened. [Charge detail](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/53e36aaf4d9f7f708baea7fb6a3d76ecbb7359a4/src/screens/coach/money/MoneyChargeScreen.tsx), [backend breakdown](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/coach-money/coach-money.service.ts).

`src/screens/coach/money/MoneyChargeScreen.tsx:139-177`: a trial maps to `pending`, `settled=false`, scheduled package price in `price_cents`, and zero fee/net fields; only `failed`/`canceled` suppress the paid-money breakdown, so pending renders “Clients paid” and says the payment must clear. [Money read model](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/coach-money/coach-money.service.ts), [detail rendering](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/53e36aaf4d9f7f708baea7fb6a3d76ecbb7359a4/src/screens/coach/money/MoneyChargeScreen.tsx).

Minimal fix: an unpaid/unsettled pending purchase shows the scheduled package price, not a paid-money equation or a payment-clearing claim; keep the real settled-charge breakdown. Verify the ordinary trial and settled-charge cases.

**B-349-2 — the held balance is falsely explained as fees only.**

Normal-user story: A coach refunds a $100 sale after its payout reaches the bank and Money explains the resulting $100 future-sales hold as 2% TGP and Stripe fees, although $94.80 is unrecovered payout principal. [Held-balance copy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/53e36aaf4d9f7f708baea7fb6a3d76ecbb7359a4/src/screens/coach/money/MoneyScreen.tsx), [refund recovery](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/connect/fees/charge-settlement.service.ts).

`src/screens/coach/money/MoneyScreen.tsx:891-901`: the summary sums all open recovery rows, including original payout amounts that cannot be reversed because the connected balance has been paid out; its fixed explanation names only retained fees. [Held read model](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/coach-money/coach-money.service.ts), [recovery production path](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/connect/fees/charge-settlement.service.ts), [adjusted targets](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/cb986a4cba16036ccd4ed11158b849eb1df0292e/src/payouts-v2/platform-fee.service.ts).

Minimal fix: describe the outstanding refund/chargeback recovery balance, including retained fees and amounts not recovered from the original payout, deducted from future sales; preserve the backend's exact amount. Verify fee-only and already-paid-out refund cases.

Restack delta checked: every Money screen, Home-card and Money navigation blob is unchanged; the single wizard step-5 conflict retains the Money first-payment body plus “Go to your dashboard.” [N2 restack hunk](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/349#issuecomment-6004975915).

Current PR CI is red by design: exactly three stale Earnings/Business assertions fail in `paymentsConnectPackages.test.ts` and `coachSaasBlockers.test.ts` (463 other suites / 6,416 tests pass); #351 updates those assertions and its integrated required CI is green. [N2 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385318013/job/112017040267), [N4 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385323691/job/112017058719).

Cs: none. Independent static cross-contract review, no prior approval evidence reused and no local test/build command. These are ordinary single-person financial-display/copy paths, not timing, retry or unusual-input findings. Land #348–#351 as one train only after the item-list fixes and exact-head approvals.
