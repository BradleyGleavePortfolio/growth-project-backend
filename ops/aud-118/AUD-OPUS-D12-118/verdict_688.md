AUDIT Claude Opus 5.5 — growth-project-backend#688 @ b17f514ccd8da195d18588ca4b7ca407a789f20e — VERDICT: REQUEST CHANGES
A/B/C = 0/2/3

AUD-OPUS-D12-118 (agent 118 wave), T4 (money, access lock, dispute handling, client and coach copy). This lens's previous verdict on this PR: REQUEST CHANGES 0/1/4 @ `6627044c` (comment 5975919515).

**Scope.** D2's own diff against D1 `f8e47bf4` covers 5 files, 2,313+/613- = 2,926 lines (under the cap, 74 lines of headroom). Fix-round delta `6627044c..b17f514c`, D2 files: `dunning-v2.service.ts` (+135), `dunning.service.ts` (+14), `env-validation.ts`, and the new `test/dunning-v2-service-fixes.spec.ts`. The rest arrives through the merges of D1 (`41404998`, `7d7e7db4`, `f8e47bf4`). FIX ROUND 2's tree check holds: `git diff 6718d211 b17f514c` is exactly D1 `7d7e7db4..f8e47bf4` (emitter plus D1 spec), and D2 touches neither file. Every changed line was read, and every caller of the changed functions was traced: `tryLock`, `runSweep`, `markSweepChecked`, `hasOpenDisputeObligation`, `onDisputeClosed`, `recordDisputeObligation`, `applyImmediateClear`, `isDisputeCycleOpen`, v1 `recordFailure`.

**Prior findings from this lens.**
| ID | Decision | Evidence |
|---|---|---|
| B-688-1 lost dispute during a payment cycle | CLOSED | `09d4038f`: `hasOpenDisputeObligation` counts not-won terminal obligations closed at or after the cycle's `entered_at`, and `onDisputeClosed` not-won runs `keepAsDisputeCycle` under the row lock. This lens's 116 probe, replayed at this head, passes 5/5 (it was 2 fail / 3 pass at `6627044c`), and a new card-update control also passes: [run 37219161671](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219161671). Builder failing-before: [run 37173207695](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173207695). |
| C-688-2 v1 link default / env doc | CLOSED | `src/common/env-validation.ts:1026-1029`. The PR body names the link change, and the stack lands as one. |
| C-688-3 v1 `recordFailure` marker race | CLOSED | `6718d211`: the write is fenced on the `last_failure_reason` it read, and a P2025 (nothing written yet) retries once on a fresh read. Failing-before: [run 37173955536](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173955536). |
| C-688-4 sweep head-of-queue starvation | CLOSED | Closed with Sol B-688-2. The sweep selects due rows only (lock due, or a due step not yet claimed), ordered by `sweep_checked_at asc nulls first, entered_at asc`. A row the sweep cannot act on is stamped, fenced by id plus `entered_at`. The filter matches `dunningV2StepForElapsed` and `dunningV2LockoutAt`. |
| C-688-5 `formatMoney` zero-decimal | CLOSED | Delegates to `formatMinor`. |

**Evidence reuse (G09).** The other lens's verdict at this head was not read before this one was written. D2 lines unchanged since `6627044c` rest on this lens's audit at that head. The D1 parts merged here rest on this lens's #687 verdict at `f8e47bf4`, posted alongside this one. All fix-round lines were audited fresh. The token mapping in `buildDispatchContext` was re-read because of this job's copy-truth check, and that re-read produced B-688-7, which this lens missed at `6627044c`.

**CI at this head.** The 7 required checks that apply on a stacked base are green (build-and-test [run 37178687237](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178687237)). CodeQL, danger, banned casts and SBOM run only on main-based PRs and pass on #687.

### B-688-6 — Sol B-688-1 fix is incomplete: a stale Day-10 worker still locks a reopened cycle on its Day 0
- `src/checkout/dunning-v2/dunning-v2.service.ts:903-917`: the lock CAS fences `entered_at: row.entered_at`. That value is not a cycle version. When v1 `recordFailure` reopens a resolved row (`dunning.service.ts:211-214`), it sets `status 'active', step_index -1` and keeps the old `entered_at`. Only v1's create path sets it (`:270`). v2 stamps a new `entered_at` only when its Day-0 claim runs (`dunning-v2.service.ts:367-381`). That claim runs after v1, in its own transaction, in D4's webhook, and a failed claim leaves this shape until the next failure.
- Sequence:
  1. The sweep reads a Day-11 unlocked row.
  2. During that worker's Stripe await (or its walk through a 500-row page), the open invoice is paid (v1 `recordResolution`) and a new renewal fails (v1 reopen).
  3. The worker's transaction then sees an eligible `past_due` purchase and a row that still matches `{id, active, unlocked, not canceled, entered_at}`. It locks the new cycle on Day 0 with `step_index 3` and `entitlement_active=false`.
  4. The v2 Day-0 claim then fails: the row has `step_index 3`, and `advance` targets step 3. So the client is locked with no Day 0/1/3/7 notices until they pay. This breaks the Day-10 lockout ruling.
- Probe: branch `audit/AUD-OPUS-D12-118/688-probes` (this head plus the probe spec only; `db55871b`, `60d63785`, `9c1adac7`), `test/aud-opus-d12-118-688.probe.spec.ts` part 2. It uses the real v1 `recordResolution`/`recordFailure` inside the Stripe await. [Run 37219161671](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219161671):
  - Both controls pass: an ordinary Day-10 cycle locks, and the builder's case (v1 reopen and the v2 claim both inside the await) is not locked.
  - The shape check passes: v1 reopened the row with step -1 and kept `entered_at`.
  - Both probes fail: `locked` expected 0, received 1; the Day-0 claim after it expected `stepIndex 0`, received `undefined`.
- Fix rule: fence the lock on the cycle state the worker read. Add `step_index: row.step_index` to the CAS (as `advance` already does, `:410-420`), or re-read the DunningState under the row lock and require `step_index >= 0`, the same `entered_at`, and status active since the read. A legitimately concurrent step claim then just skips one tick. Verify: both part-2 probes pass and both controls still pass.

### B-688-7 — client and coach dunning notices render unresolved `{tokens}`
- `buildDispatchContext` (`dunning-v2.service.ts:1606-1617`, new in D2) supplies `cardLast4: customer?.default_card_last4 ?? undefined` and never supplies `reason`. `applyTokens` (main, `renderer.ts:85-90`) leaves an unknown token in the text.
  - `default_card_last4` is written only by the `customer.updated` handler and by D3's card update. Checkout saves the first card on the subscription (`stripe-connect-api.service.ts:438`, `save_default_payment_method=on_subscription`), so it is null for every client who has never updated their card, which is the normal first cycle. Both variants of the Day-1 client email then read "The card on file ends {cardLast4}." The Day-3 and Day-7 client push variants carry the same token.
  - Every Day-7 coach email (`COACH_EMAIL`, both variants) prints "declined ({reason})" four times.
- Probe: same branch, part 4. [Run 37219161671](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219161671) and [run 37219503806](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219503806), through the real service, dispatcher and renderer:
  - The control passes: with a stored card, the Day-1 email names `4242` and has no braces.
  - The probe fails: with no stored card, the body contains "The card on file ends {cardLast4}."
  - The probe fails: the Day-7 coach email contains "Day 0 — $150.00 — declined ({reason})" four times.
- Fix rule: no client or coach dunning surface renders an unresolved `{token}`.
  - Take the card from the payment method actually charged (the subscription default, or the failed invoice's PaymentIntent). If it is unknown, use a variant without the card clause.
  - Supply the retry history from real attempt data (amount and a safe decline category, never raw provider text), or render a variant without history. Never list an attempt that did not happen. On hard declines Stripe does not retry until a new card exists, so "four declines on Days 0/1/3/7" can be false.
  - Verify with a test that renders every copyKey on every surface, both variants, with `cardLast4` and `reason` absent, and asserts no `/\{\w+\}/`, plus the part-4 probes.

### C (follow-ups; not blocking)
- **C-688-8** `dunning-v2.service.ts:1287` / `:1344`: the not-won branch of `onDisputeClosed` converts any active cycle into the dispute cycle even when this dispute's obligation was already terminal and closed before the current cycle began. Example: a second `charge.dispute.closed` delivery, or a late reprocess. That is inconsistent with the `closed_at >= cycleStart` rule in `hasOpenDisputeObligation` (`:1253`). Event dedupe makes this unlikely. Fix: run `keepAsDisputeCycle` only when `upsertDisputeObligation` created the row or advanced it to terminal (`priorStatus` null or not terminal).
- **C-688-9** Lock order. `tryLock` now takes `DunningState FOR UPDATE` (`:903`) and then writes `ClientPurchase` (`:921-924`). Per `applyImmediateClear`'s own contract (`:944-949`), the invoice.paid transaction holds the `ClientPurchase` row lock before it writes `DunningState`. The orders are opposite, so Postgres aborts one transaction as a deadlock. Both are retried (Stripe redelivery, or the next hourly tick), but an aborted invoice.paid delays the unlock. The pre-existing CAS then purchase update had the same order; the window is now wider. Fix: in `tryLock`, lock the `ClientPurchase` row first (`SELECT ... FOR UPDATE`), then `DunningState`.
- **C-688-10** `dunning-v2.service.ts:1617`, the same lines as B-688-7: the coach email's "The full record is here: {dunningDetailDeeplink}" is `tgp://coach/clients/<id>`. Most mail clients do not link a custom scheme. Fix: use the https universal link (AASA is served by this backend).

### Verified (no finding)
- `tryLock`:
  - It re-reads the purchase under the row lock (eligible; `past_due`/`unpaid`, or not canceled on a dispute cycle). "Paid during the Stripe check" and "v2 claim during the await" are not locked.
  - A Stripe error still skips.
  - A cycle converted to a dispute cycle during the await is judged conservatively and locks on the next tick.
- `hasOpenDisputeObligation`:
  - With the ledger lost and the record still open (`closed_at` null), it counts (fail closed). Won or `warning_closed` never counts.
  - Every caller passes the cycle's `entered_at` (`applyImmediateClear`, `isDisputeCycleOpen`).
- `onDisputeClosed`:
  - A lost close that arrives before its created event converts the cycle. The later created event records `open`, which never moves a final status back, and returns `cycle_already_active`.
  - Not-in-favour beats won in both merge directions.
- `runSweep`:
  - A stamp is fenced to the same cycle. A reopened row (step -1) is excluded.
  - Rows that are acted on leave the due filter. Rows that keep skipping rotate behind null and older stamps. `nulls: 'first'` is valid on Prisma 6.19.
  - The new column is nullable, sits in the unapplied D1 migration and down.sql, and holds no user id.
- v1 `recordFailure`: the first write is the fenced update, so a P2025 retry repeats nothing. A second P2025 throws to the webhook, which Stripe redelivers.
- Logs and outbox:
  - Every changed catch logs `dunningErrorCode`, and `last_error` stores codes only (Sol B-688-4).
  - The remaining `err.message` logs in v1 `dunning.service.ts` (`:784`, `:930`, `:1159`, `:1186`) are main code outside this diff.

**Outside this PR (operator).** The D3 card-update path with an open obligation and no marker remains as reported by AUD-OPUS-D12-116 item 1. It belongs to the #689 lenses.

Head re-read right before posting: `b17f514ccd8da195d18588ca4b7ca407a789f20e`.
