

######## COMMENT 5975772994 2026-10-04T02:26:47Z
READY FOR AUDIT (operator 116) — growth-project-backend#689 @ 9e77159a710fe9022fd8016374f1fd9067337b0f

Piece D3 of the dunning split of #628 (5 pieces: #687 -> #688 -> #689 -> #690 -> #691). Base `agent115/dunning-split-2-dunning-service`. T4 (max-tier rule).
Checks at this head (latest run per check, 11 checks): all green. CodeQL, danger, banned casts and build-sbom run only when the stack lands on main.
Land rule: Land as one (rule 11); D4 #690 is the first live change; deploy after D5, then mobile #352-#354.

SIZE ASSESSMENT (operator 116, MODEL_ROUTING 8.2) — growth-project-backend#689 @ 9e77159a710fe9022fd8016374f1fd9067337b0f
- Lines: 2462 changed (source 2462 / tests 0 / migrations 0 / docs 0; excluded 0); 2 files. Under the 3,000 hard limit.
- Seams (largest areas): `src/checkout/client-billing.service.ts` 2414, `src/checkout/client-billing.reconciler.ts` 48.
- Coupling: code piece with its own tests; the piece boundaries, dependency direction (no piece imports a later piece) and per-piece tests are stated in the PR body.
- Decision: KEEP. This is already one logical piece of the owner-ordered split of #628. Cutting it further would separate code from the tests that prove it, and would add a restack round to every later piece without making any line easier to audit. Fix rounds must keep it under 3,000.


######## COMMENT 5975999246 2026-10-04T03:02:06Z
AUDIT GPT-6.1 Sol — growth-project-backend#689 @ 9e77159a710fe9022fd8016374f1fd9067337b0f — VERDICT: REQUEST CHANGES

A/B/C = 0/4/0

T4, independent full-depth review of all 2,462 D3 source lines, reconciliation, operation journaling/fencing, customer/SetupIntent authorization and the D4 consumption boundary; under the 3,000-line cap and operator KEEP assessment. D3 is inert until D4, and its committed acceptance suites arrive in D4/D5: the binding land-as-one/deploy-after-D5 rule remains mandatory. [Exact-head READY and assessment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689#issuecomment-5975772994)

### Prior findings and evidence applicability

The last original Sol verdict was REQUEST CHANGES, not APPROVE; no approved-code evidence is reused. Both D3 files are byte-identical to original FIX ROUND 8 `dc47e0ef`, establishing provenance, not approval. [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972111414) [Original FIX ROUND 8](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972389418)

**B-628-11's reported unreplayed-400 subtype closes:** `replayPay:962–966` now requires the operation-bound replay header; independent foreground and background probes retain the original intent and open operation through an unrecognized unreplayed 400, then recover exactly 15,000 cents on an authoritative replay. The existing FIX ROUND 8 failing-before evidence applies to this unchanged split implementation; the new initial-pay attribution defect below is a different boundary, not a claim that these closure controls failed. [Original failing-before run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144731263) [Exact-D3 independent passing closure controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172495586)

The separately reported first-call 429 and 409 changes are correct on the independent controls: 429 with another collector's payment reports already_paid/zero credited; 409 remains uncertain and never says nothing was charged. [Exact-D3 controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172495586)

### B-689-1 — Card update bypasses the obligation-aware dispute guard through v1 resolution

`src/checkout/client-billing.service.ts:315–316,422,581,728–734,830,1091–1118,1934–1935`: D3 bases dispute protection on an initial marker-only snapshot, while its actual restoration path calls v1 `recordResolution` regardless of v2 refusing `applyImmediateClear`. With an open recorded dispute during an ordinary decline-marked cycle, v2 correctly reports `isDisputeCycleOpen=true`, but a successful card update still turns the cycle **resolved**; a dispute arriving during the pay await produces the same result. Both real-service assertions fail, while the already-marked dispute control passes. [Executed two-interleaving counterexamples](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172495586)

**Minimal fix:** revalidate current obligation/cycle authority under consistent serialization for the final restore and BOTH v1/v2 resolution paths; quote, response, replay and background reconciliation must use the same obligation-aware rule, not the initial marker. Preserve open/unfavorably settled obligations until authorized favorable settlement, and test arrival during provider await plus the same background path. The lost-before-renewal terminal-status classifier **belongs to #688**, not a finding against D3; this D3 defect is independently proved with a still-open obligation that D2 already recognizes correctly. [D3 proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172495586) [D2 finding ownership](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5975856430)

### B-689-2 — New billing failure diagnostics disclose arbitrary text to logs

Service `:755–757,1085–1087,1110,1839,2307,2335,2356,2367` and `client-billing.reconciler.ts:41–42` interpolate provider/DB/transport messages directly. A synthetic provider error containing an email, token-shaped string and message body is captured verbatim by the real billing logger; the no-leak assertion fails. These are synthetic inputs, not customer data. [Executed diagnostic boundary](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172495586)

**Minimal fix:** emit only restricted error codes, relevant IDs and short correlation references across every new catch; never arbitrary messages, error objects or unrestricted names in logs/Sentry. Add provider, DB and transport synthetic no-leak controls while preserving specific client-facing recovery instructions. [Affected executed failure handler](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172495586)

### B-689-3 — An initial unknown pay result wrongly credits another collector's payment

`client-billing.service.ts:1007–1022`: a transport error or 5xx plus a paid invoice is treated as this update's successful collection without operation-authoritative evidence. Independent probe: the app's pay never executes, another Stripe retry collects 15,000 cents during the await, then the app receives a synthetic upstream 503; D3 returns **paid**, credits the retry to this card-update line and terminalizes the operation instead of preserving uncertainty for same-key reconciliation. This is not a double-charge claim; it is incorrect durable attribution. [Executed initial-pay counterexample](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172632594)

**Minimal fix:** a paid invoice proves invoice settlement, not which operation collected it; retain the uncertain journal until an operation-bound receipt/same-key replay establishes attribution, keeping safe key-window admission. Preserve actual own-pay lost-reply recovery and another-collector controls; do not relabel every lost response already_paid/zero either. [Existing replay contract and new initial-call proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172632594)

### B-689-4 — Dispute-only dunning cancel incorrectly becomes period-end cancellation

`client-billing.service.ts:1482–1485,1565–1567,1597–1600,1614–1670`: a paid invoice status is accepted as proof that the current debt disappeared, without considering the reversal obligation. A locked dispute-only cycle with an outstanding recorded dispute, no open invoice and an apparently paid latest invoice returns **scheduled**, leaves Stripe uncanceled and re-enables local entitlement rather than applying immediate 2A; the invoice's paid flag does not settle the recorded reversal. [Executed cancellation counterexample](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172632594)

**Minimal fix:** distinguish genuine paid-meanwhile recovery from unresolved dispute debt when selecting the option-A fallback; cancel the dispute-only dunning plan/access now without claiming the reversed payment was settled. Retain the existing legitimate retry-paid period-keeping behavior and cover open/lost obligations as well as ordinary voluntary cancellation. [Counterexample](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172632594) [Existing paid-meanwhile and voluntary controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172556863)

### Execution and exact-head checks

Audit-only commit `d188d499` directly parents from this candidate and adds the probe only: **3 failures / 5 passes**; supplemental `3c3639b2` adds two newly identified cases, selected run **2 failures / 8 intentionally unselected tests**. These runs use actual production services and stateful Prisma/Stripe-shaped doubles, not live Postgres locking, provider or device acceptance. [First probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172495586) [Supplemental probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172632594)

All seven required checks applicable on the stacked base are green at this SHA; CodeQL, danger, banned-cast and SBOM main-only checks remain required on the landing composition, and skipped production deploy-readiness is not claimed executed. No candidate-branch edit, local heavy execution, production/provider mutation, flag change or deployment occurred. [Exact-head candidate build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37152164026/job/111288097610) [Landing/check qualification](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689#issuecomment-5975772994)



######## COMMENT 5976089521 2026-10-04T03:16:18Z
AUDIT Claude Opus 5.5 — growth-project-backend#689 @ 9e77159a710fe9022fd8016374f1fd9067337b0f — VERDICT: REQUEST CHANGES
A/B/C = 0/2/2

Job AUD-OPUS-D34-116, tier T4, full-depth read of D3 (src/checkout/client-billing.service.ts, src/checkout/client-billing.reconciler.ts) and the D1/D2 helpers it calls (DunningV2Service.applyImmediateClear / isDisputeCycleOpen / keepAsDisputeCycle / hasOpenDisputeObligation / handleLateReversal / tryLock, v1 DunningService.recordFailure / recordResolution).

Evidence reuse: every D3 file is byte-identical to #628 @ dc47e0ef (FIX ROUND 8, never audited by this lens). This lens's last verdict on that code was REQUEST CHANGES 0/1/2 @ 33e0696a (B-628-13). Nothing from the earlier APPROVE @ 739e9a54 is reused: client-billing.service.ts changed by +485 lines since then, so it was re-read in full at this head.

Probe: branch `audit/AUD-OPUS-D34-116/689-dispute-paths` = this head plus one probe spec (`test/audit-opus-d34-689-dispute-paths.probe.spec.ts`, D1-D3 code only, no D4 wiring needed). Run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172931700 : control C1 passes, P1 / P1b / P2 fail as predicted (first run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172705037 had the same result).

## B-689-1 — a card update settles an open dispute; the Day-10 lock lifts (B-628-13 is still open on the card-update path)
- Where: `src/checkout/client-billing.service.ts:315-317` (`isDisputeCycle` only checks the marker `last_failure_reason === 'charge_disputed'`). That marker-only check makes four decisions: `:422` (the quote's `disputes` list), `:581` (payPlan `dispute_open`), `:830` (the replay path) and `:1934` (reconcileCardOperation). After payment, `:727-733` calls `restoreAfterPayment`. Inside it, `:1104` `applyImmediateClear` correctly refuses, because the obligation guard sees the open dispute. Then `:1113-1121` runs v1 `dunning.recordResolution` regardless, and that call resolves any active row (dunning.service.ts, recordResolution).
- Counterexample (probe P1): the Day 0 renewal fails. A Day 2 dispute arrives during that payment cycle, and `handleLateReversal` returns `cycle_already_active`. The obligation is recorded, but the marker stays as the decline text. D2's durable predicate `isDisputeCycleOpen` then returns true. The Day-10 sweep locks. On Day 11 the client saves a card in the app and the renewal is paid. Observed: `{"quote_disputes":0,"plan_dispute_open":false,"plan_access":"restored","state_status":"resolved","still_locked":false,"dispute_cycle_open":false,"message":"Your card ending 4242 is saved. $150.00 went through. Your plan is active again."}`. The dispute is still open and was never settled, yet the cycle is resolved, the lock is lifted, and the app is told nothing about the dispute. The D4 webhook path (`resolveDunningOnPaid`, FIX ROUND 8) keeps the same cycle open in the same situation, so the two payment paths now disagree.
- Operator lead (D12 B-688-1, "dispute closes lost before the renewal is paid") confirmed on this path as probe P1b: the dispute closes `lost` on Day 5, the lock lands on Day 10, and the Day 11 card update gives `{"plan_dispute_open":false,"state_status":"resolved","still_locked":false}`. The reason a `lost` obligation counts as closed is the D2 predicate, which belongs to #688. The reason the card update ignores the obligation at all is in this PR.
- Minimal fix rule: D3 decides "dispute open" from durable state only. Use `dunningV2.isDisputeCycleOpen(purchase.id, db)` (active row plus the marker or an open obligation) at `:422`, `:581`, `:830` and `:1934`. A card payment that settles the payment part of a cycle with an open dispute calls `dunningV2.keepAsDisputeCycle` and never calls v1 `recordResolution`. Put the same guard inside `restoreAfterPayment`, because `:1934` reaches it directly. If the predicate read fails, fail closed: do not resolve, and leave the cycle for the webhook or reconciler. Because the fix goes through the D2 helper, the #688 `lost` fix then applies here automatically.
- How to verify: P1 passes at the fix head. P1b passes once #688 B-688-5 / B-688-1 also lands. C1 still passes. Add a failing-before test for the card update and for the reconciler (`reconcileCardOperation` with a dispute obligation and a paid line), with run URLs.

## B-689-2 — "End my plan" during a dispute cycle settles the dispute, keeps the disputed period and states the payment went through
- Where: `runDunningCancel`. It finds no open invoice, and `latestPeriodState` (`:1580-1607`) reads the disputed invoice as `paid`, so it calls `keepPaidPeriod` (`:1614-1671`). That function does three things. At `:1630` it restores `status`/`entitlement_active: true` for a delinquent purchase. At `:1649` `applyImmediateClear('retry')` correctly refuses. At `:1657-1665` v1 `recordResolution` resolves the dispute cycle anyway. The result goes through `scheduledResult(..., true)` (`:1441`), which returns "Your latest payment went through before your plan ended, so you keep the period you paid for." The out-of-band 2A sweep in `reconcile` (`:1843-1865`) reaches the same code when cancel-at-period-end is set outside the app.
- Counterexample (probe P2): the renewal fails, Stripe's retry pays it, and the cycle resolves. On Day 12 the client disputes that payment, which opens a compressed dispute cycle. On Day 13 the client taps End my plan. Observed: `{"outcome":"scheduled","paid_period_kept":true,"says_payment_went_through":true,"state_status":"resolved","dispute_cycle_open":false,"locked_on_dispute_day":0,"entitlement_active":true,"access_expires_at":"2026-11-04T16:00:00.000Z","message":"Your latest payment went through before your plan ended, so you keep the period you paid for. ..."}`. The client keeps a full period whose payment the bank reversed, the Day-19 dispute lock never happens, and the copy is untrue. Reading `:1630` gives one more case, not probed: a client already locked on the dispute timeline who taps cancel gets entitlement back.
- Minimal fix rule: a cancel never resolves a dispute cycle and never reports a disputed period as paid. When the D2 predicate says a dispute is open, `runDunningCancel` must not take `keepPaidPeriod`. Two options; operator decision, recommended default (a):
  - (a) 2A: end access now. Cancel the subscription now; there is nothing to void. The state becomes abandoned and the copy is truthful about the open dispute.
  - (b) Schedule the period-end cancel but keep the dispute cycle. That means no v1 resolution, no entitlement restore and an unchanged lock timeline. The out-of-band sweep must not then pick the row up again every tick.
- How to verify: P2 passes at the fix head. Add a failing-before test for cancel during a dispute cycle, both before and after the lock, plus the out-of-band variant.

## C-689-1 — free-form error text in logs
- Where: `client-billing.service.ts:756, 1086, 1110, 1118, 1588, 1603, 1662, 1691, 1839, 1861, 1898, 2165, 2298, 2307`. Each logs `(err as Error).message`. `:2335` also logs the Stripe error message. These are the same class as #688 B-688-4: the logging rule allows ids and codes only.
- Fix rule: log `err.name` or the Stripe code / http status through the same safe error-label helper chosen for B-688-4. Verify: grep shows no `.message` in the log lines of these files.

## C-689-2 — reconciler fairness
- Where: `:1811-1815` processes `take: 100` ordered by `updated_at asc`. An operation that throws before any write keeps the oldest `updated_at`, so more than 100 permanently failing operations (for example a subscription Stripe answers 404 for) starve every newer one. The out-of-band query at `:1844-1852` (`take: 100`) has no order.
- Fix rule: bump `updated_at` (or an attempt counter with backoff) on every failed attempt, and order the out-of-band query. Verify: a test with 101 failing operations plus one healthy operation finishes the healthy one.

## Prior findings decided for code in this PR
- B-628-13 (this lens): webhook path closed in #690. Card-update path NOT closed; it continues as B-689-1.
- B-628-11: CLOSED. `replayPay` (`:945-976`) settles `already_paid` only on an `idempotentReplayed` 402 or 400 `invalid_request_error`. An unreplayed 400 stays unknown. The replay header is read in D1 `stripe-connect-api.service.ts:1153-1167`. Never over-credits; the tests are in #691 (FIX ROUND 8 failing-before run 37144731263).
- C-628-14: CLOSED. In `payOne` (`:1016-1022`), a 429 on an invoice that is already paid returns `already_paid`; a lost reply applies only to non-Stripe errors or 5xx.
- C-628-15: CLOSED. A 409 returns uncertain with `PAYMENT_RESULT_UNKNOWN` (`:1016-1018`, `:1046`).

## Belongs to other PRs (not findings here)
- #688: a `lost` obligation counts as terminal in `hasOpenDisputeObligation` (DISPUTE_TERMINAL_STATUSES), so B-688-5 / Opus D12 B-688-1 also feeds P1b. The free-form log class is B-688-4.

Verified with no finding: lease CAS, renew and fencing on every write; pay-intent journaled before pay; the approved amount, currency and invoice set is enforced; tenancy (SetupIntent customer plus metadata owner, purchase owner); 1A unlock on the non-dispute path (C1); 2A void-before-cancel ordering; integer cents; copy in this file has no first person, no exclamation marks and no emojis.



######## COMMENT 5976301258 2026-10-04T03:51:23Z
FIX ROUND 1 (B-D34-116, agent 116) — growth-project-backend#689 @ 6cead7ec88e2ba17aa6418cf2636874a024bdf4a

Scope: closes Sol RC 0/4/0 (5975999246) and Opus RC 0/2/2 (5976089521). The latest #688 (6718d211) was merged in first (merge commit, no rebase). Piece size is 2,913 changed lines (was 2,462).

| Finding | Change | Commit | Test (`test/dunning-d3-fix-round.spec.ts`) |
|---|---|---|---|
| Sol B-689-1 / Opus B-689-1 (card update settles an open dispute, lock lifts) | `disputeOpen()` is the marker or D2 `isDisputeCycleOpen`. It is used in the quote, `payPlan`, `replayPlan` and `reconcileCardOperation`. `restoreAfterPayment` re-decides after the pay, inside the money tx, under `DunningState ... FOR UPDATE` (`settleCycleOnPaid`, the same lock D2 dispute recording takes). A disputed cycle gets `keepAsDisputeCycle`, with no `applyImmediateClear` and no v1. v1 `recordResolution` runs only when the locked check cleared the cycle, and a failed check resolves nothing. `keepPaidPeriod` uses the same rule. | `67096788` | obligation-only cycle; dispute recorded mid-pay; background reconcile; failed authority read; no-dispute control |
| Opus P1b (dispute closed lost before the renewal) | Decided by D2's predicate. It passes only with #688 B-688-5, which is merged here. | `2edc9826` | "a dispute that closed lost during the cycle still blocks the card update" |
| Sol B-689-2 / Opus C-689-1 (free-form diagnostics) | Every log line uses `dunningErrorCode(err)` (the D1 closed vocabulary). This includes the reconciler fatal log. | `67096788` | sentinel no-leak across Stripe 503, transport, TypeError and reconciler |
| Sol B-689-3 (paid invoice credited without attribution) | A lost reply on a paid invoice triggers an immediate same-key replay. A replayed paid result is paid; a definitive refusal is `already_paid` (0). Anything else is `uncertain`, and the op stays open for the reconciler. | `67096788` | Stripe retry paid during the await -> uncertain -> reconcile `already_paid` 0; own lost reply credited (control) |
| Sol B-689-4 / Opus B-689-2 (cancel during a dispute keeps the period, resolves the dispute) | Operator ruling: with a dispute open, `runDunningCancel` never takes option A; it takes 2A (end now). The cycle ends abandoned, never resolved. The reply adds: "Ending the plan does not settle the payment your bank reversed; contact support at ... to sort it out." Nothing claims that a payment went through. | `67096788` | latest invoice paid; before the lock / after the lock / set outside the app (reconcile); option-A control |
| Opus C-689-2 (reconciler starvation) | A failed or orphaned op is moved to the back of the queue (`updated_at` bump, settle window again). The out-of-band 2A page is ordered and bumped on failure. | `4f477b21` | 100 failing ops + 1 healthy op: the healthy one finishes |
| copy | A dispute-only plan no longer says "access is still updating". | `67096788` | asserted in the first case |

Failing-before runs (at 9e77159a plus the spec):
- First set: 7 failed / 3 controls passed: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173650946
- Full set: 12 failed / 3 controls passed: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174160085

Passing after: https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174229442 (D3 spec plus the D2 service, foundation and fix suites, 75/75). The D4/D5 suites on top also pass: runs 37174520805 and 37174570264.

Left for the operator (code in #688, see report B-D34-116):
- v1 `recordResolution` has no tx or dispute guard, so a dispute recorded in the milliseconds between the locked check and v1 still lands on a resolved cycle.
- `resolvePurchaseFromCharge` swallows errors.

Checks at this head: all applicable checks green. CodeQL, danger, banned casts and SBOM do not run on stacked bases.

READY FOR AUDIT

