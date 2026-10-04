# B-SHEET-118 — builder (agent 118), mobile payment sheet #342 (S1) + #343 (S2) (+ #344 restack)

Started 09:46 PDT 10-04 (from `date`).

## Status
- 10:19 PDT: DONE. FIX ROUND 1 + READY FOR AUDIT posted at green heads on #342, #343, #344 (restack).
  - #342 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/342#issuecomment-5982491578 (Typecheck/lint/test 37219351230, CodeQL 37219351237: pass)
  - #343 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/343#issuecomment-5982491752 (Typecheck/lint/test 37219352660: pass)
  - #344 https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5982498620 (Typecheck/lint/test 37219688466: pass)
- PR bodies updated: tier header + Fix rounds table.

## Heads
| PR | start | now |
|---|---|---|
| #342 S1 (base main) | 728214956d999e741ae65e99cee93b1ea0157385 | 56f281ad3aa977882c962a6591d3594899cdd5a1 |
| #343 S2 (base #342) | af984441a5328c9738bc12e3bdc09a44d3664477 | fd739d5819c232764e0389afd778860bf452b41c |
| #344 S3 (base #343) | f629e0f9c0ca4fdda5985dad5a775efa80f47a22 | e7fcc5d2504e8c3948494ee847e16ff4937b78c3 |

Sizes (add+del, tests count): #342 ~2,018 (1,500-3,000 band); #343 ~2,813 vs new #342 (1,500-3,000 band, ~190 headroom); #344 ~2,086.

## Findings closed this round
- B-342-1 (both lenses): recurring PAYMENT_RETRY / STRIPE_CHECKOUT_ERROR / SUBSCRIPTION_SETUP_UNAVAILABLE and any unmapped answer -> `notConfirmed` / neutral `unknown` copy (no charge claim), key kept, support + reference, Open your plan. One-time payment-intent PAYMENT_RETRY keeps the proven no-charge copy.
- B-342-2 (Sol): #661 PAYMENT_ALREADY_COMPLETE (open plan, refresh, retire key), PAYMENT_REFUNDED_OR_IN_REVIEW (status + support, key kept), PAYMENT_CHECKOUT_CLOSED (retire key, new checkout). Also CHECKOUT_KEY_OTHER_PLAN (retire), SUBSCRIPTION_ATTEMPT_EXPIRED (retire flag), PLAN_CHANGE_UNCONFIRMED (sent, not confirmed, refresh). Production backend 643817b3 (no subscription-intent route, bare Nest 404) -> `renewingUnavailable` (proven no charge, message coach).
- C-342-1 (Sol, same lines as the default branch): only UPPER_SNAKE backend codes / short Stripe labels reach Sentry.
- B-343-1 (Sol): liveness fence (mounted + auth epoch; logout/login bump it and drop keys/reads) after every await; no init/present after unmount or account change.
- B-343-2: per package+kind key map.
- B-343-3: notice flags retireKey / completed / openPlan consumed by the hook and PurchaseFeedback.
- B-343-1 (Opus): `checking` state -> "Checking whether the payment went through." while an unclear one-time result is read.
- B-343-4: reconcileIntentTerms compares the pinned trial_ends_at (setup mode) with the shown date; review copy termsReviewTrialDate; adopted pkg carries the pinned date; confirming replays the same key.
- B-343-5: selected card keeps bgSurface (light 5.54:1, dark 6.29:1) with a 2 px accent border.

## CI lane runs
- S1 failing-before: 37218790538 (16 failed / 4 passed controls).
- S2 failing-before: 37219282995 (12 failed / 1 passed control).
- S1 probe replay: 37219370245 (Opus C-342-1 isCombo probe stays red: deferred C).
- S2 probe replay: 37219714087 (tsc pass, 9 suites, 120/120; supersedes 37219381921, which used the stale S3 trial fixtures).
- Replay copy of Sol recur3 + B-343-4 with the fixture fix: ops/aud-118/B-SHEET-118/audSolP12117.recur3pinned.replay.test.tsx.
- Comment bodies: ops/aud-118/B-SHEET-118/fixround1_34{2,3,4}.md; new PR bodies newbody34{2,3,4}.md.

## Follow-ups (C)
- C-342-1 (Opus) src/lib/planTerms.ts:83-88 `isCombo` must also require `recurringAmount > 0` (mirror backend isRecurringPackage). Fix rule: a one-time package whose recurring part is $0 sells as one-time (payment-intent).
- C-342-2 (Opus) trial_days un-nulled for main's old ClientPackagesScreen: land #342-#344 as one.
- C-342-3 (Opus) S1 had no tests: this round adds src/lib/__tests__/packagePayment.replyCodes.test.ts.
- C-343-1 (Sol) recur3 / subscription suites live in S3 (#344): replay them against the S2 head in the CI lane each round (done this round).
- C-343-2 (Sol) `handleURLCallback` never called: iOS 3DS return path needs a device check.
- #344 YourPlansPanel `listClientPlans` against production backend 643817b3 (no GET /v1/checkout/subscriptions): must fall back truthfully (operator/P3 gate with C-334-2).
- C-661-14 note (operator mail): trials never get "payment complete" copy: PAYMENT_ALREADY_COMPLETE is only produced by one-time payment-intent; trial success copy is "Your trial has started". Optional hardening: guard the mapping by step === "payment_intent".

## Operator decisions
- #344 round is not strictly merge-only: one test-only commit e7fcc5d2 updates two S3 trial fixtures to today + 7 (they pinned 2026-10-10, which B-343-4 now correctly reviews). Recommended default: accept as part of the restack.

## Progress log
- 09:46-10:00 read rules, both lenses' verdicts (#342 Sol 5976926407 / Opus 5977006434; #343 Sol 5976959713 / Opus 5977006549), probes in ops/aud-117/AUD-{OPUS,SOL}-P12-117, backend contracts: prod 643817b3, #661 f80f0088, recurring top 67905b43.
- Took lock ops/lanes118/locks/sheet; released 10:13 after the #344 push; notify written.
- S1: merge main 43f6bfad; test 2212e9e5; fix 56f281ad. S2: merge S1 f3e63d33; test a69e7954; fix fd739d58. S3: merge S2 + fixture commit e7fcc5d2.

## HANDOFF
- Builder done: READY FOR AUDIT at #342 56f281ad, #343 fd739d58, #344 e7fcc5d2 (all required checks green). Next: Opus 5.5 + Sol audits at those exact heads.
- Expected red probe: Opus C-342-1 (isCombo $0 recurring) stays red by design (deferred C).
- Lock ops/lanes118/locks/sheet released; notify/sheet.txt: "sheet top: #344 @ e7fcc5d2504e8c3948494ee847e16ff4937b78c3".
- Cleanup done: ci/B-SHEET-118-* branches deleted, worktrees removed.
- Backend #661 mail (operator 10:09): 409 PAYMENT_ALREADY_COMPLETE / PAYMENT_REFUNDED_OR_IN_REVIEW / PAYMENT_CHECKOUT_CLOSED mapped; 503 PAYMENT_IN_PROGRESS already mapped (S3-asserted copy); Stripe-only PAYMENT_SUCCESS_RETRY / PAYMENT_FAILURE_RETRY never reach clients (would fall to the neutral unknown copy). C-661-14: trial starts never show payment-complete copy.
