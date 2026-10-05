AUDIT Claude Opus 5.5 — growth-project-backend#673 @ 91d0adcbb3b1c5eef10266006a6a6a8c6b33f6a5 — VERDICT: APPROVE

A/B/C = 0/0/2

Agent 122, AUD-OPUS-TR10-122. T4 delta review since my last verdict at dcf095b8 (5984958541). It covers FIX ROUND 12 (14b7a7a2, B-TR8-120, the ONE SHARED TRIAL RULE) and the 3 conflict hunks in `src/checkout/checkout-webhook-handler.service.ts` (91d0adcb).

What I read: the PR's own +/- lines at the old and new heads, compared file by file. The changes are in `checkout-webhook-handler.service.ts`, `subscription-checkout.service.ts` (capability registration), `stripe-connect-api.service.ts` (T3's `listPaidInvoices` renamed `listSubscriptionPaidInvoices`; T3's `voidInvoice` dropped) and `trial-conflict.service.ts` (main's keyed `voidInvoice(id, 'tgp-trial-void-<id>')`). `billing.service.ts` and `checkout.service.ts` PR lines are unchanged.

### The shared rule, checked on normal paths
- **First trial.** `trialTransition` (:1765) runs `markStarted`, which returns 'owned' (unique client+coach row). The purchase then gets `trial_started_at` and access, and the trial-ending notice is recorded.
- **Second package from the same coach.** The checkout's step 3 eligibility (`subscription-checkout.service.ts:555-575`) sees `trial_started_at` and sends 0 trial days. The second purchase has `trial_days` null, so `isTrialStart` is false and the claim never runs. It is a normal paid plan with access.
  - The offer agrees: `offersForClient` reads the 'started' ledger row and shows already_used. That ledger row is written in the same tx as the marker, on all three writers (:1691, :2549, deleted :2040).
- **Renewals and plain recurring plans.** The purchase owns, so access equals subscriptionGrantsAccess, and the only extra work is one `find`. Recurring is unchanged.
- **Losing purchase.** Only two trial checkouts started at the same moment can produce one: no access, cancel owed, or a kept paid plan if it already billed.
- **Wiring.** `TrialUsageService`, `TrialNoticeService` and `TrialCheckoutCapability` are exported by PackagesModule, which CheckoutModule imports. `TrialConflictService` is provided by CheckoutModule.
- **Production assumption (B-TR8-120 decision 2).** Main has no `CoachPackage.trial_days`, and `packageTrialDays` reads it through Reflect, so it returns 0. Production therefore holds no native `trial_started_at` without a ledger row. Agreed.

### Conflict hunks
- Imports: fine.
- `applySubscriptionUpdated` (:1691-1704) and `applyInvoicePaid` (:2549-2565) both keep `entitlement_active: trial.entitled`, `trial.owns ? trialStartPatch(...)`, `...trial.data`, and main's B-661-14/15 erase keyed on `entitled`. Correct.

No B.

### C
- **C-673-11 (builder's, agree C).** `offersForClient` has no in-progress state while another package's open trial attempt holds the trial. Mostly closed in normal use: `retireStaleTrialAttempts` (:298) retires that attempt before the next checkout decides.
- **C-673-12 (edge, deferred to 10k clients).** A race loser has its sheet secrets erased (main's `entitled` key). Agree with B-TR9-121 decision 1: accept.
- Carried, unchanged: C-673-1 rest, C-673-2/3/4/8/9/10, and MAX_TRIAL_DAYS 730 vs 30.

CI at this head: 10 of 11 checks green, including build-and-test, schema parity, rls-live-tests and community-live-tests. deploy-readiness-gate was skipped.
Size: 2,996 lines, under the 3,000 limit.
