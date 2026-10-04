FIX ROUND 3 (B-SHEET3-119, agent 119) — growth-project-mobile#344 @ 8f53887a6fe12a928313fde3f4464a2ee0630f3d

Closes Sol B-344-1..4 (RC 5982674874) and Opus B-344-5/6 (RC 5982759668), both at `e7fcc5d2` (runtime identical at `25af6569`). Base #343 `19678ce7` unchanged; #342/#343 not touched.

Commits: `0ac7fea` test (12 regressions), `aff733b` fix, `8f53887` test typing only.

| Finding | Change | Commit | Test |
|---|---|---|---|
| B-344-1 (Sol) list failure hidden | `YourPlansPanel` keeps a list state. Bare 404 (route absent on today's production backend): "Ending or keeping a renewing plan is not available in the app yet. Message your coach to end or change a renewing plan." (testID `your-plans-unavailable`). Any other failure: "The app could not load your renewing plans ..." + Try again + Email support with reference (offline: check connection + Try again). Cached plans stay, marked stale (`your-plans-stale`). Membership fine print no longer promises in-app cancel unconditionally: "A renewing plan can be ended at any time in Your plans when it shows End my plan, or through your coach". | aff733b | recovery `B-344-1` x2 |
| B-344-2 (Sol) / B-344-5.1 (Opus) dunning consent | `past_due` gets its own dialog (title "End this plan now?", action "End plan now"): access ends now, unpaid charge canceled and never collected; if that payment went through meanwhile, access continues through the period it paid for. Active/trialing keep the period-end copy byte-identical. | aff733b | recovery `B-344-2/5` #1 |
| B-344-5.2 (Opus) outcome discarded | New `src/lib/planActions.ts` `cancelPlan` parses `CancelPlanResult`; the card shows the authoritative outcome: ended (with the voided amount in the result's currency, amount omitted if no currency), scheduled, scheduled with `paid_period_kept`, already_ended. The ended plan stays visible with its outcome until the next pull-to-refresh. | aff733b | recovery `B-344-2/5` #2, #3 |
| B-344-5.3 (Opus) dead card instruction | past-due line names actions that exist on this tree (message the coach, or End my plan); `payment_failed` gets its own truthful line. Native Update card stays with lockout #352-#354 (C-344-1). | aff733b | recovery `B-344-2/5` #1 |
| B-344-3 (Sol) stale financial state | The canonical resume plan view replaces the card; every read and action answer carries a generation, so an older read never overwrites a newer answer; a failed refresh after an action is said (stale line + Try again). | aff733b | recovery `B-344-3` #1 |
| C-344-3 (Sol, same lines as B-344-3) | no read or state write after unmount; deferred alert callbacks after unmount do nothing. | aff733b | recovery `B-344-3` #2 |
| B-344-4 (Sol) / B-344-6 (Opus) support path and plan copy | `describePlanActionFailure`: plan copy for no answer, 401, 429, bare 404 (route missing: "not available in the app yet, so your plan was not changed. Message your coach"), BILLING_ACTION_IN_PROGRESS, NOT_A_SUBSCRIPTION, CANCEL_INCOMPLETE, PLAN_CHANGE_RESULT_UNKNOWN/STRIPE_UNAVAILABLE/STRIPE_CHECKOUT_ERROR/SUBSCRIPTION_SETUP_UNAVAILABLE (not confirmed), STRIPE_REQUEST_FAILED/PAYMENTS_NOT_CONFIGURED/CUSTOMER_NOT_FOUND (not changed), unknown (support). Support notices render Email support + `SupportEmailFallback` (shared pattern of `PurchaseFeedback.tsx`); the reference shows once. Sentry gets status + machine code + reference only. | aff733b | recovery `B-344-4/6` x5 |

Failing before / passing after (CI lane):
- Before (PR head `25af6569` + the regressions + both lens probes, no fix): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37230835677 — 23 failed / 7 passed: all 12 regressions fail; Opus 4 fail / 5 pass; Sol 7 fail / 2 pass.
- After (`8f53887` + both lens probes, `tsc --noEmit` + 8 suites): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37231377294 — tsc pass, 94/94 (regressions 12, Opus 9, Sol 9, ClientPackagesScreen.purchase, PackageCheckoutScreen.buyer, contrast, recur3, subscription).

Prior probe replay (probe files kept in the CI lane only, for size):
- Opus `audOpusSH3118.yourPlans.probe.test.tsx`, assertions unchanged (one test-helper type `Awaited<...>` for tsc): 9/9 pass. B-344-1 confirmation pass; B-344-1 outcome ended pass; B-344-2 unknown + Email support pass; B-344-2 offline pass (already passed before: B-342-1 copy); B-344-2 bare 404 pass; controls: list 404 keeps `your-plans` hidden pass (the unavailable line has its own testID), active period-end copy pass, past-due line pass, PLAN_ALREADY_ENDED pass.
- Sol `planRecovery.test.tsx`: 9/9 pass, including C-344-3. Harness changes, no assertion weakened: expo-clipboard mocked (the support fallback imports it, as every other purchase suite does); B-344-1 uses `queryAllByText(...).length > 0` with the same regex (the copy and the Email support action both match the alternation, so `queryByText` would throw on two matches); B-344-3 #1 waits for `busy` on End my plan instead of Keep my plan, because the canonical resume answer (`can_resume` false) correctly removes Keep my plan.

Money self-check:
- Webhook order and redelivery: the client never infers state; every action is followed by a fresh read, and an older read cannot publish over a newer answer (generation fence).
- Concurrency: one action at a time (ref guard, not only render state); overlapping reads fenced; the backend lease answer BILLING_ACTION_IN_PROGRESS has its own copy and a reload.
- Terminal states: ended (outcome kept visible), already_ended, PLAN_ALREADY_ENDED, payment_failed line; a disputed recurring plan cancelled from the app comes back `ended` (2A) and is told "access ended today", consistent with R-DISPUTE-PAUSE; deleted account/session: 401 and PURCHASE_NOT_FOUND copy, nothing claimed.
- List pagination and completeness: the client contract is one full list; a failed or missing read is never shown as "no plans".
- Currency: the voided amount is formatted from integer minor units with the result's currency through the exponent-aware `money` (B-342-3); without a currency the amount is not shown.
- Copy truth: outcome copy only after the backend answer; consent copy is state-specific and covers the paid-meanwhile race; no first person, no exclamation marks, no generic errors.

Size: +2,481 / -247 = 2,728 changed lines (grandfathered, under 3,000; this round +572 / -53).

Required checks at this head: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37231378504 pass (CodeQL runs only on main-based PRs).

Follow-up Cs (operator tickets): C-344-1 (native Update card composition with lockout #352-#354), C-344-5, C-344-6, C-344-8 (resume now shows the next charge from the canonical plan; the button itself still has no amount), C-344-9, C-344-10, C-344-11 unchanged.

READY FOR AUDIT
