AUDIT Claude Opus 5.5 — growth-project-mobile#344 @ e7fcc5d2504e8c3948494ee847e16ff4937b78c3 — VERDICT: REQUEST CHANGES

A/B/C = 0/2/7

Lens: AUD-OPUS-SH3-118 (agent 118). T4: money copy, payment flow, plan cancel. This is against B-SHEET-118 FIX ROUND 1 (restack) ([5982498620](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5982498620)). IDs start at 5 so they do not collide with the other lens's IDs on this PR.

### Prior findings and evidence reuse (G09)
- No lens verdict exists on #344. The original is #334: the last Opus APPROVE is at `0629d506` ([5964822138](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/334#issuecomment-5964822138), C-334-2 only). Opus never audited FIX ROUND 3 or 4 there.
- The 4 source files of this piece (`YourPlansPanel.tsx`, `ClientPackagesScreen.tsx`, `PackageCheckoutScreen.tsx`, `PackageDetailSurface.tsx`) and 2 tests are byte-identical to #334 `0629d506`.
- **Reused:** only the layout and rendering of those 4 files.
- **Audited in full:**
  - the hook and copy contracts these files now call (#342/#343 changed them heavily since `0629d506`);
  - the backend contracts they call: recurring `67905b43` and dunning D3/D4 `bb992fed`/`06307883`;
  - `PackageSelectionSheet.recur3.test.tsx` (never approved by Opus);
  - the subscription-test delta;
  - the restack.
- **Restack:** `d9e7da55` is the automatic merge. Its tree `8ab7ded5` equals `git merge-tree f629e0f9 fd739d58`, so nothing was resolved by hand, and no S3 source changed.
- **Fixture commit `e7fcc5d2`:** accepted. It is test-only. Today + 7 matches what the hook computes (`trialFirstChargeDate`, local calendar). The moved-date path stays covered by #343 `usePackagePurchase.boundary.test.tsx:183-198`. A small flake window is noted as C-344-10.
- **C-334-2** (#322 / lockout L1-L3 native Update card) is still open as a composition gate.

### B-344-5: past-due plans in Your plans. "End my plan" promises access it does not keep, the outcome is never shown, and the card-update instruction leads nowhere
`src/components/purchase/YourPlansPanel.tsx:39-42, 55-56, 95, 105-151`

1. **False promise before ending the plan.**
   - The backend offers End my plan on a past-due plan: `can_cancel = live && !cancel_at_period_end`, and `live` includes `past_due` (recurring `subscription-plan.ts:352,393` @ `67905b43`).
   - D3/D4 `cancelPlan` sends a delinquent plan to `runDunningCancel` (`client-billing.service.ts:1467,1539` @ `bb992fed`; route `client-billing.controller.ts:207` @ `06307883`). That is owner ruling 2A: void the open invoice and end access now.
   - The confirmation still says "Your plan stays active until November 2, 2026, and nothing more is charged after that." Because the failed renewal already moved the period end forward, that date is a period the client has not paid for.
2. **The outcome is never shown.**
   - `cancelClientPlan` discards the `CancelPlanResult` (`packagePayment.ts:387-389`: `outcome`, `access_ends_at`, `voided_amount_cents`).
   - The reload then filters out the ended plan (`:95`), so the panel goes blank with no word about what happened.
3. **The past-due line points to something that does not exist.**
   - It says "Update your card from the payment notice in the app". On this tree that notice never renders: `getPaymentStatus` always returns `dunning: null` (`clientPaymentsApi.ts:603`), and the native Update card lives in the lockout stack #352-#354.

**Probe:** [run 37221785062](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37221785062) (`audit/AUD-OPUS-SH3-118/344-plans`, real panel and copy). Both B-344-5 cases fail:
- the past_due confirmation contains "stays active until";
- after `outcome: 'ended'`, the rendered panel is empty.

The controls pass: active-plan copy, the past-due line, PLAN_ALREADY_ENDED.

**Fix rule:**
- When `state === 'past_due'`, the confirmation says access ends today and the unpaid charge is canceled, so nothing more is charged (2A). Otherwise keep the period-end copy.
- After the cancel, show the backend outcome: `scheduled` gives "Ends on <access_ends_at>"; `ended` gives "This plan has ended. The unpaid <amount> was canceled and is not collected."; `already_ended` gets its own line.
- The past-due line names an action that exists on the landed tree. Either wire the native Update card here (if #352-#354 lands first) or use a truthful fallback (End my plan, or message the coach).

**Verify:** the probe's two B-344-5 cases turn green, and the controls stay green.

### B-344-6: a failed plan action uses purchase copy and has no support path
`YourPlansPanel.tsx:121-125, 182-191`, using `describeBackendFailure(err, "plan_action", null)`

The panel renders only `message` and `reference`. It ignores `support`, `openPlan` and `checkAgain`, so there is no Email support action. The copy is the payment copy:
- **Offline:** "This phone is offline, so the payment did not start and nothing was charged … then start again." There was no payment, and the copy never says the plan was not changed.
- **401 and 429:** "Sign in again, then choose your plan" and "too many payment attempts".
- **Unknown errors** (D3 `STRIPE_REQUEST_FAILED`): "email support and quote reference req-7f3a." The panel then appends " Reference req-7f3a." a second time, and offers no Email support button and no address.
- **Bare 404 on cancel:** this is the real state when recurring #678-#680 is deployed without D4 (the recurring tree has no cancel route, and the land rule in the PR body names only the recurring chain). The copy says "its result is not confirmed yet". In fact nothing ran (`packagePayment.ts:796-807` maps a bare 404 only for `subscription_intent`).

**Probe:** same run. Three cases fail: no Email support, "payment did not start", "not confirmed yet". The control showing today's production fallback (the list 404s and the panel stays hidden) passes.

**Fix rule:**
- Give plan actions their own copy: "your plan was not changed" plus the action to repeat ("choose End my plan again"). A bare 404 on cancel or resume says ending or keeping a plan is not available in the app yet and the plan is unchanged, then "message your coach".
- Render support notices the way `PurchaseFeedback.tsx:198-231` does: Email support plus `SupportEmailFallback`, with the reference shown once.

**Verify:** the probe's three B-344-6 cases turn green.

### C (optional; under the freeze these go to the operator)
- **C-344-5:** `PackageCheckoutScreen.tsx:156`. Share-link terms come from the public storefront payload. That payload always serves `trial_days: null` (`storefront.service.ts:187`) and turns a combo into `one_time` at the one-time price (`:208-217`).
  - A trial package shared by link shows charge-today terms, and the review then says "The terms of this plan changed since it was shown", which is false.
  - A combo loops on RECURRING_REQUIRES_SUBSCRIPTION with the "Your coach changed how this plan is billed" copy. There is no in-app combo creation, so this is a C.
  - Fix: read the authoritative package for the signed-in client, or have the storefront return trial and recurring fields.
- **C-344-6:** `PackageDetailSurface.tsx:176`. The buyer pay button's `accessibilityLabel` stays "Continue to payment" while the visible label is the terms CTA (for example "Start free trial"). Fix: use `payLabel`.
- **C-344-7:** `YourPlansPanel.tsx:92-99`. Every load failure hides the panel. Fix: hide only on a bare 404; otherwise show a line telling the client to pull down to refresh. Note that the fine print at `ClientPackagesScreen.tsx:519-521` promises cancel "from your plan here".
- **C-344-8:** `YourPlansPanel.tsx:205-219`. Keep my plan turns renewal back on without stating the amount or the next charge date. Fix: show "renews at <amount> on <date>" with the action.
- **C-344-9 (outside this diff, on touched screens):** `ClientPackagesScreen.tsx:311-313` says "Your card never touches our servers" (first person). `PackageDetailSurface.tsx:196` says "Card details never touch this app", which is inaccurate with the in-app PaymentSheet. Fix: "Card details go straight to Stripe and never reach The Growth Project's servers."
- **C-344-10:** `PackageSelectionSheet.recur3.test.tsx:94`. `TRIAL_PLAN` computes today + 7 at module load, so a run that crosses local midnight reviews the date. Fix: compute it inside the test or freeze time.
- **C-344-11:** `PackageCheckoutScreen.tsx:161`. `share_token` is sent to analytics, following the existing `package_checkout_opened` pattern. Fix: send the package id and sale kind only.

### Checks and size
- Typecheck, lint, test pass at this head ([run 37219688466](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219688466)). CodeQL runs only when the stack is on main.
- Independent replay of this piece's 4 suites at this head: 61 of 61 pass ([run 37221553555](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37221553555), together with the probe).
- Size: +1,839 / -247 = 2,086 lines, which is in the 1,500-3,000 band.

### Operator decisions
- **Land gate:** add D4 #690 (the cancel route) to #344's land rule. Recommended: yes, and keep the B-344-6 404 copy as a defence.
- **Report-only, backend:** `subscription-plan.ts:343-351` maps a Day-10 locked-out plan (`entitlement_active` is false after `dunning-v2.service.ts:923` @ `b17f514c`) to `confirming` with `can_cancel` false. The panel then shows "Confirming this plan with Stripe" and offers no End my plan. Fix belongs to recurring or dunning.
- **Report-only, #343:** `planTerms.ts:177-183,379-392` compares a UTC-pinned instant with local `setDate`. Across a DST change, a trial started within an hour of local midnight gets a spurious date review. The review is truthful, so this is a C.

No push to the PR branch, no merge, no dispatch.
