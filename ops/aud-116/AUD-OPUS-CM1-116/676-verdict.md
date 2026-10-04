AUDIT Claude Opus 5.5 — growth-project-backend#676 @ 564f33bf1469e483a253df29ecaac750c5c43a22 — VERDICT: REQUEST CHANGES

A/B/C = 0/2/1 (C-641-2 is carried on top and not counted)

Lens AUD-OPUS-CM1-116, T4 (money). This is piece M3 of #641. Every line of the piece diff `9a512028..564f33bf` (16 files) was read.

**IDs:** this verdict uses the Sol lens's IDs at this head for the same defects (B-676-1, B-676-2).
- Both lenses report them. Both were re-derived and re-proved here from source and this lens's own probe; nothing is taken over from the other verdict.
- B-676-1 was not found by this lens's first pass. Its fb29fb9e APPROVE (below) missed it.

**Evidence reuse (G09), and where it stops**
This piece is byte-identical to #641 @ `fb29fb9e`, which this lens APPROVED in [5964726454](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/641#issuecomment-5964726454), apart from three changes listed below. The identical files are:
- `src/coach-money/*`;
- `connect-onboarding-return.controller.ts`, the `connect.module.ts` registration and `coach-connect.controller.ts`;
- `coach-connect.service.ts`, except `payoutReason`;
- the Connect docs and env lines;
- `test/coach-money-production-writes.spec.ts`, `test/support/money-read-double.ts`, and the coach-connect and talent-marketplace spec hunks.

How it was checked:
- `git diff fb29fb9e 564f33bf -- <those paths>` touches only three things:
  - `payoutReason` with its spec (audited line by line);
  - main-merged .env.example lines;
  - the `EngagementModule` import.
- `merge-tree(f60ed603, d23fa317)` equals this head plus the #675 and #677 files.
- Main moved from 2e3094b9 to d23fa317 after that approve's base, and that range changes no payment model.

The reuse covers:
- guards and tenancy;
- currency scoping;
- lifetime totals;
- the onboarding landings.

It does **not** cover event-level window cents. A fresh real-writer probe disproves those at this head (B-676-1). This verdict supersedes the fb29fb9e approval on that point.

**Prior findings from this lens**
- **C-641-13 (own):** OPEN, still C. It is now C-676-2.
- **C-641-2:** carried (Sol tracks it as C-676-1).
- The #674 defects (B-674-2/3/4, B-641-12) belong to #674 and are not counted here (guide rule 9).

**Piece boundary: OK**
- The base is #674. Every check that runs on a stacked base is green.
- Imports go only to main or #674 code. #677 adds only `test/coach-money.service.spec.ts`, and nothing here imports it.
- There is no migration.
- The CoachMoneyService unit spec arrives in #677. That is acceptable only because rule 11 lands #674 -> #676 -> #677 as one.

**What goes live on deploy: OK**
- `/v1/coach/money/*`:
  - Guarded by `JwtAuthGuard`, `CoachOrOwnerGuard`, `NoActiveSubCoachGuard` and `@Roles('coach','owner')`.
  - Every handler reads `req.user.id`.
  - It is read-only.
- `POST /coach/connect/status/refresh` is throttled at 12 per minute.
- The two public HTTPS landings redirect to a fixed `tgp://` target and read or echo no input.

### B-676-1 — a later partial refund rewrites cents already reported for an earlier window, and its tax CSV
**Where:** `allocateReversal` (coach-money.service.ts:408-445) re-splits a slice's **cumulative** `reversed_cents` across all of its refund and lost-dispute events, in proportion to the client refund amounts, with the newest event taking the remainder. `reversedInWindow` (:449) and the folds and CSV read that split.

The writer instead posts each event as `floor(slice.amount * refund / purchase.amount)`, capped (`applyLedgerReversal`). The two disagree per event, and every new event moves cents between dates that have already been reported.

**Counterexample** (red: [ci-lane run 37172376221](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172376221))
The real RefundDisputeHandlerService and SplitLedgerService write the ledger; the real CoachMoneyService reads it.
- Setup: a 4900-cent sale with a 4802-cent destination slice.
- Refund 1 (99 cents, 40 days ago): the writer posts **97**, and the first window reports **97**.
- Refund 2 (101 cents, 5 days ago): the writer posts **98**, and the ledger total is 195 (correct).
- After refund 2:
  - The first window reports **96**. The cent moved after the fact.
  - The current window reports **99**, not 98.
  - The first window's CSV export is no longer the file the coach already downloaded.

**Probe source:** `test/audit-cm1-676-window-cents.spec.ts`.
- Its commit is `efdd3c6e0618ec5ed31a000ecc38ddd55cdff23d` on top of this head. The lane commit is `c663a942`, and the lane branch is deleted when this job ends.

**Fix rule:** each event's reported cents must equal what the writer posted for that event, and must never change afterwards. Two ways:
- Persist per-event reversal postings at write time (slice, event, cents, at). This is the durable option, and it also makes #674's ledger auditable.
- Or replay the writer's exact arithmetic in event order through **one shared pure function** that both `applyLedgerReversal` and the reader call, so the two cannot drift. Keep the proportional split only as a flagged fallback for slices whose replay total differs from `reversed_cents`.

**Verify:**
- The probe passes unchanged (97/97/97/98/98, CSV unchanged).
- Add cases for a lost dispute after a partial refund, a `head_coach_split` slice, and the lifetime-equals-sum-of-windows invariant.

### B-676-2 — the new refresh handler writes raw exception text to the log
**Where:** `refreshStatus` (coach-connect.service.ts:222) interpolates `(err as Error)?.message ?? err` into `logger.warn`.

**Counterexample:** any exception from `syncFromStripe` reaches that line, for example:
- a Prisma connection or invocation error (DB host, file path, query arguments);
- a Stripe error's message.

AGENT_RULES says not to expose sensitive internals in logs. It is the same class as B-641-11 and #674's B-674-4.

**Fix rule:** log a closed code (HTTP status and a closed Stripe or Prisma code) and ids only; never message, name or stack. The response stays `refreshed: false` with the mirrored status.

**Verify:** a spec throws an error whose message holds a canary, and asserts the canary never reaches the logger.

### C (optional)
- **C-676-2 (= C-641-13, own, carried):** `payoutReason` (coach-connect.service.ts:134-141, used at :314) has two problems on a failed payout:
  - It shows Stripe's raw English `failure_message`, with no next action.
  - A failed payout with no message falls back to its description (e.g. "STRIPE PAYOUT"), which then reads as the reason.
  - Fix: map `failure_code` (`account_closed`, `no_account`, `invalid_account_number`, `could_not_process`, `debit_not_authorized`, ...) to app copy with an action (e.g. "Update your bank account in Stripe"). Send unknown codes as a short reference plus the support path. Never present the description as a reason.
- **C-641-2 (carried):** exact-candidate integration with #627/#628.
  - `foldTotals` and `foldWindowTotals` add every seller slice's `amount_cents` into `gross_cents`, `stripe_fee` included. Once #627 writes `stripe_fee` slices, check that gross still equals the client price.

Approval at the next head requires B-676-1 and B-676-2 closed with failing-before tests and every applicable check green. A merge-only restack from #674 gets a delta check. No push, merge or dispatch to the PR branch by this lens.
