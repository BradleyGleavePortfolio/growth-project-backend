# B-DUNSPLIT-119 report (builder, Claude Opus 5.5, T4) — agent 119

Started 12:30 PDT 10-04. Lock `dunning` taken 12:30 PDT (ops/lanes119/locks/dunning). Updated 13:05 PDT.

## PRs and heads (first push 13:02 PDT, second 13:14 PDT; normal pushes only)
| Piece | PR | Branch | Base | Head | Changed lines |
|---|---|---|---|---|---|
| D1 | #687 | agent115/dunning-split-1-foundation | main | c260a849ee31ecc7103d409783464fc1452751dd | 2,822 (2,526+/296-; grandfathered, under 3,000) |
| D2a | #688 | agent115/dunning-split-2-dunning-service | #687 | f29fc201b43a93b3a2f2e431b76b545110bff015 | 2,440 (1,905+/535-; grandfathered) |
| D2b | #704 (new) | agent119/dunning-split-2b-v1-marker-fixtures | #688 | 276a9f60139ff33f197c235c6d9825e614ca97d7 | 694 (615+/79-) |
| D2c | #705 (new) | agent119/dunning-split-2c-dispute-pause | #704 | 279ec1677d574b86e773248174eef57c1d2a237d | 1,287 (907+/380-) |

Sizes from `gh pr view N --json additions,deletions` / git diff at 13:14 PDT.

Second push (13:14): main's #700 privacy guard (merged in via main) has an exact-match list of legacy exception-text log counts; the D1 dispatcher and coach-alert emitter and the D2a service print none, so build-and-test failed on #688/#704 on that one assertion. Fix: drop those 3 entries (D1 `c260a849`: 2 entries, D2a `f29fc201`: 1 entry), merged up to D2b `276a9f60` and D2c `279ec167`.

## What was done
- #687: merged main `3e9a9a75` (merge-only, 21e1deac); moved `test/fixtures/stripe/dunning-v2/*.json` (7 files, only D5 specs read them) up to D2b byte-identical (6d9e3954); dispute copy now says access has ended, billing for the plan is paused, the coach decides whether to restart (59f2f851); the dispute email hides the card button; test regex fixed so the coach restart line is asserted on step 3, where coach channels exist (13c008a6).
- #688 (D2a): merged D1; split commit 999557c7 keeps only `dunning-v2.service.ts` + `test/dunning-v2-service.spec.ts` (byte-identical to audited 2368d5fa); `dunning.service.ts`, `env-validation.ts`, `test/dunning-v2-service-fixes.spec.ts` restored to D1 and moved up.
- #704 (D2b): byte-identical restore of those files and the fixtures from 2368d5fa. Tree at D2b = 2368d5fa + main merge + D1 copy fix.
- #705 (D2c): builds R-DISPUTE-PAUSE (see PR body for behaviour, R138 gate, mobile contract).

## Seams
File-level only; an intra-file seam would create unaudited intermediate code. D2a alone is 2,439 lines (grandfathered under 3,000; cannot drop further without an intra-file cut of the audited service).

## Stripe mechanism
`pause_collection[behavior]=void` on the subscription plus open invoices marked `uncollectible`; restart = `pause_collection=''` via `DunningV2Service.restartAfterDisputePause` (owner-only, tenant-checked). Not cancel: cancel is not reversible by the coach and loses subscription, price and card. Not void: voiding forgives money still owed.

## Mobile contract (ClientDunningStatus, D2c)
Dispute-paused recurring plan: `state: 'locked'`, `kind: 'dispute'`, `reason: 'dispute_paused'`, `access_ended: true`, `billing_paused: true`, `restart_by: 'coach'`, `lockout_at: null`, `locked_at: <ISO>`, `amount_cents: null`, `update_payment_route: null`, `update_card_url: null`, `cancel_route: null`; plus `coach_name`, `purchase_id`, `currency`, `failed_at`. With another live entitlement: `state: 'past_due'`, `lock_waived: true`, same reason fields.
Payment cycle: `reason: 'payment_failed'`, `access_ended: state === 'locked'`, `billing_paused: false`, `restart_by: null`; other fields as before.
No cycle / one-time purchase: `state: 'none'`, `reason: null`, `access_ended: false`, `billing_paused: false`, `restart_by: null`.

## CI lane evidence
- #687 failing-before: [37229268820](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229268820) (5 failed / 58 passed, the new copy assertions on 6d9e3954).
- D2c failing-before on D2b d92c83df: [37230001355](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230001355) (30 failed / 42 passed: 28 new cases + 2 replaced B-688-5 cases; one-time cases pass before and after).
- Intermediate replays: 687 [37230160413](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230160413), D2a [37230183469](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230183469), D2b [37230193846](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230193846), D2c [37230213687](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230213687): only fail was a D1 test regex (fixed 13c008a6) and, on D2c, the unadapted compressed-cycle probes (superseded, below).
- Final CI lane (heads before the privacy-list fix): 687 @13c008a6 [37230710669](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230710669) 113 passed; 688 @9506bc95 [37230722879](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230722879) 132 passed; 704 @2b8f0c8f [37230734885](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230734885) 150 passed; 705 @77d009ec [37230747608](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230747608) 237 passed, 0 failed everywhere.

## Probe replay (both lenses)
Adapted copies in ops/reports/B-DUNSPLIT-119-evidence/probes.
- Sol 118 687-probe: line 75 expected 'Update card in the app' in the dispute email; superseded by R-DISPUTE-PAUSE; adapted to not.toContain plus the pause sentence.
- Opus 118 687, Sol 116 d1, Sol 118 688-probe, 688-probe-v2: unchanged, pass on every head.
- Opus 116 lost-dispute, Opus 118 688 part 1, Sol 116 d2: pass unchanged on D2a and D2b. On D2c the security intent (lock kept, clear refused, lost dispute protects) holds; superseded assertions adapted in `*-pause.spec.ts`: reason `cycle_already_active` -> `paused` (opened true), `not_won` -> `pause_kept`, "won during payment cycle resolves" -> stays paused; the Stripe pause call is stubbed because those probes' Stripe stubs predate it.

## Money self-check (D2c)
- Webhook order/redelivery: created twice, closed-before-created, invoice.paid before and after, payment_failed after, subscription.updated with pause_collection after: one pause, one notice set, no restore. Pass.
- Concurrency: two workers serialized by the ClientPurchase row lock produce one pause, one notice set; lock order DunningState then ClientPurchase asserted. Pass.
- Terminal states: won, lost, warning_closed, charge_refunded keep the pause; refund without dispute id does not pause; canceled plan = plan_ended; deleted account = purchase_unresolved / restart not_found. Pass.
- List pagination/completeness: open-invoice list fails closed (throws, redelivered, no notice). Pass.
- Currency: no amount is computed or shown for a dispute (amount_cents null); no currency arithmetic added. Pass.
- Copy truth: notices sent only after the Stripe pause succeeds; client and coach text state access ended, billing paused, coach decides; one-time purchases get no notice. Pass.

## Follow-ups (C)
- C-688-9 (carried): invoice.paid path lock order vs v2 (ClientPurchase before DunningState in v1); rule: take DunningState first.
- Carried from B-DUNA-118: Roman payment push copy; LOCKOUT_SCREEN copy; blocker 160-char cut; dispute blocker deep link tgp://billing/update (src/checkout/dunning-v2/dunning-v2.copy.ts) should point at the plan screen, not card update; dispute amount source; pushToUser ticket.message log; v1 raw failure reason.
- New: reconciler to re-assert the Stripe pause when webhook retries are exhausted (dunning-v2.service.ts pauseBillingAtStripe); rule: sweep active marker rows and re-call pause_collection.
- New: LR_LOCKOUT_SCREEN (dunning-v2.copy.ts) still reuses card-update lockout copy; rule: dispute lockout text = access ended, billing paused, coach decides.
- New: copy in D1-D2b says "access has ended" for a dispute while the old compressed cycle code is still in place there; rule: FEATURE_DUNNING_V2 stays off until D2c merges (flag is off; stack lands together).

## Findings for B-DUNB-119 (D3/D4/D5, not touched)
- D4 runDisputeEffect must pass `closedAt: new Date(event.created * 1000)` to onDisputeClosed and the dispute id on created.
- Port the isDisputePaused entitlement guard into D4's applySubscriptionUpdated and invoice.paid code.
- D4 resolveDunningOnPaid / keepAsDisputeCycle stay compatible (marker-only).
- D5 specs asserting the compressed cycle need R-DISPUTE-PAUSE expectations.
- Expose the coach-owned POST restart endpoint in D4 wiring to restartAfterDisputePause.
- #689 is based on #688's branch: its displayed diff now includes #704/#705 until retargeted to #705's branch.

## Decisions for the operator (recommended default first)
1. Inquiries (warning_needs_response) pause too, per "any dispute". Default: yes.
2. A cycle already locked keeps its earlier lock instant. Default: yes.
3. Restart endpoint lands in D4 (service path here). Default: yes.

## HANDOFF
- In progress: waiting for final CI at all four heads, then FIX ROUND 3 (#687), FIX ROUND 4 (#688), OPENING + READY (#704, #705), notify file, lock release, cleanup.
