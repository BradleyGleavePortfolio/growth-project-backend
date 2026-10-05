FIX ROUND (B-TR11-122, agent 122) — growth-project-backend#707 @ 92f48a5abbf4dd081787c019c9f632e31acb6769

Fixes Sol B-673-3 (https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-6004661734; operator ruling: B, false customer-facing claim in an ordinary sequence). Code is here because #673 has no room.

Commits since the dual-approved head 2bb4b368f39d8a380a48086c6c79d21cb4cc34b9:
- 5ca2db336ff44ebb61ab08fff0f00f205fe990c7: merge of #706 3437a93d (main refresh restack). Clean.
- 096d7ee8ccfbe0fa3ef057588ba56dac93622116: the B-673-3 fix + tests (below).
- 92f48a5abbf4dd081787c019c9f632e31acb6769: merge of #706 4f66e844 (picks up the #672 test typing fix). Clean.

Story: a client opens package A's free-trial sheet, dismisses it without saving a card, then opens package B of the same coach. B's offer said the trial was available, but checkout sold B with no trial, because A's unstarted open attempt still held the one trial.

Opus C-673-11 check: the claim that an abandoned attempt is retired before the next checkout holds only for attempts older than 23 h (`retireStaleTrialAttempts` filtered on `created_at <= now - OPEN_ATTEMPT_MAX_AGE_MS`). A just-dismissed A attempt for a different package was not retired, so the mismatch was real.

Fix (preferred behaviour; `src/checkout/subscription-checkout.service.ts`, +19 / -5):
- `createSubscriptionIntent` passes `pkgTrial > 0` to `retireStaleTrialAttempts(..., releaseOtherPlans)`.
- With `releaseOtherPlans`, the stale query's age filter becomes `OR: [{ created_at <= 23 h ago }, { package_id != this package }]`. All other filters stay (same client and coach, recurring, `entitlement_active: false`, `trial_started_at: null`, `trial_days` set, open status, this client's key prefix, limit 3).
- The retire itself is the existing Stripe-confirmed path: no card saved (SetupIntent `requires_payment_method`/`canceled`): the SetupIntent is canceled, the subscription ended and the row expired, so B's `decide` gives B the trial its offer showed. Card saved: kept and attached, and it still holds the trial (unchanged).
- Unchanged: same-package resume (this package's own attempt keeps the 23 h reuse window), already-started trials (`trial_started_at` set), plans without a trial (no extra retire), the offer reader.

Tests:
- `test/b-trials-8-shared-rule.spec.ts`: Sol's test from ops/aud-122/AUD-SOL-TR10-122/B-673-3-normal-offer-mismatch.diff, plus checks that B gets 14 days, A's subscription was canceled and A's row is expired. Failed before (`Expected: false, Received: true`), passes after. Also a same-package resume control (A reopened: same subscription, 7-day trial, nothing canceled).
- `test/b-recur-fix-round-1-checkout.spec.ts`: main's R1-1 "still holds the one trial with this coach for another package" encoded the old behaviour. Split into (a) no card: A retired, B gets its 14-day trial; (b) card saved: nothing canceled, B has no trial.

Evidence: CI lane run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386217121 at exactly 92f48a5a (ci/B-TR11-122-1): full `tsc --noEmit` green; 57 suites / 916 tests green (every b-trials and b-recur spec, every spec that builds SubscriptionCheckoutService / CheckoutWebhookHandlerService / TrialNoticeService / TrialUsageService, the push-preference specs and the new trial_ending test).
Size: 1,313 changed lines (1,275 + / 38 -), under 1,500.

PR CI at 92f48a5a: all checks green (10 success, deploy-readiness-gate skipped), including build-and-test. https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/707/checks

Prior verdicts at 2bb4b368: Sol APPROVE https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/707#issuecomment-6004662915, Opus APPROVE https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/707#issuecomment-6004667898.

READY FOR AUDIT
