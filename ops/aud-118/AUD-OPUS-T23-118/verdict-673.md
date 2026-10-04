AUDIT Claude Opus 5.5 — growth-project-backend#673 @ df76889fb862095170498dccb23f35db3d116690 — VERDICT: APPROVE
A/B/C = 0/0/3

Job AUD-OPUS-T23-118 (agent 118). Tier T4 (money path). Trials T3: webhook trial lifecycle, one trial per client per coach, durable conflict cancel, and the trial view in the purchase list. Base T2 #672 `c5e7ed8e35f1e5b88653e5605dded2af8614182d`. Size: 11 files, +2,619 / -8 = 2,627 changed lines (about 700 source lines), under the 3,000 cap. CI at this head: 10 checks pass, deploy-readiness-gate skipped ([CI run 37186105856](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37186105856)). CodeQL, danger, banned-casts and SBOM run only once this piece is based on main.

### Evidence reuse decision

Nothing reused. This lens never approved #656 or any #673 head, so this is a full fresh audit. Every changed line was read:
- `checkout-webhook-handler.service.ts`: `subscriptionGrantsEntitlement`, `applyTrialState` / `trialTransition`, `applyTrialWillEnd`, `applyInvoicePaid`, `applySubscriptionDeleted`, `deliverTrialNotice` and `cancelTrialConflict`.
- `billing.service.ts`: the event case and the post-commit hooks.
- `trial-conflict.service.ts` (full file), `checkout.service.ts` `listForClient`, `client-purchases.select.ts`, `checkout.module.ts`, `docs/stripe-setup.md` and `.env.example`.
- All three specs, including the round-8 test adjustments (`45100490..df07fabc`), which adapt the tests to T2's stamped-zone and same-process rules without weakening any assertion.

### Prior findings of this lens

**C-671-4 (from #671) is closed at the writer. The builder's claim is accepted on evidence.**
- On this stack the only writer of `ClientPurchase.trial_ends_at` is `checkout-webhook-handler.service.ts:934`. The other `trial_ends_at` writes in `trial-usage.service.ts` are on the `PackageTrialUsage` ledger.
- That writer runs only when the purchase already has an end, when the subscription is `trialing` and entitled, or when the ledger says the trial started (`:930-933`). A lost race returns before the write (`:929`).
- Composed controls through the real handler are green:
  - a $0 trial invoice without a card, then `customer.subscription.deleted`, leaves `trial_ends_at` null and reads `setup_incomplete`, then `none`;
  - a lost race (card saved, trial already used with the same coach), then cancel, leaves `trial_ends_at` null and reads `none`.
  - Evidence: [probe run 37219356220](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219356220). The PR's own test is `test/b-trials-notice-and-webhook.spec.ts:480`.
- So T1's comment at `trial-view.ts:98-101` now holds. The direct view probe from AUD-OPUS-T12-117 stays red by design ([probe run 37218788517](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218788517)): it builds a row this writer can no longer produce, and T1 is unchanged.
- The one-writer rule has to survive the #680 composition. #680 has its own `trial_started_at` model, which is already item 5/6 of the C-656-1 integration list.

**B-672-3 composed (T2 fix through the T3 webhook): control green.** A shortened trial's `trial_will_end` arrives before its `customer.subscription.updated`. Delivery retires the notice (`skip:trial_superseded`, nothing sent). The update writes the new end, and the reconciler reopens the notice and sends it once on each channel. Evidence: [probe run 37219356220](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219356220).

### C-673-1 — post-commit trial work is awaited inside the webhook request

- **File:line:** `src/billing/billing.service.ts:674-686`. `deliverTrialNotice` (push 30 s + 5 s grace, then email 30 s + 5 s) and `cancelTrialConflict` (20 s deadline) run before the response, so the worst case is about 90 s.
- **Why C:** the [Stripe webhook docs](https://docs.stripe.com/webhooks) say the endpoint must return a 2xx quickly before complex logic. A late reply only causes a retry, which the processed-event dedup absorbs, and both jobs are idempotent with a 5-minute sweep as backstop.
- **Minimal fix rule:** start both post-commit jobs without awaiting them (`void ... .catch(log)`), and leave retries to the sweeps.

### C-673-2 — an older subscription event rewrites an extended trial end

- **File:line:** `checkout-webhook-handler.service.ts:930-934`. Once a purchase has a trial end, `!!purchase.trial_ends_at` writes whatever `trial_end` the event carries, with no ordering check.
- **Counterexample (probe, red as expected):** the trial was extended to +9 d. A pre-extension `customer.subscription.updated` (+2 d) is retried late. The purchase goes back to +2 d, and `recordIfDue` records a notice for the old date. The view and the notice then name a day before the real charge. Evidence: [probe run 37219356220](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219356220).
- **Why C:** it needs a Stripe-side trial edit, which no product path makes, plus a late retry of the earlier event. The wrong date is earlier than the charge, which is the safe direction for money. The same ordering gap for `status` is pre-existing recurring code, so it goes to the report.
- **Minimal fix rule:** write `trial_ends_at` only from the newest subscription state. Either re-read the subscription before applying trial fields on `customer.subscription.updated`, or skip an event whose `created` is older than the last one applied to the purchase.

### C-673-3 — outside this diff: coach metrics count never-billed trials (binding ruling)

- **File:line:** `src/coach-connect/coach-connect.service.ts:281-295` (MRR from `entitlement_active` recurring purchases), `:307-314` (`clients_churned_30d` counts every `canceled` purchase) and `:339-346` (sub-coach churn, same rule). This is main's code. T3 makes a started trial `entitlement_active`.
- **Counterexample (probes, red as expected):** a trial started through the real handler with nothing billed gives `mrr` 49 instead of 0. Cancelled during the trial, it gives `clients_churned_30d` 1 instead of 0. This breaks the binding ruling "MRR/churned_30d exclude never-billed trials". Evidence: [probe run 37219356220](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219356220).
- **Why C (not unsafe here):** on main plus T1-T3 no trial can be sold. The T2 checkout capability is unregistered (`trial_offer` reads `not_offered_yet`), and no client-package checkout passes trial days; the only `trialPeriodDays` caller is the owner SaaS plan. So no wrong metric can appear until trials compose with #680.
- **Minimal fix rule (operator item):** in the trials #680 integration round, exclude never-billed trials from `mrr`, `clients_churned_30d` and `sub_coach_churn_30d` (reuse #676's billed predicate), and carry a composed test like this probe.

### Checked and sound

- **Card up front.** `subscriptionGrantsEntitlement` grants `trialing` access only with a subscription `default_payment_method` (`:114`). A started trial keeps access when the card is removed, and Stripe cancels at the trial end. `active` and `past_due` entitlement is unchanged for existing recurring purchases, including the `invoice.paid` path (`:1359`).
- **One trial per client per coach.** `markStarted` runs before the package lock (no lock cycle found). A lost race writes an owed `PackageTrialConflict` on the webhook tx and is vetoed on every later event. The cancel goes through a lease plus a deadline, backoff and a sweep. It is superseded (support alert, ids only) only when Stripe billed.
- **Release on abandon.** `applySubscriptionDeleted` releases only a reserved trial and marks a conflict cancelled.
- **Notices and trial view.** The trial-ending notice is recorded on the tx and sent after commit, and nothing is sent on rollback. `listForClient` adds `trial` from DB reads only.
- **DI.** PackagesModule exports the trial services, and CheckoutModule provides TrialConflictService.
- **Copy and logs.** Copy rules hold, and the logs carry closed codes and ids.

Probe branch `audit/AUD-OPUS-T23-118/673-probes` (probe spec only, on this head): `test/audit-opus-t23-118-673.spec.ts`, with 3 probes red as expected and 3 controls green.
