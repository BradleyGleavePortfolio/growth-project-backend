AUDIT Claude Opus 5.5 — growth-project-backend#678 @ 09e159d83e192e9718bef7a493aa18944022eb0b — VERDICT: APPROVE
A/B/C = 0/0/2

AUD-OPUS-R12D-119, agent 119. T4 delta audit of FIX ROUND 7 (B-RECUR7A-119). Every changed line in `77bce450..09e159d8` was read: 4 files, +206/-23. In `src/` the changes are `account-deletion.billing.ts` and `checkout/subscription-attempt.ts`; the rest are the new `test/b-recur7a-119-r1.spec.ts` and the fixture/where edit in `test/b-recur6a-118-r1.spec.ts`. The history is three linear commits on top of 77bce450, with no merges and no fees-base change: the merge base is still 13c814f7.

**Evidence reuse (G09):** every line outside this delta is byte-identical to 77bce450, where this lens approved 0/0/2 ([verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/678#issuecomment-5983746979)). That approval is the evidence for those lines. No verdict from the other lens is borrowed.

**Prior findings**
- Opus C-678-4 is CLOSED:
  - The collector now selects `OR: [{client_user_id}, {coach_user_id}]` (account-deletion.billing.ts:93-111), and each key is qualified by that row's own client (:115).
  - `sendFenced` takes FOR KEY SHARE on both User rows in sorted id order. It returns `'gone'` for a deleted client and `'closed'` for a deleted coach, and the claim, read-back and bind all require `coach_user_id` (subscription-attempt.ts:53-87).
  - My R12 probe's coach-deletion acceptance case now passes.
- Opus C-678-3 is still OPEN (frozen C, see below). Its acceptance case still fails, as expected.
- I judged the Sol B-678-3 and B-678-4 fixes independently against their fix rules, and both are met:
  - Payer and payee are both collected, and the fail-closed rules (the 2-minute window, `has_more`) are kept for both.
  - Shared authority is held through create and bind.
  - The deterministic lock order is safe for reciprocal identities.

**Concurrency proof (real PostgreSQL, two or more sessions, actual `sendFenced`)**
The probe ran in [CI lane run 37231743536](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37231743536) on audit commit 4d1b4323, which is #679 @ 23d2c04c (this head merged in) plus probe specs only. 35 tests passed and 2 failed; both failures are expected.
- **Coach finalization first:** finalization holds the coach FOR UPDATE and writes the tombstone, then the send starts. The send blocks on the coach row until the commit, then answers `closed` with 0 creates, and the marker is untouched (`OPUS_COACH_FIRST { out: 'closed', creates: 0, blockedUntilCommit: true }`).
- **Finalization rolls back:** the waiting send proceeds and binds.
- **Client tombstoned:** the send answers `gone`.
- **Reciprocal identities:** two sends are in flight, (client X, coach Y) and (client Y, coach X). FOR UPDATE SKIP LOCKED on X and on Y both skip. A waiting FOR UPDATE (the requestDeletion mode) queues behind them and completes. Both sends bind, with no deadlock.
- **Sol's PostgreSQL fence probe, re-run independently:** both cases pass (`SOL_COACH_FENCE { skipped: true, creates: 1 }`).
- **Lock-mode check:** KEY SHARE conflicts only with FOR UPDATE and key changes. The manifest's `ClientPurchase` updates and the tombstone UPDATE of the deleted user take no lock on another user's row that conflicts with KEY SHARE. `lockUser` locks only the deleted user's own row, so no cycle is possible.

**Builder claims verified:**
- Failing-before [run 37229770060](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37229770060) concluded failure, at 7ec88952 = 77bce450 + test only.
- After [run 37230098522](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230098522) concluded success.
- The two failures in probe [run 37230108455](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230108455) are the superseded "minimal bodies" cases.
- The test edit in b-recur6a-118-r1.spec.ts only adapts the fixture and the where shape to the new OR query. Its assertions still pin the status, the unbound sub, `startsWith 'sub-'` and the list arguments; nothing was weakened.

**Money list**
- **Webhook order and redelivery:** not touched. The bind is still a CAS on an open pending row.
- **Concurrency:** proven above.
- **Terminal states:**
  - The manifest cancels the coach's rows (status `canceled`, coach id retained). The claim requires pending, and `holdUnresolved` never reopens a canceled row.
  - Collected ids skip canceled and incomplete_expired subscriptions.
- **Lists:** `has_more` still throws for both parties.
- **Currency:** not touched.
- **Copy:** none added.

**Size:** 2,572+22 = 2,594 (grandfathered, under 3,000).

**CI:** every required check emitted at this head is green: build-and-test, rls-floor-guard, rls-live, mwb-3-live, community-live, npm audit, Schema parity and both migration gates. `mergeStateStatus` UNSTABLE comes only from a queued, non-required size-label rerun. CodeQL, danger, banned casts and build-sbom must pass after the retarget to main.

### Follow-ups (C, frozen; operator tickets)
- **C-678-3 (carried, open)**
  - **Where:** src/account-deletion/account-deletion.billing.ts:124-132.
  - **Problem:** a Stripe 404 resource_missing ("No such customer") from the list throws on every nightly run. Admin force-delete gets an uncoded 500.
  - **Fix rule:** treat a 404 resource_missing on the customer list as proven absence. Keep every other error fail-closed. Admin force-delete answers a coded, retryable 409/503 that gives the retry time.
  - **Verify:** the probe case in run 37231743536 passes.
- **C-678-5 (new)**
  - **Where:** account-deletion.billing.ts:93-136, with the coach side new in this round.
  - **Problem:** coach finalization now does one Stripe list per stale pending, unbound native attempt across all of that coach's clients. It does this inside the finalization transaction (FINALIZE_TX_TIMEOUT_MS), and nothing ever sweeps such rows. A `sub-retry-` row left by a client who never retried stays pending forever. Separately, while a coach's finalization holds the coach row, every send by that coach's clients waits on it for up to 30 s, each holding a pooled connection. This widens Sol C-678-3.
  - **Fix rule:** bound the work. Either cap the number of rows per run and throw the coded "still finishing" retry, or have a sweep expire stale pending attempts after a proven-absent Stripe lookup. Measure pool waits.
  - **Verify:** a test that seeds N stale attempts under one coach and asserts a bounded number of Stripe reads per run.
- Also carried (not this lens's IDs): Sol C-678-2 (busy copy; its scope now includes the coach row) and Sol C-678-3 (connection pool).

**Landing:** the merge-only restack onto the final fees top needs a short delta check. The own patch must stay exactly `13c814f7..09e159d8` per file, and every conflict hunk must be read. Keep `sendFenced` as the only path to `createSubscription`, keep both-party KEY SHARE in sorted order, and keep `collectUnboundAttemptSubscriptionIds` running inside the locked finalization before the tombstone.
