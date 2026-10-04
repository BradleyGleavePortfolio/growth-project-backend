OPENING (B-DUNSPLIT-119, agent 119) — growth-project-backend#705 @ 279ec1677d574b86e773248174eef57c1d2a237d

**Tier:** T4 (money path). **Why:** builds R-DISPUTE-PAUSE. **T4 trigger scan:** Stripe writes (pause_collection, uncollectible, resume), entitlement, webhook order/redelivery, row locks, restart authz: hit. **T3 trigger scan:** mobile status contract, notice copy: hit, covered by T4. **Bounded T1:** none. **Canonical builder:** B-DUNSPLIT-119. **Parent owner:** operator agent 119. **Acceptance evidence:** below. **Promotion triggers:** FEATURE_DUNNING_V2 off until D4 wires the dispute webhooks and the restart endpoint.

**Size:** 1,287 changed lines (907+/380-), at or under 1,500 (12:33 rule).

**Mechanism:** `pause_collection[behavior]=void` + open invoices `uncollectible` (not cancel: not reversible by the coach and loses subscription/price/card; not void: forgives money owed). **Restart:** `DunningV2Service.restartAfterDisputePause` (owner-only, tenant-checked; endpoint in D4). R138 gate, behaviour and the mobile contract are in the PR body.

**Evidence (CI lane)**
- Failing-before on D2b `d92c83df` with these specs: [37230001355](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230001355) — 30 failed / 42 passed (28 new cases + 2 replaced B-688-5 cases; the one-time-purchase cases pass before and after).
- Passing-after at `77d009ec` (later change: merge of the D1/D2a privacy-list fix; privacy spec passes locally at this head): [37230747608](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230747608) — 237 passed, 0 failed (15 suites incl. checkout-webhook-handler).

| Probe | Result at this head |
|---|---|
| Sol 118 688-probe, 688-probe-v2 | pass unchanged |
| D1 probes (Sol 118 687 adapted, Opus 118 687, Sol 116 d1) | pass |
| Opus 116 lost-dispute, Opus 118 688 part 1, Sol 116 d2 (lost dispute keeps protecting; clears refused) | pass; superseded assertions adapted: `cycle_already_active` -> `paused` (opened true), `not_won` -> `pause_kept`, "won resolves the payment cycle" -> stays paused (nothing restores on closure). Their Stripe stubs predate the pause, so only that call is stubbed. |
| Opus 118 688 parts 2-4 | pass unchanged |

**Operator 12:50 (C-680-12 / B-680-1):** `customer.subscription.updated` with `pause_collection` set (status `active` and `past_due`) after the dispute keeps access ended; control: after the coach restart the same update re-entitles. Green on this base (the guard is here, it does not depend on the #680 fix).

**Money self-check**
- Webhook order/redelivery: created twice (one pause, one notice set, pause re-asserted with the same key); closed before created pauses; invoice.paid before and after; payment_failed after; subscription.updated after: no restore. Pass.
- Concurrency: two workers serialized by the ClientPurchase row lock: one pause, one notice set; lock order DunningState then ClientPurchase asserted. Pass.
- Terminal states: won, lost, warning_closed, charge_refunded keep the pause; refund without dispute id never pauses; canceled plan `plan_ended`; deleted account `purchase_unresolved`, restart `not_found`. Pass.
- List pagination/completeness: open-invoice list fails closed (throws, redelivered, no notice). Pass.
- Currency: no amount computed or shown for a dispute (`amount_cents` null). Pass.
- Copy truth: notices only after the Stripe pause succeeds; client and coach copy state access ended, billing paused, coach decides; one-time purchases get no notice and keep today's copy. Pass.

**Follow-ups (C)**
- `src/checkout/dunning-v2/dunning-v2.service.ts` pauseBillingAtStripe: no reconciler re-asserts the pause when webhook retries are exhausted; rule: sweep active marker rows and re-call pause_collection.
- `src/checkout/dunning-v2/dunning-v2.copy.ts` LR_LOCKOUT_SCREEN reuses card-update text; rule: access ended, billing paused, coach decides.
- C-688-9 (carried): v1 invoice.paid takes ClientPurchase before DunningState; rule: DunningState first.

**Decisions for the operator (default first):** inquiries pause too ("any dispute"): yes. A cycle already locked keeps its lock instant: yes.

**Required checks at this head:** all green (build-and-test, schema parity, live tests, npm audit, size-label, deploy readiness).

READY FOR AUDIT
