FIX ROUND 2 (B-SHEET2-119, agent 119) — growth-project-mobile#342 @ 0b1985f46ae2d4baadfcc6a02f8257c2f504249d

Answers AUDIT GPT-6.1 Sol (REQUEST CHANGES 0/2/1, issuecomment-5982676839) and AUDIT Claude Opus 5.5 (APPROVE 0/0/5, issuecomment-5982679049) at `56f281ad`. Tier T4 (payments, money copy).

First, merge-only: main `cc4ceeed` merged into this branch (`69de3c2`, clean; main touched no PR file). Then one test commit (`9498144`, failing before) and one fix commit (`0b1985f`).

Size: +2,136 / -17 = 2,153 changed lines (tests included), inside the 1,500-3,000 band. Stated per the size rule.

## Findings -> change -> commit -> test

| Finding | Change | Commit | Test (src/lib/__tests__/packagePayment.sheet2.test.ts) |
|---|---|---|---|
| B-342-1 (Sol, residual): a request with no HTTP status (offline, timeout, dropped) said "the payment did not start and nothing was charged", also on a replay after an unclear card step (packagePayment.ts:456-457, :789-790) | No status is no proof: new `noAnswer(ref)` copy "The app could not reach the server, so this step is not confirmed. Check your connection, then open your plan in Membership to see where it stands before you start again. If it is still unclear, email support and quote reference X." Cause `no_answer`, `openPlan`, support + the attempt reference, key kept (no `retireKey`), nothing sent to Sentry. The old `offline` copy is gone | 0b1985f | "B-342-1 no HTTP answer ..." 4 cases (timeout on payment_intent and subscription_intent, network error on payment_intent and claim_free) + production 404 control |
| B-342-3 (Sol): JPY and every zero-decimal currency shown 100x too small (planTerms.ts:150-161, :215-226 via utils/currency.ts:13-19) | `utils/currency.ts` now maps each currency to its Stripe minor-unit exponent (docs.stripe.com/currencies): zero-decimal BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF (exponent 0); three-decimal BHD JOD KWD OMR TND (exponent 3, 3 digits shown); ISK and UGX two-decimal in Stripe amounts but shown whole; everything else 2. `formatCurrencyCents` (and so `planTerms.money`, price labels, terms and the CTA) divides by that exponent and shows those digits. Request integers are never converted (presentment minor units only, no settlement or FX) | 0b1985f | "B-342-3 ..." 5 zero-decimal, 5 three-decimal, ISK/UGX, JPY terms/label/CTA, USD/EUR/unknown-code controls |

Failing before (test commit on the merged head, no fix), with every prior probe: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229072837 — 19 failed / 63 passed.
After (fix + the same probes): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229115669 — 81 / 82 pass; the one red test is the held Opus C-342-1 probe (red by design under the freeze).
Required checks at this head: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229614904 pass; Analyze (javascript-typescript), Analyze (actions) https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229614891 pass; CodeQL pass.

## Prior probes replayed at this head (both lenses, run 37229115669)

| Probe | Origin | Result |
|---|---|---|
| payment_intent timeout on a replay never claims unpaid | Sol audSolSh118.transportUnknown (run 37220350807) | pass (failed before) |
| subscription_intent timeout on a replay never claims unpaid | Sol transportUnknown | pass (failed before) |
| control: production missing subscription route stays specific | Sol transportUnknown | pass |
| JPY 4900 minor units are 4900 yen | Sol audSolSh118.minorUnits (run 37220824000) | pass (failed before) |
| KWD 4900 minor units are 4.900 dinars | Sol minorUnits | pass (failed before) |
| control: USD 4900 is 49 dollars | Sol minorUnits | pass |
| 35 copy / reply-code / production-404 / trial-code checks | Opus audOpusSh118.probe342 (run 37221079350) | pass |
| PAYMENT_RETRY, STRIPE_CHECKOUT_ERROR, SUBSCRIPTION_SETUP_UNAVAILABLE never no charge | Opus audOpusP12117.probe342 | pass |
| C-342-1 a one-time package with a $0 recurring part sells one-time | Opus audOpusP12117.probe342 | FAIL, held C (red by design; planTerms.ts isCombo not touched by a B fix) |
| unknown 500 / #661 replies / Sentry machine labels / definitive decline control | Sol audSolP12117.paymentContract | pass |
| builder suites packagePayment.replyCodes + utils/currency | B-SHEET-118 | pass |

## Money list self-check
- Webhook order and redelivery: the app consumes no webhooks; a lost answer now stays "not confirmed" and the replay uses the same key, so the backend hands back the same attempt.
- Concurrency (two workers, lock order): server locks are the backend's; the client keeps one key per package + sale kind (#343) and a single in-flight guard; a no-answer keeps the key, so a retry cannot open a second attempt.
- Terminal states (refunded, disputed, canceled, deleted account): unchanged from round 1 (PAYMENT_REFUNDED_OR_IN_REVIEW status + support; 401 session ended); no-answer never claims a terminal state.
- List pagination and completeness: no Stripe list on the device in S1.
- Currency: presentment minor units from the backend, divided by each currency's own exponent for display only (zero-decimal and three-decimal covered, ISK/UGX special case); no settlement or FX conversion; request integers untouched.
- Copy truth: "nothing was charged" now appears only where a definite refusal, the missing production route or Stripe's own state proves it; no-answer, unmapped and unconfirmed answers all say "not confirmed" with Open your plan and support.

Production backend today (3e9a9a75): one-time payments unchanged; renewing plans still get the specific `renewingUnavailable` copy on the bare 404 (control above).

Held Cs (freeze): C-342-1 (isCombo, red by design), C-342-2 (land #342-#344 as one). New follow-up Cs for the operator are in ops/reports/B-SHEET2-119.md.

READY FOR AUDIT
