# AUD-OPUS-SH-118 — Claude Opus 5.5 lens (agent 118 wave), mobile payment sheet P1 #342 + P2 #343

Started 10:20 PDT 10-04 and finished 10:41 PDT (times from `TZ=America/Los_Angeles date`). Claims: ops/lanes118/claims/mobile-342-56f281ad-opus and mobile-343-fd739d58-opus.
Notes, comment bodies and probe specs are in ops/aud-118/AUD-OPUS-SH-118/ (verdict-342.md, verdict-343.md, probes/, c342.json, c343.json).

## Verdicts (posted 10:41 PDT; heads and checks re-read right before posting)
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| mobile#342 (S1 payment core) | 56f281ad3aa977882c962a6591d3594899cdd5a1 | APPROVE | 0/0/5 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5982679049 |
| mobile#343 (S2 sheet + hook) | fd739d5819c232764e0389afd778860bf452b41c | REQUEST CHANGES | 0/1/5 | https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5982679186 |

Sizes: #342 +2,009/-9 = 2,018; #343 +2,553/-260 = 2,813. Both are in the 1,500-3,000 band. #343 has 187 lines of headroom; the B fix needs about 1 line plus the probe spec (about 165 lines if kept as-is, or trimmed to the P1 case).

CI at the heads: #342 Typecheck/lint/test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219351230 and CodeQL https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219351237 passed. #343 Typecheck/lint/test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219352660 passed; CodeQL runs only on main-based PRs.

## Probes (CI lane; branches deleted, specs kept in ops/aud-118/AUD-OPUS-SH-118/probes/)
- #342 control: audit/AUD-OPUS-SH-118/342-copy, run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37221079350. Passed: 2 suites, 35/35. It covers the exact production 404 envelope, the #661 error-only envelopes, the recurring code+error envelopes, the trial codes (info for C-342-4), the copy rules over every PACKAGE_PAYMENT_COPY string, and the builder's replyCodes suite.
- #343: audit/AUD-OPUS-SH-118/343-freeclaim (probe commit 3d54938d), run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37221093192. Result: 1 failed, 3 passed. P1 (B-343-6) is red. Controls P2-P4 are green: "Payment received" only after a confirmed sheet; the production 404 on a renewing plan gives `renewingUnavailable`; the neutral checking copy after a lost answer.

## Evidence reuse (G09)
- #342: the last Opus verdict was RC @ 72821495, and it audited all 10 files. Only packagePayment.ts, planTerms.ts and the new replyCodes test changed since then, and those were audited in full. The other 7 files are byte-identical, so that audit is reused. Main's merge (7fdb629a) touched no PR file.
- #343: the last Opus verdict was RC @ af984441. The hook, PurchaseFeedback, PackageSelectionSheet and the payment test changed, plus 2 new tests; all were audited in full. PlanTermsBlock and the stripePublishableKey test are byte-identical, so that audit is reused.
- The builder's CI runs and the S3 replay (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219714087) are reused as CI evidence. No Sol evidence or verdict was reused.

## Findings (blocking)
- B-343-6 (Opus) `src/hooks/usePackagePurchase.ts:746-748, 790-791`. When a one-time plan was made free after the list loaded, payment-intent answers 400 PACKAGE_IS_FREE. The hook reroutes to `claimFree`, which sets only `phase: "confirming"`, so `saleKind` stays "one_time". PurchaseFeedback (`PurchaseFeedback.tsx:47-56`) then shows "Payment received. Setting up your plan." (a live region) during the claim, although no payment exists. Minimal fix rule: `claimFree` sets `saleKind: "free"` together with `phase: "confirming"`. That covers both reroutes (`:790-791` and `:962-964`). The probe P1 then turns green and stays as the regression test.

## Prior findings closed
- #342: B-342-1 (Opus), B-342-2 (Sol), C-342-1 (Sol) and C-342-3 (Opus).
- #343: B-343-1 (Opus); B-343-1 to B-343-5 (Sol); C-343-1 (Opus), closed by the builder's S3 replay.

## Job checks (from JOBS118)
- Today's production backend 643817b3 has no subscription-intent route. Renewing plans get the truthful `renewingUnavailable` copy (route absent, nothing charged, message the coach). It is not a dead end, and the plan is never sold one-time. One-time payments work on production.
- The #661 codes map to specific copy: PAYMENT_ALREADY_COMPLETE, PAYMENT_REFUNDED_OR_IN_REVIEW, PAYMENT_CHECKOUT_CLOSED (409) and PAYMENT_IN_PROGRESS (503) each get their own copy and key rule. PAYMENT_SUCCESS_RETRY and PAYMENT_FAILURE_RETRY are webhook-only; if ever received, they get neutral copy with no money claim.
- The recurring codes map to specific copy: PLAN_CHANGE_UNCONFIRMED, SETUP_UNAVAILABLE, PAYMENT_RETRY, STRIPE_CHECKOUT_ERROR and CHECKOUT_KEY_OTHER_PLAN. The trial setup path shows the trial copy and never payment-complete copy.
- Copy: no first person and no exclamation marks. The only "paid before proof" claim found is B-343-6.
- Opus C-342-1 (isCombo) stays red by design and is held as a C under the freeze.

## Follow-ups (C)
- C-342-1 (held) `src/lib/planTerms.ts:90-93`: isCombo routes a legacy one-time row with a $0 recurring part as renewing. Fix rule: `recurringAmount !== null && recurringAmount > 0`.
- C-342-2 (held) `src/api/clientPaymentsApi.ts:347-349`: un-nulled `trial_days` is safe only under the land-as-one rule. Fix rule: no build from a main that has S1 without S3.
- C-342-4 `src/lib/packagePayment.ts:990-1003`: TRIAL_ALREADY_USED and TRIAL_IN_PROGRESS (trials T3 df76889f `src/packages/trials/trial-usage.service.ts:85-101`) get neutral rather than specific copy. Fix rule: whichever merges second maps them (regular-price start with reload; finish the other checkout or wait; key kept).
- C-342-5 `src/lib/packagePayment.ts:510-511`: the `inProgress` copy says "payment" for trial setups. Fix rule: step-aware wording ("This plan is still being set up").
- C-342-6, outside this diff (dunning D3/D4 06307883 `src/checkout/client-billing.service.ts:2259-2287, 2474-2486`): PLAN_CHANGE_RESULT_UNKNOWN, CANCEL_INCOMPLETE, BILLING_ACTION_IN_PROGRESS and PAYMENT_RESULT_UNKNOWN get the neutral default on plan actions. Fix rule: the dunning mobile lane maps each one when it wires those actions.
- C-343-2 (held), outside this diff: no `handleURLCallback` for the Stripe return URL. Fix rule: forward Linking URLs to Stripe first, or record on-device iOS 3DS redirect acceptance before release.
- C-343-3 `src/components/PackageSelectionSheet.tsx:246-252`, with callers `Day1WinScreen.tsx:190-194, 229-233` and `RootNavigator.tsx:908-912` (outside this diff): no caller passes `onOpenPlan`, so "Open your plan" just closes the sheet into the app. Fix rule: pass an `onOpenPlan` that navigates to Membership, or relabel the fallback.
- C-343-4 `src/hooks/usePackagePurchase.ts:624-633` (prior code): plan state `ended` gets "nothing was charged" in `settleUncertain`. Fix rule: claim no charge only on awaiting_payment/awaiting_card.
- C-343-5 `src/hooks/usePackagePurchase.ts:1102-1135`: after an account change, `inFlightRef` stays set until the stale await returns, so a tap in that window is silently dropped. Fix rule: tag the flag with the epoch.
- C-343-6 PackageSelectionSheet CTA after PAYMENT_ALREADY_COMPLETE: the key is retired and the CTA stays live, so a further tap is a repeat purchase. Fix rule: show the done state after a `completed` notice.

## Cleanup
Worktrees /home/user/workspace/wt/AUD-OPUS-SH-118-342 and -343 were removed (`git worktree remove --force`). Local and remote audit/AUD-OPUS-SH-118/* branches were deleted. The main clone checkout was unchanged (main). The Sol lens worktrees were not touched.

## HANDOFF
- Done. Both verdicts are posted (see the table). Nothing is left running.
- Builder (B-SHEET-118 or successor), next round on #343: fix B-343-6 with the one-line `saleKind: "free"` in `claimFree`. Replay probe P1 from ops/aud-118/AUD-OPUS-SH-118/probes/audOpusSh118.probe343.test.tsx (probe commit 3d54938d; the remote branch is deleted, so copy the spec onto the new head). Re-check the size (187 lines of headroom). #342 needs no change. If the fix touches only `usePackagePurchase.ts` plus a test, the Opus lens posts a short delta verdict on #343.
- Operator decisions:
  1. Ticket the 10 Cs above. The recommended default is to file them all as post-merge tickets with no change to this stack.
  2. The trial reply codes (C-342-4). The recommended default is that the trials wiring lane maps them when `reserve()` gains a caller.
  3. The S2 "Open your plan" target (C-343-3). The recommended default is to wire `onOpenPlan` to Membership in the callers in a follow-up, since the button works today and closes into the app.
