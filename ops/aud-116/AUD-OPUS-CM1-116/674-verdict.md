AUDIT Claude Opus 5.5 — growth-project-backend#674 @ 9a512028f49682073227c04ef1268c81102716fd — VERDICT: REQUEST CHANGES

A/B/C = 0/4/5 (C-641-2 is carried on top and not counted)

Lens AUD-OPUS-CM1-116, T4 (money). This is a full audit of piece M1 of #641: every line of `d23fa317..9a512028` (17 files) was read, and every caller of the reversal, ledger and reconcile paths was traced.

**IDs:** to keep one ID per defect, this verdict uses the Sol lens's IDs at this head wherever both lenses report the same defect.
- B-641-12 is Sol's B-674-1.
- B-674-3 was found and proved here independently, before Sol's verdict was read. The probe's test titles still say "B-674-1" for it.
- B-674-4 was drafted here as a C, then raised to B so it is rated the same as B-641-11. Sol rates it B as well.
- B-674-2 was first raised by Sol. This lens re-derived it from source and concurs.

**Evidence base**
- The piece is faithful to its source. `git merge-tree --write-tree f60ed603 d23fa317` gives tree `d4d5d4bc`. `git diff 564f33bf d4d5d4bc` touches only the M2 files (packages.*) and the M4 spec. So the M1 code is byte-identical to #641 FIX ROUND 5 merged with main.
- No evidence reuse for this piece. This lens's last APPROVE on #641 was at fb29fb9e, and almost all of this code changed after it, so it was audited fresh.

**Prior findings from this lens and the other lens, decided at this head**
- **B-641-12 (Opus @ 02cd3f88): OPEN.** The code is unchanged.
  - FIX ROUND 5 was posted 19 minutes after that verdict and folded only Sol's findings.
  - It is proved red again at this head; see B-641-12 below.
- **C-641-7 and B-641-7 narrowed: still closed.**
  - The ledger claim and the reversal commit in one transaction (refund-dispute-handler.service.ts:536-544).
  - One refund-scoped key (`tgp-tr-rev-refund-<id>`) is used, with the first attempt stamped before Stripe sees it.
  - A resend is admitted only within 23 h; after that the row goes to review once, with a single Sentry alert (ids and amounts only).
- **Sol's findings at 02cd3f88, checked from this lens: all four closed.**
  - B-641-8 narrowed:
    - Never-attempted rows are taken first, then the least recently attempted.
    - Every touched row either leaves the owed set or is stamped with this run's `now`, so a page always moves on. Runs are bounded at 20 pages.
  - B-641-9: there is a unique `transfer_reversal_stripe_id`, a check that the reversal is not bound elsewhere (:941), and a P2002 mapping (:958).
  - B-641-10: an undersized receipt is refused (:924).
  - B-641-11: error codes come from a closed catalog.
- **C-641-13** lives in #676 and is decided there.
- **C-641-2** is carried (see the end of this comment).

**Checks the job asked for**
- **Admin endpoints: no one but the owner gets in, but the owner cannot get in either (B-674-2).**
  - The class has `@UseGuards(JwtAuthGuard, ServiceTokenGuard, RolesGuard)` and `@Roles('owner')` (payment-ops.controller.ts:111-113).
  - The new handlers at :581 and :588 add no handler-level `@Roles`, and RolesGuard reads `getAllAndOverride`. Nobody other than the owner can pass.
  - The body must be a `trr_` id or a boolean; anything else is a 400 `RECONCILE_BODY_INVALID`.
- **Reversal idempotency holds per refund at Stripe.** The local mirror is not idempotent against the webhook writer (B-674-3).
- **Coach-visible money vs. the ledger:** the ledger itself drifts from Stripe here (B-674-3, B-641-12). #676 then reads that drift faithfully.

**Piece boundary: OK**
- The base is main. All 18 checks are green at this head, including CodeQL, danger, banned casts and SBOM.
- The piece carries its own specs, harness and double.
- It imports nothing from #676 or #677.
- Migration 20270314000000:
  - It is additive and nullable, sorts after main's and production's latest (20270301000000), and has an exact down.sql.
  - It adds no user-id column, so there is no deletion-manifest change.
- The piece is live once deployed (15-minute cron plus two owner routes). That is harmless at production's 0 Connect accounts.

### B-674-2 — the owner cannot reach the review and reconcile routes, which the runbook makes mandatory
**Where:** both guards read the same `Authorization: Bearer` header, and each demands a different value:
- `JwtAuthGuard` requires a JWKS-verified Supabase JWT (auth.guard.ts:85-101).
- `ServiceTokenGuard` requires the same header to equal `ADMIN_SERVICE_TOKEN` byte for byte (service-token.guard.ts:24-44).

The class applies both to `GET refund-reversals/review` (:581) and `POST refund-reversals/:id/reconcile` (:588).

**Counterexample**
- An owner JWT passes JwtAuthGuard, then gets 401 "Invalid service token".
- The owner console's service token fails `jwks.verify`, giving 401 "Invalid or expired token".
- No request can satisfy both guards.

The runbook (docs/runbooks/refund-transfer-reversal-review.md:19-20) tells the owner to call both routes within one business day. It is the only way out of review for an owed head-coach reversal past the 23 h window. In practice those rows stay stuck, and the share is never recovered.

The guard line itself predates this PR, and the other routes in this controller share it. That part is outside this diff, but it makes this PR's new mandatory workflow unusable, so it is rated B here.

**Fix rule:** these two routes need an explicit guard that admits exactly:
- an owner JWT (JwtAuthGuard + RolesGuard `owner`), or
- the owner-console service token (as `OwnerConsoleController` uses it);

and nothing else.

**Verify:** a guard spec over the real guards:
- owner JWT -> 200;
- coach or client JWT -> 403;
- service token -> 200;
- no token or a wrong one -> 401.

### B-674-3 — the `transfer.reversed` webhook and the new record paths count one Stripe reversal twice
**Where**
- `onTransferReversed` (refund-dispute-handler.service.ts:1417-1442) writes Stripe's **cumulative** `amount_reversed` into `ConnectTransfer.reversed_amount_cents`, and sets `status: 'reversed'` when Stripe says the transfer is fully reversed.
- `.env.example:285` lists `transfer.reversed` as a required event ("head-coach reversal mirror").
- This PR's record paths **add** the same reversal again:
  - `recordReversal` re-reads the row after the Stripe call and adds the amount (transfer-orchestrator.service.ts:251-265).
  - Callers: the retry sweep, which replays a request Stripe may already have honoured, and owner reconcile `recorded_from_stripe` (:949), which runs 23 h or more after Stripe made the reversal, so its webhook has long since landed.
- `owedHeadCoachReversal` (:624-638) then trusts that mirror. Its cap is `amount - reversed_amount_cents`, and it looks only for transfers with status `succeeded`.
- The result of `stripe.reverseTransfer` (transfer-orchestrator.service.ts:216) is discarded, so the reversal id and amount are never recorded on the automatic path.

**Counterexamples** (all three red: [ci-lane run 37171850436](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171850436))
The probe runs the real RefundDisputeHandlerService, SplitLedgerService and TransferOrchestratorService over this PR's own harness and stateful double. Only Stripe is synthetic. The request reaches Stripe but times out at the client; `handleFetchError` maps that to 503 `request_timeout`.

1. **Owner reconcile after the webhook.**
   - Stripe holds `trr_1` for 122. The webhook sets the mirror to 122.
   - Reconcile returns `recorded_from_stripe` and the mirror becomes **244**, while Stripe holds 122.
2. **Two half refunds on a 245-cent head-coach transfer.**
   - The first reversal timed out after Stripe made it. The webhook mirrors 122, then the sweep replays the same key and adds 122, so the mirror reads **244** after the first refund.
   - The second refund owes 122, but `owedHeadCoachReversal` caps it at 245 - 244 = **1 cent**.
   - Final state: Stripe reversed **123 instead of 244**. The platform never recovers 121 cents, and nothing alerts.
3. **Full refund (4900 of 4900).**
   - The timed-out reversal lands by webhook, which marks the transfer `reversed`.
   - The sweep finds no `succeeded` transfer and returns `nothing_owed`. The refund is marked done, but the `head_coach_split` ledger slice keeps `reversed_cents` **0 instead of 245**.
   - #676's Money read model then shows the head coach 245 cents of income that Stripe took back.
4. **Control:** the same timeout with no webhook in between records 122 once (green).

**Probe source:** `test/audit-cm1-674-reversal-mirror.spec.ts`.
- Its commit is `2cad0d3a0dc57393052bad017c1aea5ebedfcbc6` on top of this head. The lane commit is `7367be54`, and the lane branch is deleted when this job ends.
- The file is also kept in the operator workspace for the builder.

**Fix rule:** one writer per number, and one record per Stripe reversal.
- (a) `reverse()` keeps the reversal Stripe returns (id and amount). It binds `transfer_reversal_stripe_id` to the refund inside the claim on **every** path, not only reconcile, and records Stripe's amount.
- (b) The two writers must stop counting the same reversal twice. Either:
  - `onTransferReversed` stops writing `reversed_amount_cents`/`status` for transfers this service reverses (it becomes a drift check that alerts on mismatch); or
  - both writers set Stripe's cumulative total under a row lock (GREATEST, never add).
- (c) The head-coach ledger slice is reversed with the refund's claim, using that refund's Stripe reversal amount. It is never skipped because the mirror already reads "reversed".
- (d) A retry replays the first attempt's exact amount. Persist that amount at the first attempt: a changed amount under the same key gets an `idempotency_error`.

**Verify:**
- The three B-674-3 probe tests pass unchanged and the control stays green.
- Add the same cases through `charge.refund.updated` and the admin refund.

### B-641-12 (carried, open) — two refunds reversed concurrently on one transfer or one ledger slice lose one reversal
**Where:** both functions read a row, then write an absolute value with no row lock:
- `recordReversal` (transfer-orchestrator.service.ts:253-265: read at :258, absolute write at :265);
- `SplitLedgerService.applyReversal` (split-ledger.service.ts:126-145: read at :134, absolute write at :145).

The only lock in each transaction is that refund's own ChargeRefund claim, so two different refunds never serialize. Under READ COMMITTED, a reversal that commits between the read and the write is overwritten. The comment at :251-252 claims the opposite.

**Proof** (red in the same run, 37171850436)
- A committed reversal of refund B lands between refund A's SELECT and UPDATE, using the double's documented concurrent-write hook.
- `ConnectTransfer.reversed_amount_cents` ends at **122 (expected 222)**.
- `SplitLedgerEntry.reversed_cents` for application_fee ends at **49 (expected 89)**. That is the seller's own ledger, which Money shows as refunded and net.

**Fix rule** (unchanged from 02cd3f88): make the write additive at the database. Either:
- `UPDATE ... SET reversed = LEAST(amount, reversed + $x)` with status and reversed_at derived in SQL (or Prisma `increment` plus a capped follow-up); or
- `SELECT ... FOR UPDATE` before the read in both functions.

Then add a live-DB test (rls-live lane) with two concurrent reversals of different refunds on one transfer and one ledger slice, asserting the sum. An `increment` fix also turns these two probe tests green; a raw-SQL lock fix needs the live test as its proof.

### B-674-4 — the new sweep scheduler writes raw exception text to the error log
**Where:** refund-transfer-reversal.scheduler.ts:28-29 takes `err instanceof Error ? err.message : String(err)` and interpolates it into `logger.error`. This is new in this diff.

**Counterexample:** anything `retryPendingTransferReversals` throws reaches that line, for example:
- a Prisma connection error ("Can't reach database server at `<host>:5432`");
- a Prisma invocation error, which carries the file path and query arguments.

AGENT_RULES says not to expose sensitive internals in logs. The same class was B-641-11 on this code, fixed for the handler's own logs in FIX ROUND 5; this caller was missed.

**Fix rule:** log a closed code (e.g. `REFUND_REVERSAL_SWEEP_FAILED` with `prisma_<code>` or `stripe_<status>_<code>`) and counts only. Never log message, name or stack.

**Verify:** a spec throws an Error whose message holds a canary, and asserts the canary is absent from the logger call.

### C (optional; the cheap ones are worth folding into the same round)
- **C-674-5:** the client timeout code `request_timeout` (stripe-connect-api.service.ts:1012) is not in `STRIPE_REVERSAL_ERROR_CODES` (refund-dispute-handler.service.ts:55-69), so it logs as `stripe_503_other`.
  - This is the one failure where Stripe may have made the reversal.
  - Fix: add it to the catalog.
- **C-674-6:** if Stripe fails during reconcile (the `reversed` send at :973, or the reversal listing), the owner gets the generic 500 "Internal server error", with no code and no runbook row.
  - Fix: map it to a coded 502/503 ("Stripe did not answer; nothing was recorded; reconcile again") and add the runbook row.
- **C-674-7:** owner reconcile records no actor, unlike the admin refund (`initiated_by_user_id`), even when it sends money (`reversed`) or binds a reversal on the owner's judgment.
  - Fix: record the owner's id and the time (column or audit log). Log ids only.
- **C-674-8 (outside this diff):** `upsertAndApplyRefund` writes `status: args.status` (:495).
  - A stale `charge.refunded` redelivery (refund status `pending`) arriving after `charge.refund.updated` succeeded regresses the row to `pending`.
  - The still-owed head-coach reversal then leaves both the sweep and the review query (both filter on `status: 'succeeded'`) with no alert, and Money shows the charge as not refunded.
  - Fix: allow only forward refund status transitions.
- **C-674-9 (outside this diff):** a head-coach transfer still `pending` when its sale is refunded is marked `nothing_owed`, because `owedHeadCoachReversal` needs status `succeeded`.
  - `TransferOrchestratorService.attempt` (transfer-orchestrator.service.ts:94-110) never checks refunds, so it later pays the full split on a refunded sale.
  - Fix: either `attempt()` nets out succeeded refunds, or the refund path cancels or shrinks the pending transfer.
- **C-641-2 (carried):** exact-candidate integration with #627/#628.
  - Concretely, `owedHeadCoachReversal` picks any `succeeded` transfer of the purchase (:628-630), not the refunded charge's own transfer (OR-111-1). That holds only while there is one transfer per purchase.

Approval at the next head requires B-674-2, B-674-3, B-674-4 and B-641-12 closed with failing-before tests (a live-DB test for B-641-12) and every required check green. No push, merge or dispatch to the PR branch by this lens.
