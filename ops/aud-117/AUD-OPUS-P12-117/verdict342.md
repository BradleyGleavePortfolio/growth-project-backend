AUDIT Claude Opus 5.5 — growth-project-mobile#342 @ 728214956d999e741ae65e99cee93b1ea0157385 — VERDICT: REQUEST CHANGES
A/B/C = 0/1/3

Lens: Claude Opus 5.5, agent 117, AUD-OPUS-P12-117. Independent audit of split piece S1 of #334 at its exact head (base main, BEHIND main 7fdb629a; the PR files are unaffected). Paired backend contract read at its current heads: #678 2174eb7c, #679 0e1cfde00f6293c0ddf4ee9e2c99f5321bbe2cb8, #680 d1c62ee100e4abd72c21295c32f8b32e450981da (`subscription-errors.ts`, `subscription-checkout.service.ts` and `checkout.service.ts` are byte-identical between #679 and #680).

Evidence reuse (G09): the last Opus APPROVE on this code is #334 @ 0629d50601618af7a51d0f92c4bbf828001dba7a (https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/334#issuecomment-5964822138). Byte-identical to that head and reused: `.env.example`, `app.config.js`, `config/expected-env.json`, `src/api/clientPaymentsApi.ts`, `src/components/purchase/usePaymentSheetAppearance.ts`, `src/config/wallets.ts`, `src/config/__tests__/wallets.test.ts`. Changed since then and audited in full: `src/lib/packagePayment.ts` (+150/-21 vs 0629d506, FIX ROUND 3/4), `src/lib/planTerms.ts` (+86). All 9 files were read in full for piece-boundary safety. Not reused: any Sol evidence.

Piece boundary: compiles alone (Typecheck/lint/test green at this head, https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37152688718/job/111289624734); nothing imports S2/S3; `packagePayment.ts` has no importer at S1 (inert); wallets default off and the Stripe config plugin is added only when a merchant id or Google Pay flag is set. Two piece-boundary notes are C-342-2 and C-342-3.

## B-342-1 — `src/lib/packagePayment.ts:512-513, 556-559, 783-787, 853-869` tells an unconfirmed subscription outcome as "nothing was charged"

`describeBackendFailure` maps three subscription-intent codes to copy that claims no charge:
- `PAYMENT_RETRY` -> `retrySameAttempt`: "The last attempt did not finish and nothing was charged. ... You will not be charged twice."
- `STRIPE_CHECKOUT_ERROR` -> `stripeUnavailable`: "The payment service did not answer, so nothing was charged."
- `SUBSCRIPTION_SETUP_UNAVAILABLE` -> `setupUnavailable`: "The trial could not be set up right now and nothing was charged." (also says "trial" for a paid, non-trial plan)

The paired backend now sends exactly these codes when the outcome is NOT confirmed (B-679-6 / B-679-7, backend #679 @ 0e1cfde0):
- `src/checkout/subscription-errors.ts:102-115` `inProgress(true)` -> PAYMENT_RETRY, "its result is not confirmed yet. Open Your plan to check whether it started before you try again."
- `subscription-checkout.service.ts:766-777` (`mintSubscription`): "paid or in flight although the attempt closed meanwhile ... never a no-charge answer" -> `throw inProgress(true)` (logged `billing.subscription_paid_after_close`). Reachable from this app: an earlier sheet on the same attempt was confirmed with an unclear answer, the key is kept, and the client taps Start again with the same key.
- `subscription-errors.ts:121-137` `stripeFailure(err)` (noCharge defaults to false) -> STRIPE_CHECKOUT_ERROR "this step did not finish"; thrown at `subscription-checkout.service.ts:936` (`replayAttempt`, the retrieve of an already bound, possibly paid subscription fails).
- `subscription-errors.ts:151-158` `setupUnavailable(false)` -> "closing it is not confirmed yet"; thrown at `subscription-checkout.service.ts:834` (`finishBound`) in payment mode as well as setup mode.
The backend separates proven no-charge from unknown only in its message text; no machine field. So the mobile copy must not assume no charge for these codes on `subscription_intent`.

Probe (red at this head, 4 failed / 4): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180147690 (branch `audit/AUD-OPUS-P12-117/342-probe`, spec `src/lib/__tests__/audOpusP12117.probe342.test.ts`). Received, for example: "The last attempt did not finish and nothing was charged. Start again to continue where it stopped. You will not be charged twice." for the backend's "result is not confirmed yet" PAYMENT_RETRY body. The same defect reproduces through the #343 hook (run 37180210458, see the #343 verdict); it is fixed here.

Minimal fix rule: for step `subscription_intent`, PAYMENT_RETRY, STRIPE_CHECKOUT_ERROR and SUBSCRIPTION_SETUP_UNAVAILABLE never claim no charge. The copy says the result is not confirmed yet, tells the client to check Your plans / Membership before starting again, and keeps the support email and reference (a Check again that reads the plan is optional). SETUP_UNAVAILABLE copy does not say "trial" unless the plan has a trial. The one-time `payment_intent` PAYMENT_RETRY may keep its no-charge copy (`checkout.service.ts:602-608`: there it means the winner failed and freed the key). One test per code, failing before the fix. Alternative (operator decision): the backend adds a machine field when no charge is proven and mobile keys on it; default is the mobile copy change, which needs no backend round.

## C-342-1 — `src/lib/planTerms.ts:83-88` a combo with a $0 recurring part is routed as a renewing plan

`isCombo` only checks `recurringAmount !== null`; the header (`planTerms.ts:10-12`) says the rule mirrors backend `isRecurringPackage()` exactly, which requires `recurring_amount_cents > 0` (`checkout.service.ts:93-104`: "A combo's recurring part of $0 renews nothing: it is a one-time sale"). A row `{billing_type:'one_time', amount_cents:20000, recurring_amount_cents:0, recurring_interval:'month'}` becomes a renewing $0.00-a-month plan (`renewing: true`, `amountCents: 0`): the request goes to subscription-intent, the backend answers ONE_TIME_REQUIRES_PAYMENT_INTENT, mobile shows termsChanged and reloads into the same row, so the plan can never be bought from the app. Backend package validation (recurring minimum, `packages.service.ts:755-762` at #680 head, also on backend main) blocks new rows like this, so only a legacy row can hit it: C. Probe: same run 37180147690, case "a one-time package whose recurring part is $0 ..." (Expected false, Received true). Fix rule: `recurringAmount !== null && recurringAmount > 0`.

## C-342-2 — `src/api/clientPaymentsApi.ts:347-349` (piece boundary) S1 alone is not fully inert

S1 un-nulls `trial_days`. On main, `ClientPackagesScreen.tsx:447-448` and its CTA already render "{n}-day free trial" / "Start free trial" from that field while still buying through POST /v1/checkout/sessions, which starts no trial. Harmless only because the stack lands as one (S3 replaces that screen), mobile main does not build or update on push, and backend main has no `trial_days` column yet (it arrives with the paired backend stack). Fix rule: no build from a main that has S1 without S3; or keep the land-as-one rule recorded in the merge plan.

## C-342-3 — piece boundary: S1's money logic has no test in S1

`packagePayment.ts` (1,025 lines) and `planTerms.ts` (385 lines) are tested only by suites in S2 (`PackageSelectionSheet.payment.test.tsx`) and S3 (`PackageSelectionSheet.recur3.test.tsx`, `.subscription.test.tsx`). S1's own CI proves compile and the existing importers only. Fix rule: any fix round on S1 runs the S2 and S3 sheet suites against the S1+S2 code in the CI lane and cites the run.

## What holds (audited at this head)
- Routing: renewing (recurring, or one-time with a recurring part) -> subscription-intent; one-time paid -> payment-intent; $0 one-time -> claim-free. Interval guard rejects unknown cadences (null, never a guess).
- `subscription-intent` request body: `package_id`, `idempotency_key` (UUID), `expected_amount_cents`, `expected_one_time_cents`, `share_token` only in its 21-character form; matches `CreateSubscriptionIntentDto` (#679 controller lines 50-78, forbidNonWhitelisted).
- Response shape: `seti_`/`pi_` prefix cross-checked against `mode`; `mode: 'none'` needs `purchase_id`; matches `resultFromRow` (`subscription-checkout.service.ts:1231-1262`).
- `checkout_state` (`packagePayment.ts:273-290`): only `awaiting_payment` / `awaiting_card` count as proof of no charge.
- B-334-1 (prior Opus finding) remains closed: SUBSCRIPTION_ATTEMPT_EXPIRED and PACKAGE_ALREADY_INCLUDED are mapped to their own copy.
- Sentry (`reportPackagePaymentFailure`, `packagePayment.ts:625-649`) gets cause, step, status, code, reference and the Stripe error code / decline code / type only; no client secret, ephemeral key or body text.
- Copy rules: no first person, no exclamation marks, no generic error text in any new string.

CI at this head: Typecheck/lint/test, Analyze (js-ts, actions) and CodeQL green. Probe branch is deleted when this job ends.
