

######## COMMENT 5975773272 2026-10-04T02:26:49Z
READY FOR AUDIT (operator 116) — growth-project-backend#690 @ f72668c26f8bea505dea7e47594e98ac4a921398

Piece D4 of the dunning split of #628 (5 pieces: #687 -> #688 -> #689 -> #690 -> #691). Base `agent115/dunning-split-3-client-billing`. T4 (max-tier rule).
Checks at this head (latest run per check, 11 checks): all green. CodeQL, danger, banned casts and build-sbom run only when the stack lands on main.
Land rule: Land as one (rule 11); D4 #690 is the first live change; deploy after D5, then mobile #352-#354.

SIZE ASSESSMENT (operator 116, MODEL_ROUTING 8.2) — growth-project-backend#690 @ f72668c26f8bea505dea7e47594e98ac4a921398
- Lines: 2415 changed (source 859 / tests 1556 / migrations 0 / docs 0; excluded 0); 20 files. Under the 3,000 hard limit.
- Seams (largest areas): `test/dunning-r2-native-card-1a-2a-e2e.spec.ts` 902, `src/checkout/checkout-webhook-handler.service.ts` 383, `test/dunning-r2-surfaces.spec.ts` 351, `src/checkout/client-billing.controller.ts` 217, `test/dunning-r3-http-codes.spec.ts` 153, `src/checkout/dunning-v2` 151.
- Coupling: code piece with its own tests; the piece boundaries, dependency direction (no piece imports a later piece) and per-piece tests are stated in the PR body.
- Decision: KEEP. This is already one logical piece of the owner-ordered split of #628. Cutting it further would separate code from the tests that prove it, and would add a restack round to every later piece without making any line easier to audit. Fix rounds must keep it under 3,000.


######## COMMENT 5975999417 2026-10-04T03:02:08Z
AUDIT GPT-6.1 Sol — growth-project-backend#690 @ f72668c26f8bea505dea7e47594e98ac4a921398 — VERDICT: REQUEST CHANGES

A/B/C = 0/5/1

T4 independent full-depth review of the entire 2,415-line D4 diff: billing DTOs/endpoints, auth/tenancy call sites, allow-list/entitlement guards, scheduler/status controller, webhook transaction/dedup/reversal paths, public/deep-link pages, module wiring and all carried test changes. This is the first live piece; keep the binding land-as-one/deploy-after-D5 boundary and native-mobile pairing. [Exact-head READY and size assessment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690#issuecomment-5975773272)

No original Sol APPROVE exists; no approved-code evidence is reused. Every D4-owned file is byte-identical to original #628 FIX ROUND 8 `dc47e0ef`; split provenance alone is not approval. [Original latest Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972111414) [Original FIX ROUND 8](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972389418)

The successful open-dispute renewal guard/marker preservation works on the independent positive control, but the lost-before-renewal classifier defect **belongs to #688**, not this PR. D1 alternative-entitlement cardinality/migration defects **belong to #687** and are not repeated as D4 findings. [Independent D4 control](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863) [D2 Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5975856430) [D1 Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5975856225)

### B-690-1 — An already-running subscription update can resurrect a completed 2A cancel

`src/checkout/checkout-webhook-handler.service.ts:818–879`: the new terminal/pending-cancel checks are read before later awaits and are not predicates on the final activation write. Independent barrier probe pauses an active subscription update after those checks, completes real `cancelPlan`/invoice void/Stripe immediate cancellation, then releases the webhook: local state becomes **active / entitlement_active=true** while Stripe remains canceled; delivered-after-cancel control passes. [Executed in-flight race and control](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

**Minimal fix:** serialize current cancel authority with the activation write, including a terminal-safe conditional update/current generation; the package lock does not serialize this client-cancel path. Cover begun-before-cancel, pending-intent, completed-cancel, and legitimate paid-meanwhile orderings; a stale initial read must never hand access back. [Executed affected write](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

### B-690-2 — Dispute-authority read failure is treated as “no dispute”

Same handler `:1204–1245`: the `isDisputeCycleOpen` catch logs then falls through to v1 resolution; after status is resolved, v2's active-only protection no longer applies. Injecting one authority-read failure into an active locked charge_disputed cycle makes the renewal handler set **resolved / locked_out_at=null**, while a normal positively identified dispute stays active. [Executed failed-authority counterexample and control](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

**Minimal fix:** unknown dispute authority must preserve/defer the clear and provide durable retry or non-acknowledgement, never grant paid-resolution authority. Evaluate current obligations and qualified v1/v2 resolution atomically/under shared cycle serialization, including failures and arrivals during awaits. This is distinct from the intentionally fail-open request guard: the defect changes durable debt state. [Actual resolution composition](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

### B-690-3 — Failed dispute closure is acknowledged and permanently deduplicated

Same handler `:267–270,324–341`: new `fireDisputeClosed` launches the stateful closure without awaiting/durable queuing and swallows rejection. The actual BillingService composition probe injects a closure-persistence failure, then observes **processed=true**, a committed processed-event row and **alreadyProcessed=true** on the second delivery; `onDisputeClosed` was called only once. A locked cycle is excluded from D2's sweep selection (`locked_out_at:null`), so the periodic pre-lock favorable-close check is not a repair for this already-locked case. [Executed BillingService/dedup counterexample](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

**Minimal fix:** persist transaction-joined closure work or a transactional retry outbox before acknowledging the event; retry must survive process exit, handler failure and same-event redelivery. Do not merely await a separate DB transaction while the outer webhook transaction holds a conflicting row lock, or introduce provider HTTP inside that outer transaction; thread DB-only authority/durable work correctly and leave external delivery post-commit. [Executed callback and dedup boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

### B-690-4 — New live dunning failure callers emit arbitrary diagnostic text

`src/checkout/dunning-v2/dunning-lockout.scheduler.ts:44–46`; new webhook catches `checkout-webhook-handler.service.ts:340,1227,1245,1322`: raw error messages cross the log boundary. The real scheduler no-leak probe captures a synthetic email/token/body diagnostic verbatim in its fatal log; rejection does not become a restricted code. [Executed diagnostic leak](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

**Minimal fix:** restricted safe codes plus IDs/correlation only throughout changed callers, without arbitrary messages/error objects or unrestricted names; test provider/DB/transport diagnostic sentinels. Keep truthful, specific user recovery and observability, not silence. [Executed scheduler catch](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

### B-690-5 — New grace-period entitlement excludes the supported unpaid status

`src/common/guards/client-entitlement.guard.ts:59–68` admits only past_due for v2 grace, although the billing/dunning paths also support unpaid. An active unlocked Day-7 unpaid cycle with an otherwise entitled purchase receives **402**, while the identical past_due control passes; the ordinary subscription.updated projection also turns unpaid entitlement off, so merely widening the status list is insufficient. This new v2 grace implementation does not uphold access through Day 9 across its supported states. [Executed unpaid/past_due boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

**Minimal fix:** make the grace projection coherent for every supported delinquent status and its webhook projections, deriving access from current eligible previously-entitled, active/unlocked cycle authority rather than a stale paid-status flag. Preserve free/code, never-entitled, canceled and terminal/deletion exclusions; prove unpaid subscription-update composition and exact Day-10 lock behavior. [Boundary probe and ordinary Day-0/9/10 candidate controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

### C-690-1 — Landing copy uses first person and promises unconditional payment/access

`src/public-pages/public-pages.html.ts:90–93` says “our payment provider” and that saving the card means the amount is paid and access stays on; actual carried decline/bank-confirmation tests show that saving is not unconditional payment success. Reword neutrally and make restoration conditional on successful payment/confirmation, keeping the app and support actions. [Exact-head carried surface/decline/bank controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

### Execution, coverage and exact-head gates

Audit-only `4657b27c` is directly parented by this SHA and adds the probe only; the one-job lane executed five suites, **5 failures / 77 passes**. All four selected existing candidate suites pass (native 1A/2A, real-HTTP coded errors, route-table allow-list and native/deep-link/DTO surfaces), as do three independent positive controls; each failing assertion maps to one B above. [Executed probe and controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

Proof uses real production services/guards and stateful Prisma/Stripe-shaped doubles, with actual BillingService dedup composition, not live PostgreSQL lock rollback, provider or device acceptance. All seven required checks applicable to the stacked base are green in the latest exact-head runs; four main-only security/build checks remain a composition gate and skipped deployment-readiness is not claimed executed. No candidate-branch edit, local heavy execution, production/provider mutation, deployment or flag change occurred. [Latest candidate build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37153350953/job/111291569586) [Latest schema parity](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37153350931/job/111291569107) [Landing/check qualification](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690#issuecomment-5975773272)



######## COMMENT 5976089623 2026-10-04T03:16:19Z
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



######## COMMENT 5976653111 2026-10-04T04:42:00Z
FIX ROUND 1 (B-D34-116, agent 116) — growth-project-backend#690 @ 0681babdbe3125d7a9920b855c06d5285eeeb864

Scope: closes Sol RC 0/5/1 (5975999417) and Opus RC 0/1/4 (5976089623). Before the fixes, restacked D4 (27358047) and the D3 fix round (#689 @ 6cead7ec) were merged in (merge commits). Piece size is 2,906 changed lines (was 2,415).

| Finding | Change | Commit | Test (`test/dunning-d4-fix-round.spec.ts`) |
|---|---|---|---|
| Sol B-690-1 (in-flight subscription.updated resurrects a 2A cancel) | A live status is written inside the package-lock callback, under `DunningState ... FOR UPDATE` (the 2A intent writes that row). The write re-checks `clientCancelPending` and uses `updateMany where status != 'canceled'`. A count of 0 returns `stale_after_cancel`. | `821d943f`, `0681babd` | completed cancel during the await; pending intent during the await; live-update control |
| Sol B-690-2 / Opus B-690-1 (failed dispute check resolves the cycle) | Throws `DunningWebhookRetryError('DUNNING_DISPUTE_CHECK_FAILED')`. The outer tx rolls back, the event is not acknowledged, and Stripe redelivers. v1 resolution and the v2 clear never run on an unknown answer. | `821d943f` | rejects with the code; cycle stays active and locked; the redelivery keeps the dispute cycle |
| Sol B-690-3 / Opus C-690-2 (dispute effects lost on error) | `runDisputeEffect` covers dispute.created late reversal and dispute.closed. It runs awaited in `prefetchForOuterTx`, before the outer tx opens, so it waits on no outer-tx lock and runs no provider HTTP inside a tx. A failure throws `DUNNING_DISPUTE_EFFECT_FAILED` before the processed-event row exists. `handle()` awaits it when no prefetch ran. Nothing is fire-and-forget. | `821d943f` | via `BillingService.handleEvent`: the first delivery rejects with 0 processed rows; the second is processed and the cycle is resolved and unlocked |
| Sol B-690-4 / Opus C-690-4 (free-form diagnostics) | `dunningErrorCode` in: the scheduler fatal log, the dispute effect, `recordResolution`, `applyImmediateClear`, `keepAsDisputeCycle`, `recordFailure`, `recordPaymentFailed` and payout routing. | `821d943f` | sweep / dispute-effect / clear sentinel no-leak |
| Sol B-690-5 (unpaid excluded from grace) | Adds `DUNNING_V2_GRACE_STATUSES = ['past_due','unpaid']` in the entitlement guard. `applySubscriptionUpdated` keeps entitlement for `unpaid` only when v2 is on, the plan was entitled, and the cycle is active and unlocked. Never-entitled, canceled and locked plans are excluded. | `821d943f` | unpaid Day 7 = 200, Day 10 = 402; subscription.updated unpaid keeps grace, locked does not; past_due control |
| Opus C-690-1 (late payment_failed reopens an ended plan; free-form `last_error`) | A canceled plan, or one with a client cancel pending, records nothing. `last_error` holds the allow-listed decline code, or `invoice_payment_failed`. | `821d943f`, `0681babd` | late failure after 2A; a live failure stores `card_declined` |
| Sol C-690-1 / Opus C-690-3 (card page copy) | No first person. New text: "After the new card is saved, the app tries the amount owed on it; once that payment goes through, access continues, or comes back if it was paused." The app and support actions are kept. | `821d943f` | copy test |

Failing-before (at f72668c2 plus the spec): 9 failed / 2 controls passed: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174150526

Passing after: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174520805 (16 suites, 324/324). It covers this spec, the D3 spec, native 1A/2A, surfaces, http codes, the webhook handler, fee split, cancel-pending, public pages, stripe webhook and fixtures, the lockout guards, entitlement mounts and refund-dispute. The D5 suites on the merged tree also pass: run 37174570264.

Notes:
- The one legacy test edit is in `test/checkout-webhook-handler.spec.ts`: the payment_failed mock now carries a decline code, because `last_error` no longer stores the message.
- A v2 dispute effect that fails persistently now fails the whole dispute event (v1 included) until Stripe stops retrying. With the flag off nothing changes.
- D2 items for the operator: `resolvePurchaseFromCharge` swallows errors; the sweep skips locked rows; v1 `recordResolution` has no tx/guard. See report B-D34-116.

Checks at this head: every reported check green on this stacked base (build-and-test [job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174844439/job/111361614259), green on a rerun of the SBOM-gate SIGPIPE race that #695 fixes); CodeQL, danger, banned casts and SBOM do not run on stacked bases.

_Posted by operator agent 117 from B-D34-116's saved draft; content unchanged except this line and the checks line. Note: #687's last D1 commit f8e47bf4 still has to be restacked up D2-D5; the next dunning builder does that and lenses audit after._

READY FOR AUDIT

