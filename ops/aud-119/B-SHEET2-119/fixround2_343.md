FIX ROUND 2 (B-SHEET2-119, agent 119) — growth-project-mobile#343 @ 19678ce780d497513764a7827447c106fb14205e

Answers AUDIT Claude Opus 5.5 (REQUEST CHANGES 0/1/5, issuecomment-5982679186) and AUDIT GPT-6.1 Sol (REQUEST CHANGES 0/3/2, issuecomment-5982700210) at `fd739d58`. Tier T4 (payments, money copy).

First, merge-only: split S1 #342 at `0b1985f4` (with main `cc4ceeed`) merged into this branch (`e53e917`, clean). Then one test commit (`8f3fd47`, failing before), one fix commit (`3887af3`) and one size commit (`19678ce`).

Size: +2,673 / -260 = 2,933 changed lines (tests included), inside the 1,500-3,000 band (67 lines of headroom). Stated per the size rule. To stay under 3,000, `src/components/__tests__/PackageSelectionSheet.contrast.test.tsx` (71 lines, B-343-5 selected-card contrast) moved byte-identical to split S3 #344 (`git diff fd739d58 25af6569 -- <file>` is empty); it runs in #344's CI.

## Findings -> change -> commit -> test

| Finding | Change | Commit | Test |
|---|---|---|---|
| B-343-6 (Opus): a one-time plan made free after the list loaded showed "Payment received. Setting up your plan." during the claim (usePackagePurchase.ts:746-748, :790-791) | `claimFree` sets `saleKind: "free"` with `phase: "confirming"`, so both reroutes (payment-intent and subscription-intent PACKAGE_IS_FREE) show "Adding your free plan." | 3887af3 | usePackagePurchase.sheet2.test.tsx "B-343-6 (Opus) ..." one-time and renewing reroute |
| B-343-1 (Sol, residual): a rejected plan read bypassed the account fence; logout/login then a rejection ran one stale `onEntitled` and slow state; a second old-account read followed (:505-566, the showSlow callers) | `pollPlan` returns `"done" \| "pending" \| "stale"`; it fences after every await, fulfilled AND rejected, and before every next request (`gone()` = unmounted or `confirmingRef` no longer this attempt; an account change clears it). Callers show the slow state only on `"pending"`. `settleUncertain` fences the rejected read the same way | 3887af3 | usePackagePurchase.sheet2.test.tsx "B-343-1 (Sol) ..." logout, login, no second read; control: same-account rejected reads still end in the slow state |
| B-343-6 (Sol) + Opus C-343-4 (same lines): `state: ended` or `checkout_state: ended` after an unclear card step said "nothing was charged" (:623-631) | Ended (canceled) is not proof of no payment: `endedWhileConfirming(ref)` "This plan closed before it was confirmed. If your card statement shows a charge for it, email support and quote reference X, and the team will put it right." with support + reference (purchase id prefix), reported to Sentry by cause only; the dead key is still retired. `awaiting_payment` / `awaiting_card` keep the proven no-charge copy | 3887af3 | usePackagePurchase.sheet2.test.tsx "B-343-6 (Sol) ..." both ended envelopes + key retired; control awaiting_payment |
| B-343-3 (Sol) + Opus C-343-3 (same lines): "Open your plan" fell back to `onPaymentSuccess` (Day 1 callers pass no `onOpenPlan`) (PackageSelectionSheet.tsx:246-252, PurchaseFeedback.tsx:188-196) | The action is labelled for what it does. With an `onOpenPlan` it stays "Open your plan" and routes there. Without one (both Day 1 call sites, the package_prompt sheet) it reads "Continue to the app" and closes the sheet through `onDismiss` (no skip timestamp written, never the payment-success callback); the notice itself says where the plan shows (Membership). `PurchaseFeedback` takes an optional `openPlanLabel` | 3887af3 | PackageSelectionSheet.payment.test.tsx "B-343-3 the plan action ..." without and with a destination |
| S1 merge consequence (B-342-1) | The payment test's offline case now expects the no-answer copy with the key reference and the support action | 8f3fd47 | PackageSelectionSheet.payment.test.tsx "no answer (B-342-1) ..." |

Failing before (test commit on the merged head, no fix), with every prior probe: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229398426 — 16 failed / 86 passed.
After (fix + the same probes, with `tsc --noEmit`): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229423237 — type-check pass; 101 / 102 pass. The one red test is the "offline (no response)" case inside Sol's openPlanAction probe file, a copy of the old payment test that asserts the very no-charge sentence B-342-1 removed (superseded by design; the current payment test asserts the new copy).
Required checks at this head: Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229616131 pass (CodeQL runs only on main-based PRs).

## Prior probes replayed at this head (both lenses, run 37229423237)

| Probe | Origin | Result |
|---|---|---|
| logout / login during a held plan read that rejects: no old-account slow progress | Sol audSolSh118.remainingBoundary (run 37220350184) | pass (failed before) |
| account change during the first failed poll: no second read | Sol remainingBoundary | pass (failed before) |
| one-time unknown then same-key timeout never becomes proven unpaid | Sol remainingBoundary | pass |
| control: account change during a successful read drops the entitlement; unmount/sign-out fences; A/B/A keys; #661 replays; checking copy; pinned trial | Sol remainingBoundary | pass |
| state ended / checkout ended never asserts unpaid; awaiting_payment control | Sol audSolSh118.endedIsNotUnpaid (run 37221348486) | pass (failed before) |
| uncertain Open your plan never uses the payment-success callback; explicit callback control | Sol audSolSh118.openPlanAction (run 37220573241) | pass (failed before) |
| offline copy in the copied payment test | Sol openPlanAction | FAIL, superseded by B-342-1 (see above) |
| P1 free reroute never says "Payment received"; P2-P4 controls | Opus audOpusSh118.probe343 (run 37221093192) | pass (P1 failed before) |
| round-1 probes | Opus audOpusP12117.probe343, Sol audSolP12117.purchaseBoundary and paymentTheme | pass |
| builder suites usePackagePurchase.boundary, PackageSelectionSheet.payment, PackageSelectionSheet.contrast | B-SHEET-118 | pass |
| S3 suites (recur3, subscription, screens) at the restacked #344 head 25af6569 | C-343-1 replay | pass (#344 Typecheck, lint, test https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229617205) |

## Money list self-check
- Webhook order and redelivery: the hook never infers paid from event order; it reads the plan, the purchases or the entitlement and says only what they show; an ended plan is now neutral.
- Concurrency (two workers, lock order): one in-flight guard, one key per package + sale kind; every await (fulfilled or rejected) is fenced on screen + account + attempt identity before the next request or state write.
- Terminal states (refunded, disputed, canceled, deleted account): ended/canceled gives the neutral support copy with a reference and retires the dead key; payment_failed keeps its own copy; sign-out/sign-in drops keys, reads and notices. Per R-DISPUTE-PAUSE, no copy here speaks about disputes.
- List pagination and completeness: the purchases read fails closed to "outcome unknown" (Check again), never to "nothing was charged"; plan reads that reject stay unknown.
- Currency: display through S1's per-currency exponent (B-342-3); the hook sends integers unchanged.
- Copy truth: "Payment received" only after a confirmed one-time sheet; a free reroute says "Adding your free plan."; "nothing was charged" only on awaiting_payment / awaiting_card or a definite refusal.

Held Cs (freeze): C-343-2 (handleURLCallback / iOS 3DS device check). Opus C-343-5 and C-343-6 stay open as follow-ups (not the same lines as a B fix). Follow-ups are in ops/reports/B-SHEET2-119.md.

READY FOR AUDIT
