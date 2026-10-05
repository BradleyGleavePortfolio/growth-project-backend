FIX ROUND 11 (B-F12-116, agent 116) — growth-project-backend#682 @ a5d6a434a9bd909699b158ac3791a09db25c241d

Round 11 on F2 against GPT-6.1 Sol [RC 0/2/1](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5975862467) and Claude Opus 5.5 [RC 0/2/1](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/682#issuecomment-5975947733), both at `007d3dcb`, plus the operator 116 additions from AUD-OPUS-F56-116 (first-person copy; C-685-2 log leak at `transfer-orchestrator.service.ts:896`). Commits on `007d3dcb`, fast-forward (no force):
1. `479873f4` merges F1 round 11 (`9de3135c`).
2. `461dc265` tests only (the failing-before head).
3. `a5d6a434` the fix.

| Finding | Change | Commit | Test (fails before, passes after) |
|---|---|---|---|
| B-682-1 (Sol and Opus): a reversal sender paused after its attempt write, or at the HTTP boundary, reversed again after a takeover and key expiry (800 at Stripe against a 400 receipt) | `drive()` now follows the transfer-send protocol. (1) Claim with a CAS `transferReversalOp.updateMany` on `(id, status pending, attempts, last_attempt_at)` as read. `attempts` only grows, by one per claim, so the claim cannot be replayed. (2) After the claim await, re-run the fence (`ChargeLockLostError` propagates) and re-read the op: still pending, same attempt, same `last_attempt_at`. (3) Start only inside the start budget (`TRANSFER_SEND_START_BUDGET_MS`, the larger of wall and monotonic age), checked again synchronously at the HTTP boundary through `reverseTransfer({ beforeSend })` (F1). A claim that is not started logs `SFEE_REVERSAL_SEND_ABANDONED` and stays pending with `attempts > 0`, so the next driver lists Stripe before any re-send. A lost or moved claim returns the recorded outcome, or `ReversalUncertainError` while the op is still pending. (4) A completion that loses its CAS to a receipt naming another Stripe reversal raises `SFEE_REVERSAL_DUPLICATE alert=true transfer= op= amount= status= recorded_stripe_reversal= also_at_stripe=` (ids and cents only). | `a5d6a434` (+ F1 `9de3135c`) | `test/s-fee-r11-reversal-admission-diagnostics.spec.ts` "B-682-1". (a) Sol's scenario: two real `ChargeLock`s, a pause after the attempt write, a takeover, key expiry, a resume. Stripe holds 400, the books 400, and A rejects with `ChargeLockLostError`. (b) The same without a lock: A sees the recorded op and sends nothing. (c) A pause at the HTTP boundary past the budget: nothing sent, `SFEE_REVERSAL_SEND_ABANDONED`. (d) A request already in flight past key expiry is detected by `SFEE_REVERSAL_DUPLICATE`. (e) Control: an ordinary reversal. Auditors: the probes' pause hook moves from `transferReversalOp.update` to the claim `updateMany` (the attempt write is now the CAS). |
| Sol B-682-2 = Opus C-682-4, plus C-685-2: free-text error messages in logs, `last_error`, refusal outcomes and errors | Every orchestrator sink now carries closed `moneyErrorDiagnostic` / `dbErrorKind` output and ids. Covered: definitive refusal (log, transfer `last_error`, ledger `last_error` through `markFailed`); uncertain create and lookup reasons; the not-visible line; receipt-pending; transfer and reversal listing failures; reversal refused (log, `last_error`, `outcome.error`, which F3 logs); reversal uncertain (log, `last_error`, `ReversalUncertainError` message). The `scheduleRecheck` catch (`:896`, reached when parking a claim after the lock is lost) now logs `SFEE_TRANSFER_RECHECK_UNSCHEDULED transfer=<id> error_kind=<kind>`. Messages still feed only the closed classifications (`transferFailureCode`, `/no such/`). Phrases pinned by later pieces are kept: `transfer lookup unavailable`, `reversal lookup unavailable`, every `SFEE_*` prefix, `park_error=<kind>`. `parkFailureKind` now delegates to the shared `dbErrorKind`. | `a5d6a434` | "B-682-2", 7 canary paths (message plus email plus body text): transfer refused (final), uncertain with listing down, not visible, receipt write fails, park write fails after the lock is lost, reversal refused, reversal uncertain with listing down. Each path asserts the canary is absent from logs, from every fake DB row, from the outcome and from the thrown message. Vocabulary unit test: unknown Stripe fields map to `other`/`none`. |
| Opus B-682-3 = Sol C-682-1, plus operator item 1: first-person payout notices | `payout-notice-copy.ts` rewritten impersonal with exact amounts kept; the 160-character limit holds. Strings, old -> new (#685 r5 pins the old ones, see below): | `a5d6a434` | "B-682-3": every event x role x 3 amount shapes has no `we/we'll/we've/us/our/ours`, no `!` and is at most 160 characters; the exact new sentences are pinned. |

| # | Where (src/connect/fees/payout-notice-copy.ts) | Old | New |
|---|---|---|---|
| 1 | heldSentence, any event, held_open_cents > 0 | `We will hold {held_open} from your next sale.` | `{held_open} is held from your next sale.` |
| 2 | refund / chargeback, coach, reversed_cents > 0 | ` We took {reversed} back from that sale's payout.` | ` {reversed} was taken back from that sale's payout.` |
| 3 | refund / chargeback, head coach, reversed_cents > 0 | ` We took {reversed} back from your share of that sale.` | ` {reversed} was taken back from your share of that sale.` |
| 4 | dispute_won, reinstated_cents > 0 | `We paid {reinstated} back to you` | `{reinstated} was paid back to you` |
| 5 | dispute_won, reinstated and released | ` ... and released the {released} hold.` | ` ... and the {released} hold was released.` |
| 6 | dispute_won, released only | ` We released the {released} hold.` | ` The {released} hold was released.` |

Unchanged (already impersonal): titles, `A client got {x} back.`, `A client's bank took back {x} in a dispute.`, `You won the dispute on a {x} charge.`, `Nothing is held from your next sale.`, the dispute_lost body, heldBreakdownLines labels.

#685 expectations a later #685 job must update (test/s-fee-r5-or-111-1.spec.ts; 7 tests red by design after this restack):
- :304 and :310 -> `A client got $100.00 back. $94.80 was taken back from that sale's payout. $5.20 is held from your next sale.`
- :401 -> `A client's bank took back $100.00 in a dispute. $94.80 was taken back from that sale's payout. $20.20 is held from your next sale.`
- :460 -> `A client got $100.00 back. $100.00 is held from your next sale.`
- :530 -> `You won the dispute on a $100.00 charge. $79.80 was paid back to you and the $20.20 hold was released. Nothing is held from your next sale.`
- :543 -> `A client got $40.00 back. $40.00 was taken back from that sale's payout. Nothing is held from your next sale.`
- :927 -> `$4.20 is held from your next sale.`
- :937, :962, :965 -> `$1.00 is held from your next sale.`

CI lane:
- Failing-before, at `461dc265`: [run 37173216866](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173216866/job/111350295701), 18 failed and 4 controls passed (ordinary reversal, F1 vocabulary, dispute_lost copy x2).
- Passing-after, at `a5d6a434` with `tsc --noEmit`: [run 37173243305](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173243305/job/111350375764), 49/49 across the new spec, `transfer-orchestrator.service.spec.ts`, `s-fee-r9-send-boundary.spec.ts` and the F1 specs.
- Composed-tree pre-check (this head merged through F3..F6, 29 fee suites locally): everything passes except the 7 copy-pinned tests in F5's `test/s-fee-r5-or-111-1.spec.ts`.

Later-piece compatibility, checked on the composed tree:
- F5 r4 "paused inside its Stripe call" still re-sends op1 under the same key (`[2000, 2000]`) and reverses once.
- F5 r4 receipt failure: still `pending` with `attempts: 1`, and it still throws `connection terminated`.
- r7, r8, r9 and sweep `SFEE_TRANSFER_*` prefixes and `last_error` shapes are unchanged.

Pre-push checklist:
- No free text in logs or persisted fields.
- Every await before a reversal send is followed by a fence and an op re-read.
- Pause and cancellation races are tested.
- Copy has no first person and no `!`, and never names a partner.
- Each finding has a failing-before test.
- Size: 2,951 changed lines (+2,836/-115) against F1, under 3,000.

Out of this PR's scope:
- F3 and F4 sinks that log `(err as Error).message` for their own DB errors are Sol B-683-3 and B-684-2.
- F4's `coach-payout-adjustment.hbs` ("We take it out of your next payout") and F4's `payout-notice.service.ts` ("We could not find") are Sol C-684-1.
- Both belong to the F3/F4 job.

Checks at `a5d6a434`:
- Every context except build-and-test passes. deploy-readiness-gate is skipped.
- build-and-test is red by design, unchanged from `007d3dcb`: [job 111353837189](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173697501/job/111353837189), attempt 2 after a known jest OOM in `diagnostic-quiz-off.spec.ts`.
  - Exactly 4 tests in 2 suites fail: `test/purchase-split-handler.service.spec.ts` (sub-coach "writes three ledger rows...", "is idempotent") and `test/checkout-webhook-fee-split.spec.ts` ("posts the head-coach transfer", "replay idempotent").
  - Cause: main's fakes have no `connectTransfer.updateMany`.
  - F4 #684 carries the updated specs, and they pass there (green at the F4 restack sha `392473a3` and on the local composed tree).
  - 12,333 tests pass.
- CodeQL, danger, banned casts and SBOM do not run on the stacked base. Banned casts was checked locally with `scripts/check-r75.js --mode=range`:
  - Round 11 (`007d3dcb..a5d6a434`) adds no banned token.
  - F2 as split (`5a19178d..007d3dcb`) already carries a net +1 `as any` at `test/transfer-orchestrator.service.spec.ts:103` (`[] as any[]`). This round leaves it alone, and the composed F1..F6 diff against main nets `as any` at -13.

READY FOR AUDIT
