# AUD-OPUS-SH3-118 — Claude Opus 5.5 lens (agent 118 wave), mobile payment sheet P3 #344

Started 10:30 PDT 10-04, verdict posted 10:51 PDT (times from `date`). Claim: ops/lanes118/claims/mobile-344-e7fcc5d2-opus.
Notes, probe and logs: ops/aud-118/AUD-OPUS-SH3-118/ (verdict344.md, posted344.txt, audOpusSH3118.yourPlans.probe.test.tsx,
run37221553555.log, run37221785062.log).

## Result
- mobile #344 @ e7fcc5d2504e8c3948494ee847e16ff4937b78c3 (base #343 fd739d58; +1,839/-247 = 2,086 lines, 1,500-3,000 band).
- VERDICT: REQUEST CHANGES, A/B/C = 0/2/7:
  https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/344#issuecomment-5982759668
- Head and checks re-read right before posting: Typecheck, lint, test = success (run 37219688466). The only required check that runs on a
  stacked piece; CodeQL runs when the stack lands on main.
- Sol posted REQUEST CHANGES at the same head before me (5982674874, IDs B-344-1..4, C-344-1/3). I did not read its content; my IDs
  start at 5 to avoid collisions.

## Evidence reuse (G09)
- Source files YourPlansPanel.tsx, ClientPackagesScreen.tsx, PackageCheckoutScreen.tsx, PackageDetailSurface.tsx and tests
  ClientPackagesScreen.purchase / PackageCheckoutScreen.buyer are byte-identical to #334 @ 0629d506 (last Opus APPROVE 5964822138).
  Reused for layout/rendering only. Audited fully: integration with the current #342/#343 hook and copy, the backend contracts
  (recurring 67905b43; dunning D3 bb992fed / D4 06307883 / D2 b17f514c), recur3 test (never Opus-approved), subscription test delta,
  restack merge d9e7da55 (tree 8ab7ded5 = automatic `git merge-tree f629e0f9 fd739d58`), fixture commit e7fcc5d2 (accepted).

## Findings (each: file:line, counterexample, fix rule, how to verify)
- B-344-5 YourPlansPanel.tsx:39-42,55-56,95,105-151 past-due plans: (1) End my plan confirmation promises "stays active until
  <period end>" but backend can_cancel includes past_due (subscription-plan.ts:352,393 @67905b43) and D3/D4 cancelPlan runs 2A
  runDunningCancel (client-billing.service.ts:1467,1539 @bb992fed; route client-billing.controller.ts:207 @06307883) = ends access now;
  (2) cancelClientPlan (packagePayment.ts:387-389) drops CancelPlanResult and the ended plan is filtered out (:95) = blank panel;
  (3) past-due line points to "the payment notice in the app", which never renders (clientPaymentsApi.ts:603 dunning null).
  Fix: 2A-truthful confirm copy for past_due; render the backend outcome (scheduled / ended with voided amount / already_ended);
  past-due line names an action that exists (native Update card if #352-#354 lands first, else truthful fallback).
  Verify: probe cases B-344-5 x2 green.
- B-344-6 YourPlansPanel.tsx:121-125,182-191 plan-action failures reuse purchase copy (offline "the payment did not start", 401
  "choose your plan", 429 "payment attempts"), unknown shows no Email support action and duplicates the reference, bare 404 on cancel
  (recurring deployed without D4) says "result is not confirmed yet" (packagePayment.ts:796-807 maps bare 404 only for
  subscription_intent). Fix: plan-action copy set ("your plan was not changed" + repeat action; bare 404 = not available yet, message
  coach) and support notices rendered like PurchaseFeedback.tsx:198-231. Verify: probe cases B-344-6 x3 green.
- Probe runs: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37221553555 (probe v1 4 fail / 3 controls
  pass + #344 suites 61/61 pass); https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37221785062 (probe v2:
  5 fail / 4 controls pass, incl. production fallback control: list 404 -> panel hidden). Branch audit/AUD-OPUS-SH3-118/344-plans
  deleted; probe file kept in ops/aud-118/AUD-OPUS-SH3-118/ for the builder to replay (copy into src/components/__tests__/).

## Follow-ups (C)
- C-344-5 PackageCheckoutScreen.tsx:156 share-link terms from the storefront payload (storefront.service.ts:187 trial_days null;
  :208-217 combo -> one_time). Trial link: charge-today terms, then a false "terms changed" review; combo: RECURRING_REQUIRES_SUBSCRIPTION
  loop (combos are API-only today). Fix: authoritative package for the signed-in client or storefront exposes trial/recurring fields.
- C-344-6 PackageDetailSurface.tsx:176 buyer a11y label "Continue to payment" vs visible CTA ("Start free trial"). Fix: use payLabel.
- C-344-7 YourPlansPanel.tsx:92-99 every load failure hides the panel. Fix: hide only on bare 404; else a pull-to-refresh line.
- C-344-8 YourPlansPanel.tsx:205-219 Keep my plan resumes renewal without amount/date. Fix: "renews at <amount> on <date>".
- C-344-9 (outside diff) ClientPackagesScreen.tsx:311-313 "our servers" (first person); PackageDetailSurface.tsx:196 "never touch
  this app" inaccurate with in-app PaymentSheet. Fix: "Card details go straight to Stripe and never reach The Growth Project's servers."
- C-344-10 PackageSelectionSheet.recur3.test.tsx:94 TRIAL_PLAN today + 7 at module load: midnight-crossing flake. Fix: compute in the
  test or freeze time.
- C-344-11 PackageCheckoutScreen.tsx:161 share_token to analytics. Fix: package id + sale kind only.

## Operator decisions (recommended default)
- Land gate: add dunning D4 #690 (POST /v1/checkout/subscriptions/:id/cancel) to #344's land rule; recurring #678-#680 alone ships the
  list but not cancel. Recommended: yes, plus the B-344-6 404 copy as defence.
- Report-only, backend (recurring/dunning owner): subscription-plan.ts:343-351 @67905b43 maps a Day-10 locked-out plan
  (entitlement_active false after dunning-v2.service.ts:923 @b17f514c, status past_due/unpaid) to state 'confirming', can_cancel false;
  the panel then says "Confirming this plan with Stripe" and offers no End my plan. Fix: non-entitled past_due/unpaid -> past_due
  (locked) with can_cancel true (2A).
- Report-only, #343: planTerms.ts:177-183,379-392 compares UTC-pinned instant vs local setDate: DST-week spurious trial-date review
  (truthful, C).
- Fixture commit e7fcc5d2: accept (recommended; test-only, correct).

## HANDOFF
- #344 @ e7fcc5d2: Opus REQUEST CHANGES 0/2/7 posted (5982759668); Sol RC posted (5982674874). Next: a builder fixes B-344-5 and
  B-344-6 (plus the other lens's Bs) on #344, replays ops/aud-118/AUD-OPUS-SH3-118/audOpusSH3118.yourPlans.probe.test.tsx (all 9 must
  pass after the fix), then a fresh Opus lens audits the new head as a delta from this report.
- Cleanup done: audit branch deleted, worktree removed. Claim dir kept (record).
