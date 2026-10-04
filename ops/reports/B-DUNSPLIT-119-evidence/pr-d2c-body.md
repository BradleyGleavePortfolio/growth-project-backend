**Tier:** T4 (money path).
**Why:** builds the owner's binding ruling R-DISPUTE-PAUSE: a dispute on any charge of a recurring plan pauses all billing for that plan at Stripe and ends access at once; nothing restores it automatically; the coach restarts it separately.
**T4 trigger scan:** Stripe writes (pause_collection, invoice uncollectible, resume), access gating (entitlement, lock), webhook order and redelivery, row locks, tenant authz on the restart. Hit.
**T3 trigger scan:** client status contract read by mobile (new fields), notices copy. Hit; covered by T4.
**Bounded T1:** none.
**Canonical builder:** B-DUNSPLIT-119 (agent 119).
**Parent owner:** operator agent 119; stack #687 D1 -> #688 D2a -> D2b -> this D2c -> #689 D3 -> #690 D4 -> #691 D5.
**Acceptance evidence:** failing-before CI-lane run [37230001355](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230001355) on D2b `d92c83df` with these specs: 30 failed / 42 passed (28 new R-DISPUTE-PAUSE cases + 2 replaced B-688-5 cases; the two one-time-purchase cases pass before and after, as they must). Passing-after: [37230747608](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230747608) at `77d009ec`, 237 passed (later change: privacy-list merge only; required checks green at `279ec167`).
**Promotion triggers:** FEATURE_DUNNING_V2 stays off until D3-D5 wire the dispute webhooks (D4 `runDisputeEffect`) and the restart endpoint; see the handoff list below.

## Behaviour
- `charge.dispute.created` (and a closure processed before it) for any charge of an eligible recurring plan (`billing_type` recurring, `amount_cents` > 0, a Stripe subscription, not canceled) runs `applyDisputePause`:
  1. One transaction: lock `DunningState` FOR UPDATE, then `ClientPurchase` FOR UPDATE (the dunning lock order); record the dispute obligation; set the cycle `active`, marker `charge_disputed`, step 3, `locked_out_at` now (an already-locked cycle keeps its instant); `entitlement_active` false; pending deliveries canceled. Access ends here.
  2. Stripe: `pause_collection[behavior]=void` on the subscription, then every open invoice (list fails closed) marked uncollectible. Idempotency keys per purchase + cycle and per invoice. A Stripe failure throws so the webhook is redelivered; the pause is re-asserted on every redelivery.
  3. Notices only after step 2: step 3 dispute set (client push, email, blocker; coach alert, push, email) with the #687 copy: access has ended, billing for the plan is paused, the coach decides whether to restart.
- Redelivery of the same dispute: re-asserts the Stripe pause, no new notice. A dispute already applied (seen before a restart) changes nothing after the restart.
- Closure (`won`, `lost`, `warning_closed`, `charge_refunded`): records the outcome, never restores. A closure delivered first pauses (closedAt = the dispute event time when D4 passes it).
- Nothing else lifts it: v1 `recordResolution` (invoice.paid), `applyImmediateClear` (retry, card_update, manual), the sweep, and `customer.subscription.updated` / the invoice.paid resync (Stripe keeps the status `active` under pause_collection) all refuse while the plan is paused. The handler decides under the `DunningState` row lock.
- Refunds (no dispute id) never pause. One-time purchases and code/free grants: unchanged (no pause, no notice, no Stripe call).
- `restartAfterDisputePause({ coachUserId, purchaseId })`: owner-only (the plan's coach; anyone else gets `not_found`, tenant check), refuses `not_paused`, `plan_ended`, `billing_unavailable`; resumes at Stripe first (`billing_resume_failed` keeps the pause); then under the row locks resolves the cycle, restores entitlement, dismisses blockers. A dispute recorded during the restart aborts (`new_dispute`) and re-pauses at Stripe.

## Mobile contract (`GET` client dunning status, `ClientDunningStatus`)
Dispute-paused recurring plan: `state: 'locked'`, `kind: 'dispute'`, `reason: 'dispute_paused'`, `access_ended: true`, `billing_paused: true`, `restart_by: 'coach'`, `lockout_at: null`, `locked_at: <ISO>`, `amount_cents: null`, `update_payment_route: null`, `update_card_url: null`, `cancel_route: null`, `coach_name`, `purchase_id`, `currency`, `failed_at`. (`state` is `'past_due'` with `lock_waived: true` only when another live entitlement keeps the client in; the reason fields are the same.)
Payment cycle: `reason: 'payment_failed'`, `access_ended: state === 'locked'`, `billing_paused: false`, `restart_by: null`, other fields unchanged. No cycle or one-time purchase: `state: 'none'`, `reason: null`, `access_ended: false`, `billing_paused: false`, `restart_by: null`.

## R138 Decision Gate
1. **Musk five principles:** questioned the compressed 7-day dispute cycle (the ruling makes it wrong); deleted its auto-resolve paths (`resolveDisputeCycle`, `hasOpenDisputeObligation`, the tryLock won-closure resolve, the manual-clear exception); simplified to one marker that only the coach restart clears; accelerated by reusing the existing lock, outbox and notice paths; automated nothing new (no reconciler yet, see Cs).
2. **Hyperscaler practice:** Stripe's own pause mechanism (`pause_collection`) for a reversible stop of collection, with idempotency keys and webhook redelivery as the retry; Stripe Billing marks unpaid invoices uncollectible rather than voiding money still owed.
3. **GOOD without BAD:** billing stops and access ends at once, without cancelling the subscription (cancel would lose the price, card and subscription and force a new checkout on restart, and is not reversible by the coach) and without voiding invoices (that would forgive the debt). DB first so access ends even if Stripe is down; notices only after the Stripe pause so the copy is true when sent.
4. **Root cause:** the old cycle treated a dispute as a late payment problem with a lock date; the ruling treats it as a stop. The root fix is one marker that every payment path refuses, plus a single explicit restart.

**Mechanism:** `pause_collection[behavior]=void` + open invoices `uncollectible`. **Restart action:** `DunningV2Service.restartAfterDisputePause` (service path; the coach-owned POST endpoint is wired in D4).
**Rollback/blast radius:** flag-gated (FEATURE_DUNNING_V2 off = every entry point returns before any read or write; the handler guard reads nothing when the service is absent). Revert this PR to return to D2b. A plan paused in production is resumed with `pause_collection=''` and the cycle row set resolved; no money moves.

## Seams and line counts
| Piece | PR | Base | Changed lines |
|---|---|---|---|
| D1 | #687 | main | 2,822 (grandfathered) |
| D2a | #688 | #687 | 2,440 (grandfathered) |
| D2b | #704 | #688 | 694 |
| D2c | this | #704 | 1,287 (907+/380-) |

Files: `dunning-v2.service.ts` (pause, restart, guards, status contract), `dunning.service.ts` (v1 recordResolution refuses a paused row), `checkout-webhook-handler.service.ts` (subscription.updated and invoice.paid resync never re-entitle a paused plan), `stripe-connect-api.service.ts` (pause, resume, uncollectible), `test/dunning-v2-dispute-pause.spec.ts` (new), and the replaced compressed-cycle cases in `test/dunning-v2-service.spec.ts` and `test/dunning-v2-service-fixes.spec.ts`.

## Handoff to D3-D5 (B-DUNB-119; not touched here)
- D4 `runDisputeEffect` passes `closedAt: new Date(event.created * 1000)` to `onDisputeClosed`, and passes the dispute id on `charge.dispute.created`.
- D4's own `applySubscriptionUpdated` / invoice.paid code must keep the `isDisputePaused` guard.
- D4 wires the coach-owned POST restart endpoint to `restartAfterDisputePause`.
- D5 specs that assert the compressed cycle need the R-DISPUTE-PAUSE expectations.
- Mobile lockout reads the contract above.

## Fix rounds
| Round | Job | Head | Closed | Comment |
|---|---|---|---|---|
| OPENING | B-DUNSPLIT-119 (agent 119) | `279ec167` | builds R-DISPUTE-PAUSE | [OPENING](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/705#issuecomment-5984075259) |
