AUDIT Claude Opus 5.5 — growth-project-mobile#343 @ af984441a5328c9738bc12e3bdc09a44d3664477 — VERDICT: REQUEST CHANGES
A/B/C = 0/1/2

Lens: Claude Opus 5.5, agent 117, AUD-OPUS-P12-117. Independent audit of split piece S2 of #334 at its exact head (base #342 @ 728214956d999e741ae65e99cee93b1ea0157385). Paired backend contract read at its current heads: #678 2174eb7c, #679 0e1cfde00f6293c0ddf4ee9e2c99f5321bbe2cb8, #680 d1c62ee100e4abd72c21295c32f8b32e450981da.

Evidence reuse (G09): the last Opus APPROVE on this code is #334 @ 0629d50601618af7a51d0f92c4bbf828001dba7a (https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/334#issuecomment-5964822138). Byte-identical to that head and reused: `src/components/purchase/PlanTermsBlock.tsx`, `src/components/__tests__/PackageSelectionSheet.payment.test.tsx`, `src/config/__tests__/stripePublishableKey.test.ts`. Changed since then and audited in full: `src/hooks/usePackagePurchase.ts` (+368/-37 vs 0629d506, FIX ROUND 3/4: B-334-3, B-334-4, C-334-3), `src/components/purchase/PurchaseFeedback.tsx` (+36/-9), `src/components/PackageSelectionSheet.tsx` (+7). All 6 files were read in full for piece-boundary safety. Not reused: any Sol evidence.

Piece boundary: compiles alone (Typecheck/lint/test green at this head, https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37152690665/job/111289631367); imports only main and S1 modules, nothing from S3. This piece is live, not inert: it replaces the Day 1 sheet's buy flow, so it must not ship before the paired backend is deployed (the READY land-as-one rule covers this).

Control evidence at this exact head: the two S3 suites that test this piece's hook and sheet (`PackageSelectionSheet.recur3.test.tsx`, `PackageSelectionSheet.subscription.test.tsx`, copied unchanged from #344 f629e0f9) plus S2's own payment suite, run against af984441: 3 suites, 76 tests green, https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180193875 (branch `audit/AUD-OPUS-P12-117/343-controls`).

## B-343-1 — `src/hooks/usePackagePurchase.ts:631-635` + `src/components/purchase/PurchaseFeedback.tsx:46-55` an unknown one-time outcome is shown as "Payment received"

When a one-time card sheet ends without a clear answer (the native call threw, timed out, or lost the connection), `settleOneTimeUnknown` sets `phase: "confirming"` while it reads the purchases. `PurchaseFeedback` maps `confirming` + `saleKind === "one_time"` to `PACKAGE_PAYMENT_COPY.confirming` = "Payment received. Setting up your plan." (`packagePayment.ts:569`). The client sees that for the whole read (up to about 10 s, `ENTITLEMENT_POLL_DELAYS_MS = [0, 1500, 2500, 3000, 3000]`) and again on every Check again (`checkAgain`, line 1079), and only then gets `outcomeUnknown` ("it is not yet clear whether this payment went through"). That is the exact claim B-334-3 forbids, made before anything is proven. New in fix round 3 (`settleOneTimeUnknown` does not exist at 0629d506), so no earlier Opus approval covers it. The subscription path is not affected: its uncertain read shows the neutral `confirmingPlan` ("Confirming your plan.").

Probe (red at this head): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180210458 (branch `audit/AUD-OPUS-P12-117/343-probe`, spec `src/components/__tests__/audOpusP12117.probe343.test.tsx`). One-time package, `presentPaymentSheet` rejects, the purchase read is held open: `payment-confirming` reads "Payment received. Setting up your plan." (Expected pattern: not /payment received/i).

Minimal fix rule: while a one-time outcome is unproven, the progress text is neutral (for example "Checking whether the payment went through."). Carry the distinction in state (an `uncertain` flag or a separate phase) so `PurchaseFeedback` shows "Payment received" only after Stripe confirmed the sheet. One test that fails before the fix: the probe above, plus the same assertion after Check again.

## C-343-1 — piece boundary: the tests for this piece's fix-round logic ship in #344

The suites that prove B-334-3, B-334-4 and C-334-3 in this piece's hook (`recur3`, 522 lines; `subscription`, 621 lines) import only S1/S2 modules but live in S3. At this head only `PackageSelectionSheet.payment.test.tsx` runs against the hook, so S2's own CI does not cover the subscription path. Moving them here would push S2 past the 3,000-line hard limit, so the split is reasonable; the control run above shows they pass at this head. Fix rule (default): every fix round on #343 runs those two suites against the #343 head in the CI lane and cites the run in its FIX ROUND. Operator alternative: move them into S2 and split the hook differently.

## C-343-2 — outside this diff: the iOS return URL is never handed to Stripe

The hook passes `returnURL: STRIPE_RETURN_URL` (`tgp://stripe-redirect`, `packagePayment.ts:430`) to `initPaymentSheet`, but no code calls `handleURLCallback` (no match in `src/`; `RootNavigator.tsx:473-476` handles incoming URLs for invites and resets only). Stripe's React Native subscription guide asks the root component to forward incoming URLs to the SDK (https://docs.stripe.com/billing/subscriptions/build-subscriptions?payment-ui=mobile&platform=react-native). Card 3DS mostly completes in-app, so this is a device-acceptance check, not a code defect proven here. Fix rule: forward `Linking` URLs to `handleURLCallback` before the app's own deep-link handling, or record on-device 3DS (redirect challenge) acceptance on iOS before release.

## Inherited, not counted here
- B-342-1 (unconfirmed subscription-intent outcome told as "nothing was charged") lives in `src/lib/packagePayment.ts` (#342) and is fixed there. It reaches users through this hook (`usePackagePurchase.ts:925`); the same probe run 37180210458 shows it: PAYMENT_RETRY with the backend's "result is not confirmed yet" body renders "The last attempt did not finish and nothing was charged. ...". The #342 fix is enough; the probe case can then become a regression test here.
- C-334-2 (#322 composition in `ClientPackagesScreen.tsx`) belongs to #344.

## What holds (audited at this head)
- B-334-3: an unclear card answer reads the plan (`settleUncertain`) or the purchases before any copy. No-charge only on `awaiting_payment` / `awaiting_card`; paid, processing and card_saved keep reading; a failed read is "outcome unknown" with Check again, never no-charge.
- B-334-4: `reconcileIntentTerms` keeps trial days at 0 when the backend says 0 (no `||` fallback), sends `expected_one_time_cents`, and opens no chargeable sheet when trial, one-time part, currency or cadence changed; a first charge inconsistent with the adopted terms is a support notice; confirm replays the same key.
- C-334-3: `pollPlan` re-checks the mount and attempt after each read (lines 465-466); no callback after unmount.
- B-334-1 (prior Opus): SUBSCRIPTION_ATTEMPT_EXPIRED retries once with a fresh key (lines 874-906); its own copy when it repeats.
- Double taps blocked (`inFlightRef`), Skip and close blocked while busy, CTA hidden in done and price-review states, secrets stay in local variables, Sentry gets cause/step/status/code/reference only.
- Copy: no first person, no exclamation marks, no generic error text.

CI at this head: Typecheck/lint/test green (CodeQL runs once the stack is on main, as the READY says). Probe and control branches are deleted when this job ends.
