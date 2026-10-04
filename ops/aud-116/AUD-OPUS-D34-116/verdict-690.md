AUDIT Claude Opus 5.5 — growth-project-backend#690 @ f72668c26f8bea505dea7e47594e98ac4a921398 — VERDICT: REQUEST CHANGES
A/B/C = 0/1/4

Job AUD-OPUS-D34-116, tier T4. This is a full-depth read of the D4 diff against #689 @ 9e77159a. Files read:
- client-billing.controller.ts
- checkout-webhook-handler.service.ts
- dunning-lockout.guard.ts and the allow-list
- dunning-lockout.scheduler.ts
- dunning-status.controller.ts
- the checkout.module wiring
- client-entitlement.guard.ts
- public-pages (controller and html)
- well-known.controller.ts
- main.ts
- the D4 test files

Evidence reuse: every D4 file is byte-identical to #628 @ dc47e0ef (FIX ROUND 8), which this lens never audited. The webhook handler changed by 61 lines since this lens's APPROVE @ 739e9a54, so it was re-read in full at this head. No earlier verdict is reused.

Probe: branch `audit/AUD-OPUS-D34-116/690-webhook-paths` = this head plus one probe spec, `test/audit-opus-d34-690-webhook-paths.probe.spec.ts`. The spec reuses the harness of `test/dunning-r2-native-card-1a-2a-e2e.spec.ts`. Run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173263249 : control W0 passes; W1 and W2 fail as predicted.

## B-690-1 — one failed dispute read on invoice.paid permanently settles the dispute cycle (fail-open)
- Where: `src/checkout/checkout-webhook-handler.service.ts:1201-1248`, `resolveDunningOnPaid`. If `isDisputeCycleOpen` throws (`:1206`), the `catch` at `:1225-1229` only logs and then falls through to two calls:
  - v1 `dunning.recordResolution` (`:1233`), which runs on `this.prisma`, outside the webhook transaction.
  - `applyImmediateClear('retry', tx)` (`:1242`).
  The handler returns normally, so the event counts as processed. In Postgres a failed read inside the transaction also aborts it, and the v1 resolution is already committed outside it. A redelivery then finds the row resolved: `isDisputeCycleOpen` returns false and the lift goes ahead. Either way the dispute cycle is gone for good. FIX ROUND 8 made a failed marker write keep the cycle (`:1210-1216`); a failed read does the opposite.
- Counterexample (probe W1): open dispute cycle (same setup as the #691 B-628-13 order-1 case). On Day 14 the next renewal is paid, and `isDisputeCycleOpen` rejects once with a pool timeout (P2024). The same `invoice.paid` is then redelivered with a healthy database, and the Day-19 sweep runs. Observed: `{"webhook_threw":false,"state_status":"resolved","dispute_cycle_open":false,"locked_on_dispute_day":0}`. Expected: the cycle stays active as the dispute cycle and locks on Day 19 (control W0 shows exactly that when there is no fault).
- Minimal fix rule: a dispute-read failure never resolves anything. Rethrow, so the event fails and Stripe redelivers it, or skip both the v1 resolution and `applyImmediateClear`. Run v1 `recordResolution` in the same transaction (or only after commit), so a rolled-back event never leaves a committed resolution. The #689 card-update path needs the same fail-closed rule (see #689 B-689-1).
- How to verify: W1 passes (cycle active, marker `charge_disputed`, Day-19 lock = 1). W0 and the #691 B-628-13 order 1 / order 2 suites still pass. Add a failing-before test with its run URL.

## C-690-1 — a late invoice.payment_failed after a 2A cancel flips the ended plan back to past_due
- Where: `applyInvoicePaymentFailed` (`:1251-1325`). The update at `:1286-1293` writes `status: 'past_due'` on a canceled purchase. `customer.subscription.updated` got a `stale_after_cancel` guard (`:829`, `:838`); this event did not. `:1274` and `:1292` also store the Stripe free-form message in `last_error`.
- Probe W2 (2A on Day 4, then the Day-3 retry's `payment_failed` arrives late): `{"purchase_status":"past_due","entitlement_active":false,"state_status":"abandoned"}`. There is no lock and no notice, because the abandoned row is not reopened. Coach and client surfaces, however, see the ended plan as past due.
- Fix rule: apply the same stale guard: a canceled purchase, or one with a client cancel pending, records nothing on the plan. Store a code in `last_error`. Verify: W2 passes.

## C-690-2 — dispute effects are fire-and-forget and lost on any error
- Where: `fireDisputeClosed` (`:324-342`, new in this PR) and `fireLateReversalProbe` (`:296-322`, existing pattern). An error is logged and the event is still counted as processed, so it is never retried. `runSweep` skips locked rows (`locked_out_at: null`). If a won-dispute effect is lost, a locked client stays locked even though they won.
- Fix rule: await the dispute effect in-band so a failure fails the event and Stripe redelivers it, or give it a durable retry. Also have the sweep re-evaluate locked dispute cycles against the obligation ledger. Verify: a test where `onDisputeClosed` fails once and the redelivery unlocks.

## C-690-3 — public card page copy
- Where: `src/public-pages/public-pages.html.ts:88-93`. "stay with our payment provider" uses the first person, which the copy rule forbids. "your access stays on" is untrue for a locked client, whose access comes back.
- Fix rule, for example: "...so card details stay with the payment provider and never pass through a web page. ... Once the new card is saved, the amount owed is paid with it and access continues, or comes back if it was paused." Verify: a public-pages test asserts the new text.

## C-690-4 — free-form error text in logs
- Where: `:1227`, `:1236`, `:1245`, `:320`, `:340` and the other new warn lines in the handler log `(err as Error).message`. Same class as #688 B-688-4. Fix: use the same safe error-label helper.

## Prior findings decided for code in this PR
- B-628-13 webhook path: CLOSED. `resolveDunningOnPaid` uses the durable predicate and calls `keepAsDisputeCycle`; W0 passes. The remaining fail-open gap is B-690-1.
- C-628-14, C-628-15 and B-628-11 have no code in this PR. They are decided CLOSED on #689.

## Belongs to other PRs (not findings here)
- #689: B-689-1 (card update settles a dispute) and B-689-2 (cancel settles a dispute). This PR makes both reachable: the routes are live, but behaviour depends on `FEATURE_DUNNING_V2`, which stays off.
- #688: B-688-5 / Opus D12 B-688-1, a `lost` obligation counted as closed. `resolveDunningOnPaid` inherits it through `isDisputeCycleOpen`.
- #687: Sol B-687-1, the `effectiveLock` read used by the lockout guard.

## Operator note (Stripe settings, not a finding)
- The Day 0-9 branch of the entitlement guard admits only `past_due`. `applySubscriptionUpdated` grants entitlement only for active, trialing and past_due.
- So the dashboard setting "If all retries for a payment fail" must stay "leave the subscription past-due". Either "mark unpaid" or "cancel" would end access on Day 7 instead of applying the Day-10 lockout.

Verified with no finding:
- The controller: DTO validation, coded errors, roles plus `SkipClientEntitlement`, throttles, and scoping to `req.user`.
- The lockout guard: exact-path message allow-list and account-rights prefixes.
- The entitlement guard: the Days 0-9 branch is flag-gated.
- The hourly scheduler: has a running guard.
- Module wiring.
- AASA path, plus the main.ts prefix exclusion for `/billing/update-card`; the `tgp://` scheme matches the mobile app config.
- `charge.refunded` no longer opens a reversal cycle (F11).
- The never-entitled seam: shared-helper ruling with #654, not a finding.
