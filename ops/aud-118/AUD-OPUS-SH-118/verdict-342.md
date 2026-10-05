AUDIT Claude Opus 5.5 — growth-project-mobile#342 @ 56f281ad3aa977882c962a6591d3594899cdd5a1 — VERDICT: APPROVE
A/B/C = 0/0/5

Lens: Claude Opus 5.5, agent 118, AUD-OPUS-SH-118. Independent audit of split piece S1 (payment core) at its exact head. Base main 7fdb629a (merge 43f6bfad; main changed none of the 10 PR files). Size +2,009/-9 = 2,018 (1,500-3,000 band, under the cap). Backend contracts read at: production 643817b3586e27ad95cc3c519733fc14d0aaafde; #661 f80f0088; recurring #678 b04ea692, #679 6760ee6a, #680 9621457e, #696 5225e078, #701 67905b43 (top); trials T3 #673 df76889f; dunning D4 #690 06307883.

Evidence reuse (G09): the last Opus verdict on this piece is REQUEST CHANGES @ 728214956d999e741ae65e99cee93b1ea0157385 (https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5977006434), which audited all 10 files. Since 72821495 only `src/lib/packagePayment.ts` (+229/-57), `src/lib/planTerms.ts` (+33) and the new `src/lib/__tests__/packagePayment.replyCodes.test.ts` (185) changed. Those three were audited in full. The other 7 files are byte-identical to 72821495 (and to the Opus APPROVE #334 @ 0629d50601618af7a51d0f92c4bbf828001dba7a), so that audit is reused. The builder's CI runs are reused as CI evidence. The reply-code contract was re-proven independently in the probe below. No Sol evidence or verdict was reused.

## Prior findings
- B-342-1 (Opus) closed. `packagePayment.ts:863-866` (PAYMENT_RETRY on subscription_intent) and `:969-972` (SUBSCRIPTION_SETUP_UNAVAILABLE, and STRIPE_CHECKOUT_ERROR on subscription_intent) now give `notConfirmed`: check the plan, support, reference, key kept, Sentry. The default (`:990-1003`), the shape error (`:777-788`) and the sheet fallbacks use the neutral `unknown` copy plus Open your plan. One-time PAYMENT_RETRY keeps the no-charge copy, which is proven: in production and #661 `checkout.service.ts`, PAYMENT_RETRY is thrown only after the reservation is deleted and before any client secret exists.
- B-342-2 (Sol) closed. #661 409 PAYMENT_ALREADY_COMPLETE gives alreadyComplete + completed + Open your plan + retireKey. PAYMENT_REFUNDED_OR_IN_REVIEW gives support + Open your plan, with the key kept and no paid claim. PAYMENT_CHECKOUT_CLOSED gives retireKey with no money claim. 503 PAYMENT_IN_PROGRESS gives inProgress with the key kept. #661 sends these codes in `error` only, and `backendCodeOf` reads that field. PAYMENT_SUCCESS_RETRY and PAYMENT_FAILURE_RETRY are webhook-only (`checkout-webhook-handler.service.ts:116-131` at f80f0088). If either ever reached the app, it would get the neutral default, which makes no money claim.
- C-342-1 (Sol) closed. `MACHINE_CODE` `/^[A-Z][A-Z0-9_]{1,63}$/` and `machineLabel` bound what reaches Sentry.
- C-342-3 (Opus) closed. S1 now ships its own reply-code suite.
- C-342-1 (Opus, isCombo) and C-342-2 (Opus, trial_days) stay C under the freeze (see below).

## Today's production backend (643817b3, no subscription-intent route)
HttpExceptionFilter plus `buildErrorEnvelope` answer `{statusCode:404, message:"Cannot POST /v1/checkout/subscription-intent", error:"Not Found", ...}` with no code. `packagePayment.ts:796-807` maps exactly that answer on subscription_intent to `renewingUnavailable` ("This plan renews automatically, and renewing plans cannot be started from the app yet, so this plan did not start and nothing was charged. Message your coach to arrange it."). The copy is truthful because the route does not exist. A coded 404 (PACKAGE_NOT_FOUND) is not mistaken for a missing route. The same bare 404 on payment-intent makes no money claim. Production payment-intent returns the shape this piece parses. Renewing plans always route to subscription-intent and are never sold one-time.

## Recurring top 67905b43 and trials
PLAN_CHANGE_UNCONFIRMED has its own copy plus reload. CHECKOUT_KEY_OTHER_PLAN and SUBSCRIPTION_ATTEMPT_EXPIRED retire the key. PAYMENT_RETRY, SUBSCRIPTION_SETUP_UNAVAILABLE and STRIPE_CHECKOUT_ERROR never claim no charge. For the B-343-4 terms, `reconcileIntentTerms` (`planTerms.ts`) compares the pinned `trial_ends_at` with the shown date in setup mode only, and `planTerms` then shows the pinned date. Every PACKAGE_PAYMENT_COPY string is free of first person, exclamation marks and generic error copy.

## Probe (independent, CI lane; a control that is expected to pass)
Branch audit/AUD-OPUS-SH-118/342-copy (this head plus one spec): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37221079350. Result: 2 suites, 35/35 passed. The run covers the exact production 404 envelope, the exact #661 error-only envelopes, the recurring code+error envelopes, the trial codes (recorded for C-342-4) and the copy rules over every PACKAGE_PAYMENT_COPY string. It also re-runs the builder's replyCodes suite.

CI at this head: Typecheck/lint/test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219351230 success; CodeQL https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219351237 success.

## Findings
No A and no B findings.

## Follow-ups (C, freeze: for the operator to ticket; none blocks)
- C-342-1 (held from the last round) `src/lib/planTerms.ts:90-93`: a legacy one-time row with a $0 recurring part routes renewing and can never be bought. The earlier probe stays red by design. Fix rule: `recurringAmount !== null && recurringAmount > 0`.
- C-342-2 (held from the last round) `src/api/clientPaymentsApi.ts:347-349`: un-nulled `trial_days` is safe only because the stack lands as one. Fix rule: keep the land-as-one rule in the merge plan, and make no build from a main that has S1 without S3.
- C-342-4 `src/lib/packagePayment.ts:990-1003`: TRIAL_ALREADY_USED and TRIAL_IN_PROGRESS (trials T3 df76889f `src/packages/trials/trial-usage.service.ts:85-101`; `reserve()` has no caller yet) fall to the neutral `unknown` copy. That copy is truthful but not specific. Fix rule: whichever of the trials wiring or this stack merges second maps TRIAL_ALREADY_USED to "the trial was already used, so the plan can start at the regular price" (reload, no charge claim) and TRIAL_IN_PROGRESS to "finish the other checkout or wait", key kept.
- C-342-5 `src/lib/packagePayment.ts:510-511`: the `inProgress` copy says "This payment is still being set up ... You will not be charged twice" even for trial (setup) attempts. Fix rule: use step- or mode-aware wording ("This plan is still being set up") when the step is subscription_intent.
- C-342-6, outside this diff (dunning D3/D4 06307883 `src/checkout/client-billing.service.ts:2259-2287, 2474-2486`): PLAN_CHANGE_RESULT_UNKNOWN, CANCEL_INCOMPLETE, BILLING_ACTION_IN_PROGRESS and PAYMENT_RESULT_UNKNOWN on plan actions fall to the neutral default. Fix rule: the dunning mobile lane maps each one to specific copy (check the plan, reload) when it wires those actions.

Probe branch audit/AUD-OPUS-SH-118/342-copy is deleted when this job ends.
