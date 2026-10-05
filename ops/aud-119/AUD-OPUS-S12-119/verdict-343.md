AUDIT Claude Opus 5.5 — growth-project-mobile#343 @ 19678ce780d497513764a7827447c106fb14205e — VERDICT: APPROVE

A/B/C = 0/0/6 (AUD-OPUS-S12-119, agent 119). Tier T4 (payments, money copy). Size +2,673 / -260 = 2,933 (grandfathered, under the 3,000 ceiling, 67 lines of headroom). Any further #343 test belongs in #344.

## Prior findings at this PR
- Opus B-343-6 (free reroute said "Payment received"): **closed.** `usePackagePurchase.ts:763` sets `saleKind: "free"` together with `phase: "confirming"`, which covers both reroutes (`:806` and `:979`). My own P1 failed before (37221093192) and passes now (37229423237). Q4 below passes.
- Opus C-343-4, together with Sol B-343-6 on the same lines: **closed.** `:634-647`: ended/canceled now gives `endedWhileConfirming(ref)` with support, the reference and a Sentry cause. The dead key is still retired. `awaiting_payment` / `awaiting_card` keep the proven no-charge copy.
- Opus C-343-3, together with Sol B-343-3: **closed** for truth. `PackageSelectionSheet.tsx:247-253, 317-322`: without `onOpenPlan`, the action reads "Continue to the app" and calls `onDismiss`.
  - In both Day 1 call sites (`Day1WinScreen.tsx:190-194, 229-233`), `onDismiss` and `onPaymentSuccess` are the same `onComplete`.
  - In RootNavigator package_prompt (`:908-912`), both are `setAuthState('student')`.
  - So the label is true at every caller, and no skip timestamp is written (Q3).
- Sol B-343-1 (rejected plan reads not fenced): verified closed.
  - `pollPlan` (`:510-559`) returns done/pending/stale. It fences after every await, fulfilled or rejected, and before every next request.
  - `onAccountChange` (`:283-289`) nulls `confirmingRef`, so the identity check covers the epoch.
  - All four callers show the slow state only on "pending".
  - `settleUncertain` fences the rejected read (`:614`) and the loop exit.
  - `settleOneTimeUnknown` and `waitForEntitlement` were already fenced before each next request.
  - A "stale" result never leaves the screen in "confirming": an account change sets IDLE, and unmount has no screen.
- Opus C-343-5 and C-343-6 stay open (not on B lines). C-343-2 stays held.

## Evidence reuse (G09)
- My RC verdict at `fd739d58` (issuecomment-5982679186) audited the whole PR. The merge `e53e917` takes S1 `0b1985f4`'s 10 changed files byte-identical, with no conflict hunks.
- I audited fully every line of `e53e917..19678ce7`: the hook (+34/-26), PackageSelectionSheet, PurchaseFeedback, the payment test, and the new `usePackagePurchase.sheet2.test.tsx`.
- The contrast test was moved byte-identical to #344, and #344's CI is green (37229617205).
- I checked the builder's claims against the logs: 16 failed / 86 passed before, and 101 / 102 after. The only red test is the "offline (no response)" case in Sol's copied payment test, which asserts the sentence B-342-1 removed. The lane commits add only test and lane files.
- No Sol verdict was reused.

## Probes (CI lane)
- audit/AUD-OPUS-S12-119/343-probe, run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37230723756. Result: 1 failed, 37 passed (my probe plus the builder's sheet2 and payment suites).
  - Q1: a timeout on payment-intent gives not-confirmed copy with the key reference, the support action and no sheet, and the next tap replays the **same** idempotency key.
  - Q2: a renewing sheet confirmed and then a plan read of ended/ended gives the neutral ended copy, support and reference `abcdef12`. There is no no-charge claim and no success.
  - Q3: "Continue to the app" calls `onDismiss` once, never `onPaymentSuccess`, and makes no `prefsStorage.set`.
  - Q4: "Adding your free plan." shows while the rerouted claim runs.
  - Q5 (INFO, red as expected) is the evidence for C-343-8.

## Job checks
- Production backend `3e9a9a75` (no subscription-intent route): the renewing fallback is unchanged and truthful, and a plan is never sold one-time.
- Trial starts never show payment-complete copy (`saleKind` / `successTrialTitle` unchanged).
- "Payment received" shows only after a confirmed one-time sheet.
- "Nothing was charged" shows only on `awaiting_payment` / `awaiting_card`, a definite refusal, or the missing route.
- No first person and no exclamation marks in the new copy. No dispute copy here (R-DISPUTE-PAUSE not touched).

## Follow-ups (C, not blocking; freeze)
- C-343-7 `src/lib/packagePayment.ts:492-493` (S1 file, S2 caller): `endedWhileConfirming` ends with "and the team will put it right", which promises an outcome before anyone has checked. Fix rule: "so the team can check it".
- C-343-8 `src/components/PackageSelectionSheet.tsx:317-322` with `packagePayment.ts:525, 552, 558-563`. Without `onOpenPlan`, the only action reads "Continue to the app", while the alreadyComplete / alreadyActive / alreadyIncluded notices say "Open your plan ...". Probe Q5 is red. Fix rule: wire `onOpenPlan` to Membership in the callers (same as C-SH2-3), or use "Your plan is in Membership" wording when there is no destination.
- C-343-9 `src/lib/packagePayment.ts:490-491`: `checkoutEnded` ("nothing was charged") no longer has a caller in S1-S3 (`25af6569` included). Fix rule: delete it, or use it only where `checkout_state` proves no payment.
- Unchanged: C-343-2 (held), C-343-5, C-343-6, and C-SH2-3 (builder's report).
