# AUD-OPUS-P12-117 — Opus lens audit of mobile #342 / #343 (split S1 / S2 of #334)

Job: AUD-OPUS-P12-117, agent 117, lens Claude Opus 5.5. Ended 2026-10-03 (PDT).

## Verdicts posted

| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile#342 (S1, base main) | 728214956d999e741ae65e99cee93b1ea0157385 | REQUEST CHANGES | 0/1/3 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5977006434 |
| mobile#343 (S2, base #342) | af984441a5328c9738bc12e3bdc09a44d3664477 | REQUEST CHANGES | 0/1/2 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5977006549 |

Heads were re-read right before posting (unchanged). One verdict per PR per head.

## Inputs read
- READY: #342 issuecomment-5975774150, #343 issuecomment-5975774163 (land as one after backend #678-#680 is deployed).
- #334 thread: Opus RC B-334-1 @ 3fc925d4; Opus APPROVE 0/0/1 @ 0629d506 (issuecomment-5964822138); Sol RC B-334-3/B-334-4 @ 0629d506; FIX ROUND 3 @ 04104c2e; Sol APPROVE @ 78ba9bc9; FIX ROUND 4 @ d466fd15 (C-334-3). Opus never audited rounds 3-4 before this job.
- Split fidelity: the #344 tree equals the merge-tree of #334 d466fd15 with main 367e6c48; 23 files split 9/6/8.
- Backend contract at current heads: #678 2174eb7c, #679 0e1cfde00f6293c0ddf4ee9e2c99f5321bbe2cb8, #680 d1c62ee100e4abd72c21295c32f8b32e450981da (`subscription-errors.ts`, `subscription-checkout.service.ts`, `checkout.service.ts` identical between #679 and #680).

## Evidence reuse (G09)
Reused against the Opus APPROVE @ 0629d506 for byte-identical files only: `.env.example`, `app.config.js`, `config/expected-env.json`, `clientPaymentsApi.ts`, `usePaymentSheetAppearance.ts`, `wallets.ts`, `wallets.test.ts` (S1); `PlanTermsBlock.tsx`, `PackageSelectionSheet.payment.test.tsx`, `stripePublishableKey.test.ts` (S2). Audited in full: `packagePayment.ts`, `planTerms.ts`, `usePackagePurchase.ts`, `PurchaseFeedback.tsx`, `PackageSelectionSheet.tsx`. All 15 files read in full for piece boundaries. No Sol evidence reused.

## Findings
### #342
- **B-342-1** `packagePayment.ts:512-513, 556-559, 783-787, 853-869`: PAYMENT_RETRY, STRIPE_CHECKOUT_ERROR and SUBSCRIPTION_SETUP_UNAVAILABLE on `subscription_intent` say "nothing was charged". Backend #679 (B-679-6/7) now uses these codes for outcomes it has not confirmed. Examples: `mintSubscription` "paid or in flight although the attempt closed" leads to `inProgress(true)` (service :766-777); `replayAttempt` retrieve failure leads to `stripeFailure(err)` (:936); `finishBound` leads to `setupUnavailable(false)` (:834). SETUP_UNAVAILABLE also says "trial" for paid plans. Probe red, 4/4 failed: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180147690.
- **C-342-1** `planTerms.ts:83-88`: a combo with a $0 recurring part is routed as renewing. The backend `isRecurringPackage` requires `> 0`, so the request goes to subscription-intent, gets ONE_TIME_REQUIRES_PAYMENT_INTENT, reloads, and loops. Only legacy rows can hit this. Same probe run.
- **C-342-2**: S1 un-nulls `trial_days` for main's old ClientPackagesScreen, which shows a "Start free trial" CTA on a flow with no trial. Safe only under land-as-one.
- **C-342-3**: S1's money logic has no tests in S1; its tests live in S2 and S3.

### #343
- **B-343-1** `usePackagePurchase.ts:631-635` + `PurchaseFeedback.tsx:46-55`: when a one-time outcome is unknown, the sheet shows "Payment received. Setting up your plan." while it reads purchases for up to about 10 s, and again on Check again. This is new in round 3. Probe red: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180210458. The same run also shows B-342-1 through the hook.
- **C-343-1**: the recur3 and subscription suites test S2 code but ship in #344. Control run of both, plus the payment suite, at the S2 head: 3 suites, 76 tests green, https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37180193875. Moving them into S2 would push it past 3,000 lines.
- **C-343-2** (outside this diff): `returnURL` is set but no code calls `handleURLCallback`, which Stripe's React Native guide asks for. Check on an iOS device during acceptance.

## For the operator (findings in other PRs, cross-lens notes)
- **C-334-2** (#322 composition, `ClientPackagesScreen.tsx`) belongs to #344 and is still open.
- **Sol's verdicts at the same heads** (read after the Opus verdicts were posted; not copied):
  - #342: Sol REQUEST CHANGES 0/2/1 (issuecomment-5976926407).
  - #343: Sol REQUEST CHANGES 0/5/0 (issuecomment-5976959713).
- **Same defect in both lenses:** Sol B-342-1 = Opus B-342-1. Sol also includes the unknown-500 default fallback. The fix round should cover that default for `subscription_intent` as well.
- **Sol B-342-2 / B-343-3:** depend on backend #661 (OPEN, head 957e3677, not in main and not part of #678-#680). Its `finishedPaymentReplay` returns 409 PAYMENT_ALREADY_COMPLETE, PAYMENT_REFUNDED_OR_IN_REVIEW or PAYMENT_CHECKOUT_CLOSED. Mobile maps none of these, so they fall through to "did not go through and nothing was charged". The Opus lens confirms the code read at #661 957e3677. It is reachable once #661 lands: the one-time key is kept after an unknown outcome, so a later Start again replays it. This lens did not raise it because #661 was outside the named contract. Treat it as part of the same fix round.
- **Sol B-343-1, B-343-2, B-343-4, B-343-5** were not raised or tested by this lens:
  - B-343-1: native sheet calls after unmount.
  - B-343-2: A/B/A selection loses the unresolved key.
  - B-343-4: pinned trial end date not reviewed.
  - B-343-5: dark-mode contrast of terms text on the selected card.
  - The next Opus audit of the fix round tests them at the new head.
- Opus B-343-1 (one-time "Payment received" while unknown) is not in Sol's list. The fix round needs the union of both lenses' B findings.

## Operator decisions (with default)
1. B-342-1 fix shape. Default: mobile copy makes no no-charge claim for these three codes (and the default) on `subscription_intent`, with no backend round. Alternative: the backend adds a machine "no charge proven" field.
2. C-343-1 / C-342-3 test placement. Default: keep the split; every fix round on S1/S2 runs the S2+S3 sheet suites against the piece head in the CI lane. Alternative: re-split so the tests sit with the hook.
3. Backend #661 composition (Sol B-342-2/B-343-3). Default: map the three replay codes in the same mobile fix round, and do not deploy #661 before that mobile build.

## CI state
- #342 @ 72821495: Typecheck/lint/test, Analyze (js-ts, actions) and CodeQL green (run 37152688718).
- #343 @ af984441: Typecheck/lint/test green (run 37152690665). CodeQL runs once on main.
- Probe runs 37180147690 (red, expected) and 37180210458 (red, expected); control run 37180193875 (green).

## Cleanup
- Remote branches deleted: `audit/AUD-OPUS-P12-117/{342-probe,343-controls,343-probe}`.
- Local branches deleted.
- Worktrees removed: `wt/AUD-OPUS-P12-117-{342,343,be680}` (no node_modules were linked).
- Claims kept: `ops/lanes117/claims/mobile-342-72821495-opus`, `mobile-343-af984441-opus`.
- Lens notes, probe specs, CI logs, verdict bodies and Sol bodies: `/home/user/workspace/ops/aud-117/AUD-OPUS-P12-117/`.

## HANDOFF
- Done: both heads audited; verdicts posted (#342 RC 0/1/3, #343 RC 0/1/2); report written; branches and worktrees cleaned.
- Next: builder fix round on #342 (B-342-1, plus the default-copy and #661 replay codes) and #343 (B-343-1, plus Sol's B findings). After that, Opus re-audits the new heads, reusing evidence only for unchanged files and testing Sol's B-343-1/2/4/5 independently.
- Blockers: none in this lane. Landing is still gated on backend #678-#680 being deployed and on C-334-2 in #344.
