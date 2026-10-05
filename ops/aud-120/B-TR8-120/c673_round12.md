FIX ROUND 12 (B-TR8-120, agent 120) — growth-project-backend#673 @ 14b7a7a28d2d5ebcfcf3d27a0845053057d4e682

Integration round under the owner ruling (10:31 PDT 10-05): ONE SHARED TRIAL RULE, at most one free trial per client per coach, whichever checkout sold it. Merge commit 14b7a7a2 = parents dcf095b8 (old #673) + b0654c80 (#672, carries main ee55f814 recurring #678). Fast-forward push, no force.

| Finding | Change | Commit | Test |
|---|---|---|---|
| B-TR7-120 RESTACK STOPPED: main #678 and T3 both owned trial access and the one-trial rule in `checkout-webhook-handler.service.ts` | Main's applySubscriptionUpdated / applyInvoicePaid / endSubscriptionPurchase are the base (live subscription authority, lockPurchase, lifecycle revision, WebhookRedeliverError, `subscriptionGrantsAccess`, `trialStartPatch`). T3's `subscriptionGrantsEntitlement` and its ledger keep-access branch are dropped. One place: `trialState`/`trialTransition`, called on the webhook tx under the package lock by all three trial_started_at writers. Every trial start claims the ledger first (`TrialUsageService.markStarted`, unique (client, coach)); only the purchase that holds it gets trial_started_at. Loser: no access + owed PackageTrialConflict (trialing/past_due), superseded when it billed (active: paid plan, no trial recorded). Deleted at end: claim first, a lost claim drops the marker; release + markCancelled as before | 14b7a7a2 | #706 `test/b-trials-8-shared-rule.spec.ts` 8 tests |
| C-673-1 (part): trial offers said "not offered yet" because no checkout registered | `SubscriptionCheckoutService` registers `TrialCheckoutCapability` (@Optional) | 14b7a7a2 | same spec, test 1 |
| Semantic merge conflict (no text conflict): two `listPaidInvoices` and two `voidInvoice` in `StripeConnectApiService` (main S-FEE / C-679-1 vs T3), tsc TS2393 | T3's is renamed `listSubscriptionPaidInvoices`; T3's `voidInvoice` dropped, the conflict worker uses main's keyed `voidInvoice(id, 'tgp-trial-void-<id>')`; T3 test stub renamed (1 line) | 14b7a7a2 | T3 suites below |

Readers: main's `decide()` step 3 (trial_started_at or an open trial attempt) and T1 `offersForClient` (ledger) are unchanged; they read the same decision because both records are written together. Assumption: no ClientPurchase.trial_started_at exists in production before the train lands (main's CoachPackage has no trial_days column; `packageTrialDays` reads it via Reflect, so 0).

**Failing-before:** lane [37356010489](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37356010489) (14b7a7a2 with main's side of the conflict, no shared rule, no registration): new spec 8/8 red, assertion failures only.
**Passing-after:** lane [37355951522](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37355951522) (14b7a7a2 + new spec + 10 verbatim #673 lens probes + `tsc --noEmit`): tsc clean; 54 suites, 685 passed / 7 failed; every b-trials, b-recur, checkout-webhook, stripe-webhook and billing suite green; the 7 reds are the ruled set below.

**Probe replay (verbatim, same lane):**
- Sol T23D-119 `673-payment-race`, `673-replay`: PASS. Sol T23-119 `673-probe`: PASS.
- Sol T23-118 `673-conflict-probe`: PASS except the unadapted late-row clock probe, red as at rounds 9 to 11.
- Sol T3E-119 `673-payable-race`: 2 uncollectible cases red, the Sol B-673-1 uncollectible case that #707 closes (listUncollectibleInvoices); same class as at dcf095b8.
- Opus T23D-119 673 P1-P6: PASS. Opus T3E-119 673 and its adapted copy: PASS.
- Opus T23-119 673: K1-K6 PASS; C-673-4 red as ruled. Opus T23-118 673: C-673-2 and both C-673-3 red (open Cs); controls PASS.

**Money list:**
- Webhook order/redelivery: the trial state runs after main's revision and stale checks inside the lock, so a WebhookRedeliverError rolls the ledger/conflict writes back; redelivery of a loser stays vetoed (test).
- Concurrency/lock order: package lock, then purchase row, then ledger insert (unique (client, coach) is the race guard); no HTTP in the tx.
- Terminal states: deleted/incomplete_expired go through endSubscriptionPurchase (claim, release, markCancelled); R-DISPUTE-PAUSE path untouched.
- Pagination/fail-closed: unchanged from round 11 (conflict worker), only the method names moved.
- Currency/minor units: no amount logic changed.
- Copy truth: no copy changes; the offer is now truthful (registered checkout).

**Size:** 2,996 changed lines vs #672 (+2,983/-13), under the grandfathered 3,000. The new tests live in #706.
**Follow-ups (C):** trial offer has no in-progress state (says offered while another package's open attempt holds; checkout then gives 0 days); `TrialCheckoutCapability` doc says the checkout reserves via TrialUsageService (it uses main's open-attempt hold); main MAX_TRIAL_DAYS 730 vs T1 30 (DB CHECK binds). Carried: C-673-1 rest, C-673-2/3/4/8/10.

**CI at 14b7a7a2:** running at post time. Not READY FOR AUDIT until every required check is green at this head; the builder report records the result.
