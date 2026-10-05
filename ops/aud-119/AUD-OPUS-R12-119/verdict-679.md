AUDIT Claude Opus 5.5 — growth-project-backend#679 @ 8bbf4a41cdd5fdbd0e30ea3baa4b35034aefc7ca — VERDICT: APPROVE
A/B/C = 0/0/1

Job AUD-OPUS-R12-119, agent 119, lens Claude Opus 5.5, T4 (money, recurring checkout, deletion). Independent of the Sol lens and of the builder: every FIX ROUND 6 claim below was re-checked in code or in CI.

**Scope.** R2 at 8bbf4a41, base #678 @ 77bce450 (an ancestor). 8 files, +2,932/-0 = 2,932, 68 under the limit: no new test may be added to this piece. This lens's last verdict here was REQUEST CHANGES 0/2/1 at f48fa8f0. There was no Opus verdict at the round-5 head.

**Evidence reuse (G09).** The controller, checkout.module.ts and the lockout route table are blob-identical to f48fa8f0, and the checkout.service.ts R2 hunk is byte-identical to 958806d1 (approved by this lens). Read in full at this head: src/checkout/subscription-checkout.service.ts (all 1,561 lines), the round-5 and round-6 specs, and the R1 helpers it now calls (sendFenced, holdUnresolved, ownTrialSheet, findAttemptSubscription, intentResult). Merges: remerge diffs are empty except 32e1a67d. Its one add/add conflict (subscription-errors.ts) resolves to the R1 file byte-for-byte, and the file is absent from the R2 diff.

**Prior findings.**
- Opus B-679-8 (an abandoned trial charged to the customer default at trial end): CLOSED. Trials are created with a Stripe-enforced end, and only `attachTrialCard`, with a card that the attempt's own SetupIntent saved, lifts it. Every "card saved" test now requires the end lifted (service :385, :1033, :1108, :1432; `ownTrialCardOn`).
- Opus B-679-9 (a canceled SetupIntent read as proof the attempt ended): CLOSED. `canceledSetupState` (:1498-1512) reads the subscription and ends it only through `endUnpaid`. An unconfirmed end keeps the row (PAYMENT_RETRY).
- Opus C-679-3 (a missing subscription blocks the plan at any age): CLOSED for new keys and bound reads (`isResourceMissing` at :922, :995, :1099, :1427). Sol's same-key trial residual C-679-3 (:1464-1490) stays open as a follow-up, under the freeze.
- Dead-lens B-679-10 (a default-card client cannot start a trial): CLOSED. A null `pending_setup_intent` gets the attempt's own SetupIntent sheet in `finishBound` (:782) and `tryReuse` (:1136), the end stays set until that card is attached, and a later key resumes the same trial and the same SetupIntent. The probe acceptance passes and its evidence cases fail by design in [run 37220452812](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220452812) (= 8bbf4a41 + prior lens probes only; 164 pass / 9 fail, each failure as listed in FIX ROUND 6).
- Sol B-679-7 / B-679-8 / B-679-10 (judged independently): the fixes meet each fix rule.
  - B-679-7: the create is sent only inside `sendFenced` (:692, :714). 'gone' gives CLIENT_NOT_FOUND, and 'closed' re-reads the row before any answer (:726-734).
  - B-679-8: `holdUnresolved` (:752) reopens the same client's row, so admission reuses that subscription, reports it, or ends it under guard. It never makes a second one.
  - B-679-10: covered above.

**Operator default: Sol B-679-8 probe deviation (`nextSubscription` = sub_1, not undefined). This lens: ACCEPT.** The next key gets the same, still-payable subscription back only through `tryReuse`. That path re-reads Stripe and re-checks the pinned terms, the trial, the amount, the first charge and both price ids (:1142-1170). Anything stale ends through `endUnpaid`. Live subscriptions stay [sub_1] and creates stay 1. That is the exclusion Sol asked for, with more function, not a second subscription.

**Money list (re-checked).**
- Webhook order and redelivery: no webhook code in R2. The attach key `tgp-trial-card-<sub>-<pm>` collapses all callers. Every R2 attach caller is gated on an unentitled row with `trial_started_at` null, so no R2 path can lift a cancel the client chose after the grant.
- Concurrency: per-(client, coach) advisory lock for admission. The claim CAS and the bind run under the user then purchase row locks, and the webhook metadata fallback loses the race cleanly (its `stripe_subscription_id: null` CAS waits on the row lock).
- Terminal states: deleted account gives 'gone'. Canceled and incomplete_expired give no sheet. A canceled SetupIntent is never replaced.
- Lists: `has_more` gives 'unreadable', and nothing is resent.
- Currency: pinned terms in minor units, unchanged.
- Copy truth: no "Nothing was charged" without proof, with one residual below.

### C-679-4: a trial with a subscription default but no SetupIntent is answered SUBSCRIPTION_ALREADY_ACTIVE although it will end with no card
- Where: src/checkout/subscription-checkout.service.ts:1045 (`attemptSettled`: `setup ? ... : !!sub.default_payment_method`), reached from `retireAttempt` (:900, terms changed) and from the `endUnpaid` re-read. `tryReuse` was fixed the opposite way in this round (:1132-1134). With the enforced end, a default card the attempt never saved can no longer convert the trial, so "settled" is not true.
- Counterexample (probe, [CI lane run 37229380504](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229380504), branch audit/AUD-OPUS-R12-119/679-probes = this head + one spec):
  1. A 7-day trial whose subscription Stripe returned with no pending SetupIntent but with a subscription default (Sol's shape 2).
  2. The ephemeral key fails, so no secret is stored.
  3. The coach changes the price, and the same key replays.
  4. The answer is 409 SUBSCRIPTION_ALREADY_ACTIVE while sub_1 stays `trialing` with `cancel_at_period_end=true`. The evidence case passes, and the acceptance case fails.
- No money moves, and a new key recovers. Shape 2 is not verified on live Stripe, and the case needs three conditions together. Hence C.
- Fix rule: with no SetupIntent, return false (unsettled), as `tryReuse` does. Test: the sequence above answers SUBSCRIPTION_ATTEMPT_EXPIRED (terms_changed), and sub_1 ends.

**For the R3 #680 lens (not this PR).** The own SetupIntent (metadata `tgp_checkout=native_subscription_trial`, `tgp_subscription_id`) is tied to its subscription only by metadata. #680's `setup_intent.succeeded` handler must attach it through `attachTrialCard` while the row is not granted, and never after a client cancel. Otherwise the plan-read poll is the only attach, and a client who saved a card and closed the app would lose the plan at trial end. Main's `applySubscriptionUpdated` (checkout-webhook-handler.service.ts:814-846) still grants on any `trialing` update. #680 must gate the trial grant on the lifted end.

**CI at this head.** All required checks are green: [build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220454466/job/111489547926), rls-floor-guard, rls-live, mwb-3, community-live, npm audit (run 37220454409), Schema parity (run 37220454378), size-label. deploy-readiness-gate was skipped. Builder failing-before [run 37220493176](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220493176) concluded failure (10/11) as stated. CodeQL, danger, banned casts and build-sbom run only after retarget to main.

**Landing and restack delta.** Rule 11 is unchanged: R1+R2+R3 land as one after fees, and the owner adds the `setup_intent.succeeded` event before deploy. After the merge-only restack onto the final fees top, a short delta must confirm:
- (a) the R2 own patch (new R1 head..new R2 head) equals 77bce450..8bbf4a41 per file;
- (b) the remerge diff of each restack merge is empty, or every conflict hunk was read;
- (c) the size stays at or under 3,000 (now 2,932);
- (d) `sendFenced` is still the only path to `createSubscription` (the service's two calls at :692 and :714);
- (e) required checks are green at the new head.
